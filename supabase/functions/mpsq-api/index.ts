import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { AwsClient } from "npm:aws4fetch@1.0.20";

const cors = { "Access-Control-Allow-Origin": "https://www.mixelpixel-squidgame.net", "Access-Control-Allow-Headers": "content-type, x-mpsq-token, x-admin-password", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS" };
const base = () => `${Deno.env.get("SUPABASE_URL")}/rest/v1`;
const key = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const headers = () => ({ apikey: key(), Authorization: `Bearer ${key()}`, "Content-Type": "application/json" });
const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  // Camera state changes rapidly. Never let an intermediary reuse an old
  // signed URL or an old API response for a later frame request.
  headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store, no-cache, max-age=0" }
});
const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const code = () => Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
const token = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const forbiddenChatFragments = ["arschloch", "bastard", "behindert", "fick", "fotze", "hurensohn", "missgeburt", "neger", "nigger", "scheisse", "schwuchtel", "spast", "wichser"];
function normalizeChatForFilter(value: string) {
  return value
    .replace(/&[0-9a-fk-or]/gi, "")
    .normalize("NFKD")
    .replace(/ß/g, "ss")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[013457@$]/g, (letter) => ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" }[letter] ?? letter))
    .replace(/[^a-z0-9]/g, "");
}
function containsForbiddenChatContent(value: string) {
  const normalized = normalizeChatForFilter(value);
  return forbiddenChatFragments.some((fragment) => normalized.includes(fragment));
}
async function sha(value: string) { const bytes = new TextEncoder().encode(value); const hash = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join(""); }
async function rest(path: string, init: RequestInit = {}) { return fetch(`${base()}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } }); }
async function json(req: Request) { try { return await req.json(); } catch { return {}; } }
async function auth(req: Request): Promise<string | null> {
  const supplied = req.headers.get("x-mpsq-token"); if (!supplied) return null;
  const result = await rest(`/mpsq_clients?token_hash=eq.${await sha(supplied)}&select=id`);
  const rows = await result.json(); return result.ok && rows[0]?.id ? rows[0].id : null;
}
function isAdmin(req: Request) {
  const expected = Deno.env.get("ADMIN_PASSWORD");
  const supplied = req.headers.get("x-admin-password");
  return !!expected && !!supplied && supplied.length === expected.length && supplied === expected;
}
async function owned(clientId: string, screenId: string) {
  const r = await rest(`/mpsq_screens?id=eq.${screenId}&owner_id=eq.${clientId}&select=id`); return (await r.json()).length > 0;
}
async function screenIdsFor(clientId: string) {
  const mine = await (await rest(`/mpsq_screens?owner_id=eq.${clientId}&select=id`)).json();
  const joined = await (await rest(`/mpsq_screen_members?client_id=eq.${clientId}&select=screen_id`)).json();
  return [...new Set([...mine.map((x: any) => x.id), ...joined.map((x: any) => x.screen_id)])];
}
// Live frames do not belong in Supabase Storage: every picture would count as
// Supabase egress and as an Edge Function invocation.  R2 owns one overwrite-
// only object per camera instead.  The mod receives short-lived, scoped S3
// links and transfers PNG data directly to/from R2.
const r2AccountId = () => Deno.env.get("R2_ACCOUNT_ID") ?? Deno.env.get("CLOUDFLARE_R2_ACCOUNT_ID") ?? "";
const r2AccessKeyId = () => Deno.env.get("R2_ACCESS_KEY_ID") ?? Deno.env.get("CLOUDFLARE_R2_ACCESS_KEY_ID") ?? "";
const r2SecretAccessKey = () => Deno.env.get("R2_SECRET_ACCESS_KEY") ?? Deno.env.get("CLOUDFLARE_R2_SECRET_ACCESS_KEY") ?? "";
const r2Bucket = () => Deno.env.get("R2_BUCKET") ?? "mpsq-camera-frames";
const framePath = (cameraId: string) => `frames/${cameraId}.png`;

function requireR2() {
  if (!r2AccountId() || !r2AccessKeyId() || !r2SecretAccessKey()) {
    throw new Error("R2 ist noch nicht konfiguriert. Es fehlen R2_ACCOUNT_ID, R2_ACCESS_KEY_ID oder R2_SECRET_ACCESS_KEY.");
  }
}

async function r2SignedFrameUrl(cameraId: string, method: "GET" | "PUT", expiresIn: number) {
  requireR2();
  const endpoint = `https://${r2AccountId()}.r2.cloudflarestorage.com/${r2Bucket()}/${framePath(cameraId)}?X-Amz-Expires=${expiresIn}`;
  const client = new AwsClient({
    service: "s3",
    region: "auto",
    accessKeyId: r2AccessKeyId(),
    secretAccessKey: r2SecretAccessKey()
  });
  const request = new Request(endpoint, method === "PUT" ? {
    method,
    // The header is covered by the signature; the mod must send the exact
    // same type, so a temporary write URL cannot be used for another format.
    headers: { "Content-Type": "image/png" }
  } : { method });
  return (await client.sign(request, { aws: { signQuery: true } })).url.toString();
}
async function canPublishCamera(clientId: string, cameraId: string) {
  const r = await rest(`/mpsq_cameras?id=eq.${cameraId}&select=owner_id,body_owner_id&limit=1`);
  const [camera] = await r.json();
  return !!camera && (camera.owner_id === clientId || camera.body_owner_id === clientId);
}
async function canReadCamera(clientId: string, cameraId: string) {
  const own = await (await rest(`/mpsq_cameras?id=eq.${cameraId}&or=(owner_id.eq.${clientId},body_owner_id.eq.${clientId})&select=id&limit=1`)).json();
  if (own[0]) return true;
  // Linked/shared camera feeds are a team privilege.  The decision is made
  // from the stored Supabase rank, never from a rank claimed by the client.
  if (!teamAllowed(await teamProfile(clientId))) return false;
  const screenIds = await screenIdsFor(clientId);
  if (!screenIds.length) return false;
  const links = await (await rest(`/mpsq_screen_cameras?camera_id=eq.${cameraId}&screen_id=in.(${screenIds.join(",")})&select=screen_id&limit=1`)).json();
  return !!links[0];
}
async function withBodyOwnerNames(cameras: any[]) {
  const ids = [...new Set(cameras.map(camera => camera.body_owner_id).filter(Boolean))];
  if (!ids.length) return cameras;
  const owners = await (await rest(`/mpsq_clients?id=in.(${ids.join(",")})&select=id,display_name`)).json();
  const names = new Map(owners.map((owner: any) => [owner.id, owner.display_name]));
  return cameras.map(camera => camera.body_owner_id
    ? { ...camera, body_owner_name: names.get(camera.body_owner_id) ?? null }
    : camera);
}
// PostgREST's combined `or=(...)` filter is fragile with UUID columns on
// some projects.  Query the two ownership cases separately, then merge them
// locally so a wearer always receives their own bodycam in the camera list.
async function camerasForClient(clientId: string) {
  const [ownedResponse, wornResponse] = await Promise.all([
    rest(`/mpsq_cameras?owner_id=eq.${clientId}&order=created_at.asc`),
    rest(`/mpsq_cameras?body_owner_id=eq.${clientId}&order=created_at.asc`)
  ]);
  const owned = await ownedResponse.json();
  const worn = await wornResponse.json();
  const merged = new Map<string, any>();
  for (const camera of [...(Array.isArray(owned) ? owned : []), ...(Array.isArray(worn) ? worn : [])]) {
    if (camera?.id) merged.set(camera.id, camera);
  }
  return { cameras: [...merged.values()], status: ownedResponse.ok && wornResponse.ok ? 200 : (ownedResponse.ok ? wornResponse.status : ownedResponse.status) };
}
const rankLevel: Record<string, number> = { vip: 0, spieler: 1, streamer: 2, "001": 3, soldat: 4, arbeiter: 5, offizier: 6, frontman: 7, sr_offizier: 8 };
const validRank = (rank: string) => Object.prototype.hasOwnProperty.call(rankLevel, rank);
const level = (rank: string | null | undefined) => rankLevel[rank ?? "spieler"] ?? 1;
async function teamProfile(clientId: string) {
  await rest("/mpsq_team_profiles?on_conflict=client_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ client_id: clientId }) });
  const result = await rest(`/mpsq_team_profiles?client_id=eq.${clientId}&select=client_id,base_rank,active_rank,name_visible`);
  const [profile] = await result.json();
  return profile ?? { client_id: clientId, base_rank: "spieler", active_rank: null, name_visible: true };
}
async function teamIdentity(clientId: string) {
  const profile = await teamProfile(clientId);
  const clients = await (await rest(`/mpsq_clients?id=eq.${clientId}&select=id,display_name`)).json();
  return { id: clientId, display_name: clients[0]?.display_name ?? "Minecraft Spieler", base_rank: profile.base_rank ?? "spieler", active_rank: profile.active_rank ?? null, name_visible: profile.name_visible !== false };
}
const shownRank = (profile: any) => profile.active_rank ?? profile.base_rank ?? "spieler";
const permissionRank = (profile: any) => profile.base_rank ?? "spieler";
// Streamer and every higher rank may use cameras and linked screens.
const teamAllowed = (profile: any) => level(permissionRank(profile)) >= level("streamer");
// To-do editing starts at Offizier.  Sr Offizier remains an Officer-category
// editor even while temporarily displaying another event role.
const canEditTodo = (profile: any) => level(profile.base_rank ?? "spieler") >= level("offizier");
// Script texts are an internal staff tool.  A temporary event rank must not
// lock an Officer, Frontman or Sr Offizier out of their prepared scripts.
const canUseTexts = (profile: any) => level(profile.base_rank ?? "spieler") >= level("offizier");
const canEditEvent = (profile: any) => level(permissionRank(profile)) >= level("offizier");
const approvalRanks = ["vip", "spieler", "streamer", "soldat", "arbeiter", "offizier", "frontman"];
async function addRankLog(actorId: string | null, targetId: string, before: any, after: any, action: string, requestId: string | null = null) {
  if (actorId === targetId || before.base_rank === after.base_rank) return;
  // Do not create noise in the protocol for a click that keeps exactly the
  // same rank (for example: an officer selecting "Offizier" again).
  if ((before.base_rank ?? "spieler") === (after.base_rank ?? "spieler")
      && (before.active_rank ?? null) === (after.active_rank ?? null)) return;
  const actor=actorId?await teamIdentity(actorId):null;
  const target=await teamIdentity(targetId);
  await rest("/mpsq_team_rank_log", { method: "POST", body: JSON.stringify({
    actor_rank:actor?.base_rank??null,actor_name:actor?.display_name??"Administration",target_name:target.display_name,
    request_id: requestId, actor_id: actorId, target_id: targetId,
    old_base_rank: before.base_rank ?? "spieler", old_active_rank: before.active_rank ?? null,
    new_base_rank: after.base_rank ?? "spieler", new_active_rank: after.active_rank ?? null, action
  }) });
  await cleanupRankRecords();
}
async function trimToNewestTen(path: string) {
  const response = await rest(`${path}&select=id&order=created_at.desc&offset=10`);
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows.length) return;
  await rest(`${path}&id=in.(${rows.map((row: any) => row.id).join(",")})`, { method: "DELETE" });
}
/** Open applications expire after a week; only the ten newest final records remain. */
async function cleanupRankRecords() {
  const expiry = encodeURIComponent(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  await rest(`/mpsq_team_rank_requests?status=eq.PENDING&created_at=lt.${expiry}`, { method: "DELETE" });

  await trimToNewestTen("/mpsq_team_rank_requests?status=in.(APPROVED,REJECTED)");
}
async function rootInfo() {
  const result = await rest("/mpsq_team_root?id=eq.1&select=root_display_name,root_client_id");
  const [root] = await result.json();
  return root ?? { root_display_name: "MP_SquidGame", root_client_id: null };
}
function validAction(type:string,data:any):boolean {
 if(!data||typeof data!=="object"||Array.isArray(data)||JSON.stringify(data).length>8192)return false;
 const sound=(v:any)=>typeof v==="string"&&/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(v)&&v.length<=128;
 switch(type){
  case "PLAY_AUDIO":return validSoundSource(data);
  case "START_PLAYLIST":return Array.isArray(data.tracks)&&data.tracks.length>0&&data.tracks.length<=100&&(String(data.sourceType??"minecraft")==="minecraft"?data.tracks.every(sound):["mp3","mp4"].includes(String(data.sourceType))&&data.tracks.every((x:any)=>typeof x==="string"&&/^[a-z0-9_-]{1,64}$/i.test(x)));
  case "START_COUNTDOWN":return Number.isInteger(data.duration)&&data.duration>=1&&data.duration<=7200&&typeof data.title==="string"&&data.title.length<=256;
  case "TOGGLE_COUNTDOWN":return Number.isInteger(data.duration)&&data.duration>=1&&data.duration<=7200&&typeof data.title==="string"&&data.title.length<=256;
  case "SHOW_BOSSBAR":return typeof data.title==="string"&&data.title.length<=256;
  case "TOGGLE_BOSSBAR":return typeof data.title==="string"&&data.title.length<=256;
  case "TOGGLE_AUDIO":return validSoundSource(data);
  case "SEND_ANNOUNCEMENT":return typeof data.text==="string"&&data.text.length<=512&&(!data.sound||sound(data.sound));
  case "SHOW_DIALOGUE":return Array.isArray(data.pages)&&data.pages.length>0&&data.pages.length<=12&&data.pages.every((p:any)=>typeof p==="string"&&p.trim().length>0&&p.length<=240);
  case "OPEN_LINK":try{const u=new URL(data.url);return u.protocol==="https:"&&!u.username&&!u.password&&u.href.length<=2048;}catch{return false;}
  case "OPEN_REDEEM":case "STOP_AUDIO":case "HIDE_BOSSBAR":return true;
  default:return false;
 }
}
const NPC_GLOW_COLORS=["none","white","orange","magenta","light_blue","yellow","lime","pink","gray","light_gray","cyan","purple","blue","brown","green","red","black"];
const NPC_ANIMATIONS=["none","bob","turn","pulse","nod","tilt","look_around","shake","wave"];
function validNpcPages(pages:any):boolean{return Array.isArray(pages)&&pages.length<=12&&pages.every((p:any)=>typeof p==="string"&&p.trim().length>0&&p.length<=240);}
function validSoundSource(data:any):boolean{
  const kind=String(data.sourceType??"minecraft"),value=data.sound;
  if(kind==="minecraft")return typeof value==="string"&&/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(value)&&value.length<=128;
  return ["mp3","mp4"].includes(kind)&&typeof value==="string"&&/^[a-z0-9_-]{1,64}$/i.test(value);
}
serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const url = new URL(req.url); const path = url.pathname.replace(/^.*\/mpsq-api/, "") || "/";
  try {
    if (req.method === "POST" && path === "/register") {
      const body = await json(req); const raw = token();
      const r = await rest("/mpsq_clients", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ token_hash: await sha(raw), display_name: String(body.displayName ?? "").slice(0, 32) }) });
      if (!r.ok) return out({ error: await r.text() }, 500); const [client] = await r.json(); return out({ clientId: client.id, token: raw }, 201);
    }

    // Private website administration.  These routes never accept a Minecraft
    // token; they require the password stored only as an Edge Function secret.
    if (path.startsWith("/admin/") && !isAdmin(req)) return out({ error: "Unauthorized" }, 401);
    if(path === "/public/redeem" && req.method === "POST") {
      const body=await json(req),name=String(body.player??""),code=String(body.code??"").trim().toUpperCase();
      if(!/^[A-Za-z0-9_]{3,16}$/.test(name)||!code||code.length>64)return out({error:"Spielername oder Code ungültig"},400);
      const escaped=name.replaceAll("_","\\_");
      const users=await(await rest(`/mpsq_clients?display_name=ilike.${encodeURIComponent(escaped)}&select=id&limit=2`)).json();
      if(!Array.isArray(users)||users.length!==1)return out({error:"Bitte die Mod einmal starten. Bei mehreren Profilen den Code direkt in der Mod einlösen."},409);
      const r=await rest("/rpc/mpsq_redeem",{method:"POST",body:JSON.stringify({p_client:users[0].id,p_code:code})});
      const result=await r.json();return out(result,r.ok?(result.error?409:200):r.status);
    }
    if (path === "/assets" && req.method === "GET") {
      const r=await rest("/mpsq_assets?kind=eq.jar&order=created_at.desc&limit=10");
      const rows=await r.json();
      if(!r.ok)return out({error:"Downloads nicht verfügbar"},r.status);
      return out(rows.map((a:any)=>({...a,url:`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/mpsq-assets/${a.path}`})));
    }
    if (path === "/admin/assets" && req.method === "GET") {
      const r=await rest("/mpsq_assets?select=id,kind,category,behavior,path,filename,display_name,created_at&order=category.asc,created_at.desc&limit=500");
      const rows=await r.json();return out(Array.isArray(rows)?rows:[],r.status);
    }
    const assetRoute=path.match(/^\/admin\/assets\/([^/]+)$/);
    if(assetRoute&&req.method==="PATCH"){
      const id=decodeURIComponent(assetRoute[1]),body=await json(req);
      const current=await rest(`/mpsq_assets?id=eq.${encodeURIComponent(id)}&select=id,category,kind&limit=1`),rows=await current.json();
      if(!current.ok)return out({error:"Asset konnte nicht geladen werden"},current.status);
      if(!rows[0])return out({error:"Asset nicht gefunden"},404);
      const displayName=String(body.name??"").trim().slice(0,80);
      if(!displayName)return out({error:"Anzeigename darf nicht leer sein"},400);
      const behavior=rows[0].category==="furniture"&&body.behavior==="interactive"?"interactive":"decoration";
      const saved=await rest(`/mpsq_assets?id=eq.${encodeURIComponent(id)}`,{method:"PATCH",body:JSON.stringify({display_name:displayName,behavior})});
      if(!saved.ok)return out({error:"Asset konnte nicht aktualisiert werden"},saved.status);
      if(rows[0].kind==="model"&&rows[0].category==="accessory"){
        const accessory=await rest(`/mpsq_accessories?model_id=eq.${encodeURIComponent(id)}`,{method:"PATCH",body:JSON.stringify({display_name:displayName})});
        if(!accessory.ok)return out({error:"Asset aktualisiert, aber Accessoire-Anzeigename konnte nicht synchronisiert werden"},502);
      }
      return out({ok:true,id,display_name:displayName,behavior});
    }
    if(assetRoute&&req.method==="DELETE"){
      const id=decodeURIComponent(assetRoute[1]);
      const current=await rest(`/mpsq_assets?id=eq.${encodeURIComponent(id)}&select=id,path&limit=1`),rows=await current.json();
      if(!current.ok)return out({error:"Asset konnte nicht geladen werden"},current.status);
      if(!rows[0])return out({error:"Asset nicht gefunden"},404);
      const accessoryRows=await rest(`/mpsq_accessories?model_id=eq.${encodeURIComponent(id)}&select=id`),accessories=await accessoryRows.json();
      if(!accessoryRows.ok)return out({error:"Accessoire-Verknüpfungen konnten nicht geladen werden"},accessoryRows.status);
      const accessoryIds=Array.isArray(accessories)?accessories.map((item:any)=>item.id).filter(Boolean):[];
      if(accessoryIds.length){
        const codes=await rest(`/mpsq_redeem_codes?accessory_id=in.(${accessoryIds.map(encodeURIComponent).join(",")})`,{method:"DELETE"});
        if(!codes.ok)return out({error:"Redeem-Codes konnten nicht entfernt werden"},codes.status);
      }
      const placements=await rest(`/mpsq_world_objects?model_id=eq.${encodeURIComponent(id)}`,{method:"DELETE"});
      if(!placements.ok)return out({error:"Möbelplatzierungen konnten nicht entfernt werden"},placements.status);
      if(accessoryIds.length){
        const removedAccessories=await rest(`/mpsq_accessories?id=in.(${accessoryIds.map(encodeURIComponent).join(",")})`,{method:"DELETE"});
        if(!removedAccessories.ok)return out({error:"Accessoire-Einträge konnten nicht entfernt werden"},removedAccessories.status);
      }
      const removed=await rest(`/mpsq_assets?id=eq.${encodeURIComponent(id)}`,{method:"DELETE"});
      if(!removed.ok)return out({error:"Asset-Datensatz konnte nicht gelöscht werden"},removed.status);
      const storagePath=String(rows[0].path??"").split("/").map(encodeURIComponent).join("/");
      const storage=await fetch(`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/mpsq-assets/${storagePath}`,{method:"DELETE",headers:{apikey:key(),Authorization:`Bearer ${key()}`}});
      if(!storage.ok)return out({ok:true,id,warning:"Datensatz gelöscht, Storage-Datei konnte nicht entfernt werden"});
      return out({ok:true,id});
    }
    if (path === "/admin/assets" && req.method === "POST") {
      const body=await json(req), kind=String(body.kind??"");
      const id=String(body.id??"").trim();
      const category=String(body.category??(kind==="model"?"accessory":kind==="jar"?"mod_release":""));
      const validCategory=kind==="model"?["furniture","accessory","npc_model"].includes(category):kind==="sound"?category==="sound":kind==="npc_skin"?["npc_skin","npc_skin_normal","npc_skin_slim"].includes(category):kind==="jar"?category==="mod_release":false;
      if(!/^[a-z0-9_-]{1,64}$/.test(id)||!validCategory)return out({error:"Bitte ID und passenden Datei-Bereich angeben."},400);
      let bytes:Uint8Array, filename:string, contentType:string;
      if(kind==="jar"||kind==="sound"||kind==="npc_skin"){
        const encoded=String(body.data??"");
        const maxBytes=kind==="jar"?16_777_216:kind==="sound"?12_582_912:2_097_152;
        if(encoded.length>Math.ceil(maxBytes*4/3)+8)return out({error:`Datei maximal ${Math.round(maxBytes/1048576)} MiB`},413);
        try{bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));}catch{return out({error:"Dateiinhalt ungültig"},400);}
        if(!bytes.length||bytes.length>maxBytes)return out({error:"Datei fehlt oder ist zu groß"},400);
        filename=String(body.filename??(id+(kind==="jar"?".jar":kind==="sound"?".ogg":".png"))).split(/[\\/]/).pop()??id;
        if(!/^[a-zA-Z0-9._-]{1,100}$/.test(filename))return out({error:"Dateiname ungültig"},400);
        const ext=filename.split(".").pop()?.toLowerCase();
        if(kind==="jar"){
          if(ext!=="jar"||bytes[0]!==80||bytes[1]!==75)return out({error:"Ungültige JAR-Datei"},400);
          contentType="application/java-archive";
        }else if(kind==="sound"){
          if(ext==="ogg"&&new TextDecoder().decode(bytes.slice(0,4))==="OggS")contentType="audio/ogg";
          else if(ext==="wav"&&new TextDecoder().decode(bytes.slice(0,4))==="RIFF")contentType="audio/wav";
          else if(ext==="mp3"&&(new TextDecoder().decode(bytes.slice(0,3))==="ID3"||(bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0)))contentType="audio/mpeg";
          else if(ext==="mp4"&&bytes.length>=12&&new TextDecoder().decode(bytes.slice(4,8))==="ftyp")contentType="video/mp4";
          else return out({error:"Bitte eine gültige OGG-, WAV-, MP3- oder MP4-Datei auswählen."},400);
        }else{
          const png=[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v);
          const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),w=bytes.length>=24?view.getUint32(16):0,h=bytes.length>=24?view.getUint32(20):0;
          if(ext!=="png"||!png||!([32,64].includes(w)&&[32,64].includes(h)))return out({error:"NPC-Skin muss eine PNG-Datei mit 32×32 oder 64×64 Pixeln sein."},400);
          contentType="image/png";
        }
      }else{
        const bundle=body.bundle;
        const elements=Array.isArray(bundle?.elements)?bundle.elements:[],meshes=Array.isArray(bundle?.meshes)?bundle.meshes:[];
        if(!bundle||elements.length>512||meshes.length>512||(!elements.length&&!meshes.length))return out({error:"Modell benötigt Würfelelemente oder Mesh-Flächen"},400);
        if(!bundle.textures||Object.keys(bundle.textures).length>32)return out({error:"Maximal 32 PNG-Texturen"},400);
        for(const texture of Object.values(bundle.textures))if(typeof texture!=="string"||!texture.startsWith("data:image/png;base64,")||texture.length>3_000_000)return out({error:"PNG-Textur ungültig oder zu groß"},400);
        for(const e of elements){
          for(const field of ["from","to","origin","rotation"])if(!Array.isArray(e[field])||e[field].length!==3||e[field].some((n:any)=>!Number.isFinite(n)||Math.abs(n)>1024))return out({error:"Ungültige Modellkoordinaten"},400);
          if(!e.faces||Object.values(e.faces).some((f:any)=>!bundle.textures[f.texture]||!Array.isArray(f.uv)||f.uv.length!==4||f.uv.some((v:any)=>!Number.isFinite(v))))return out({error:"Ungültige Modellflächen"},400);
        }
        let vertexTotal=0;
        for(const mesh of meshes){
          if(!mesh||!bundle.textures[mesh.texture]||!Array.isArray(mesh.vertices)||!Array.isArray(mesh.indices)||mesh.vertices.length>200000)return out({error:"Ungültiges Mesh"},400);
          vertexTotal+=mesh.vertices.length;if(vertexTotal>200000||mesh.indices.length>600000||mesh.indices.length%3!==0)return out({error:"Mesh überschreitet die Modellgrenze"},400);
          if(mesh.vertices.some((v:any)=>!Array.isArray(v)||v.length!==5||v.some((n:any)=>!Number.isFinite(n)||Math.abs(n)>8192))||mesh.indices.some((i:any)=>!Number.isInteger(i)||i<0||i>=mesh.vertices.length))return out({error:"Ungültige Mesh-Koordinaten"},400);
        }
        bytes=new TextEncoder().encode(JSON.stringify(bundle));filename=id+".json";contentType="application/json";
        if(bytes.length>12_000_000)return out({error:"Modellpaket maximal 12 MB"},413);
      }
      const behavior=category==="furniture"&&body.behavior==="interactive"?"interactive":"decoration";
      const previousResult=await rest(`/mpsq_assets?id=eq.${encodeURIComponent(id)}&select=path&limit=1`),previousRows=await previousResult.json();
      const previousPath=previousResult.ok?previousRows[0]?.path:null;
      const pathKey=`${category}/${id}/${crypto.randomUUID()}/${filename}`;
      const upload=await fetch(`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/mpsq-assets/${pathKey}`,{method:"POST",headers:{apikey:key(),Authorization:`Bearer ${key()}`,"Content-Type":contentType},body:bytes});
      if(!upload.ok)return out({error:"Upload fehlgeschlagen. ASSET_LIBRARY.sql ausführen und Storage prüfen."},502);
      const displayName=String(body.name??id).trim().slice(0,80)||id;
      const saved=await rest("/mpsq_assets?on_conflict=id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates"},body:JSON.stringify({id,kind,category,behavior,path:pathKey,filename,display_name:displayName,created_at:new Date().toISOString()})});
      if(!saved.ok)return out({error:"Datei gespeichert, Metadaten konnten nicht gespeichert werden"},500);
      if(kind==="model"&&category==="accessory"){
        const savedModel=await rest("/mpsq_accessories?on_conflict=accessory_key",{method:"POST",headers:{Prefer:"resolution=merge-duplicates"},body:JSON.stringify({accessory_key:id,model_id:id,display_name:String(body.name??id).slice(0,80)})});
        if(!savedModel.ok)return out({error:"Modell gespeichert, Accessoire konnte nicht angelegt werden"},500);
      }
      if(previousPath&&previousPath!==pathKey){const oldPath=String(previousPath).split("/").map(encodeURIComponent).join("/");await fetch(`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/mpsq-assets/${oldPath}`,{method:"DELETE",headers:{apikey:key(),Authorization:`Bearer ${key()}`}});}
      return out({ok:true,id,kind,category,behavior,url:`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/mpsq-assets/${pathKey}`},201);
    }    if (path === "/admin/redeem-codes" && req.method === "POST") {
      const body = await json(req); const code = String(body.code ?? "").trim().toUpperCase(); const modelId = String(body.modelId ?? "").trim();
      if (!code || !modelId) return out({ error: "Code und Modell-ID fehlen" }, 400);
      const accessories = await (await rest(`/mpsq_accessories?model_id=eq.${encodeURIComponent(modelId)}&select=id&limit=1`)).json();
      if (!accessories[0]) return out({ error: "Accessoire-Modell nicht gefunden" }, 404);
      const result = await rest("/mpsq_redeem_codes", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ code, accessory_id: accessories[0].id, max_uses: body.maxUses ?? null, expires_at: body.expiresAt ?? null }) });
      return out(await result.json(), result.ok ? 201 : result.status);
    }
    if (path === "/admin/rank-requests" && req.method === "GET") {
      await cleanupRankRecords();
      const rows = await (await rest("/mpsq_team_rank_requests?select=*&order=created_at.desc&limit=200")).json();
      const ids = [...new Set(rows.flatMap((row: any) => [row.requested_by, row.target_id, row.decided_by]).filter(Boolean))];
      const users = ids.length ? await (await rest(`/mpsq_clients?id=in.(${ids.join(",")})&select=id,display_name`)).json() : [];
      const names = new Map(users.map((row: any) => [row.id, row.display_name]));
      return out(rows.map((row: any) => ({ ...row, requester_name: names.get(row.requested_by) ?? "Unbekannt", target_name: names.get(row.target_id) ?? "Unbekannt", decided_by_name: names.get(row.decided_by) ?? null })));
    }
    if (path === "/admin/rank-log" && req.method === "GET") {
      await cleanupRankRecords();
      const rows = await (await rest("/mpsq_team_rank_log?select=*&order=created_at.desc&limit=200")).json();
      const ids = [...new Set(rows.flatMap((row: any) => [row.actor_id, row.target_id]).filter(Boolean))];
      const users = ids.length ? await (await rest(`/mpsq_clients?id=in.(${ids.join(",")})&select=id,display_name`)).json() : [];
      const names = new Map(users.map((row: any) => [row.id, row.display_name]));
      return out(rows.map((row: any) => ({ ...row, actor_name: names.get(row.actor_id) ?? "System", target_name: names.get(row.target_id) ?? "Unbekannt" })));
    }
    if (path.match(/^\/admin\/rank-requests\/[^/]+\/decision$/) && req.method === "POST") {
      const requestId = path.split("/")[3]; const body = await json(req); const approved = body.approved === true;
      const rows = await (await rest(`/mpsq_team_rank_requests?id=eq.${requestId}&status=eq.PENDING&select=*`)).json();
      const request = rows[0]; if (!request) return out({ error: "Rang-Antrag nicht gefunden oder bereits entschieden" }, 404);
      const root = await rootInfo();
      const before = await teamProfile(request.target_id);
      if (approved && (before.base_rank === "sr_offizier" || request.target_id === root.root_client_id)) {
        return out({ error: "Der Sr-Offizier kann nicht durch einen Rang-Antrag verändert werden" }, 403);
      }
      if (approved) {
        const update = { base_rank: request.requested_rank, active_rank: null, updated_at: new Date().toISOString() };
        const changed = await rest(`/mpsq_team_profiles?client_id=eq.${request.target_id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(update) });
        if (!changed.ok) return out({ error: await changed.text() }, changed.status);
        const [after] = await changed.json();
        await rest(`/mpsq_team_rank_requests?id=eq.${requestId}`, { method: "PATCH", body: JSON.stringify({ status: "APPROVED", decided_by: root.root_client_id, decided_at: new Date().toISOString() }) });
        await addRankLog(root.root_client_id ?? null, request.target_id, before, after ?? { ...before, ...update }, "APPROVED", requestId);
      } else {
        await rest(`/mpsq_team_rank_requests?id=eq.${requestId}`, { method: "PATCH", body: JSON.stringify({ status: "REJECTED", decided_by: root.root_client_id, decided_at: new Date().toISOString() }) });
        await addRankLog(root.root_client_id ?? null, request.target_id, before, before, "REJECTED", requestId);
      }
      return out({ ok: true, approved });
    }
    if (path === "/admin/root-candidates" && req.method === "GET") {
      const root = await rootInfo();
      const candidates = await (await rest(`/mpsq_clients?display_name=eq.${encodeURIComponent(root.root_display_name)}&select=id,display_name,created_at,last_seen_at&order=last_seen_at.desc`)).json();
      return out({ root, candidates });
    }
    if (path === "/admin/root-bind" && req.method === "POST") {
      const root = await rootInfo(); if (root.root_client_id) return out({ error: "Sr-Offizier ist bereits sicher gebunden" }, 409);
      const body = await json(req); const candidateId = String(body.clientId ?? "");
      const candidates = await (await rest(`/mpsq_clients?id=eq.${candidateId}&display_name=eq.${encodeURIComponent(root.root_display_name)}&select=id,display_name`)).json();
      if (!candidates[0]) return out({ error: "Kandidat gehört nicht zu MP_SquidGame" }, 400);
      const updatedRoot = await rest("/mpsq_team_root?id=eq.1&root_client_id=is.null", { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ root_client_id: candidateId, bound_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
      const rootRows = await updatedRoot.json(); if (!updatedRoot.ok || !rootRows[0]) return out({ error: "Root-Bindung konnte nicht gespeichert werden" }, 409);
      const before = await teamProfile(candidateId); const update = { base_rank: "sr_offizier", active_rank: null, updated_at: new Date().toISOString() };
      const profileUpdate = await rest(`/mpsq_team_profiles?client_id=eq.${candidateId}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(update) });
      const [after] = await profileUpdate.json();
      await addRankLog(candidateId, candidateId, before, after ?? { ...before, ...update }, "ROOT_BOUND");
      return out({ ok: true, root: rootRows[0] });
    }
    // Recovery endpoint: a bound root account cannot be permanently demoted
    // by an ordinary rank assignment in the client UI.
    if (path === "/admin/root-restore" && req.method === "POST") {
      const root = await rootInfo();
      if (!root.root_client_id) return out({ error: "Sr-Offizier ist noch nicht gebunden" }, 409);
      const before = await teamProfile(root.root_client_id);
      const update = { base_rank: "sr_offizier", active_rank: null, updated_at: new Date().toISOString() };
      const changed = await rest(`/mpsq_team_profiles?client_id=eq.${root.root_client_id}`, {
        method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(update)
      });
      if (!changed.ok) return out({ error: await changed.text() }, changed.status);
      const [after] = await changed.json();
      await addRankLog(root.root_client_id, root.root_client_id, before, after ?? { ...before, ...update }, "ROOT_BOUND");
      return out({ ok: true, root });
    }
    const clientId = await auth(req); if (!clientId) return out({ error: "Unauthorized" }, 401);
    await rest(`/mpsq_clients?id=eq.${clientId}`, { method: "PATCH", body: JSON.stringify({ last_seen_at: new Date().toISOString() }) });

    // MPSQ Team: public rank display plus private staff tools. All permission
    // decisions are made here, never trusted from the client UI.
    if(path==="/accessory-catalog" && req.method==="GET"){
      const assets=await(await rest("/mpsq_assets?kind=eq.model&category=eq.accessory&select=id,category,path,filename,display_name,created_at&order=created_at.desc&limit=500")).json();
      if(!Array.isArray(assets))return out({error:"Accessoirekatalog nicht verfügbar"},502);
      const defs=await(await rest("/mpsq_accessories?select=id,accessory_key,display_name,model_id,description,price_points&order=display_name.asc&limit=500")).json();
      const owned=await(await rest(`/mpsq_user_accessories?client_id=eq.${clientId}&select=accessory_id`)).json(),ownedIds=new Set(Array.isArray(owned)?owned.map((x:any)=>x.accessory_id):[]);
      return out(assets.map((a:any)=>{const d=defs.find((x:any)=>x.model_id===a.id);return {id:a.id,asset_id:a.id,accessory_id:d?.id??null,display_name:d?.display_name??a.display_name??a.id,description:d?.description??null,price_points:Number(d?.price_points??500),owned:ownedIds.has(d?.id),category:a.category,filename:a.filename,url:`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/mpsq-assets/${a.path}`};}));
    }
    if(path==="/models/catalog" && req.method==="GET"){
      const self=await teamProfile(clientId);if(level(permissionRank(self))<level("offizier"))return out({error:"Keine Berechtigung"},403);
      const r=await rest("/mpsq_assets?kind=in.(model,npc_skin)&category=in.(furniture,npc_model,npc_skin,npc_skin_normal,npc_skin_slim)&select=id,kind,category,behavior,path,filename,display_name,created_at&order=category.asc,created_at.desc&limit=1000");
      const assets=await r.json();if(!r.ok)return out({error:"Modellkatalog nicht verfügbar"},r.status);
      const defs=await(await rest("/mpsq_accessories?select=display_name,model_id&limit=1000")).json();
      return out(assets.map((a:any)=>({id:a.id,asset_id:a.id,kind:a.kind,category:a.category,behavior:a.behavior,filename:a.filename,name:defs.find((n:any)=>n.model_id===a.id)?.display_name??a.display_name??a.id,created_at:a.created_at,url:`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/mpsq-assets/${a.path}`})));
    }
    if(path==="/furniture/catalog" && req.method==="GET"){
      const r=await rest("/mpsq_assets?kind=eq.model&category=in.(furniture,shared)&select=id,path,display_name,filename&order=display_name.asc&limit=500");
      const assets=await r.json();if(!r.ok||!Array.isArray(assets))return out({error:"Möbelkatalog nicht verfügbar"},r.status||502);
      return out(assets.map((a:any)=>({id:a.id,name:a.display_name??a.filename??a.id,url:`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/mpsq-assets/${a.path}`})));
    }
    if(path.match(/^\/sounds\/[a-z0-9_-]{1,64}$/i)&&req.method==="GET"){
      const id=path.split("/")[2],kind=url.searchParams.get("type");if(!["mp3","mp4"].includes(kind??""))return out({error:"Audioformat ungültig"},400);
      const rows=await(await rest(`/mpsq_assets?id=eq.${encodeURIComponent(id)}&kind=eq.sound&category=eq.sound&select=id,filename,path&limit=1`)).json(),asset=rows[0];
      if(!asset?.path||!String(asset.filename??"").toLowerCase().endsWith(`.${kind}`))return out({error:"Sounddatei nicht gefunden oder falsches Format"},404);
      return out({id:asset.id,type:kind,url:`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/mpsq-assets/${asset.path}`});
    }
    if(path==="/npcs" && req.method==="GET"){
      const server=url.searchParams.get("server")??"",world=url.searchParams.get("world")??"";if(!server||!world)return out({error:"Welt fehlt"},400);
      const r=await rest(`/mpsq_world_npcs?server_id=eq.${encodeURIComponent(server.toLowerCase())}&world_id=eq.${encodeURIComponent(world)}&select=*,mpsq_assets(id,category,filename,display_name,path)&limit=500`);
      const rows=await r.json();if(!r.ok)return out({error:"NPCs nicht verfügbar; bitte die aktuelle Supabase-Migration ausführen."},r.status);
      const done=await(await rest(`/mpsq_tutorial_completions?client_id=eq.${clientId}&select=client_id&limit=1`)).json();const tutorialDone=Array.isArray(done)&&done.length>0;
      return out(rows.map((n:any)=>({...n,task_type:n.task_type??"none",tutorial_completed:n.task_type==="tutorial"&&tutorialDone,world_x:n.position_x??n.x+0.5,world_y:n.position_y??n.y,world_z:n.position_z??n.z+0.5,asset_id:n.model_id,category:n.mpsq_assets?.category,name:n.display_name??n.mpsq_assets?.display_name??n.mpsq_assets?.filename??n.model_id,url:n.mpsq_assets?.path?`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/mpsq-assets/${n.mpsq_assets.path}`:null})));
    }
    if(path==="/me/points" && req.method==="GET"){
      const rows=await(await rest(`/mpsq_point_accounts?client_id=eq.${clientId}&select=balance&limit=1`)).json();return out({points:Number(rows?.[0]?.balance??0),currency:"MPSQ-Punkte"});
    }
    if(path==="/me/points/grant" && req.method==="POST"){
      const self=await teamProfile(clientId);if(!canEditEvent(self))return out({error:"Keine Berechtigung"},403);const body=await json(req),amount=Number(body.amount);if(!Number.isInteger(amount)||amount<1||amount>10000)return out({error:"Punkte: 1–10000"},400);
      const r=await rest("/rpc/mpsq_grant_points",{method:"POST",body:JSON.stringify({p_client_id:clientId,p_amount:amount})}),result=await r.json();return out(r.ok?result:{error:result?.message??"Punkte konnten nicht gutgeschrieben werden"},r.ok?200:r.status);
    }
    if(path==="/me/accessories/buy" && req.method==="POST"){
      const body=await json(req);if(!/^[0-9a-f-]{36}$/i.test(String(body.accessoryId??"")))return out({error:"Accessoire ungültig"},400);
      const r=await rest("/rpc/mpsq_buy_accessory",{method:"POST",body:JSON.stringify({p_client_id:clientId,p_accessory_id:body.accessoryId})});const result=await r.json();return out(r.ok?result:{error:result?.message??"Kauf fehlgeschlagen"},r.status);
    }
    if(path==="/npcs" && req.method==="POST"){
      const self=await teamProfile(clientId);if(!canEditEvent(self))return out({error:"Keine Berechtigung"},403);const b=await json(req);
      if(!b.server||!b.world||![b.x,b.y,b.z].every((n:any)=>Number.isInteger(n)&&Math.abs(n)<=30000000))return out({error:"Server, Welt oder NPC-Koordinaten fehlen oder sind ungültig"},400);
      if(b.remove===true){const r=await rest(`/mpsq_world_npcs?server_id=eq.${encodeURIComponent(String(b.server).toLowerCase())}&world_id=eq.${encodeURIComponent(String(b.world))}&x=eq.${b.x}&y=eq.${b.y}&z=eq.${b.z}`,{method:"DELETE"});return out({ok:r.ok},r.ok?200:r.status);}
      if(!/^[a-z0-9_-]{1,64}$/.test(String(b.assetId??"")))return out({error:"Ungültige NPC-Modell-ID"},400);
      const asset=await(await rest(`/mpsq_assets?id=eq.${encodeURIComponent(b.assetId)}&kind=in.(model,npc_skin)&category=in.(npc_model,npc_skin_normal,npc_skin_slim)&select=id,kind,category`)).json();if(!asset[0])return out({error:"NPC-Modell oder Skin nicht gefunden oder nicht dem NPC-Bereich zugeordnet"},404);
      const displayName=String(b.name??asset[0].id).trim().slice(0,64)||String(asset[0].id);const scale=Number(b.scale??1),glow=String(b.glowColor??"none"),animation=String(b.animation??"none"),pages=b.interactionData?.pages??["Hallo!"],yaw=Number(b.yaw??0),pitch=Number(b.pitch??0),facePlayer=b.facePlayer===true,positionX=Number(b.positionX??(b.x+0.5)),positionY=Number(b.positionY??b.y),positionZ=Number(b.positionZ??(b.z+0.5));
      if(!Number.isFinite(scale)||scale<0.25||scale>3||!Number.isFinite(yaw)||Math.abs(yaw)>3600||!Number.isFinite(pitch)||pitch < -90||pitch > 90||![positionX,positionY,positionZ].every((n:any)=>Number.isFinite(n)&&Math.abs(n)<=30000000)||!NPC_GLOW_COLORS.includes(glow)||!NPC_ANIMATIONS.includes(animation)||!validNpcPages(pages))return out({error:"NPC-Eigenschaften ungültig"},400);
      const taskType=String(b.taskType??"none");if(!["none","accessories","tutorial","quest"].includes(taskType))return out({error:"NPC-Aufgabe ungültig"},400);
      const r=await rest("/mpsq_world_npcs?on_conflict=server_id,world_id,x,y,z,model_id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=representation"},body:JSON.stringify({server_id:String(b.server).toLowerCase(),world_id:String(b.world),x:b.x,y:b.y,z:b.z,position_x:positionX,position_y:positionY,position_z:positionZ,model_id:b.assetId,display_name:displayName,scale,glow_color:glow,animation,yaw:((yaw%360)+360)%360,pitch,face_player:facePlayer,task_type:taskType,interaction_data:{pages},created_by:clientId})});return out(r.ok?await r.json():{error:await r.text()},r.ok?201:r.status);
    }
    if(path.match(/^\/npcs\/[0-9a-f-]{36}\/tutorial-complete$/)&&req.method==="POST"){
      const body=await json(req),id=path.split("/")[2],server=String(body.server??"").trim().toLowerCase(),world=String(body.world??"").trim();if(!server||!world)return out({error:"Welt fehlt"},400);
      const rpc=await rest("/rpc/mpsq_complete_tutorial",{method:"POST",body:JSON.stringify({p_client_id:clientId,p_npc_id:id,p_server_id:server,p_world_id:world})});const result=await rpc.json();return out(rpc.ok?result:{error:result?.message??"Tutorial-Abschluss konnte nicht gespeichert werden."},rpc.status);
    }
    if(path.match(/^\/npcs\/[0-9a-f-]{36}\/quests$/)&&(req.method==="GET"||req.method==="POST")){
      const id=path.split("/")[2];
      if(req.method==="GET"){
        const server=(url.searchParams.get("server")??"").toLowerCase(),world=url.searchParams.get("world")??"";if(!server||!world)return out({error:"Welt fehlt"},400);
        const npc=await(await rest(`/mpsq_world_npcs?id=eq.${id}&server_id=eq.${encodeURIComponent(server)}&world_id=eq.${encodeURIComponent(world)}&select=id,task_type&limit=1`)).json();if(!npc[0]||npc[0].task_type!=="quest")return out({error:"Quest-NPC nicht gefunden"},404);
        const defs=await(await rest(`/mpsq_quests?npc_id=eq.${id}&enabled=eq.true&select=*&order=created_at.asc`)).json();if(!Array.isArray(defs))return out({error:"Quests nicht verfügbar"},502);
        const states=await(await rest(`/mpsq_user_quests?client_id=eq.${clientId}&select=quest_id,progress,claimed_at`)).json(),byId=new Map((Array.isArray(states)?states:[]).map((s:any)=>[s.quest_id,s]));
        return out(defs.map((q:any)=>{const s:any=byId.get(q.id);return {...q,progress:Number(s?.progress??0),accepted:!!s,claimed:!!s?.claimed_at};}));
      }
      const self=await teamProfile(clientId);if(!canEditEvent(self))return out({error:"Keine Berechtigung"},403);const b=await json(req),npcId=await(await rest(`/mpsq_world_npcs?id=eq.${id}&server_id=eq.${encodeURIComponent(String(b.server??"").toLowerCase())}&world_id=eq.${encodeURIComponent(String(b.world??""))}&select=id,task_type&limit=1`)).json();if(npcId[0]?.task_type!=="quest")return out({error:"Quest-NPC nicht gefunden"},404);
      if(b.action==="delete"&&/^[0-9a-f-]{36}$/i.test(String(b.questId??""))){const r=await rest(`/mpsq_quests?id=eq.${b.questId}&npc_id=eq.${id}`,{method:"DELETE"});return out({ok:r.ok},r.ok?200:r.status);}
      const title=String(b.title??"").trim(),icon=String(b.iconItem??"minecraft:paper"),item=String(b.objectiveItem??""),amount=Number(b.targetCount),points=Number(b.rewardPoints??0),reward=String(b.rewardAccessoryId??"");
      if(title.length<1||title.length>80||!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(icon)||!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(item)||!Number.isInteger(amount)||amount<1||amount>1000000||!Number.isInteger(points)||points<0||points>1000000||(points>0&&reward)||((points===0)&&! /^[0-9a-f-]{36}$/i.test(reward)))return out({error:"Quest-Daten ungültig"},400);
      const payload={npc_id:id,title,icon_item:icon,objective_item:item,target_count:amount,reward_points:points,reward_accessory_id:points>0?null:reward};let r:Response;
      if(/^[0-9a-f-]{36}$/i.test(String(b.questId??"")))r=await rest(`/mpsq_quests?id=eq.${b.questId}&npc_id=eq.${id}`,{method:"PATCH",headers:{Prefer:"return=representation"},body:JSON.stringify(payload)});
      else r=await rest("/mpsq_quests",{method:"POST",headers:{Prefer:"return=representation"},body:JSON.stringify(payload)});
      return out(r.ok?await r.json():{error:await r.text()},r.status);
    }
    if(path.match(/^\/quests\/[0-9a-f-]{36}\/(accept|progress|claim|decline)$/)&&req.method==="POST"){
      const [,questId,action]=path.match(/^\/quests\/([0-9a-f-]{36})\/(accept|progress|claim|decline)$/)!;const body=await json(req);let rpcPath:string,rpcBody:any;
      if(action==="accept"){rpcPath="mpsq_accept_quest";rpcBody={p_client_id:clientId,p_quest_id:questId};}
      else if(action==="progress"){const progress=Number(body.progress);if(!Number.isInteger(progress)||progress<0)return out({error:"Fortschritt ungültig"},400);rpcPath="mpsq_update_quest_progress";rpcBody={p_client_id:clientId,p_quest_id:questId,p_progress:progress};}
      else if(action==="decline") {const q=await(await rest(`/mpsq_quests?id=eq.${questId}&select=target_count&limit=1`)).json(),s=await(await rest(`/mpsq_user_quests?client_id=eq.${clientId}&quest_id=eq.${questId}&select=progress&limit=1`)).json();if(!q[0]||!s[0])return out({error:"Quest wurde nicht angenommen"},404);if(Number(s[0].progress)>=Number(q[0].target_count))return out({error:"Abgeschlossene Quests können nicht abgelehnt werden"},409);const r=await rest(`/mpsq_user_quests?client_id=eq.${clientId}&quest_id=eq.${questId}`,{method:"DELETE"});return out({declined:r.ok},r.ok?200:r.status);}
      else {rpcPath="mpsq_claim_quest";rpcBody={p_client_id:clientId,p_quest_id:questId};}
      const r=await rest(`/rpc/${rpcPath}`,{method:"POST",body:JSON.stringify(rpcBody)});const result=await r.json();return out(r.ok?result:{error:result?.message??"Quest-Aktion fehlgeschlagen"},r.status);
    }
    if(path.match(/^\/npcs\/[0-9a-f-]{36}$/)&&req.method==="PATCH"){
      const self=await teamProfile(clientId);if(!canEditEvent(self))return out({error:"Keine Berechtigung"},403);const b=await json(req);const name=String(b.name??"").trim(),scale=Number(b.scale),glow=String(b.glowColor??"none"),animation=String(b.animation??"none"),taskType=String(b.taskType??"none"),pages=b.interactionData?.pages,yaw=Number(b.yaw??0),pitch=Number(b.pitch??0),facePlayer=b.facePlayer===true;
      if(!name||name.length>64||!Number.isFinite(scale)||scale<0.25||scale>3||!Number.isFinite(yaw)||Math.abs(yaw)>3600||!Number.isFinite(pitch)||pitch < -90||pitch > 90||!NPC_GLOW_COLORS.includes(glow)||!NPC_ANIMATIONS.includes(animation)||!["none","accessories","tutorial","quest"].includes(taskType)||!validNpcPages(pages))return out({error:"NPC-Eigenschaften ungültig"},400);
      const id=path.split("/")[2],server=String(b.server??"").trim().toLowerCase(),world=String(b.world??"").trim();if(!server||server.length>255||!world||world.length>255)return out({error:"Welt fehlt"},400);
      const r=await rest(`/mpsq_world_npcs?id=eq.${id}&server_id=eq.${encodeURIComponent(server)}&world_id=eq.${encodeURIComponent(world)}`,{method:"PATCH",headers:{Prefer:"return=representation"},body:JSON.stringify({display_name:name,scale,glow_color:glow,animation,yaw:((yaw%360)+360)%360,pitch,face_player:facePlayer,task_type:taskType,interaction_data:{pages}})});return out(r.ok?await r.json():{error:await r.text()},r.status);
    }
    if(path==="/me/accessories/equip" && req.method==="POST"){
      const body=await json(req);
      if(body.id!==null&&!/^[0-9a-f-]{36}$/i.test(String(body.id)))return out({error:"Ungültiges Accessoire"},400);
      const root=await rootInfo();if(body.id!==null&&root.root_client_id===clientId)await rest("/mpsq_user_accessories?on_conflict=client_id,accessory_id",{method:"POST",headers:{Prefer:"resolution=ignore-duplicates"},body:JSON.stringify({client_id:clientId,accessory_id:body.id})});
      const r=await rest("/rpc/mpsq_equip_accessory",{method:"POST",body:JSON.stringify({p_client:clientId,p_accessory:body.id})});
      return out(r.ok?{ok:true}:{error:"Accessoire nicht freigeschaltet"},r.ok?200:403);
    }
    if(path==="/accessory-wearers" && req.method==="GET"){
      const r=await rest("/mpsq_user_accessories?equipped=eq.true&select=client_id,mpsq_accessories(model_id)");
      if(!r.ok)return out({error:"Accessoires nicht verfügbar"},r.status);
      const worn=await r.json();
      const ids=[...new Set(worn.map((w:any)=>w.client_id))];
      const users=ids.length?await(await rest(`/mpsq_clients?id=in.(${ids.join(",")})&select=id,display_name`)).json():[];
      const assets=await(await rest("/mpsq_assets?kind=eq.model&category=in.(accessory,shared)&select=id,path")).json();
      return out(worn.map((w:any)=>{
        const asset=assets.find((a:any)=>a.id===w.mpsq_accessories?.model_id);
        return {name:users.find((u:any)=>u.id===w.client_id)?.display_name,url:asset?`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/mpsq-assets/${asset.path}`:null};
      }).filter((w:any)=>w.name&&w.url));
    }
    if(path === "/actions" && req.method === "POST") {
      const self=await teamProfile(clientId); if(!canEditEvent(self))return out({error:"Keine Berechtigung"},403);
      const body=await json(req), type=String(body.actionType??""), data=body.actionData??{};
      if(!validAction(type,data))return out({error:"Ungültige Aktionsdaten"},400);
      const supported=["PLAY_AUDIO","START_PLAYLIST","STOP_AUDIO","SHOW_BOSSBAR","START_COUNTDOWN","HIDE_BOSSBAR","TOGGLE_AUDIO","TOGGLE_COUNTDOWN","TOGGLE_BOSSBAR","SEND_ANNOUNCEMENT","SHOW_DIALOGUE"];
      if(!supported.includes(type)||!body.serverId||!body.worldId||JSON.stringify(data).length>8192)return out({error:"Ungültige Aktion"},400);
      if(type==="START_COUNTDOWN"&&(!Number.isInteger(data.duration)||data.duration<1||data.duration>7200))return out({error:"Ungültige Dauer"},400);
      if(["START_COUNTDOWN","SHOW_BOSSBAR"].includes(type)&&typeof data.title!=="string")return out({error:"Titel fehlt"},400);
      if(type==="SEND_ANNOUNCEMENT"&&typeof data.text!=="string")return out({error:"Text fehlt"},400);
      if(type==="PLAY_AUDIO"&&typeof data.sound!=="string")return out({error:"Sound fehlt"},400);
      if(type==="START_PLAYLIST"&&(!Array.isArray(data.tracks)||data.tracks.length>100||data.tracks.some((x:any)=>typeof x!=="string")))return out({error:"Playlist ungültig"},400);
      const r=await rest("/rpc/mpsq_publish_action",{method:"POST",body:JSON.stringify({p_actor:clientId,p_server:String(body.serverId).toLowerCase(),p_world:String(body.worldId),p_type:type,p_data:data})});
      return out(await r.json(),r.status);
    }
    if(path==="/objects"&&req.method==="GET"){
      const server=url.searchParams.get("server")??"",world=url.searchParams.get("world")??"";
      if(!server||!world)return out({error:"Welt fehlt"},400);
      const r=await rest(`/mpsq_world_objects?server_id=eq.${encodeURIComponent(server)}&world_id=eq.${encodeURIComponent(world)}&select=*,mpsq_assets(path,display_name,filename,category)&limit=500`);
      const rows=await r.json();if(!r.ok)return out({error:"Objekte nicht verfügbar"},r.status);
      return out(rows.map((o:any)=>({...o,name:o.mpsq_assets?.display_name??o.mpsq_assets?.filename??o.model_id,category:o.mpsq_assets?.category,url:`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/mpsq-assets/${o.mpsq_assets.path}`})));
    }
    if(path==="/objects"&&req.method==="POST"){
      const self=await teamProfile(clientId);if(!canEditEvent(self))return out({error:"Keine Berechtigung"},403);
      const b=await json(req);
      if(!b.server||!b.world||![b.x,b.y,b.z].every(n=>Number.isInteger(n)&&Math.abs(n)<=30000000))return out({error:"Position ungültig"},400);
      if(b.remove===true){const r=await rest(`/mpsq_world_objects?server_id=eq.${encodeURIComponent(String(b.server).toLowerCase())}&world_id=eq.${encodeURIComponent(b.world)}&x=eq.${b.x}&y=eq.${b.y}&z=eq.${b.z}`,{method:"DELETE"});return out({ok:r.ok},r.ok?200:r.status);}
      if(!/^[a-z0-9_-]{1,64}$/.test(b.modelId)||![0,90,180,270].includes(b.rotation))return out({error:"Modell oder Drehung ungültig"},400);
      const assets=await(await rest(`/mpsq_assets?id=eq.${b.modelId}&kind=eq.model&category=in.(furniture,shared)&select=id`)).json();if(!assets[0])return out({error:"Möbelmodell nicht gefunden oder nicht dem Möbelbereich zugeordnet"},404);
      const r=await rest("/mpsq_world_objects?on_conflict=server_id,world_id,x,y,z",{method:"POST",headers:{Prefer:"resolution=merge-duplicates"},body:JSON.stringify({server_id:String(b.server).toLowerCase(),world_id:b.world,x:b.x,y:b.y,z:b.z,model_id:b.modelId,rotation:b.rotation,created_by:clientId})});return out({ok:r.ok},r.ok?200:r.status);
    }
    if(path === "/calendar" && req.method === "GET") {
      const self=await teamProfile(clientId);if(!teamAllowed(self))return out({error:"Keine Berechtigung"},403);
      const r=await rest("/mpsq_calendar?order=starts_at.asc&limit=200");return out(await r.json(),r.status);
    }
    if(path === "/calendar" && req.method === "POST") {
      const self=await teamProfile(clientId);if(!canEditEvent(self))return out({error:"Keine Berechtigung"},403);
      const body=await json(req),title=String(body.title??"").trim(),date=Date.parse(body.startsAt);
      if(!title||title.length>120||!Number.isFinite(date))return out({error:"Titel oder Datum ungültig"},400);
      const r=await rest("/mpsq_calendar",{method:"POST",body:JSON.stringify({title,starts_at:new Date(date).toISOString(),description:String(body.description??"").slice(0,1000),created_by:clientId})});
      return out({ok:r.ok},r.status);
    }
    if(/^\/calendar\/[0-9a-f-]{36}$/.test(path)&&req.method==="DELETE"){
      const self=await teamProfile(clientId);if(!canEditEvent(self))return out({error:"Keine Berechtigung"},403);
      const r=await rest(`/mpsq_calendar?id=eq.${path.split("/")[2]}`,{method:"DELETE"});return out({ok:r.ok},r.status);
    }
    if (path === "/me/accessories" && req.method === "GET") {
      const root=await rootInfo();
      if(root.root_client_id===clientId){
        const [all,owned]=await Promise.all([rest("/mpsq_accessories?select=id,accessory_key,display_name,model_id,description&order=display_name.asc&limit=1000"),rest(`/mpsq_user_accessories?client_id=eq.${clientId}&select=accessory_id,equipped,granted_at`)]);
        const defs=await all.json(),mine=await owned.json();if(!Array.isArray(defs)||!Array.isArray(mine))return out({error:"Accessoires konnten nicht geladen werden"},502);
        const assets=await(await rest("/mpsq_assets?kind=eq.model&category=eq.accessory&select=id,path&limit=1000")).json(),urls=new Map((Array.isArray(assets)?assets:[]).map((a:any)=>[a.id,`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/mpsq-assets/${a.path}`]));
        return out(defs.map((a:any)=>{const record=mine.find((x:any)=>x.accessory_id===a.id);return {accessory_id:a.id,equipped:record?.equipped??false,granted_at:record?.granted_at??null,url:urls.get(a.model_id)??null,mpsq_accessories:a};}));
      }
      const result = await rest(`/mpsq_user_accessories?client_id=eq.${clientId}&select=accessory_id,equipped,granted_at,mpsq_accessories(accessory_key,display_name,model_id,description)&order=granted_at.desc`);
      const rows=await result.json();if(!Array.isArray(rows))return out(rows,result.status);
      const assets=await(await rest("/mpsq_assets?kind=eq.model&category=eq.accessory&select=id,path&limit=1000")).json(),urls=new Map((Array.isArray(assets)?assets:[]).map((a:any)=>[a.id,`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/mpsq-assets/${a.path}`]));
      return out(rows.map((r:any)=>({...r,url:urls.get(r.mpsq_accessories?.model_id)??null})),result.status);
    }
    if (path === "/playlists" && req.method === "GET") {
      const result = await rest("/mpsq_playlists?enabled=eq.true&select=id,name,tracks&order=name.asc");
      return out(await result.json(), result.status);
    }
    if (path === "/bossbars" && req.method === "GET") {
      const result = await rest("/mpsq_bossbars?visible=eq.true&select=id,title,color,value,visible");
      return out(await result.json(), result.status);
    }

    if (path === "/redeem" && req.method === "POST") {
      const body = await json(req); const code = String(body.code ?? "").trim().toUpperCase();
      if (!code || code.length > 64) return out({ error: "Code fehlt" }, 400);
      const response = await rest("/rpc/mpsq_redeem", {method:"POST",body:JSON.stringify({p_client:clientId,p_code:code})});
      const result=await response.json();
      return out(result,response.ok ? (result.error ? 409 : 200) : response.status);
    }
    if (path === "/action-events" && req.method === "GET") {
      const server = url.searchParams.get("server") ?? "";
      const world = url.searchParams.get("world") ?? "";
      const after = url.searchParams.get("after");
      if (!server || !world || (after !== null && !/^[0-9]{1,18}$/.test(after))) return out({error:"Ungültiger Ereignisfilter"},400);
      const scope = "server_id=eq."+encodeURIComponent(server)+"&world_id=eq."+encodeURIComponent(world);
      const query = after === null ? "&order=id.desc&limit=1" : "&id=gt."+after+"&order=id.asc&limit=100";
      const result = await rest("/mpsq_action_events?"+scope+query);
      const rows = await result.json();
      if (!result.ok) return out(rows,result.status);
      return out({events:after === null ? [] : rows,cursor:rows.length ? String(rows[rows.length-1].id) : (after ?? "0")});
    }
    // Shared world triggers. The server registry is authoritative; clients do
    // not decide locally whether a block has a Mod action attached to it.
    if (path === "/triggers" && req.method === "GET") {
      const result = await rest("/mpsq_action_triggers?enabled=eq.true&server_id=eq."+encodeURIComponent(url.searchParams.get("server") ?? "")+"&select=*&order=updated_at.asc");
      return out(await result.json(), result.status);
    }
    if (path === "/triggers" && req.method === "POST") {
      const self = await teamProfile(clientId); if (!canEditEvent(self)) return out({ error: "Forbidden" }, 403);
      const body = await json(req); const worldId = String(body.worldId ?? "").trim();
      const actionType = String(body.actionType ?? "").trim().toUpperCase(); const blockId = String(body.blockId ?? "").trim();
      const pos = body.position ?? {};
      if(!validAction(actionType,body.actionData??{}))return out({error:"Ungültige Aktionsdaten"},400);
      const supported = ["PLAY_AUDIO","START_PLAYLIST","STOP_AUDIO","SHOW_BOSSBAR","START_COUNTDOWN","HIDE_BOSSBAR","TOGGLE_AUDIO","TOGGLE_COUNTDOWN","TOGGLE_BOSSBAR","SEND_ANNOUNCEMENT","SHOW_DIALOGUE","OPEN_REDEEM","OPEN_LINK"];
      if (!supported.includes(actionType) || !String(body.serverId ?? "").trim()) return out({error:"Aktion oder Server ungültig"},400);
      if (!validRank(String(body.minimumRank ?? "offizier"))) return out({error:"Ungültiger Mindestrang"},400);
      if (JSON.stringify(body.actionData ?? {}).length > 8192) return out({error:"Aktionsdaten zu groß"},400);
      if (actionType === "START_COUNTDOWN" && (!Number.isInteger(body.actionData?.duration) || body.actionData.duration<1 || body.actionData.duration>7200)) return out({error:"Dauer: 1–7200 Sekunden"},400);
      if (!worldId || !blockId || !actionType || !Number.isInteger(pos.x) || !Number.isInteger(pos.y) || !Number.isInteger(pos.z)) return out({ error: "Welt, Block und Position sind erforderlich" }, 400);
      if(actionType==="OPEN_LINK" && !/^https:\/\//i.test(String(body.actionData?.url??"")))return out({error:"HTTPS-Link erforderlich"},400);
      const row = { server_id: String(body.serverId ?? "").trim().toLowerCase(), world_id: worldId, pos_x: pos.x, pos_y: pos.y, pos_z: pos.z, block_id: blockId, object_type: String(body.objectType ?? "TRIGGER"), action_type: actionType, action_data: body.actionData ?? {}, minimum_rank: String(body.minimumRank ?? "offizier"), created_by: clientId, updated_at: new Date().toISOString() };
      const result = await rest("/mpsq_action_triggers?on_conflict=server_id,world_id,pos_x,pos_y,pos_z", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(row) });
      return out(await result.json(), result.ok ? 201 : result.status);
    }
    if (path.match(/^\/triggers\/[^/]+\/fire$/) && req.method === "POST") {
      const triggerId = path.split("/")[2]; const triggerRows = await (await rest(`/mpsq_action_triggers?id=eq.${triggerId}&enabled=eq.true&select=*`)).json();
      const trigger = triggerRows[0]; if (!trigger) return out({ error: "Trigger nicht gefunden" }, 404);
      const self = await teamProfile(clientId); if (!validRank(trigger.minimum_rank) || level(permissionRank(self)) < level(trigger.minimum_rank)) return out({ error: "Keine Berechtigung" }, 403);
      const body = await json(req);
      const result = await rest("/rpc/mpsq_fire_action", { method: "POST", body: JSON.stringify({
        p_trigger: trigger.id, p_actor: clientId, p_server: String(body.serverId ?? "").toLowerCase(), p_world: String(body.worldId ?? "")
      }) });
      return out(await result.json(), result.status);
    }

    // MPSQ Team: public rank display plus private staff tools. All permission
    // decisions are made here, never trusted from the client UI.
    if (path === "/team/rank-log" && req.method === "GET") {
      const self = await teamProfile(clientId);
      if (level(self.base_rank) < level("offizier")) return out({ error: "Keine Berechtigung" }, 403);
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (!Number.isSafeInteger(offset) || offset < 0) return out({error:"Ungültige Seite"},400);
      const response = await rest(`/mpsq_team_rank_log?select=*&order=created_at.desc,id.desc&limit=100&offset=${offset}`);
      if (!response.ok) return out({error:"Logs konnten nicht geladen werden"},response.status);
      const records = (await response.json()).filter((r:any) => r.actor_id !== r.target_id && r.old_base_rank !== r.new_base_rank);
      const ids = [...new Set(records.flatMap((r:any)=>[r.actor_id,r.target_id]).filter(Boolean))];
      const people = ids.length ? await (await rest(`/mpsq_clients?id=in.(${ids.join(",")})&select=id,display_name`)).json() : [];
      const names = new Map(people.map((p:any)=>[p.id,p.display_name]));
      return out(records.map((r:any)=>({...r,target_name:r.target_name??names.get(r.target_id)??"Unbekannt",actor_name:r.actor_name??names.get(r.actor_id)??"Administration"})));
    }
    if (path === "/team/me" && req.method === "GET") return out(await teamIdentity(clientId));
    if (path === "/team/me/name-visibility" && req.method === "POST") {
      const body = await json(req);
      if (typeof body.visible !== "boolean") return out({ error: "visible muss true oder false sein" }, 400);
      const result = await rest(`/mpsq_team_profiles?client_id=eq.${clientId}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ name_visible: body.visible, updated_at: new Date().toISOString() })
      });
      const rows = await result.json();
      return out(rows[0] ?? { name_visible: body.visible }, result.ok ? 200 : result.status);
    }
    if (path === "/team/members" && req.method === "GET") {
      const profiles = await (await rest("/mpsq_team_profiles?select=client_id,base_rank,active_rank,name_visible")).json();
      const clients = await (await rest("/mpsq_clients?select=id,display_name&order=display_name.asc")).json();
      const names = new Map(clients.map((row: any) => [row.id, row.display_name]));
      // The rank page is also a read-only overview for Spieler and VIPs.
      // It never exposes controls; only the authenticated write routes below
      // can alter a profile.
      const unique = new Map<string, any>();
      for (const p of profiles) {
        const member = { id: p.client_id, display_name: names.get(p.client_id) ?? "Minecraft Spieler", base_rank: p.base_rank, active_rank: p.active_rank, name_visible: p.name_visible !== false };
        const identity = member.display_name.trim().toLocaleLowerCase();
        const current = unique.get(identity);
        const strength = member.base_rank === "sr_offizier" ? Number.MAX_SAFE_INTEGER : level(member.active_rank ?? member.base_rank);
        const currentStrength = !current ? -1 : current.base_rank === "sr_offizier" ? Number.MAX_SAFE_INTEGER : level(current.active_rank ?? current.base_rank);
        if (!current || strength > currentStrength) unique.set(identity, member);
      }
      return out([...unique.values()]);
    }
    if (path.match(/^\/team\/members\/[^/]+\/rank$/) && req.method === "POST") {
      const memberId = path.split("/")[3]; const body = await json(req); const requested = String(body.rank ?? "");
      const self = await teamProfile(clientId); const target = await teamProfile(memberId);
      if (!validRank(requested) || requested === "sr_offizier") return out({ error: "Dieser Rang kann nicht vergeben werden" }, 403);
      const root = await rootInfo();
      if (target.base_rank === "sr_offizier" || memberId === root.root_client_id) return out({ error: "Der Sr-Offizier kann nicht verändert werden" }, 403);
      const ownRank = permissionRank(self);
      const affectsLeadership = requested === "offizier" || requested === "frontman"
        || target.base_rank === "offizier" || target.base_rank === "frontman";
      // The bound Sr Offizier is the root administrator and may apply a
      // leadership change immediately. Everybody else still has to use the
      // reviewable rank-request flow below.
      if (affectsLeadership && ownRank !== "sr_offizier") return out({ error: "Leadership changes require approval" }, 403);
      // 001 is a personal, temporary event rank. It may be toggled only by
      // the member itself and only if its real base rank is staff level or
      // higher. Never trust the client-side rank button for this decision.
      const self001 = memberId === clientId
        && ["arbeiter", "soldat", "offizier", "frontman"].includes(self.base_rank ?? "")
        && requested === "001";
      const senior001 = ownRank === "sr_offizier" && requested === "001";
      const mayAssign = ownRank === "sr_offizier"
        || ((ownRank === "offizier" || ownRank === "frontman") && level(target.base_rank) <= level("arbeiter"));
      if (requested === "001" && !self001 && !senior001) return out({ error: "001 darf nur an sich selbst vergeben werden" }, 403);
      if (!self001 && !mayAssign) return out({ error: "No permission for this rank change" }, 403);
      const update = requested === "001" ? { active_rank: "001" } : { base_rank: requested, active_rank: null, updated_at: new Date().toISOString() };
      const result = await rest(`/mpsq_team_profiles?client_id=eq.${memberId}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(update) });
      const rows = await result.json();
      if (result.ok) await addRankLog(clientId, memberId, target, rows[0] ?? { ...target, ...update }, requested === "001" ? "EVENT_001" : "DIRECT_CHANGE");
      return out(rows, result.ok ? 200 : result.status);
    }
    if (path.match(/^\/team\/members\/[^/]+\/event-rank$/) && req.method === "POST") {
      const memberId = path.split("/")[3]; const body = await json(req); const requested = String(body.rank ?? "");
      const self = await teamProfile(clientId); const target = await teamProfile(memberId); const root = await rootInfo();
      if (!validRank(requested) || requested === "sr_offizier") return out({ error: "Invalid temporary rank" }, 400);

      // A root user's temporary role never replaces their protected base rank.
      const seniorSelf = memberId === clientId
        && self.base_rank === "sr_offizier"
        && memberId === root.root_client_id;
      const self001 = memberId === clientId
        && ["arbeiter", "soldat", "offizier", "frontman"].includes(self.base_rank ?? "")
        && requested === "001";
      const senior001ForOther = self.base_rank === "sr_offizier"
        && requested === "001"
        && memberId !== root.root_client_id;
      if (!seniorSelf && !self001 && !senior001ForOther) return out({ error: "No permission for this temporary rank" }, 403);
      if (target.base_rank === "sr_offizier" && !seniorSelf) return out({ error: "The Sr Officer cannot be changed" }, 403);

      const update = { active_rank: requested, updated_at: new Date().toISOString() };
      const result = await rest(`/mpsq_team_profiles?client_id=eq.${memberId}`, {
        method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(update)
      });
      const rows = await result.json();
      if (result.ok) await addRankLog(clientId, memberId, target, rows[0] ?? { ...target, ...update }, "TEMPORARY_ROLE");
      return out(rows, result.ok ? 200 : result.status);
    }
    if (path.match(/^\/team\/members\/[^/]+\/event-rank$/) && req.method === "DELETE") {
      const memberId = path.split("/")[3]; const self = await teamProfile(clientId); const target = await teamProfile(memberId);
      const root = await rootInfo();
      const seniorSelf = memberId === clientId
        && self.base_rank === "sr_offizier"
        && memberId === root.root_client_id;
      if ((target.base_rank === "sr_offizier" || memberId === root.root_client_id) && !seniorSelf) return out({ error: "Der Sr-Offizier kann nicht verändert werden" }, 403);
      if (!target.active_rank) return out({ error: "Kein temporärer Rang aktiv" }, 400);
      const selfMayClear = memberId === clientId && ["arbeiter", "soldat", "offizier", "frontman"].includes(self.base_rank ?? "");
      const seniorMayClear = self.base_rank === "sr_offizier" && target.active_rank === "001";
      if (!seniorSelf && !selfMayClear && !seniorMayClear) return out({ error: "Keine Berechtigung zum Entfernen des temporären Rangs" }, 403);
      const update = { active_rank: null, updated_at: new Date().toISOString() };
      const changed = await rest(`/mpsq_team_profiles?client_id=eq.${memberId}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(update) });
      const rows = await changed.json();
      if (changed.ok) await addRankLog(clientId, memberId, target, rows[0] ?? { ...target, ...update }, "TEMPORARY_ROLE_REMOVED");
      return out(rows, changed.ok ? 200 : changed.status);
    }
    if (path === "/team/rank-requests" && req.method === "POST") {
      const self = await teamProfile(clientId); const body = await json(req);
      const targetId = String(body.targetId ?? ""); const requested = String(body.rank ?? "");
      if (!targetId || !approvalRanks.includes(requested)) return out({ error: "Ungültiger Rang-Antrag" }, 400);
      const target = await teamProfile(targetId); const ownRank = permissionRank(self);
      const root = await rootInfo();
      if (target.base_rank === "sr_offizier" || targetId === root.root_client_id) {
        return out({ error: "Der Sr-Offizier kann nicht durch einen Rang-Antrag verändert werden" }, 403);
      }
      const canRequest = ownRank === "sr_offizier"
        || ((ownRank === "offizier" || ownRank === "frontman") && approvalRanks.slice(0, 5).includes(requested) && level(target.base_rank) <= level("arbeiter"));
      if (!canRequest) return out({ error: "Keine Berechtigung für diesen Rang-Antrag" }, 403);
      if (targetId === clientId && ownRank !== "sr_offizier") return out({ error: "Eigene Beförderung ist nicht erlaubt" }, 403);
      const result = await rest("/mpsq_team_rank_requests", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ requested_by: clientId, target_id: targetId, requested_rank: requested, previous_base_rank: target.base_rank, note: String(body.note ?? "").trim().slice(0, 256) }) });
      return out(await result.json(), result.ok ? 201 : result.status);
    }
    if (path === "/team/me/event-rank" && req.method === "DELETE") {
      const self = await teamProfile(clientId); if (self.active_rank !== "001") return out({ error: "Kein 001-Eventrang aktiv" }, 400);
      const result = await rest(`/mpsq_team_profiles?client_id=eq.${clientId}`, { method: "PATCH", body: JSON.stringify({ active_rank: null }) });
      return out({ ok: result.ok }, result.ok ? 200 : result.status);
    }
    if (path === "/team/chat" && req.method === "GET") {
      const self = await teamProfile(clientId);
      const publicViewer = ["spieler", "vip"].includes(self.base_rank ?? "spieler");
      if (!teamAllowed(self) && !publicViewer) return out({ error: "Forbidden" }, 403);
      const rows = await (await rest("/mpsq_team_messages?select=id,sender_id,message,created_at&order=created_at.desc&limit=100")).json();
      const messages = [];
      for (const row of rows.reverse()) {
        if (publicViewer && !String(row.message).match(/.+ wurde disqualifiziert\.$/i)) continue;
        const sender = await teamIdentity(row.sender_id);
        messages.push({ id: row.id, sender_name: sender.display_name, sender_rank: shownRank(sender), message: row.message, created_at: row.created_at });
      }
      return out(messages);
    }
    if (path === "/team/chat" && req.method === "POST") {
      const self = await teamProfile(clientId); const body = await json(req); const message = String(body.message ?? "").trim().slice(0, 256);
      if (!teamAllowed(self)) return out({ error: "Forbidden" }, 403); if (!message) return out({ error: "Nachricht fehlt" }, 400);
      if (containsForbiddenChatContent(message)) return out({ error: "FILTERED" }, 422);
      const result = await rest("/mpsq_team_messages", { method: "POST", body: JSON.stringify({ sender_id: clientId, message }) });
      return out({ ok: result.ok }, result.ok ? 201 : result.status);
    }
    if (path === "/team/todos" && req.method === "GET") {
      const self = await teamProfile(clientId); if (!teamAllowed(self)) return out({ error: "Forbidden" }, 403);
      const result = await rest("/mpsq_team_todos?select=id,text,list_key,created_at&order=created_at.asc"); return out(await result.json(), result.status);
    }
    if (path === "/team/todos" && req.method === "POST") {
      const self = await teamProfile(clientId); const body = await json(req); const text = String(body.text ?? "").slice(0, 512); const listKey = String(body.listKey ?? "arbeiter");
      if (!canEditTodo(self)) return out({ error: "Forbidden" }, 403); if (!text) return out({ error: "Aufgabe fehlt" }, 400);
      if (!["arbeiter", "soldat", "offizier", "frontman"].includes(listKey)) return out({ error: "Ungültige To-do-Liste" }, 400);
      const result = await rest("/mpsq_team_todos", { method: "POST", body: JSON.stringify({ text, list_key: listKey, created_by: clientId }) }); return out({ ok: result.ok }, result.ok ? 201 : result.status);
    }
    if (path.match(/^\/team\/todos\/[^/]+$/) && req.method === "PATCH") {
      const self = await teamProfile(clientId); const body = await json(req); const text = String(body.text ?? "").slice(0, 512); const listKey = String(body.listKey ?? "");
      if (!canEditTodo(self)) return out({ error: "Forbidden" }, 403); if (!text || !["arbeiter", "soldat", "offizier", "frontman"].includes(listKey)) return out({ error: "Ungültige To-do-Aufgabe" }, 400);
      const result = await rest(`/mpsq_team_todos?id=eq.${path.split("/")[3]}`, { method: "PATCH", body: JSON.stringify({ text, list_key: listKey }) }); return out({ ok: result.ok }, result.ok ? 200 : result.status);
    }
    if (path.match(/^\/team\/todos\/[^/]+$/) && req.method === "DELETE") {
      const self = await teamProfile(clientId); if (!canEditTodo(self)) return out({ error: "Forbidden" }, 403);
      const result = await rest(`/mpsq_team_todos?id=eq.${path.split("/")[3]}`, { method: "DELETE" }); return out({ ok: result.ok }, result.ok ? 200 : result.status);
    }
    if (path === "/team/timer" && req.method === "GET") {
      const self = await teamProfile(clientId); if (!teamAllowed(self)) return out({ error: "Forbidden" }, 403);
      const rows = await (await rest("/mpsq_team_timer?id=eq.1&select=running,ends_at,label")).json(); return out(rows[0] ?? { running: false, ends_at: null, label: "" });
    }
    if (path === "/team/timer" && req.method === "POST") {
      const self = await teamProfile(clientId); const body = await json(req); if (!canEditEvent(self)) return out({ error: "Forbidden" }, 403);
      const seconds = Math.max(0, Math.min(86400, Number(body.durationSeconds ?? 0))); const running = body.running === true && seconds > 0;
      const endsAt = running ? new Date(Date.now() + seconds * 1000).toISOString() : null;
      const result = await rest("/mpsq_team_timer?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ id: 1, running, ends_at: endsAt, label: String(body.label ?? "").trim().slice(0, 96), updated_by: clientId }) }); return out({ ok: result.ok }, result.ok ? 200 : result.status);
    }
    if (path === "/team/templates" && req.method === "GET") {
      const self = await teamProfile(clientId); if (!canUseTexts(self)) return out({ error: "Forbidden" }, 403);
      const result = await rest("/mpsq_team_templates?select=id,text,speaker_role,sound_id,created_at&order=created_at.asc");
      const rows = await result.json();
      return out(Array.isArray(rows) ? rows.map((row: any) => ({ ...row, speaker: row.speaker_role ?? "offizier" })) : rows, result.status);
    }
    if (path === "/team/templates" && req.method === "POST") {
      const self = await teamProfile(clientId); const body = await json(req); const text = String(body.text ?? "").slice(0, 512);
      const speakerRole = String(body.speaker ?? body.speakerRole ?? "offizier");
      if (!canUseTexts(self)) return out({ error: "Forbidden" }, 403); if (!text || !["offizier", "frontman"].includes(speakerRole)) return out({ error: "Ungültiger Text" }, 400);
      const result = await rest("/mpsq_team_templates", { method: "POST", body: JSON.stringify({ text, sound_id: String(body.soundId??"").slice(0,128)||null, speaker_role: speakerRole, created_by: clientId }) }); return out({ ok: result.ok }, result.ok ? 201 : result.status);
    }
    if (path.match(/^\/team\/templates\/[^/]+$/) && req.method === "PATCH") {
      const self = await teamProfile(clientId); const body = await json(req); const text = String(body.text ?? "").slice(0, 512); const speakerRole = String(body.speaker ?? body.speakerRole ?? "");
      if (!canUseTexts(self)) return out({ error: "Forbidden" }, 403); if (!text || !["offizier", "frontman"].includes(speakerRole)) return out({ error: "Ungültiger Text" }, 400);
      const result = await rest(`/mpsq_team_templates?id=eq.${path.split("/")[3]}`, { method: "PATCH", body: JSON.stringify({ text, sound_id: String(body.soundId??"").slice(0,128)||null, speaker_role: speakerRole }) }); return out({ ok: result.ok }, result.ok ? 200 : result.status);
    }
    if (path.match(/^\/team\/templates\/[^/]+$/) && req.method === "DELETE") {
      const self = await teamProfile(clientId); if (!canUseTexts(self)) return out({ error: "Forbidden" }, 403);
      const result = await rest(`/mpsq_team_templates?id=eq.${path.split("/")[3]}`, { method: "DELETE" }); return out({ ok: result.ok }, result.ok ? 200 : result.status);
    }
    if (path === "/kick-animation" && req.method === "POST") {
      const self=await teamProfile(clientId); const body=await json(req); const name=String(body.displayName??"").trim().slice(0,32);
      const server=String(body.serverId??"").trim().toLowerCase(),world=String(body.worldId??"").trim();
      if(!teamAllowed(self)||!name||!server||server.length>255||!world||world.length>255)return out({error:"Forbidden"},403);
      const event=await rest("/mpsq_action_events",{method:"POST",body:JSON.stringify({trigger_id:null,server_id:server,world_id:world,actor_id:clientId,action_type:"KICK_ANIMATION",action_data:{targetName:name}})});
      return out(event.ok?{ok:true}:{error:"Animation konnte nicht verteilt werden"},event.ok?202:event.status);
    }
    if (path === "/team/disqualify" && req.method === "POST") {
      const self = await teamProfile(clientId); const body = await json(req); const name = String(body.displayName ?? "").trim().slice(0, 32);
      if (!teamAllowed(self) || !name) return out({ error: "Forbidden" }, 403);
      const targets = await (await rest(`/mpsq_clients?display_name=eq.${encodeURIComponent(name)}&select=id&limit=2`)).json(); if (targets.length !== 1) return out({ error: "Spieler nicht gefunden" }, 404);
      const before = await teamProfile(targets[0].id);
      await rest(`/mpsq_team_profiles?client_id=eq.${targets[0].id}`, { method: "PATCH", body: JSON.stringify({ active_rank: "vip" }) });
      await addRankLog(clientId, targets[0].id, before, { ...before, active_rank: "vip" }, "AUTO_VIP");
      await rest("/mpsq_team_messages", { method: "POST", body: JSON.stringify({ sender_id: clientId, message: `${name} wurde disqualifiziert.` }) });
      return out({ ok: true });
    }
    if (path === "/team/camera-events" && req.method === "GET") {
      const self = await teamProfile(clientId); if (!teamAllowed(self)) return out({ error: "Forbidden" }, 403);
      const after = encodeURIComponent(new Date(Date.now() - 15_000).toISOString());
      const rows = await (await rest(`/mpsq_team_camera_presence?updated_at=gt.${after}&select=camera_id,viewer_id,updated_at`)).json();
      const cameraIds = [...new Set(rows.map((row: any) => row.camera_id))];
      const viewerIds = [...new Set(rows.map((row: any) => row.viewer_id))];
      const cameras = cameraIds.length ? await (await rest(`/mpsq_cameras?id=in.(${cameraIds.join(",")})&select=id,name`)).json() : [];
      const viewers = viewerIds.length ? await (await rest(`/mpsq_clients?id=in.(${viewerIds.join(",")})&select=id,display_name`)).json() : [];
      const cameraNames = new Map(cameras.map((row: any) => [row.id, row.name]));
      const viewerNames = new Map(viewers.map((row: any) => [row.id, row.display_name]));
      return out(rows.map((row: any) => ({ camera_id: row.camera_id, camera_name: cameraNames.get(row.camera_id) ?? "Kamera", viewer_name: viewerNames.get(row.viewer_id) ?? "Unbekannt" })));
    }
    if (path === "/team/camera-events" && req.method === "POST") {
      const self = await teamProfile(clientId); const body = await json(req);
      if (!teamAllowed(self)) return out({ error: "Forbidden" }, 403);
      const cameraId = String(body.cameraId ?? ""); const action = body.action === "stop" ? "stop" : "start";
      const cameras = await (await rest(`/mpsq_cameras?id=eq.${cameraId}&select=name`)).json();
      if (!cameras[0]) return out({ error: "Kamera nicht gefunden" }, 404);
      if (action === "stop") {
        const result = await rest(`/mpsq_team_camera_presence?camera_id=eq.${cameraId}&viewer_id=eq.${clientId}`, { method: "DELETE" });
        return out({ ok: result.ok }, result.ok ? 200 : result.status);
      }
      const result = await rest("/mpsq_team_camera_presence?on_conflict=camera_id", {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ camera_id: cameraId, viewer_id: clientId, updated_at: new Date().toISOString() })
      });
      return out({ ok: result.ok }, result.ok ? 201 : result.status);
    }

    if (req.method === "PATCH" && path === "/me") {
      const b = await json(req); const displayName = String(b.displayName ?? "Minecraft Client").trim().slice(0, 32) || "Minecraft Client";
      const r = await rest(`/mpsq_clients?id=eq.${clientId}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ display_name: displayName, last_seen_at: new Date().toISOString() }) });
      return out(await r.json(), r.status);
    }

    if (req.method === "POST" && path === "/bodycam-requests") {
      const b = await json(req); const targetName = String(b.targetDisplayName ?? "").trim().slice(0, 32);
      if (!targetName) return out({ error: "Spielername fehlt" }, 400);
      const targetResult = await rest(`/mpsq_clients?display_name=eq.${encodeURIComponent(targetName)}&select=id,display_name&limit=2`);
      const targets = await targetResult.json();
      if (!targets[0]) return out({ error: "Spieler nicht gefunden" }, 404);
      if (targets.length > 1) return out({ error: "Spielername ist nicht eindeutig" }, 409);
      if (targets[0].id === clientId) return out({ error: "Eigene Bodycam nicht anfragen" }, 400);

      // A declined request only blocks another request to this exact player for
      // 30 seconds. Requests to a different player remain possible instantly.
      const cooldownSince = new Date(Date.now() - 30_000).toISOString();
      const declined = await (await rest(`/mpsq_bodycam_requests?requester_id=eq.${clientId}&target_id=eq.${targets[0].id}&status=eq.DECLINED&responded_at=gt.${encodeURIComponent(cooldownSince)}&select=id&limit=1`)).json();
      if (declined[0]) return out({ error: "Diese Person hat abgelehnt. Bitte warte 30 Sekunden." }, 429);

      const pending = await (await rest(`/mpsq_bodycam_requests?requester_id=eq.${clientId}&target_id=eq.${targets[0].id}&status=eq.PENDING&select=id&limit=1`)).json();
      if (pending[0]) return out({ error: "Eine Anfrage an diese Person läuft bereits." }, 409);

      const accepted = await (await rest(`/mpsq_bodycam_requests?requester_id=eq.${clientId}&target_id=eq.${targets[0].id}&status=eq.ACCEPTED&select=id&limit=1`)).json();
      if (accepted[0]) return out({ error: "Diese Person trägt bereits deine Bodycam." }, 409);

      // The schema keeps one row per state. Once the decline cooldown expired,
      // discard the old decline so a new request can later be declined again.
      await rest(`/mpsq_bodycam_requests?requester_id=eq.${clientId}&target_id=eq.${targets[0].id}&status=eq.DECLINED`, { method: "DELETE" });

      const r = await rest("/mpsq_bodycam_requests", { method: "POST", headers: { Prefer: "return=representation,resolution=merge-duplicates" }, body: JSON.stringify({ requester_id: clientId, target_id: targets[0].id }) });
      return out(await r.json(), r.status);
    }
    if (req.method === "GET" && path === "/bodycam-requests") {
      const r = await rest(`/mpsq_bodycam_requests?target_id=eq.${clientId}&status=eq.PENDING&select=id,requester_id,created_at&order=created_at.asc`);
      const requests = await r.json();
      const requesterIds = requests.map((row: any) => row.requester_id);
      if (!requesterIds.length) return out([]);
      const names = await (await rest(`/mpsq_clients?id=in.(${requesterIds.join(",")})&select=id,display_name`)).json();
      const byId = new Map(names.map((row: any) => [row.id, row.display_name]));
      return out(requests.map((row: any) => ({ ...row, requesterName: byId.get(row.requester_id) ?? "Unbekannt" })));
    }
    if (path.match(/^\/bodycam-requests\/[^/]+\/respond$/) && req.method === "POST") {
      const id = path.split("/")[2]; const b = await json(req); const accepted = b.accepted === true;
      const requestResult = await rest(`/mpsq_bodycam_requests?id=eq.${id}&target_id=eq.${clientId}&status=eq.PENDING&select=id,requester_id,target_id`);
      const [request] = await requestResult.json(); if (!request) return out({ error: "Anfrage nicht gefunden" }, 404);
      await rest(`/mpsq_bodycam_requests?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: accepted ? "ACCEPTED" : "DECLINED", responded_at: new Date().toISOString() }) });
      if (accepted) {
        const targetResult = await rest(`/mpsq_clients?id=eq.${clientId}&select=display_name`); const [target] = await targetResult.json();
        const cameraName = `${target?.display_name ?? "Spieler"}'s Bodycam`;
        await rest("/mpsq_cameras", { method: "POST", body: JSON.stringify({ owner_id: request.requester_id, name: cameraName, kind: "BODYCAM", dimension: "minecraft:overworld", body_owner_id: clientId }) });
      }
      return out({ ok: true, accepted });
    }

    if (req.method === "GET" && path === "/cameras") {
      const result = await camerasForClient(clientId);
      return out(await withBodyOwnerNames(result.cameras), result.status);
    }
    if (req.method === "GET" && path === "/cameras/accessible") {
      const ownResult = await camerasForClient(clientId);
      const ownCameras = ownResult.cameras;
      if (!teamAllowed(await teamProfile(clientId))) return out(await withBodyOwnerNames(ownCameras), ownResult.status);
      const ids = await screenIdsFor(clientId);
      if (!ids.length) return out(await withBodyOwnerNames(ownCameras), ownResult.status);
      const links = await (await rest(`/mpsq_screen_cameras?screen_id=in.(${ids.join(",")})&select=camera_id`)).json();
      const sharedIds = [...new Set(links.map((link: any) => link.camera_id).filter(Boolean))];
      if (!sharedIds.length) return out(await withBodyOwnerNames(ownCameras), ownResult.status);
      const shared = await (await rest(`/mpsq_cameras?id=in.(${sharedIds.join(",")})&order=created_at.asc`)).json();
      const merged = new Map<string, any>();
      [...ownCameras, ...shared].forEach(camera => merged.set(camera.id, camera));
      return out(await withBodyOwnerNames([...merged.values()]));
    }
    if (req.method === "GET" && path === "/bodycams/mine") {
      const r = await rest(`/mpsq_cameras?kind=eq.BODYCAM&body_owner_id=eq.${clientId}&select=id&order=created_at.asc`);
      return out(await r.json(), r.status);
    }
    if (req.method === "POST" && path === "/cameras") {
      const b = await json(req); const kind = b.kind === "BODYCAM" ? "BODYCAM" : "STATIC";
      const name = String(b.name ?? "").trim().slice(0, 64);
      if (!name) return out({ error: "Name fehlt" }, 400);
      const duplicateResult = await rest(`/mpsq_cameras?owner_id=eq.${clientId}&name=eq.${encodeURIComponent(name)}&select=id&limit=1`);
      const duplicates = await duplicateResult.json();
      if (duplicates[0]) return out({ error: "Name bereits vergeben" }, 409);
      const row = { owner_id: clientId, name, kind, dimension: String(b.dimension ?? "minecraft:overworld"), x: b.x ?? null, y: b.y ?? null, z: b.z ?? null, yaw: Number(b.yaw ?? 0), pitch: Number(b.pitch ?? 0), body_owner_id: kind === "BODYCAM" ? (b.bodyOwnerId ?? clientId) : null };
      const r = await rest("/mpsq_cameras", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) }); return out(await r.json(), r.status);
    }
    if (path.match(/^\/cameras\/[^/]+$/) && req.method === "PATCH") {
      const id = path.slice(9); const b = await json(req); const allowed: Record<string, unknown> = {};
      const cameraResult = await rest(`/mpsq_cameras?id=eq.${id}&owner_id=eq.${clientId}&select=id`);
      const cameras = await cameraResult.json(); if (!cameras[0]) return out({ error: "Kamera nicht gefunden" }, 404);
      if (typeof b.name === "string") {
        const name = b.name.trim().slice(0, 64); if (!name) return out({ error: "Name fehlt" }, 400);
        const duplicateResult = await rest(`/mpsq_cameras?owner_id=eq.${clientId}&id=neq.${id}&name=eq.${encodeURIComponent(name)}&select=id&limit=1`);
        const duplicates = await duplicateResult.json(); if (duplicates[0]) return out({ error: "Name bereits vergeben" }, 409);
        allowed.name = name;
      }
      if (typeof b.dimension === "string") allowed.dimension = b.dimension;
      for (const key of ["x", "y", "z", "yaw", "pitch"]) if (typeof b[key] === "number") allowed[key] = b[key];
      if (!Object.keys(allowed).length) return out({ error: "Keine Änderungen" }, 400);
      const r = await rest(`/mpsq_cameras?id=eq.${id}&owner_id=eq.${clientId}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(allowed) });
      return out(await r.json(), r.status);
    }
    if (path.startsWith("/cameras/") && req.method === "DELETE") {
      const id = path.slice(9);
      // A bodycam wearer may stop and remove their own bodycam. Static cameras
      // still remain deletable only by their original owner.
      const cameraResult = await rest(`/mpsq_cameras?id=eq.${id}&select=owner_id,body_owner_id,kind&limit=1`);
      const [camera] = await cameraResult.json();
      const allowed = !!camera && (camera.owner_id === clientId
        || (camera.kind === "BODYCAM" && camera.body_owner_id === clientId));
      if (!allowed) return out({ error: "Kamera nicht gefunden" }, 404);
      const r = await rest(`/mpsq_cameras?id=eq.${id}`, { method: "DELETE" });
      return out({ ok: r.ok }, r.ok ? 200 : r.status);
    }

    // Each active source obtains a temporary R2 PUT link roughly once a
    // minute. The following PNG uploads go directly to R2 and never traverse
    // Supabase, preventing camera use from consuming Edge Function calls or
    // Supabase egress for every frame.
    if (path.match(/^\/cameras\/[^/]+\/frame-upload-url$/) && req.method === "POST") {
      const id = path.split("/")[2];
      if (!await canPublishCamera(clientId, id)) return out({ error: "Keine Berechtigung für dieses Kamera-Bild" }, 403);
      return out({ url: await r2SignedFrameUrl(id, "PUT", 90), expiresIn: 90 });
    }
    if (path.match(/^\/cameras\/[^/]+\/frame$/) && req.method === "GET") {
      const id = path.split("/")[2];
      if (!await canReadCamera(clientId, id)) return out({ error: "Keine Freigabe für dieses Kamera-Bild" }, 403);
      // GET links can be reused by the viewer for 90 seconds. Each individual
      // frame download is a direct R2 read (free R2 egress), not an Edge
      // Function invocation or Supabase Storage download.
      return out({ url: await r2SignedFrameUrl(id, "GET", 90), expiresIn: 90 });
    }

    if (req.method === "GET" && path === "/screens") {
      const ids = await screenIdsFor(clientId); if (!ids.length) return out([]);
      const r = await rest(`/mpsq_screens?id=in.(${ids.join(",")})&select=*,mpsq_screen_cameras(camera_id,sort_order),mpsq_screen_groups(id,activation_code)&order=created_at.asc`);
      const screens = await r.json();
      if (!r.ok) return out(screens, r.status);
      return out(screens.map((screen: any) => ({ ...screen, is_owner: screen.owner_id === clientId })));
    }
    if (req.method === "POST" && path === "/screens") {
      const b = await json(req); const mode = b.mode === "CAMERA" ? "CAMERA" : "KINO";
      const p1 = b.pos1 ?? {}, p2 = b.pos2 ?? {};
      const requestedFront = String(b.front ?? "NORTH").toUpperCase();
      const front = ["NORTH", "SOUTH", "EAST", "WEST", "UP", "DOWN"].includes(requestedFront) ? requestedFront : "NORTH";
      const row = { owner_id: clientId, name: String(b.name ?? "Bildschirm").slice(0, 64), mode, dimension: String(b.dimension ?? "minecraft:overworld"), pos1_x: p1.x|0, pos1_y: p1.y|0, pos1_z: p1.z|0, pos2_x: p2.x|0, pos2_y: p2.y|0, pos2_z: p2.z|0, front, activation_code: code(), cinema_url: mode === "KINO" ? String(b.cinemaUrl ?? "") : "" };
      const r = await rest("/mpsq_screens", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) }); return out(await r.json(), r.status);
    }
    if (req.method === "POST" && path === "/join") {
      const b = await json(req); const supplied = String(b.code ?? "");
      const groupResult = await rest(`/mpsq_screen_groups?activation_code=eq.${encodeURIComponent(supplied)}&select=id`); const groups = await groupResult.json();
      const screenResult = groups[0] ? await rest(`/mpsq_screens?group_id=eq.${groups[0].id}&select=id`) : await rest(`/mpsq_screens?activation_code=eq.${encodeURIComponent(supplied)}&select=id`);
      const matches = await screenResult.json(); if (!matches[0]) return out({ error: "Code nicht gefunden" }, 404);
      const joined = await rest("/mpsq_screen_members", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(matches.map((x: any) => ({ screen_id: x.id, client_id: clientId })) ) }); return out({ ok: joined.ok }, joined.ok ? 200 : joined.status);
    }
    if (path.match(/^\/screens\/[^/]+\/members$/) && req.method === "POST") {
      const id = path.split("/")[2]; if (!await owned(clientId, id)) return out({ error: "Forbidden" }, 403);
      const b = await json(req); const displayName = String(b.displayName ?? "").trim().slice(0, 32);
      if (!displayName) return out({ error: "Spielername fehlt" }, 400);
      const clientResult = await rest(`/mpsq_clients?display_name=eq.${encodeURIComponent(displayName)}&select=id,display_name&limit=2`);
      const clients = await clientResult.json();
      if (!clients[0]) return out({ error: "Spieler nicht gefunden" }, 404);
      if (clients.length > 1) return out({ error: "Spielername ist nicht eindeutig" }, 409);
      const screenResult = await rest(`/mpsq_screens?id=eq.${id}&select=group_id`); const [screen] = await screenResult.json();
      let screenIds = [id];
      if (screen?.group_id) {
        const groupResult = await rest(`/mpsq_screens?group_id=eq.${screen.group_id}&select=id`);
        screenIds = (await groupResult.json()).map((row: any) => row.id);
      }
      const joined = await rest("/mpsq_screen_members", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(screenIds.map((screenId: string) => ({ screen_id: screenId, client_id: clients[0].id }))) });
      return out({ ok: joined.ok, displayName: clients[0].display_name }, joined.ok ? 200 : joined.status);
    }
    if (path.match(/^\/screens\/[^/]+\/members$/) && req.method === "GET") {
      const id = path.split("/")[2]; if (!await owned(clientId, id)) return out({ error: "Forbidden" }, 403);
      const r = await rest(`/mpsq_screen_members?screen_id=eq.${id}&select=client_id,joined_at,mpsq_clients(display_name)&order=joined_at.asc`);
      return out(await r.json(), r.status);
    }
    if (path.match(/^\/screens\/[^/]+\/members\/[^/]+$/) && req.method === "DELETE") {
      const [, , id, , memberId] = path.split("/"); if (!await owned(clientId, id)) return out({ error: "Forbidden" }, 403);
      const screenResult = await rest(`/mpsq_screens?id=eq.${id}&select=group_id`); const [screen] = await screenResult.json();
      let screenIds = [id];
      if (screen?.group_id) {
        const groupResult = await rest(`/mpsq_screens?group_id=eq.${screen.group_id}&select=id`);
        screenIds = (await groupResult.json()).map((row: any) => row.id);
      }
      const r = await rest(`/mpsq_screen_members?screen_id=in.(${screenIds.join(",")})&client_id=eq.${memberId}`, { method: "DELETE" });
      return out({ ok: r.ok }, r.ok ? 200 : r.status);
    }
    if (req.method === "POST" && path === "/groups") {
      const b = await json(req); const ids = Array.isArray(b.screenIds) ? b.screenIds : []; if (ids.length < 2) return out({ error: "Mindestens zwei Bildschirme erforderlich" }, 400);
      for (const id of ids) if (!await owned(clientId, String(id))) return out({ error: "Forbidden" }, 403);
      const created = await rest("/mpsq_screen_groups", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ owner_id: clientId, activation_code: code() }) }); const [group] = await created.json();
      if (!group) return out({ error: "Gruppe konnte nicht erstellt werden" }, 500);
      await rest(`/mpsq_screens?id=in.(${ids.join(",")})`, { method: "PATCH", body: JSON.stringify({ group_id: group.id }) }); return out(group, 201);
    }
    if (path.match(/^\/screens\/[^/]+\/remove-from-group$/) && req.method === "POST") {
      const id = path.split("/")[2]; if (!await owned(clientId, id)) return out({ error: "Forbidden" }, 403);
      const r = await rest(`/mpsq_screens?id=eq.${id}&select=group_id`); const [screen] = await r.json(); if (!screen?.group_id) return out({ error: "Keine Gruppe" }, 400);
      await rest(`/mpsq_screens?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ group_id: null, activation_code: code() }) });
      const members = await (await rest(`/mpsq_screens?group_id=eq.${screen.group_id}&select=id`)).json();
      if (members.length < 2) { await rest(`/mpsq_screens?group_id=eq.${screen.group_id}`, { method: "PATCH", body: JSON.stringify({ group_id: null }) }); await rest(`/mpsq_screen_groups?id=eq.${screen.group_id}`, { method: "DELETE" }); }
      return out({ ok: true });
    }
    if (path.startsWith("/screens/") && req.method === "PATCH") {
      const id = path.slice(9); if (!await owned(clientId, id)) return out({ error: "Forbidden" }, 403);
      const b = await json(req); const allowed: Record<string, unknown> = {};
      if (typeof b.name === "string") {
        const name = b.name.trim().slice(0, 64);
        if (!name) return out({ error: "Name fehlt" }, 400);
        const duplicateResult = await rest(`/mpsq_screens?owner_id=eq.${clientId}&id=neq.${id}&name=eq.${encodeURIComponent(name)}&select=id&limit=1`);
        const duplicates = await duplicateResult.json();
        if (duplicates[0]) return out({ error: "Name bereits vergeben" }, 409);
        allowed.name = name;
      }
      if (typeof b.cinemaUrl === "string") allowed.cinema_url = b.cinemaUrl;
      if (b.mode === "KINO" || b.mode === "CAMERA") allowed.mode = b.mode;
      if (b.playbackState) allowed.playback_state = b.playbackState;
      allowed.updated_at = new Date().toISOString();
      const r = await rest(`/mpsq_screens?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(allowed) }); return out(await r.json(), r.status);
    }
    if (path.match(/^\/screens\/[^/]+\/cameras$/) && req.method === "POST") {
      const id = path.split("/")[2]; if (!await owned(clientId, id)) return out({ error: "Forbidden" }, 403); const b = await json(req);
      const camera = await (await rest(`/mpsq_cameras?id=eq.${b.cameraId}&owner_id=eq.${clientId}&select=id`)).json(); if (!camera[0]) return out({ error: "Kamera nicht gefunden" }, 404);
      const sortOrder = Math.max(0, Number(b.sortOrder ?? 0) | 0);
      const r = await rest("/mpsq_screen_cameras?on_conflict=screen_id,camera_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ screen_id: id, camera_id: b.cameraId, sort_order: sortOrder }) });
      return out(await r.json(), r.ok ? 200 : r.status);
    }
    if (path.match(/^\/screens\/[^/]+\/cameras\/[^/]+$/) && req.method === "DELETE") {
      const [, , id, , cameraId] = path.split("/"); if (!await owned(clientId, id)) return out({ error: "Forbidden" }, 403);
      const r = await rest(`/mpsq_screen_cameras?screen_id=eq.${id}&camera_id=eq.${cameraId}`, { method: "DELETE" }); return out({ ok: r.ok }, r.ok ? 200 : r.status);
    }
    if (path.startsWith("/screens/") && req.method === "DELETE") {
      const id = path.slice(9); if (!await owned(clientId, id)) return out({ error: "Forbidden" }, 403);
      const sr = await rest(`/mpsq_screens?id=eq.${id}&select=group_id`); const [screen] = await sr.json();
      const where = screen?.group_id ? `group_id=eq.${screen.group_id}` : `id=eq.${id}`;
      const r = await rest(`/mpsq_screens?${where}`, { method: "DELETE" }); return out({ ok: r.ok }, r.ok ? 200 : r.status);
    }
    return out({ error: "Not found" }, 404);
  } catch (error) { return out({ error: String(error) }, 500); }
});





