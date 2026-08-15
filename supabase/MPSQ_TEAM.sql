-- MPSQ Team: execute this once in the Supabase SQL editor.
-- The Edge Function uses the service-role key; these tables have no public RLS policies.

create table if not exists public.mpsq_team_profiles (
  client_id uuid primary key references public.mpsq_clients(id) on delete cascade,
  base_rank text not null default 'spieler' check (base_rank in ('vip','spieler','001','soldat','arbeiter','offizier','frontman','sr_offizier')),
  active_rank text null check (active_rank in ('vip','001')),
  updated_at timestamptz not null default now()
);

create table if not exists public.mpsq_team_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.mpsq_clients(id) on delete cascade,
  message text not null check (char_length(message) between 1 and 256),
  created_at timestamptz not null default now()
);
create index if not exists mpsq_team_messages_created_at_idx on public.mpsq_team_messages(created_at desc);

-- Short-lived active camera records for the lower-right live indicator.
create table if not exists public.mpsq_team_camera_presence (
  camera_id uuid primary key references public.mpsq_cameras(id) on delete cascade,
  viewer_id uuid not null references public.mpsq_clients(id) on delete cascade,
  updated_at timestamptz not null default now()
);
create index if not exists mpsq_team_camera_presence_updated_idx
  on public.mpsq_team_camera_presence(updated_at desc);

create table if not exists public.mpsq_team_todos (
  id uuid primary key default gen_random_uuid(),
  text text not null check (char_length(text) between 1 and 256),
  done boolean not null default false,
  created_by uuid references public.mpsq_clients(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.mpsq_team_timer (
  id smallint primary key check (id = 1),
  running boolean not null default false,
  ends_at timestamptz null,
  label text not null default '',
  updated_by uuid references public.mpsq_clients(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.mpsq_team_timer (id) values (1) on conflict (id) do nothing;

create table if not exists public.mpsq_team_templates (
  id uuid primary key default gen_random_uuid(),
  text text not null check (char_length(text) between 1 and 256),
  minimum_rank text not null default 'offizier' check (minimum_rank in ('vip','spieler','001','soldat','arbeiter','offizier','frontman','sr_offizier')),
  created_by uuid references public.mpsq_clients(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.mpsq_team_profiles enable row level security;
alter table public.mpsq_team_messages enable row level security;
alter table public.mpsq_team_camera_presence enable row level security;
alter table public.mpsq_team_todos enable row level security;
alter table public.mpsq_team_timer enable row level security;
alter table public.mpsq_team_templates enable row level security;

-- First administrator setup: replace the Minecraft name, run once, then remove this line.
-- update public.mpsq_team_profiles set base_rank = 'sr_offizier', active_rank = null
-- where client_id = (select id from public.mpsq_clients where display_name = 'DEIN_MINECRAFT_NAME' limit 1);

-- ---------------------------------------------------------------------------
-- MPSQ Team security and rank approval system.
--
-- IMPORTANT: no Minecraft name in this file automatically receives a rank.
-- `MP_SquidGame` is only the label used by the private root-binding screen.
-- After that screen has bound the real client id once, the root is tied to that
-- id and cannot be reassigned through the normal Team API.
-- ---------------------------------------------------------------------------
create table if not exists public.mpsq_team_root (
  id smallint primary key check (id = 1),
  root_display_name text not null default 'MP_SquidGame',
  root_client_id uuid unique references public.mpsq_clients(id) on delete restrict,
  bound_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.mpsq_team_root (id, root_display_name)
values (1, 'MP_SquidGame')
on conflict (id) do update set root_display_name = excluded.root_display_name;

create table if not exists public.mpsq_team_rank_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references public.mpsq_clients(id) on delete cascade,
  target_id uuid not null references public.mpsq_clients(id) on delete cascade,
  requested_rank text not null check (requested_rank in ('vip','spieler','soldat','arbeiter','offizier','frontman')),
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED','CANCELLED','EXPIRED')),
  previous_base_rank text not null,
  decided_by uuid references public.mpsq_clients(id) on delete set null,
  decided_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists mpsq_team_rank_requests_pending_idx
  on public.mpsq_team_rank_requests(status, created_at desc);
-- Makes rerunning this migration safe when an earlier test version only
-- allowed staff ranks in a request.
alter table public.mpsq_team_rank_requests
  drop constraint if exists mpsq_team_rank_requests_requested_rank_check;
alter table public.mpsq_team_rank_requests
  add constraint mpsq_team_rank_requests_requested_rank_check
  check (requested_rank in ('vip','spieler','soldat','arbeiter','offizier','frontman'));

create table if not exists public.mpsq_team_rank_log (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.mpsq_team_rank_requests(id) on delete set null,
  actor_id uuid references public.mpsq_clients(id) on delete set null,
  target_id uuid not null references public.mpsq_clients(id) on delete cascade,
  old_base_rank text not null,
  old_active_rank text,
  new_base_rank text not null,
  new_active_rank text,
  action text not null check (action in ('APPROVED','REJECTED','ROOT_BOUND','AUTO_VIP','EVENT_001','DIRECT_CHANGE')),
  created_at timestamptz not null default now()
);
create index if not exists mpsq_team_rank_log_created_idx
  on public.mpsq_team_rank_log(created_at desc);

alter table public.mpsq_team_root enable row level security;
alter table public.mpsq_team_rank_requests enable row level security;
alter table public.mpsq_team_rank_log enable row level security;

-- Applies safely to databases created before DIRECT_CHANGE existed.
alter table public.mpsq_team_rank_log drop constraint if exists mpsq_team_rank_log_action_check;
alter table public.mpsq_team_rank_log add constraint mpsq_team_rank_log_action_check
  check (action in ('APPROVED','REJECTED','ROOT_BOUND','AUTO_VIP','EVENT_001','DIRECT_CHANGE'));

-- The Edge Function uses the service role. Do not add public policies to these
-- tables: rank requests and the audit log must never be readable directly.
