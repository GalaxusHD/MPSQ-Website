-- =============================================
-- MPSQ Team Management – Supabase Setup SQL
-- =============================================
-- Run this script in your Supabase SQL Editor:
-- Go to https://supabase.com → Your Project → SQL Editor → New Query

-- 1. Create the team_members table
CREATE TABLE IF NOT EXISTS public.team_members (
    id            BIGSERIAL PRIMARY KEY,
    minecraft_name TEXT      NOT NULL,
    discord_id     TEXT      NOT NULL,
    rank           TEXT      NOT NULL CHECK (rank IN (
                       'Frontman | Leiter',
                       'Quadrat | Offizier',
                       'Dreieck | Soldat',
                       'Kreis | Arbeiter'
                   )),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Enable Row Level Security
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

-- 3. Allow everyone to read team members (public)
CREATE POLICY "public_read_team_members"
  ON public.team_members
  FOR SELECT
  USING (true);

-- 4. Write access via the anon key from the website
--    NOTE: Since this is a static site without a server, the anon key is public.
--    The editor access check is enforced in JavaScript (editing.html only loads
--    for Discord ID 826234747373617212). For additional security you can restrict
--    write access by IP or upgrade to Supabase Auth with proper user roles.
CREATE POLICY "anon_write_team_members"
  ON public.team_members
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- 5. Create an index for faster queries
CREATE INDEX IF NOT EXISTS idx_team_members_rank
  ON public.team_members (rank, minecraft_name);

-- 6. Add an updated_at trigger to auto-update timestamps
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS team_members_updated_at ON public.team_members;
CREATE TRIGGER team_members_updated_at
    BEFORE UPDATE ON public.team_members
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
