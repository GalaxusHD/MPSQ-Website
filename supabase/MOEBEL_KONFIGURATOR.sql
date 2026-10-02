-- Additive furniture-configuration fields; safe to run more than once.
ALTER TABLE public.mpsq_world_objects
    ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS scale real NOT NULL DEFAULT 1.0,
    ADD COLUMN IF NOT EXISTS sound_id text NOT NULL DEFAULT '';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'mpsq_world_objects_scale_range'
          AND conrelid = 'public.mpsq_world_objects'::regclass
    ) THEN
        ALTER TABLE public.mpsq_world_objects
            ADD CONSTRAINT mpsq_world_objects_scale_range
            CHECK (scale >= 0.25 AND scale <= 3.0) NOT VALID;
    END IF;
END $$;

ALTER TABLE public.mpsq_world_objects
    VALIDATE CONSTRAINT mpsq_world_objects_scale_range;
