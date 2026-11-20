-- Kitchen Ledger online copy. Paste the whole file into Supabase:
-- SQL Editor > New query > Run. It is safe to run again.
--
-- One sign-in (a Supabase Auth user) per business. Every device of that
-- business signs in with it and sees only that business's rows.

create table if not exists public.ledger_records (
  owner       uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  kind        text        not null check (kind in ('item', 'supplier', 'recipe', 'order', 'meta')),
  key         text        not null,          -- e.g. item: "supplier||name" in lower case
  data        jsonb,                          -- the record; null when deleted
  fp          text        not null,           -- fingerprint of data, to spot changes cheaply
  deleted     boolean     not null default false,
  rev         bigint      not null default 0, -- set by the server on every write
  updated_at  timestamptz not null default now(),
  updated_by  text        not null default '', -- the computer's name, e.g. "iMac 1"
  primary key (owner, kind, key)
);

create sequence if not exists public.ledger_records_rev_seq;

-- The server numbers every write, so devices fetch "everything after rev N"
-- without trusting any device's clock.
create or replace function public.ledger_records_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- One write at a time per business, held until it commits, so numbers are
  -- committed in order and a device never skips a write that was still saving.
  perform pg_advisory_xact_lock(hashtext('ledger_records:' || coalesce(auth.uid()::text, '')));
  new.owner := auth.uid();
  -- A deletion is final: an upload that would bring a deleted record back
  -- (from a device that hadn't heard of the deletion yet) keeps it deleted.
  -- The new number makes every device fetch the deletion again.
  if tg_op = 'UPDATE' and old.deleted and not new.deleted then
    new.data := old.data; new.fp := old.fp; new.deleted := true;
  end if;
  new.rev := nextval('public.ledger_records_rev_seq');
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists ledger_records_stamp on public.ledger_records;
create trigger ledger_records_stamp before insert or update on public.ledger_records
  for each row execute function public.ledger_records_stamp();

create index if not exists ledger_records_owner_rev on public.ledger_records (owner, rev);

alter table public.ledger_records enable row level security;

drop policy if exists "own rows: read"   on public.ledger_records;
drop policy if exists "own rows: insert" on public.ledger_records;
drop policy if exists "own rows: update" on public.ledger_records;
create policy "own rows: read"   on public.ledger_records for select to authenticated using (owner = auth.uid());
create policy "own rows: insert" on public.ledger_records for insert to authenticated with check (owner = auth.uid());
create policy "own rows: update" on public.ledger_records for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
-- No delete policy: deletions are kept as rows with deleted = true, so every
-- device learns about them and an import never brings the record back.

revoke all on public.ledger_records from anon;
grant select, insert, update on public.ledger_records to authenticated;
