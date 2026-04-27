# Deploying the `admin-write` Edge Function

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) installed  
  `npm install -g supabase`
- Logged in: `supabase login`
- Linked to this project: `supabase link --project-ref hbikjzzkxsvjoqnedbmm`

---

## 1. Run the database migration

Open the Supabase Dashboard → **SQL Editor** → **New Query**, paste the
contents of [`supabase-setup.sql`](./supabase-setup.sql) and click **Run**.

This creates:

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
  ADMIN_PASSWORD="Jl2007jl!" \
  SUPABASE_SERVICE_ROLE_KEY="<your-service-role-key>"
```

> **Never embed the service role key in any website file.**  
> Get the key from Supabase Dashboard → Settings → API → `service_role` key.

`SUPABASE_URL` is injected automatically by Supabase at runtime.

---

## 3. Deploy the Edge Function

```bash
supabase functions deploy admin-write --no-verify-jwt
```

The `--no-verify-jwt` flag is required because we use a custom
`x-admin-password` header for authentication instead of Supabase JWTs.

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
  -H "x-admin-password: Jl2007jl!" \
  -H "Content-Type: application/json" \
  -d '[{"rank":"Kreis","name":"TestUser","subrank":"Tester","image_url":"","sort_order":0}]'
```

A `200` response with the inserted row confirms everything is working.

---

## 6. Updating secrets later

```bash
supabase secrets set ADMIN_PASSWORD="<new-password>"
```

The Edge Function picks up the new value on next invocation (no redeploy needed).
