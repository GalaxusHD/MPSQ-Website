-- Shared MPSQ trigger/action registry.
create table if not exists public.mpsq_action_triggers (
  id uuid primary key default gen_random_uuid(),
  world_id text not null,
  pos_x integer not null,
  pos_y integer not null,
  pos_z integer not null,
  block_id text not null,
  object_type text not null default 'TRIGGER',
  action_type text not null,
  action_data jsonb not null default '{}'::jsonb,
  minimum_rank text not null default 'offizier',
  enabled boolean not null default true,
  created_by uuid not null references public.mpsq_clients(id),
  updated_at timestamptz not null default now(),
  unique (world_id, pos_x, pos_y, pos_z)
);
create index if not exists mpsq_action_triggers_world_pos_idx
  on public.mpsq_action_triggers(world_id, pos_x, pos_y, pos_z);
alter table public.mpsq_action_triggers enable row level security;
