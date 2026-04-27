// supabase/functions/admin-write/index.ts
// Authenticated admin writes for the MPSQ website.
//
// Deploy:
//   supabase functions deploy admin-write
//
// Required secrets (set once):
//   supabase secrets set ADMIN_PASSWORD="<your-password>"
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
//
// SUPABASE_URL is automatically available as an env var inside Edge Functions.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-password",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // Validate admin password
  const adminPassword = Deno.env.get("ADMIN_PASSWORD");
  const requestPassword = req.headers.get("x-admin-password");
  if (!adminPassword || !requestPassword || requestPassword !== adminPassword) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse(
      { error: "Server misconfiguration: missing env vars" },
      500,
    );
  }

  const restBase = `${supabaseUrl}/rest/v1`;
  const storageBase = `${supabaseUrl}/storage/v1`;

  const serviceHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "apikey": serviceRoleKey,
    "Authorization": `Bearer ${serviceRoleKey}`,
  };

  // Extract sub-path after /admin-write (e.g. /team-members, /content-blocks)
  const url = new URL(req.url);
  const pathMatch = url.pathname.match(/\/admin-write(\/.*)?$/);
  const subPath = (pathMatch?.[1] ?? "/").replace(/\/$/, "") || "/";

  try {
    // ── POST /team-members ────────────────────────────────────────────────────
    // Batch upsert (create or update) team members by id.
    if (req.method === "POST" && subPath === "/team-members") {
      const body = await req.json();
      const members = Array.isArray(body) ? body : [body];

      const res = await fetch(`${restBase}/team_members`, {
        method: "POST",
        headers: {
          ...serviceHeaders,
          "Prefer": "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(members),
      });

      const data = await res.json();
      if (!res.ok) return jsonResponse({ error: data }, res.status);
      return jsonResponse(data);
    }

    // ── DELETE /team-members/:id ──────────────────────────────────────────────
    if (req.method === "DELETE" && subPath.startsWith("/team-members/")) {
      const id = subPath.slice("/team-members/".length);

      const res = await fetch(
        `${restBase}/team_members?id=eq.${encodeURIComponent(id)}`,
        { method: "DELETE", headers: serviceHeaders },
      );

      if (!res.ok) {
        const data = await res.json();
        return jsonResponse({ error: data }, res.status);
      }
      return jsonResponse({ ok: true });
    }

    // ── POST /content-blocks ──────────────────────────────────────────────────
    // Upsert one or more content blocks by their key.
    if (req.method === "POST" && subPath === "/content-blocks") {
      const body = await req.json();
      const blocks = Array.isArray(body) ? body : [body];

      const res = await fetch(`${restBase}/content_blocks`, {
        method: "POST",
        headers: {
          ...serviceHeaders,
          "Prefer": "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(blocks),
      });

      const data = await res.json();
      if (!res.ok) return jsonResponse({ error: data }, res.status);
      return jsonResponse(data);
    }

    // ── POST /upload-image ────────────────────────────────────────────────────
    // Upload an image file to the "team" storage bucket.
    // Returns { publicUrl, path }.
    if (req.method === "POST" && subPath === "/upload-image") {
      const formData = await req.formData();
      const file = formData.get("file") as File | null;

      if (!file) {
        return jsonResponse({ error: "No file provided" }, 400);
      }

      // Validate that the file is an allowed image type
      const ALLOWED_TYPES = [
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "image/avif",
      ];
      const contentType = file.type || "";
      if (!ALLOWED_TYPES.includes(contentType)) {
        return jsonResponse(
          { error: `File type '${contentType}' is not allowed. Allowed: jpg, png, gif, webp, avif` },
          400,
        );
      }

      const extMap: Record<string, string> = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/avif": "avif",
      };
      const ext = extMap[contentType] ?? "jpg";
      const fileName = `${crypto.randomUUID()}.${ext}`;

      const fileBuffer = await file.arrayBuffer();

      const uploadRes = await fetch(
        `${storageBase}/object/team/${encodeURIComponent(fileName)}`,
        {
          method: "POST",
          headers: {
            "apikey": serviceRoleKey,
            "Authorization": `Bearer ${serviceRoleKey}`,
            "Content-Type": file.type || "application/octet-stream",
            "x-upsert": "true",
          },
          body: fileBuffer,
        },
      );

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        return jsonResponse({ error: errText }, uploadRes.status);
      }

      const publicUrl =
        `${supabaseUrl}/storage/v1/object/public/team/${encodeURIComponent(fileName)}`;
      return jsonResponse({ publicUrl, path: fileName });
    }

    return jsonResponse({ error: "Not Found" }, 404);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
