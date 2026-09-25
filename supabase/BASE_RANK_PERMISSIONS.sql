-- Rangberechtigungen für bestehende MPSQ-Knopfaktionen korrigieren.
-- Führt die Berechtigungsprüfung ausschließlich über base_rank aus.
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
 select coalesce(base_rank,'spieler') into actor_rank from public.mpsq_team_profiles where client_id=p_actor;
 if not (ranks ? t.minimum_rank) or coalesce((ranks->>actor_rank)::integer,-1)<(ranks->>t.minimum_rank)::integer then raise exception 'Keine Berechtigung'; end if;
 if t.last_fired_at > now()-interval '2 seconds' then return jsonb_build_object('cooldown',true); end if;
 update public.mpsq_action_triggers set last_fired_at=now() where id=t.id;
 insert into public.mpsq_action_events(trigger_id,server_id,world_id,actor_id,action_type,action_data)
 values(t.id,t.server_id,t.world_id,p_actor,t.action_type,t.action_data) returning * into e;
 return to_jsonb(e);
end $$;
revoke all on function public.mpsq_fire_action(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.mpsq_fire_action(uuid,uuid,text,text) to service_role;

