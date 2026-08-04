-- MPSQ mod data. This is intentionally separate from the website tables.
create extension if not exists pgcrypto;

create table if not exists public.mpsq_clients (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.mpsq_cameras (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.mpsq_clients(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('STATIC', 'BODYCAM')),
  dimension text not null default 'minecraft:overworld',
  x double precision,
  y double precision,
  z double precision,
  yaw real not null default 0,
  pitch real not null default 0,
  body_owner_id uuid references public.mpsq_clients(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mpsq_screen_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.mpsq_clients(id) on delete cascade,
  activation_code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.mpsq_screens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.mpsq_clients(id) on delete cascade,
  name text not null,
  mode text not null check (mode in ('KINO', 'CAMERA')),
  dimension text not null,
  pos1_x integer not null, pos1_y integer not null, pos1_z integer not null,
  pos2_x integer not null, pos2_y integer not null, pos2_z integer not null,
  activation_code text not null unique,
  group_id uuid references public.mpsq_screen_groups(id) on delete set null,
  cinema_url text not null default '',
  playback_state jsonb not null default '{"playing":false,"positionMs":0,"revision":0}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mpsq_screen_cameras (
  screen_id uuid not null references public.mpsq_screens(id) on delete cascade,
  camera_id uuid not null references public.mpsq_cameras(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (screen_id, camera_id)
);

create table if not exists public.mpsq_screen_members (
  screen_id uuid not null references public.mpsq_screens(id) on delete cascade,
  client_id uuid not null references public.mpsq_clients(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (screen_id, client_id)
);

alter table public.mpsq_clients enable row level security;
alter table public.mpsq_cameras enable row level security;
alter table public.mpsq_screen_groups enable row level security;
alter table public.mpsq_screens enable row level security;
alter table public.mpsq_screen_cameras enable row level security;
alter table public.mpsq_screen_members enable row level security;

-- The mod never accesses PostgREST directly; only the Edge Function uses service role access.
create index if not exists mpsq_cameras_owner_idx on public.mpsq_cameras(owner_id);
create index if not exists mpsq_screens_owner_idx on public.mpsq_screens(owner_id);
create index if not exists mpsq_screens_group_idx on public.mpsq_screens(group_id);
create index if not exists mpsq_members_client_idx on public.mpsq_screen_members(client_id);

insert into storage.buckets (id, name, public)
values ('mpsq_live', 'mpsq_live', false)
on conflict (id) do nothing;
