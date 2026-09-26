begin;

alter table public.mpsq_world_npcs
  add column if not exists task_type text not null default 'none';
alter table public.mpsq_world_npcs drop constraint if exists mpsq_world_npcs_task_type_check;
alter table public.mpsq_world_npcs add constraint mpsq_world_npcs_task_type_check
  check (task_type in ('none','accessories','tutorial','quest'));
alter table public.mpsq_accessories add column if not exists price_points integer not null default 500 check (price_points >= 0);

create table if not exists public.mpsq_point_accounts (
  client_id uuid primary key references public.mpsq_clients(id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);
create table if not exists public.mpsq_point_ledger (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.mpsq_clients(id) on delete cascade,
  amount bigint not null,
  reason text not null,
  source_type text not null,
  source_id uuid not null,
  created_at timestamptz not null default now(),
  unique (client_id, source_type, source_id)
);
create table if not exists public.mpsq_tutorial_completions (
  client_id uuid primary key references public.mpsq_clients(id) on delete cascade,
  npc_id uuid not null references public.mpsq_world_npcs(id) on delete cascade,
  completed_at timestamptz not null default now()
);
create unique index if not exists mpsq_tutorial_completions_client_once_idx
  on public.mpsq_tutorial_completions(client_id);

create table if not exists public.mpsq_quests (
  id uuid primary key default gen_random_uuid(),
  npc_id uuid not null references public.mpsq_world_npcs(id) on delete cascade,
  title text not null check (length(title) between 1 and 80),
  icon_item text not null default 'minecraft:paper',
  objective_item text not null,
  target_count integer not null check (target_count between 1 and 1000000),
  reward_points integer not null default 0 check (reward_points >= 0),
  reward_accessory_id uuid references public.mpsq_accessories(id) on delete set null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  check ((reward_points > 0 and reward_accessory_id is null) or (reward_points = 0 and reward_accessory_id is not null))
);
create table if not exists public.mpsq_user_quests (
  client_id uuid not null references public.mpsq_clients(id) on delete cascade,
  quest_id uuid not null references public.mpsq_quests(id) on delete cascade,
  progress integer not null default 0 check (progress >= 0),
  accepted_at timestamptz not null default now(),
  claimed_at timestamptz,
  primary key (client_id, quest_id)
);
alter table public.mpsq_quests enable row level security;
alter table public.mpsq_user_quests enable row level security;
revoke all on public.mpsq_quests, public.mpsq_user_quests from anon, authenticated;

alter table public.mpsq_point_accounts enable row level security;
alter table public.mpsq_point_ledger enable row level security;
alter table public.mpsq_tutorial_completions enable row level security;
revoke all on public.mpsq_point_accounts, public.mpsq_point_ledger, public.mpsq_tutorial_completions from anon, authenticated;

create or replace function public.mpsq_complete_tutorial(
  p_client_id uuid, p_npc_id uuid, p_server_id text, p_world_id text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  inserted_count integer;
  current_balance bigint;
begin
  if not exists (
    select 1 from public.mpsq_world_npcs n
    where n.id = p_npc_id and n.task_type = 'tutorial'
      and n.server_id = lower(p_server_id) and n.world_id = p_world_id
  ) then
    raise exception 'Tutorial-NPC nicht gefunden';
  end if;

  insert into public.mpsq_tutorial_completions(client_id,npc_id)
  values (p_client_id,p_npc_id) on conflict (client_id) do nothing;
  get diagnostics inserted_count = row_count;

  if inserted_count > 0 then
    insert into public.mpsq_point_ledger(client_id,amount,reason,source_type,source_id)
    values (p_client_id,1000,'Tutorial abgeschlossen','tutorial',p_npc_id)
    on conflict (client_id,source_type,source_id) do nothing;
    if found then
      insert into public.mpsq_point_accounts(client_id,balance,updated_at)
      values (p_client_id,1000,now())
      on conflict (client_id) do update set balance=public.mpsq_point_accounts.balance+1000,updated_at=now();
    end if;
  end if;

  select coalesce(a.balance,0) into current_balance
  from public.mpsq_point_accounts a where a.client_id=p_client_id;
  return jsonb_build_object('completed',true,'awarded',inserted_count>0,'points',coalesce(current_balance,0));
end;
$$;
revoke all on function public.mpsq_complete_tutorial(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.mpsq_complete_tutorial(uuid,uuid,text,text) to service_role;

create or replace function public.mpsq_buy_accessory(p_client_id uuid, p_accessory_id uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  price integer;
  current_balance bigint;
begin
  select price_points into price from public.mpsq_accessories where id=p_accessory_id;
  if not found then raise exception 'Accessoire nicht gefunden'; end if;
  if exists(select 1 from public.mpsq_user_accessories where client_id=p_client_id and accessory_id=p_accessory_id) then
    raise exception 'Dieses Accessoire besitzt du bereits';
  end if;
  select balance into current_balance from public.mpsq_point_accounts where client_id=p_client_id for update;
  if current_balance is null or current_balance < price then raise exception 'Nicht genügend MPSQ-Punkte'; end if;
  update public.mpsq_point_accounts set balance=balance-price,updated_at=now() where client_id=p_client_id;
  insert into public.mpsq_user_accessories(client_id,accessory_id) values(p_client_id,p_accessory_id);
  insert into public.mpsq_point_ledger(client_id,amount,reason,source_type,source_id)
    values(p_client_id,-price,'Accessoire gekauft','accessory_purchase',p_accessory_id);
  select balance into current_balance from public.mpsq_point_accounts where client_id=p_client_id;
  return jsonb_build_object('purchased',true,'points',current_balance);
end;
$$;
revoke all on function public.mpsq_buy_accessory(uuid,uuid) from public, anon, authenticated;
grant execute on function public.mpsq_buy_accessory(uuid,uuid) to service_role;

create or replace function public.mpsq_accept_quest(p_client_id uuid,p_quest_id uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
begin
  if not exists(select 1 from public.mpsq_quests where id=p_quest_id and enabled) then raise exception 'Quest nicht verfügbar'; end if;
  insert into public.mpsq_user_quests(client_id,quest_id) values(p_client_id,p_quest_id) on conflict do nothing;
  return jsonb_build_object('accepted',true);
end;
$$;
revoke all on function public.mpsq_accept_quest(uuid,uuid) from public, anon, authenticated;
grant execute on function public.mpsq_accept_quest(uuid,uuid) to service_role;

create or replace function public.mpsq_update_quest_progress(p_client_id uuid,p_quest_id uuid,p_progress integer)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare target integer; current_progress integer;
begin
  select target_count into target from public.mpsq_quests where id=p_quest_id and enabled;
  if target is null then raise exception 'Quest nicht verfügbar'; end if;
  if p_progress < 0 or p_progress > target then raise exception 'Fortschritt ungültig'; end if;
  update public.mpsq_user_quests set progress=greatest(progress,p_progress)
   where client_id=p_client_id and quest_id=p_quest_id returning progress into current_progress;
  if current_progress is null then raise exception 'Quest wurde noch nicht angenommen'; end if;
  return jsonb_build_object('progress',current_progress,'target',target,'completed',current_progress>=target);
end;
$$;
revoke all on function public.mpsq_update_quest_progress(uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.mpsq_update_quest_progress(uuid,uuid,integer) to service_role;

create or replace function public.mpsq_claim_quest(p_client_id uuid,p_quest_id uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare state public.mpsq_user_quests%rowtype; quest public.mpsq_quests%rowtype; current_balance bigint;
begin
  select * into state from public.mpsq_user_quests where client_id=p_client_id and quest_id=p_quest_id for update;
  if not found then raise exception 'Quest wurde nicht angenommen'; end if;
  select * into quest from public.mpsq_quests where id=p_quest_id;
  if state.claimed_at is not null then raise exception 'Belohnung wurde bereits abgeholt'; end if;
  if state.progress < quest.target_count then raise exception 'Quest noch nicht abgeschlossen'; end if;
  if quest.reward_accessory_id is not null and exists(
    select 1 from public.mpsq_user_accessories where client_id=p_client_id and accessory_id=quest.reward_accessory_id
  ) then raise exception 'Dieses Belohnungs-Accessoire besitzt du bereits'; end if;
  update public.mpsq_user_quests set claimed_at=now() where client_id=p_client_id and quest_id=p_quest_id;
  if quest.reward_points > 0 then
    insert into public.mpsq_point_ledger(client_id,amount,reason,source_type,source_id)
      values(p_client_id,quest.reward_points,'Questbelohnung','quest',quest.id);
    insert into public.mpsq_point_accounts(client_id,balance,updated_at) values(p_client_id,quest.reward_points,now())
      on conflict(client_id) do update set balance=public.mpsq_point_accounts.balance+quest.reward_points,updated_at=now();
  else
    insert into public.mpsq_user_accessories(client_id,accessory_id) values(p_client_id,quest.reward_accessory_id)
      on conflict(client_id,accessory_id) do nothing;
  end if;
  select coalesce((select balance from public.mpsq_point_accounts where client_id=p_client_id),0) into current_balance;
  return jsonb_build_object('claimed',true,'points',current_balance,'reward_points',quest.reward_points,'reward_accessory_id',quest.reward_accessory_id);
end;
$$;
revoke all on function public.mpsq_claim_quest(uuid,uuid) from public, anon, authenticated;
grant execute on function public.mpsq_claim_quest(uuid,uuid) to service_role;

create or replace function public.mpsq_grant_points(p_client_id uuid,p_amount integer)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare current_balance bigint; grant_id uuid := gen_random_uuid();
begin
  if p_amount < 1 or p_amount > 10000 then raise exception 'Punkte müssen zwischen 1 und 10000 liegen'; end if;
  insert into public.mpsq_point_ledger(client_id,amount,reason,source_type,source_id)
    values(p_client_id,p_amount,'Team-Punktgutschrift','staff_grant',grant_id);
  insert into public.mpsq_point_accounts(client_id,balance,updated_at)
    values(p_client_id,p_amount,now())
    on conflict(client_id) do update set balance=public.mpsq_point_accounts.balance+p_amount,updated_at=now()
    returning balance into current_balance;
  return jsonb_build_object('points',current_balance,'added',p_amount);
end;
$$;
revoke all on function public.mpsq_grant_points(uuid,integer) from public, anon, authenticated;
grant execute on function public.mpsq_grant_points(uuid,integer) to service_role;

commit;

