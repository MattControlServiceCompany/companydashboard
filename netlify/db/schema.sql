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
  updated_by  text,
  updated_at  timestamptz not null default now()
);

comment on table public.kv is
  'Shared-backend replication target for CompanyHub app/db.js. One row per '
  'sset()/sget() key. version is the optimistic-concurrency counter — the '
  'Function does UPDATE ... WHERE key=$1 AND version=$2, never a blind write.';

-- Lock the table down completely. No policies = no access for anon/
-- authenticated roles. Only service_role (the secret key, held ONLY by the
-- Netlify Function's server-side env) can read/write — service_role bypasses
-- RLS entirely in Supabase's PostgREST layer regardless of policies present.
alter table public.kv enable row level security;
-- (Deliberately no `create policy` statements — see comment above.)

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
-- select * from storage.buckets where id = 'pdf_blobs';
-- -- expect one row, public = false
-- ============================================================
