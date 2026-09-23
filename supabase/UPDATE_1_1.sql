-- MPSQ 1.1 update for an existing MPSQ project. Run once before deploying index.ts.
begin;

-- TRIGGER_SYSTEM.sql
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


-- MPSQ_FEATURES.sql
-- MPSQ 1.1 shared content foundations
create table if not exists public.mpsq_playlists (
  id uuid primary key default gen_random_uuid(), name text unique not null,
  tracks jsonb not null default '[]'::jsonb, enabled boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.mpsq_accessories (
  id uuid primary key default gen_random_uuid(), accessory_key text unique not null,
  display_name text not null, model_id text not null, description text not null default '',
  visible_to_all_clients boolean not null default true, created_at timestamptz not null default now()
);
create table if not exists public.mpsq_user_accessories (
  client_id uuid not null references public.mpsq_clients(id) on delete cascade,
  accessory_id uuid not null references public.mpsq_accessories(id) on delete cascade,
  redeemed_code text, granted_at timestamptz not null default now(),
  primary key (client_id, accessory_id)
);
create table if not exists public.mpsq_redeem_codes (
  code text primary key, accessory_id uuid not null references public.mpsq_accessories(id),
  max_uses integer null, used_count integer not null default 0,
  expires_at timestamptz null, enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.mpsq_bossbars (
  id text primary key, title text not null, color text not null default 'purple',
  value double precision not null default 1, visible boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.mpsq_playlists enable row level security;
alter table public.mpsq_accessories enable row level security;
alter table public.mpsq_user_accessories enable row level security;
alter table public.mpsq_redeem_codes enable row level security;
alter table public.mpsq_bossbars enable row level security;


-- ACTION_EVENTS.sql
-- Run after TRIGGER_SYSTEM.sql. Existing triggers must be assigned a scope before use.
alter table public.mpsq_action_triggers add column if not exists server_id text not null default '';
alter table public.mpsq_action_triggers add column if not exists last_fired_at timestamptz;
create table if not exists public.mpsq_action_events (
 id bigint generated always as identity primary key,
 trigger_id uuid not null references public.mpsq_action_triggers(id) on delete cascade,
 server_id text not null, world_id text not null,
 actor_id uuid not null references public.mpsq_clients(id),
 action_type text not null, action_data jsonb not null,
 created_at timestamptz not null default now()
);
create index if not exists mpsq_action_events_scope on public.mpsq_action_events(server_id,world_id,id);
alter table public.mpsq_action_events enable row level security;
revoke all on public.mpsq_action_events from anon, authenticated;
create or replace function public.mpsq_fire_action(p_trigger uuid, p_actor uuid, p_server text, p_world text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.mpsq_action_triggers; e public.mpsq_action_events;
 actor_rank text;
 ranks jsonb := '{"vip":0,"spieler":1,"streamer":2,"001":3,"soldat":4,"arbeiter":5,"offizier":6,"frontman":7,"sr_offizier":8}';
begin
 perform pg_advisory_xact_lock(hashtextextended(p_server || '|' || p_world, 0));
 select * into t from public.mpsq_action_triggers where id=p_trigger for update;
 if not found or not t.enabled or t.server_id<>p_server or t.world_id<>p_world then
   raise exception 'Trigger nicht verfügbar';
 end if;
 select case when base_rank='sr_offizier' then base_rank else coalesce(active_rank,base_rank) end into actor_rank from public.mpsq_team_profiles where client_id=p_actor;
 if not (ranks ? t.minimum_rank) or coalesce((ranks->>actor_rank)::integer,-1)<(ranks->>t.minimum_rank)::integer then raise exception 'Keine Berechtigung'; end if;
 if t.last_fired_at > now()-interval '2 seconds' then return jsonb_build_object('cooldown',true); end if;
 update public.mpsq_action_triggers set last_fired_at=now() where id=t.id;
 insert into public.mpsq_action_events(trigger_id,server_id,world_id,actor_id,action_type,action_data)
 values(t.id,t.server_id,t.world_id,p_actor,t.action_type,t.action_data) returning * into e;
 return to_jsonb(e);
end $$;
revoke all on function public.mpsq_fire_action(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.mpsq_fire_action(uuid,uuid,text,text) to service_role;

-- Scope uniqueness includes the server, avoiding cross-server coordinate collisions.
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='public.mpsq_action_triggers'::regclass and contype='u' and pg_get_constraintdef(oid)='UNIQUE (world_id, pos_x, pos_y, pos_z)'
 loop execute format('alter table public.mpsq_action_triggers drop constraint %I',c.conname); end loop;
end $$;
create unique index if not exists mpsq_trigger_scope_position on public.mpsq_action_triggers(server_id,world_id,pos_x,pos_y,pos_z);


-- REDEEM_ATOMIC.sql
create table if not exists public.mpsq_redeem_attempts(client_id uuid primary key references public.mpsq_clients(id) on delete cascade, window_start timestamptz not null default now(), attempts integer not null default 0);
alter table public.mpsq_redeem_attempts enable row level security;
revoke all on public.mpsq_redeem_attempts from anon,authenticated;
-- Run after MPSQ_FEATURES.sql. Grant and usage counter commit together.
create or replace function public.mpsq_redeem(p_client uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.mpsq_redeem_codes; a public.mpsq_accessories; limiter public.mpsq_redeem_attempts;
begin
  insert into public.mpsq_redeem_attempts(client_id) values(p_client) on conflict do nothing;
  select * into limiter from public.mpsq_redeem_attempts where client_id=p_client for update;
  if limiter.window_start>now()-interval '1 minute' and limiter.attempts>=10 then return jsonb_build_object('error','Zu viele Versuche. Bitte eine Minute warten.'); end if;
  update public.mpsq_redeem_attempts set attempts=case when window_start<=now()-interval '1 minute' then 1 else attempts+1 end,window_start=case when window_start<=now()-interval '1 minute' then now() else window_start end where client_id=p_client;
  select * into r from public.mpsq_redeem_codes where code=upper(trim(p_code)) for update;
  if not found or not r.enabled then return jsonb_build_object('error','Code ungültig'); end if;
  if r.expires_at is not null and r.expires_at<=now() then return jsonb_build_object('error','Code abgelaufen'); end if;
  if r.max_uses is not null and r.used_count>=r.max_uses then return jsonb_build_object('error','Code vollständig verwendet'); end if;
  if exists(select 1 from public.mpsq_user_accessories where client_id=p_client and accessory_id=r.accessory_id) then
    return jsonb_build_object('error','Accessoire bereits freigeschaltet');
  end if;
  insert into public.mpsq_user_accessories(client_id,accessory_id,redeemed_code) values(p_client,r.accessory_id,r.code)
  on conflict do nothing;
  if not found then return jsonb_build_object('error','Accessoire bereits freigeschaltet'); end if;
  update public.mpsq_redeem_codes set used_count=used_count+1 where code=r.code;
  select * into a from public.mpsq_accessories where id=r.accessory_id;
  return jsonb_build_object('ok',true,'accessoryName',a.display_name,'modelId',a.model_id);
end $$;
revoke all on function public.mpsq_redeem(uuid,text) from public, anon, authenticated;
grant execute on function public.mpsq_redeem(uuid,text) to service_role;


-- ASSETS.sql
-- Run after MPSQ_FEATURES.sql.
insert into storage.buckets(id,name,public,file_size_limit)
values('mpsq-assets','mpsq-assets',true,33554432)
on conflict(id) do update set public=true,file_size_limit=33554432;
create table if not exists public.mpsq_assets (
 id text primary key, kind text not null check(kind in ('model','jar')),
 path text not null, filename text not null, created_at timestamptz not null default now()
);
alter table public.mpsq_assets enable row level security;
revoke all on public.mpsq_assets from anon,authenticated;
alter table public.mpsq_user_accessories add column if not exists equipped boolean not null default false;
create unique index if not exists mpsq_one_equipped_accessory on public.mpsq_user_accessories(client_id) where equipped;
create or replace function public.mpsq_equip_accessory(p_client uuid,p_accessory uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 perform 1 from public.mpsq_clients where id=p_client for update;
 if p_accessory is not null and not exists(select 1 from public.mpsq_user_accessories where client_id=p_client and accessory_id=p_accessory) then
  raise exception 'Accessoire nicht freigeschaltet';
 end if;
 update public.mpsq_user_accessories set equipped=false where client_id=p_client;
 update public.mpsq_user_accessories set equipped=true where client_id=p_client and accessory_id=p_accessory;
 return true;
end $$;
revoke all on function public.mpsq_equip_accessory(uuid,uuid) from public,anon,authenticated;
grant execute on function public.mpsq_equip_accessory(uuid,uuid) to service_role;


-- EVENT_CONTROLS.sql
-- Run after ACTION_EVENTS.sql.
alter table public.mpsq_action_events alter column trigger_id drop not null;
alter table public.mpsq_team_templates add column if not exists sound_id text;
create or replace function public.mpsq_publish_action(p_actor uuid,p_server text,p_world text,p_type text,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public.mpsq_action_events;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_server||'|'||p_world,0));
 if exists(select 1 from public.mpsq_action_events where actor_id=p_actor and created_at>now()-interval '1 second') then
  return jsonb_build_object('cooldown',true);
 end if;
 insert into public.mpsq_action_events(actor_id,server_id,world_id,action_type,action_data)
 values(p_actor,p_server,p_world,p_type,p_data) returning * into e;
 return to_jsonb(e);
end $$;
revoke all on function public.mpsq_publish_action(uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.mpsq_publish_action(uuid,text,text,text,jsonb) to service_role;
create table if not exists public.mpsq_calendar (
 id uuid primary key default gen_random_uuid(), title text not null,
 starts_at timestamptz not null, description text not null default '',
 created_by uuid not null references public.mpsq_clients(id),
 created_at timestamptz not null default now()
);
alter table public.mpsq_calendar enable row level security;
revoke all on public.mpsq_calendar from anon,authenticated;


-- WORLD_OBJECTS.sql
create table if not exists public.mpsq_world_objects (
 id uuid primary key default gen_random_uuid(), server_id text not null, world_id text not null,
 x integer not null,y integer not null,z integer not null, model_id text not null references public.mpsq_assets(id),
 rotation integer not null default 0, category text not null default 'furniture',
 created_by uuid not null references public.mpsq_clients(id),
 unique(server_id,world_id,x,y,z)
);
alter table public.mpsq_world_objects enable row level security;
revoke all on public.mpsq_world_objects from anon,authenticated;


-- RANK_LOG_DETAILS.sql
alter table public.mpsq_team_rank_log add column if not exists actor_rank text;
alter table public.mpsq_team_rank_log add column if not exists actor_name text;
alter table public.mpsq_team_rank_log add column if not exists target_name text;

commit;