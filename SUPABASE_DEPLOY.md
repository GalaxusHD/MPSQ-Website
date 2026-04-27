# Deploying the `admin-write` Edge Function

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) installed  
  `npm install -g supabase`
- Logged in: `supabase login`
- Linked to this project: `supabase link --project-ref hbikjzzkxsvjoqnedbmm`

---

## 1. Run the database migration

> ⚠️ **This step is required before the website will work.** Without it, REST
> reads return `404` (table not found) or `400` (column not found).

Open the Supabase Dashboard → **SQL Editor** → **New Query**, paste the
contents of [`supabase-setup.sql`](./supabase-setup.sql) and click **Run**.

The script is safe to run multiple times (`IF NOT EXISTS` guards everywhere).

This creates / updates:

| Table / Bucket | Purpose |
|---|---|
| `public.team_members` | Team member records (rank, name, subrank, image_url, sort_order) |
| `public.content_blocks` | Arbitrary JSON blocks keyed by string (e.g. `ueber-uns`, `event`) |
| `storage.buckets: team` | Public bucket for team member images |

RLS is enabled. The anon key can only **read**. All writes go through the
Edge Function below.

---

## 2. Set required secrets

```bash
# Replace <values> with real credentials
supabase secrets set \
  ADMIN_PASSWORD="<your-admin-password>" \
  SUPABASE_SERVICE_ROLE_KEY="<your-service-role-key>"
```

> **Never embed the service role key in any website file.**  
> Get the key from Supabase Dashboard → Settings → API → `service_role` key.

`SUPABASE_URL` is injected automatically by Supabase at runtime (do **not**
set it manually).

---

## 3. Deploy the Edge Function

```bash
supabase functions deploy admin-write --no-verify-jwt
```

The `--no-verify-jwt` flag is required because we use a custom
`x-admin-password` header for authentication instead of Supabase JWTs.

> ⚠️ **CORS errors in the browser** ("Failed to fetch" / preflight blocked)
> almost always mean the Edge Function has **not been deployed yet**, or was
> deployed without `--no-verify-jwt`. Re-deploy and the CORS headers the
> function returns will fix the issue.

---

## 4. Edge Function endpoints

All requests must include the header:

```
x-admin-password: <admin-password>
```

| Method | Path | Body | Action |
|--------|------|------|--------|
| `POST` | `/functions/v1/admin-write/team-members` | `[{id, rank, name, subrank, image_url, sort_order}, …]` | Batch upsert team members |
| `DELETE` | `/functions/v1/admin-write/team-members/:id` | — | Delete a team member by UUID |
| `POST` | `/functions/v1/admin-write/content-blocks` | `[{key, value}, …]` | Upsert content blocks |
| `POST` | `/functions/v1/admin-write/upload-image` | `multipart/form-data: file=<binary>` | Upload image to `team` bucket; returns `{publicUrl, path}` |

---

## 5. Verify

After deployment, test with:

```bash
curl -X POST \
  "https://hbikjzzkxsvjoqnedbmm.supabase.co/functions/v1/admin-write/team-members" \
  -H "x-admin-password: <your-admin-password>" \
  -H "Content-Type: application/json" \
  -d '[{"rank":"Kreis","name":"TestUser","subrank":"Tester","image_url":"","sort_order":0}]'
```

A `200` response with the inserted row confirms everything is working.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `GET /rest/v1/content_blocks` → **404** | `content_blocks` table doesn't exist | Run `supabase-setup.sql` in SQL Editor |
| `GET /rest/v1/team_members` → **400** | `sort_order` or another column missing from existing table | Re-run `supabase-setup.sql` (the `ALTER TABLE ADD COLUMN IF NOT EXISTS` lines add missing columns) |
| Admin-write fetch → **CORS / "Failed to fetch"** | Edge Function not deployed (or deployed without `--no-verify-jwt`) | Run step 3 above |
| Admin-write fetch → **401** | Wrong or missing `ADMIN_PASSWORD` secret | Re-set the secret (step 2) and verify your password |
| Admin-write fetch → **500** | `SUPABASE_SERVICE_ROLE_KEY` not set | Run step 2 above |

---

## 7. Updating secrets later

```bash
supabase secrets set ADMIN_PASSWORD="<new-password>"
```

The Edge Function picks up the new value on next invocation (no redeploy needed).
