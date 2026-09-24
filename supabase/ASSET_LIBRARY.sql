-- Run after ASSETS.sql. Extends the original model/JAR store into the central asset library.
insert into storage.buckets(id,name,public,file_size_limit)
values('mpsq-assets','mpsq-assets',true,33554432)
on conflict(id) do update set public=true,file_size_limit=33554432;

alter table public.mpsq_assets add column if not exists category text not null default 'shared';
alter table public.mpsq_assets add column if not exists behavior text not null default 'decoration';
alter table public.mpsq_assets drop constraint if exists mpsq_assets_kind_check;
alter table public.mpsq_assets drop constraint if exists mpsq_assets_category_check;
alter table public.mpsq_assets drop constraint if exists mpsq_assets_behavior_check;
alter table public.mpsq_assets add constraint mpsq_assets_kind_check check(kind in ('model','jar','sound','npc_skin'));
alter table public.mpsq_assets add constraint mpsq_assets_category_check check(category in ('shared','furniture','accessory','sound','npc_skin','mod_release'));
alter table public.mpsq_assets add constraint mpsq_assets_behavior_check check(behavior in ('decoration','interactive'));
create index if not exists mpsq_assets_category_created_idx on public.mpsq_assets(category,created_at desc);
