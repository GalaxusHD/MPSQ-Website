-- =============================================
-- MPSQ Website – Supabase Setup SQL (v2)
-- =============================================
-- Run this script in your Supabase SQL Editor:
-- Go to https://supabase.com → Your Project → SQL Editor → New Query

-- ==============================
-- 1. TEAM MEMBERS TABLE
-- ==============================
CREATE TABLE IF NOT EXISTS public.team_members (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    rank       TEXT        NOT NULL CHECK (rank IN ('Frontman', 'Quadrat', 'Dreieck', 'Kreis')),
    name       TEXT        NOT NULL,
    subrank    TEXT        NOT NULL DEFAULT '',
    image_url  TEXT        NOT NULL DEFAULT '',
    sort_order INTEGER     NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==============================
-- 2. CONTENT BLOCKS TABLE
-- ==============================
-- Stores arbitrary JSON content keyed by a string identifier.
-- Used for "Über uns" (key: 'ueber-uns') and "Event" (key: 'event') page data.
CREATE TABLE IF NOT EXISTS public.content_blocks (
    key        TEXT        PRIMARY KEY,
    value      JSONB       NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==============================
-- 3. ENABLE ROW LEVEL SECURITY
-- ==============================
ALTER TABLE public.team_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_blocks ENABLE ROW LEVEL SECURITY;

-- ==============================
-- 4. PUBLIC READ POLICIES (anon key)
-- ==============================
-- Anyone can read – no credentials needed
CREATE POLICY "allow_public_select_team_members"
  ON public.team_members FOR SELECT USING (true);

CREATE POLICY "allow_public_select_content_blocks"
  ON public.content_blocks FOR SELECT USING (true);

-- NOTE: There are NO insert/update/delete policies for the anon role.
-- All writes go through the admin-write Edge Function, which uses
-- the service role key (bypasses RLS entirely).

-- ==============================
-- 5. INDEXES
-- ==============================
-- Ensure sort_order column exists (safe to run even if already present).
-- This handles databases created before sort_order was added to the schema.
ALTER TABLE public.team_members
    ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_team_members_rank_order
  ON public.team_members (rank, sort_order);

-- ==============================
-- 6. UPDATED_AT TRIGGER
-- ==============================
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS team_members_updated_at ON public.team_members;
CREATE TRIGGER team_members_updated_at
    BEFORE UPDATE ON public.team_members
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS content_blocks_updated_at ON public.content_blocks;
CREATE TRIGGER content_blocks_updated_at
    BEFORE UPDATE ON public.content_blocks
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ==============================
-- 7. STORAGE BUCKET FOR TEAM IMAGES
-- ==============================
-- Creates a public storage bucket named "team".
-- Images are uploaded by the admin-write Edge Function.
INSERT INTO storage.buckets (id, name, public)
  VALUES ('team', 'team', true)
  ON CONFLICT (id) DO NOTHING;

-- Allow public read of team images
CREATE POLICY "allow_public_read_team_images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'team');
