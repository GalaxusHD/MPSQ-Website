-- Add editable NPC presentation and interaction fields to an existing MPSQ database.
begin;
alter table public.mpsq_world_npcs add column if not exists display_name text not null default 'NPC';
alter table public.mpsq_world_npcs add column if not exists scale double precision not null default 1;
alter table public.mpsq_world_npcs add column if not exists glow_color text not null default 'none';
alter table public.mpsq_world_npcs add column if not exists animation text not null default 'none';
alter table public.mpsq_world_npcs add column if not exists interaction_data jsonb not null default '{"pages":["Hallo!"]}'::jsonb;
alter table public.mpsq_world_npcs add column if not exists yaw double precision not null default 0;
alter table public.mpsq_world_npcs add column if not exists pitch double precision not null default 0;
alter table public.mpsq_world_npcs add column if not exists face_player boolean not null default false;
alter table public.mpsq_world_npcs add column if not exists position_x double precision;
alter table public.mpsq_world_npcs add column if not exists position_y double precision;
alter table public.mpsq_world_npcs add column if not exists position_z double precision;
commit;
