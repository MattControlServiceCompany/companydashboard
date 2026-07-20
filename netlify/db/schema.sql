-- ============================================================
-- CompanyHub shared-backend slice — kv table + pdf_blobs bucket
-- Run once in Supabase SQL editor (project rrdugvwxtddjywqykphf).
-- ============================================================

-- One row per storage key, mirroring app/db.js's IndexedDB `kv` object
-- store 1:1. `value` holds the same JSON blob sset()/sget() already pass
-- around (en_utility_{projId}, en_projects, en_eqmatrix_{projId}, ...).
create table if not exists public.kv (
  key         text primary key,
  value       jsonb not null,
  version     bigint not null default 1,
  hash        text,
  deleted     boolean not null default false,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

comment on table public.kv is
  'Shared-backend replication target for CompanyHub app/db.js. One row per '
  'sset()/sget() key. version is the optimistic-concurrency counter — the '
  'Function does UPDATE ... WHERE key=$1 AND version=$2, never a blind write.';

comment on column public.kv.hash is
  'SHA-256 of a canonical (stable-key-sorted) JSON serialization of `value`, '
  'computed server-side by kv-sync.js at write time. Never recomputed from '
  'raw jsonb at read time (jsonb key order is unstable) — see kv-sync.js '
  'header, finding F8. NULL for rows written before this column existed, '
  'until their next write.';

comment on column public.kv.deleted is
  'CAS-checked tombstone flag (supabase-migration-plan-FINAL-2026-07-19.md '
  '§3, integration #1). Set true by a tombstone PUT; the row is NEVER '
  'physically removed. Any normal (non-tombstone) write sets this back to '
  'false, which is how "Restore my version" un-deletes a key.';

-- Phase 2a additive migration for the LIVE table (the CREATE above already
-- includes these columns for a fresh install; these ALTERs are the
-- idempotent no-op-on-fresh-install / apply-to-live-table path).
alter table public.kv add column if not exists hash text;
alter table public.kv add column if not exists deleted boolean not null default false;

-- Lock the table down completely. No policies = no access for anon/
-- authenticated roles. Only service_role (the secret key, held ONLY by the
-- Netlify Function's server-side env) can read/write — service_role bypasses
-- RLS entirely in Supabase's PostgREST layer regardless of policies present.
alter table public.kv enable row level security;
-- (Deliberately no `create policy` statements — see comment above.)

-- ============================================================
-- kv_history — server-side snapshot-on-explicit-overwrite audit trail
-- (supabase-migration-plan-FINAL-2026-07-19.md §5, finding F10).
-- Written ONLY when a PUT is flagged `explicitOverwrite: true` (the user
-- chose "Overwrite with mine" in the 409 conflict modal) — never on every
-- write. Retention is enforced by kv-sync.js after each insert: at most
-- HISTORY_MAX_PER_KEY (20) rows per key, and nothing older than
-- HISTORY_MAX_AGE_DAYS (30) days, so the free-tier DB stays bounded.
-- ============================================================
create table if not exists public.kv_history (
  id           bigint generated always as identity primary key,
  key          text not null,
  value        jsonb,
  version      bigint not null,
  updated_by   text,
  replaced_at  timestamptz not null default now()
);

comment on table public.kv_history is
  'Snapshot of a kv row taken immediately before an explicit conflict-'
  'resolution overwrite. Not a full write-audit log — scoped and retention-'
  'capped, see kv-sync.js snapshotHistory()/enforceHistoryRetention().';

create index if not exists kv_history_key_replaced_at_idx
  on public.kv_history (key, replaced_at desc);

alter table public.kv_history enable row level security;
-- (Deliberately no `create policy` statements — service_role only, same
-- reasoning as the kv table above.)

-- Private bucket for bill PDF blobs, mirroring the existing separate
-- `en_pdf_store` IndexedDB store (kept out of the small-value kv table
-- exactly like it's kept out of the small-value IDB cache today).
-- Out-of-scope for THIS slice's client wiring (item 3 below only wires
-- kv, not PDFs) — created now so the schema is complete and Phase 3
-- migration doesn't need a second SQL pass.
insert into storage.buckets (id, name, public)
values ('pdf_blobs', 'pdf_blobs', false)
on conflict (id) do nothing;

-- storage.objects already has RLS enabled by default in every Supabase
-- project. No policies are added for the pdf_blobs bucket, so — same
-- reasoning as above — only service_role can read/write objects in it.

-- ============================================================
-- Verification query (run after the above, still in the SQL editor,
-- to confirm lockout):
--
-- select tablename, rowsecurity from pg_tables where tablename = 'kv';
-- -- expect rowsecurity = true
-- select tablename, rowsecurity from pg_tables where tablename = 'kv_history';
-- -- expect rowsecurity = true
-- select column_name from information_schema.columns
-- where table_name = 'kv' and column_name in ('hash','deleted');
-- -- expect both rows present
-- select * from storage.buckets where id = 'pdf_blobs';
-- -- expect one row, public = false
-- ============================================================
