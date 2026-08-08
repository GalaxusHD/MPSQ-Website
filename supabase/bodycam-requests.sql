-- Paket 3.5: Bodycam-Anfragen. Einmal im Supabase SQL Editor ausführen.
create table if not exists public.mpsq_bodycam_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.mpsq_clients(id) on delete cascade,
  target_id uuid not null references public.mpsq_clients(id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'DECLINED')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (requester_id, target_id, status)
);

alter table public.mpsq_bodycam_requests enable row level security;
create index if not exists mpsq_bodycam_target_idx on public.mpsq_bodycam_requests(target_id, status);
