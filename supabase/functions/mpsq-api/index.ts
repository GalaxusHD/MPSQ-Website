import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

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
// A camera owns exactly one fixed image in Supabase Storage.  Every upload
// overwrites this file, so old frames never build up in the bucket.
const frameBucket = "mpsq_live";
const framePath = (cameraId: string) => `frames/${cameraId}.png`;
const storageBase = () => `${Deno.env.get("SUPABASE_URL")}/storage/v1`;
const storageHeaders = () => ({ apikey: key(), Authorization: `Bearer ${key()}` });

async function storagePutFrame(cameraId: string, bytes: Uint8Array) {
  return fetch(`${storageBase()}/object/${frameBucket}/${framePath(cameraId)}`, {
    method: "POST",
    headers: {
      ...storageHeaders(),
      "Content-Type": "image/png",
      "x-upsert": "true",
      // A frame is deliberately never cached: the next request must see the
      // replacement that was just written to the same object key.
      "Cache-Control": "no-store, no-cache, max-age=0"
    },
    body: bytes
  });
}
async function storageGetFrame(cameraId: string) {
  return fetch(`${storageBase()}/object/${frameBucket}/${framePath(cameraId)}`, {
    headers: { ...storageHeaders(), "Cache-Control": "no-cache" }
  });
}
async function storageSignedFrameUrl(cameraId: string, expiresIn = 5) {
  const response = await fetch(`${storageBase()}/object/sign/${frameBucket}/${framePath(cameraId)}`, {
    method: "POST",
    headers: { ...storageHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn })
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const signedPath = data.signedURL ?? data.signedUrl;
  if (typeof signedPath !== "string") throw new Error("Supabase lieferte keine signierte Frame-URL.");
  return `${storageBase()}${signedPath}`;
}
async function canPublishCamera(clientId: string, cameraId: string) {
  const r = await rest(`/mpsq_cameras?id=eq.${cameraId}&select=owner_id,body_owner_id&limit=1`);
  const [camera] = await r.json();
  return !!camera && (camera.owner_id === clientId || camera.body_owner_id === clientId);
}
async function canReadCamera(clientId: string, cameraId: string) {
  const own = await (await rest(`/mpsq_cameras?id=eq.${cameraId}&or=(owner_id.eq.${clientId},body_owner_id.eq.${clientId})&select=id&limit=1`)).json();
  if (own[0]) return true;
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
const rankLevel: Record<string, number> = { vip: 0, spieler: 1, "001": 2, soldat: 3, arbeiter: 4, offizier: 5, frontman: 6, sr_offizier: 7 };
const validRank = (rank: string) => Object.prototype.hasOwnProperty.call(rankLevel, rank);
const level = (rank: string | null | undefined) => rankLevel[rank ?? "spieler"] ?? 1;
async function teamProfile(clientId: string) {
  await rest("/mpsq_team_profiles?on_conflict=client_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ client_id: clientId }) });
  const result = await rest(`/mpsq_team_profiles?client_id=eq.${clientId}&select=client_id,base_rank,active_rank`);
  const [profile] = await result.json();
  return profile ?? { client_id: clientId, base_rank: "spieler", active_rank: null };
}
async function teamIdentity(clientId: string) {
  const profile = await teamProfile(clientId);
  const clients = await (await rest(`/mpsq_clients?id=eq.${clientId}&select=id,display_name`)).json();
  return { id: clientId, display_name: clients[0]?.display_name ?? "Minecraft Spieler", base_rank: profile.base_rank ?? "spieler", active_rank: profile.active_rank ?? null };
}
const shownRank = (profile: any) => profile.active_rank ?? profile.base_rank ?? "spieler";
const permissionRank = (profile: any) => shownRank(profile);
const teamAllowed = (profile: any) => level(permissionRank(profile)) >= 2;
const canEditTodo = (profile: any) => level(permissionRank(profile)) >= 4;
const canEditEvent = (profile: any) => level(permissionRank(profile)) >= 5;
const approvalRanks = ["vip", "spieler", "soldat", "arbeiter", "offizier", "frontman"];
async function addRankLog(actorId: string | null, targetId: string, before: any, after: any, action: string, requestId: string | null = null) {
  await rest("/mpsq_team_rank_log", { method: "POST", body: JSON.stringify({
    request_id: requestId, actor_id: actorId, target_id: targetId,
    old_base_rank: before.base_rank ?? "spieler", old_active_rank: before.active_rank ?? null,
    new_base_rank: after.base_rank ?? "spieler", new_active_rank: after.active_rank ?? null, action
  }) });
}
async function rootInfo() {
  const result = await rest("/mpsq_team_root?id=eq.1&select=root_display_name,root_client_id");
  const [root] = await result.json();
  return root ?? { root_display_name: "MP_SquidGame", root_client_id: null };
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
    if (path === "/admin/rank-requests" && req.method === "GET") {
      const rows = await (await rest("/mpsq_team_rank_requests?select=*&order=created_at.desc&limit=200")).json();
      const ids = [...new Set(rows.flatMap((row: any) => [row.requested_by, row.target_id, row.decided_by]).filter(Boolean))];
      const users = ids.length ? await (await rest(`/mpsq_clients?id=in.(${ids.join(",")})&select=id,display_name`)).json() : [];
      const names = new Map(users.map((row: any) => [row.id, row.display_name]));
      return out(rows.map((row: any) => ({ ...row, requester_name: names.get(row.requested_by) ?? "Unbekannt", target_name: names.get(row.target_id) ?? "Unbekannt", decided_by_name: names.get(row.decided_by) ?? null })));
    }
    if (path === "/admin/rank-log" && req.method === "GET") {
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
    const clientId = await auth(req); if (!clientId) return out({ error: "Unauthorized" }, 401);
    await rest(`/mpsq_clients?id=eq.${clientId}`, { method: "PATCH", body: JSON.stringify({ last_seen_at: new Date().toISOString() }) });

    // MPSQ Team: public rank display plus private staff tools. All permission
    // decisions are made here, never trusted from the client UI.
    if (path === "/team/me" && req.method === "GET") return out(await teamIdentity(clientId));
    if (path === "/team/members" && req.method === "GET") {
      const self = await teamProfile(clientId); if (!teamAllowed(self)) return out({ error: "Forbidden" }, 403);
      const profiles = await (await rest("/mpsq_team_profiles?select=client_id,base_rank,active_rank")).json();
      const clients = await (await rest("/mpsq_clients?select=id,display_name&order=display_name.asc")).json();
      const names = new Map(clients.map((row: any) => [row.id, row.display_name]));
      const ownLevel = level(permissionRank(self));
      return out(profiles.filter((p: any) => p.client_id === clientId || level(shownRank(p)) <= ownLevel)
        .map((p: any) => ({ id: p.client_id, display_name: names.get(p.client_id) ?? "Minecraft Spieler", base_rank: p.base_rank, active_rank: p.active_rank })));
    }
    if (path.match(/^\/team\/members\/[^/]+\/rank$/) && req.method === "POST") {
      const memberId = path.split("/")[3]; const body = await json(req); const requested = String(body.rank ?? "");
      const self = await teamProfile(clientId); const target = await teamProfile(memberId);
      if (!validRank(requested) || requested === "sr_offizier") return out({ error: "Dieser Rang kann nicht vergeben werden" }, 403);
      const self001 = memberId === clientId && (self.base_rank === "soldat" || self.base_rank === "arbeiter") && requested === "001";
      if (!self001) return out({ error: "Rangänderung muss im Admin-Log bestätigt werden" }, 403);
      const update = { active_rank: "001" };
      const result = await rest(`/mpsq_team_profiles?client_id=eq.${memberId}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(update) });
      const rows = await result.json();
      if (result.ok) await addRankLog(clientId, memberId, target, rows[0] ?? { ...target, ...update }, "EVENT_001");
      return out(rows, result.ok ? 200 : result.status);
    }
    if (path === "/team/rank-requests" && req.method === "POST") {
      const self = await teamProfile(clientId); const body = await json(req);
      const targetId = String(body.targetId ?? ""); const requested = String(body.rank ?? "");
      if (!targetId || !approvalRanks.includes(requested)) return out({ error: "Ungültiger Rang-Antrag" }, 400);
      const target = await teamProfile(targetId); const ownRank = permissionRank(self);
      const canRequest = ownRank === "sr_offizier"
        || ((ownRank === "offizier" || ownRank === "frontman") && approvalRanks.slice(0, 4).includes(requested) && level(shownRank(target)) <= level("arbeiter"));
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
      const self = await teamProfile(clientId); if (!teamAllowed(self)) return out({ error: "Forbidden" }, 403);
      const rows = await (await rest("/mpsq_team_messages?select=id,sender_id,message,created_at&order=created_at.desc&limit=100")).json();
      const messages = [];
      for (const row of rows.reverse()) { const sender = await teamIdentity(row.sender_id); messages.push({ sender_name: sender.display_name, sender_rank: shownRank(sender), message: row.message, created_at: row.created_at }); }
      return out(messages);
    }
    if (path === "/team/chat" && req.method === "POST") {
      const self = await teamProfile(clientId); const body = await json(req); const message = String(body.message ?? "").trim().slice(0, 256);
      if (!teamAllowed(self)) return out({ error: "Forbidden" }, 403); if (!message) return out({ error: "Nachricht fehlt" }, 400);
      const result = await rest("/mpsq_team_messages", { method: "POST", body: JSON.stringify({ sender_id: clientId, message }) });
      return out({ ok: result.ok }, result.ok ? 201 : result.status);
    }
    if (path === "/team/todos" && req.method === "GET") {
      const self = await teamProfile(clientId); if (!teamAllowed(self)) return out({ error: "Forbidden" }, 403);
      const result = await rest("/mpsq_team_todos?select=id,text,done,created_at&order=created_at.asc"); return out(await result.json(), result.status);
    }
    if (path === "/team/todos" && req.method === "POST") {
      const self = await teamProfile(clientId); const body = await json(req); const text = String(body.text ?? "").trim().slice(0, 256);
      if (!canEditTodo(self)) return out({ error: "Forbidden" }, 403); if (!text) return out({ error: "Aufgabe fehlt" }, 400);
      const result = await rest("/mpsq_team_todos", { method: "POST", body: JSON.stringify({ text, created_by: clientId }) }); return out({ ok: result.ok }, result.ok ? 201 : result.status);
    }
    if (path.match(/^\/team\/todos\/[^/]+$/) && req.method === "PATCH") {
      const self = await teamProfile(clientId); const body = await json(req); if (!canEditTodo(self)) return out({ error: "Forbidden" }, 403);
      const result = await rest(`/mpsq_team_todos?id=eq.${path.split("/")[3]}`, { method: "PATCH", body: JSON.stringify({ done: body.done === true }) }); return out({ ok: result.ok }, result.ok ? 200 : result.status);
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
      const self = await teamProfile(clientId); if (!teamAllowed(self)) return out({ error: "Forbidden" }, 403);
      const result = await rest("/mpsq_team_templates?select=id,text,minimum_rank,created_at&order=created_at.asc");
      const rows = await result.json(); return out(rows.filter((row: any) => level(row.minimum_rank) <= level(permissionRank(self))));
    }
    if (path === "/team/templates" && req.method === "POST") {
      const self = await teamProfile(clientId); const body = await json(req); const text = String(body.text ?? "").trim().slice(0, 256);
      if (!canEditEvent(self)) return out({ error: "Forbidden" }, 403); if (!text) return out({ error: "Text fehlt" }, 400);
      const result = await rest("/mpsq_team_templates", { method: "POST", body: JSON.stringify({ text, minimum_rank: permissionRank(self), created_by: clientId }) }); return out({ ok: result.ok }, result.ok ? 201 : result.status);
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
    if (path === "/team/camera-events" && req.method === "POST") {
      const self = await teamProfile(clientId); const body = await json(req);
      if (!teamAllowed(self)) return out({ error: "Forbidden" }, 403);
      const cameraId = String(body.cameraId ?? ""); const action = body.action === "stop" ? "stop" : "start";
      const cameras = await (await rest(`/mpsq_cameras?id=eq.${cameraId}&select=name`)).json();
      if (!cameras[0]) return out({ error: "Kamera nicht gefunden" }, 404);
      const sender = await teamIdentity(clientId);
      const message = action === "start"
        ? `${sender.display_name} nutzt Kamera ${cameras[0].name}.`
        : `Kamera ${cameras[0].name} ist nicht mehr live geladen.`;
      const result = await rest("/mpsq_team_messages", { method: "POST", body: JSON.stringify({ sender_id: clientId, message }) });
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

    // Exactly one Storage object exists per camera. Every upload replaces this
    // same file, so old frames can never accumulate.
    if (path.match(/^\/cameras\/[^/]+\/frame$/) && req.method === "POST") {
      const id = path.split("/")[2];
      if (!await canPublishCamera(clientId, id)) return out({ error: "Keine Berechtigung für dieses Kamera-Bild" }, 403);
      const b = await json(req); const encoded = typeof b.pngBase64 === "string" ? b.pngBase64 : "";
      if (!encoded || encoded.length > 2_500_000) return out({ error: "Ungültiges Kamera-Bild" }, 400);
      let bytes: Uint8Array;
      try { bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0)); }
      catch { return out({ error: "Ungültiges Kamera-Bild" }, 400); }
      const upload = await storagePutFrame(id, bytes);
      if (!upload.ok) return out({ error: await upload.text() }, upload.status);
      return out({ ok: true });
    }
    if (path.match(/^\/cameras\/[^/]+\/frame$/) && req.method === "GET") {
      const id = path.split("/")[2];
      if (!await canReadCamera(clientId, id)) return out({ error: "Keine Freigabe für dieses Kamera-Bild" }, 403);
      // Used only if the client cannot download the temporary signed URL.
      if (url.searchParams.get("inline") === "1") {
        const frame = await storageGetFrame(id);
        if (!frame.ok) return out({ error: "Kamera ist offline" }, frame.status === 404 ? 404 : 502);
        const bytes = new Uint8Array(await frame.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return out({ pngBase64: btoa(binary) });
      }
      return out({ url: await storageSignedFrameUrl(id), expiresIn: 5 });
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
