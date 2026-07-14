-- 001_veto_system.sql
-- KASTLR Veto Service — own, standalone Supabase project.
-- This service does NOT share a database with the main KASTLR platform.
-- KASTLR-sanctioned sessions reference a match only via the string
-- match_id carried inside a signed handoff token (see handoffToken.js) —
-- never via a live foreign key or cross-project join.

create table if not exists veto_pool_templates (
  id uuid primary key default gen_random_uuid(),
  game text not null default 'cs2',
  name text not null,
  maps jsonb not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_veto_pool_active_per_game
  on veto_pool_templates (game)
  where is_active = true;

create table if not exists veto_sessions (
  id uuid primary key default gen_random_uuid(),

  -- Provenance, no FK — populated only from a verified handoff token's claims
  is_kastlr_sanctioned boolean not null default false,
  kastlr_match_id text,             -- opaque string from KASTLR platform, null for public sessions
  kastlr_origin_note text,          -- e.g. 'kastlr.co.za season1' — free-text audit trail only

  pool_template_id uuid not null references veto_pool_templates(id),
  ruleset text not null check (ruleset in ('bo1','bo2','bo3','bo5')),
  veto_structure text not null default 'standard',
  team_a_name text not null,
  team_b_name text not null,

  -- Anonymous link auth (always generated; used directly for public sessions,
  -- and as a fallback/share-link even for sanctioned sessions once opened)
  team_a_token text unique not null,
  team_b_token text unique not null,
  spectator_token text unique not null,

  -- Populated only if this captain authenticated via a verified KASTLR handoff token
  team_a_steam_id text,
  team_b_steam_id text,

  timer_seconds int not null default 25 check (timer_seconds in (25,30,60)),
  coinflip_winner text check (coinflip_winner in ('team_a','team_b')),
  current_turn text check (current_turn in ('team_a','team_b','complete')),
  status text not null default 'pending' check (status in ('pending','active','complete','expired')),

  expires_at timestamptz,           -- set for public sessions; null for sanctioned ones
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_veto_sessions_status on veto_sessions(status);
create index if not exists idx_veto_sessions_kastlr_match_id on veto_sessions(kastlr_match_id);

create table if not exists veto_actions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references veto_sessions(id),
  sequence_no int not null,
  actor text not null check (actor in ('team_a','team_b','system')),
  action_type text not null check (action_type in ('coinflip','ban','pick','decider','side_pick','timeout_auto')),
  map text,
  side text check (side in ('ct','t')),
  steam_id text,                    -- populated only if actor came in via verified handoff token
  prev_action_hash text,
  action_hash text not null,
  created_at timestamptz not null default now(),
  unique (session_id, sequence_no)
);

create index if not exists idx_veto_actions_session_id on veto_actions(session_id);

-- RLS: this project's service role is used exclusively by the veto-service backend.
-- No public client ever talks to Supabase directly — every read/write goes through
-- this service's own API, which validates link-tokens or handoff-token signatures.
alter table veto_pool_templates enable row level security;
alter table veto_sessions enable row level security;
alter table veto_actions enable row level security;

create policy veto_pool_templates_public_read on veto_pool_templates
  for select using (true);
