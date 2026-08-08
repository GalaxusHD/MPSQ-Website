import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-mpsq-token", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS" };
const base = () => `${Deno.env.get("SUPABASE_URL")}/rest/v1`;
const key = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const headers = () => ({ apikey: key(), Authorization: `Bearer ${key()}`, "Content-Type": "application/json" });
const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
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
async function owned(clientId: string, screenId: string) {
  const r = await rest(`/mpsq_screens?id=eq.${screenId}&owner_id=eq.${clientId}&select=id`); return (await r.json()).length > 0;
}
async function screenIdsFor(clientId: string) {
  const mine = await (await rest(`/mpsq_screens?owner_id=eq.${clientId}&select=id`)).json();
  const joined = await (await rest(`/mpsq_screen_members?client_id=eq.${clientId}&select=screen_id`)).json();
  return [...new Set([...mine.map((x: any) => x.id), ...joined.map((x: any) => x.screen_id)])];
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
    const clientId = await auth(req); if (!clientId) return out({ error: "Unauthorized" }, 401);
    await rest(`/mpsq_clients?id=eq.${clientId}`, { method: "PATCH", body: JSON.stringify({ last_seen_at: new Date().toISOString() }) });

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
        const cameraName = `Bodycam ${target?.display_name ?? "Spieler"} ${id.slice(0, 4)}`;
        await rest("/mpsq_cameras", { method: "POST", body: JSON.stringify({ owner_id: request.requester_id, name: cameraName, kind: "BODYCAM", dimension: "minecraft:overworld", body_owner_id: clientId }) });
      }
      return out({ ok: true, accepted });
    }

    if (req.method === "GET" && path === "/cameras") {
      const r = await rest(`/mpsq_cameras?owner_id=eq.${clientId}&order=created_at.asc`); return out(await r.json(), r.status);
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
      const id = path.slice(9); const r = await rest(`/mpsq_cameras?id=eq.${id}&owner_id=eq.${clientId}`, { method: "DELETE" }); return out({ ok: r.ok }, r.ok ? 200 : r.status);
    }

    if (req.method === "GET" && path === "/screens") {
      const ids = await screenIdsFor(clientId); if (!ids.length) return out([]);
      const r = await rest(`/mpsq_screens?id=in.(${ids.join(",")})&select=*,mpsq_screen_cameras(camera_id,sort_order)&order=created_at.asc`); return out(await r.json(), r.status);
    }
    if (req.method === "POST" && path === "/screens") {
      const b = await json(req); const mode = b.mode === "CAMERA" ? "CAMERA" : "KINO";
      const p1 = b.pos1 ?? {}, p2 = b.pos2 ?? {};
      const row = { owner_id: clientId, name: String(b.name ?? "Bildschirm").slice(0, 64), mode, dimension: String(b.dimension ?? "minecraft:overworld"), pos1_x: p1.x|0, pos1_y: p1.y|0, pos1_z: p1.z|0, pos2_x: p2.x|0, pos2_y: p2.y|0, pos2_z: p2.z|0, activation_code: code(), cinema_url: mode === "KINO" ? String(b.cinemaUrl ?? "") : "" };
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
      const r = await rest("/mpsq_screen_cameras", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ screen_id: id, camera_id: b.cameraId, sort_order: Number(b.sortOrder ?? 0) }) }); return out({ ok: r.ok }, r.ok ? 200 : r.status);
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
