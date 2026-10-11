-- 0001_init.sql — CT TCG restock tracker core schema (PostgreSQL 15+, Supabase-compatible).
--
-- STATUS: DRAFT. Not applied to any database. Review before applying.
-- Hosting/DB choice is not yet decided (see docs/PHASE0-AUDIT.md). Row-level security policies
-- at the end assume Supabase's auth.uid(); adapt if a different auth provider is chosen.
--
-- Design rules enforced here:
--   * inventory_observations are append-only; only moderation status may change.
--   * unknown quantity is NULL with quantity_kind = 'unknown' — never 0.
--   * fingerprint uniqueness makes ingestion retries idempotent.
--   * notification_events.idempotency_key uniqueness prevents duplicate alerts.
--   * synthetic rows are rejected when app_settings.environment = 'production'.

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- settings
create table app_settings (
  id boolean primary key default true check (id),
  environment text not null check (environment in ('development', 'preview', 'production'))
);

create or replace function app_is_production() returns boolean
language sql stable as $$
  select coalesce((select environment = 'production' from app_settings), false)
$$;

-- ---------------------------------------------------------------- catalog
create table games (
  id text primary key check (id in ('pokemon', 'one_piece')),
  display_name text not null
);

create table products (
  id uuid primary key default gen_random_uuid(),
  game_id text not null references games(id),
  canonical_name text not null,
  category text not null check (category in (
    'booster_pack','booster_box','elite_trainer_box','booster_bundle','tin',
    'starter_deck','double_pack','collection','other_sealed')),
  set_name text,                    -- only when verified
  image_url text,
  image_provenance text,            -- licence / permission note; required if image_url set
  official_reference_url text,
  active boolean not null default true,
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  check (image_url is null or image_provenance is not null),
  check (game_id = 'pokemon' or category not in ('elite_trainer_box','booster_bundle','tin')),
  check (game_id = 'one_piece' or category not in ('starter_deck','double_pack'))
);
create index products_game_idx on products (game_id) where active;
create index products_name_idx on products using gin (to_tsvector('simple', canonical_name));

-- Explicit identifier mappings. Products are never merged on name similarity.
create table product_identifiers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  id_type text not null check (id_type in ('gtin','retailer_sku','retailer_item_id','publisher_code')),
  retailer_id text,                 -- required for retailer_* types
  value text not null,
  verified_at timestamptz,
  verification_source text,
  check ((id_type like 'retailer_%') = (retailer_id is not null)),
  check (id_type <> 'gtin' or value ~ '^[0-9]{8,14}$')
);
create unique index product_identifiers_unique
  on product_identifiers (id_type, coalesce(retailer_id, ''), value);

-- ---------------------------------------------------------------- retailers / stores
create table retailers (
  id text primary key,              -- 'walmart','target','gamestop','bestbuy'
  display_name text not null
);

create table stores (
  id uuid primary key default gen_random_uuid(),
  retailer_id text not null references retailers(id),
  external_store_id text,
  name text not null,
  address_line text not null,
  city text not null,
  state text not null default 'CT' check (state = 'CT'),
  zip text not null check (zip ~ '^06[0-9]{3}$'),  -- Connecticut ZIPs are 06xxx
  latitude numeric(9,6) not null check (latitude between 40.9 and 42.1),
  longitude numeric(9,6) not null check (longitude between -73.8 and -71.7),
  official_url text,
  location_source text not null,    -- where the store record came from (licensed/official)
  location_verified_at timestamptz not null,
  active boolean not null default true,
  is_synthetic boolean not null default false,
  unique (retailer_id, external_store_id)
);

-- ---------------------------------------------------------------- sources
create table inventory_sources (
  id text primary key,              -- matches SOURCE_REGISTRY keys in src/domain/sources.js
  retailer_id text references retailers(id),
  source_type text not null check (source_type in
    ('authorized_feed','community_report','manual_verification')),
  authorization_status text not null check (authorization_status in
    ('VERIFIED','PARTIAL','BLOCKED','UNVERIFIED')),
  authorization_evidence text,      -- link to agreement / approval record
  kill_switch boolean not null default false,
  is_synthetic boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- observations
create table inventory_observations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  store_id uuid not null references stores(id),
  source_id text not null references inventory_sources(id),
  source_type text not null check (source_type in
    ('authorized_feed','community_report','manual_verification')),
  availability text not null check (availability in
    ('in_stock','limited','out_of_stock','uncertain','unknown')),
  quantity_kind text not null check (quantity_kind in ('exact','estimate','unknown')),
  quantity_exact integer check (quantity_exact between 0 and 10000),
  quantity_min integer check (quantity_min between 0 and 10000),
  quantity_max integer check (quantity_max between 0 and 10000),
  source_timestamp timestamptz,     -- as provided by the source / reporter (UTC)
  received_at timestamptz not null default now(),  -- server-assigned
  verification_status text not null check (verification_status in
    ('verified','pending','accepted','rejected','expired')),
  source_record_id text,            -- audit reference into the source
  reporter_id uuid,                 -- community only; never exposed publicly
  fingerprint text not null unique, -- idempotent ingestion
  is_synthetic boolean not null default false,
  check (
    (quantity_kind = 'exact'    and quantity_exact is not null and quantity_min is null and quantity_max is null) or
    (quantity_kind = 'estimate' and quantity_exact is null and quantity_min is not null and quantity_max >= quantity_min) or
    (quantity_kind = 'unknown'  and quantity_exact is null and quantity_min is null and quantity_max is null)
  ),
  check (source_type <> 'community_report' or (quantity_kind <> 'exact' and verification_status <> 'verified' and reporter_id is not null)),
  check (not (quantity_kind = 'exact' and quantity_exact > 0 and availability = 'out_of_stock'))
);
create index obs_product_store_time_idx
  on inventory_observations (product_id, store_id, coalesce(source_timestamp, received_at) desc);
create index obs_store_idx on inventory_observations (store_id, received_at desc);

-- Append-only: block deletes and any update except community moderation status.
create or replace function obs_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'inventory_observations are append-only';
  end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'verification_status') <> (to_jsonb(old) - 'verification_status') then
      raise exception 'only verification_status may change on an observation';
    end if;
    if old.source_type <> 'community_report' and new.verification_status <> old.verification_status then
      raise exception 'trusted observations cannot be re-moderated';
    end if;
  end if;
  return new;
end $$;
create trigger obs_guard_trg before update or delete on inventory_observations
  for each row execute function obs_guard();

-- Synthetic data can never enter a production database.
create or replace function reject_synthetic_in_prod() returns trigger language plpgsql as $$
begin
  if new.is_synthetic and app_is_production() then
    raise exception 'synthetic rows are not allowed in production (%).', tg_table_name;
  end if;
  return new;
end $$;
create trigger products_no_synth before insert or update on products
  for each row execute function reject_synthetic_in_prod();
create trigger stores_no_synth before insert or update on stores
  for each row execute function reject_synthetic_in_prod();
create trigger sources_no_synth before insert or update on inventory_sources
  for each row execute function reject_synthetic_in_prod();
create trigger obs_no_synth before insert on inventory_observations
  for each row execute function reject_synthetic_in_prod();

create table stock_changes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  store_id uuid not null references stores(id),
  source_id text not null references inventory_sources(id),
  previous_observation_id uuid not null references inventory_observations(id),
  new_observation_id uuid not null unique references inventory_observations(id),
  previous_quantity integer not null,
  new_quantity integer not null,
  delta integer not null check (delta <> 0 and delta = new_quantity - previous_quantity),
  detected_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- moderation / audit
create table moderation_actions (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references inventory_observations(id),
  moderator_id uuid not null,
  action text not null check (action in ('accept','reject','expire')),
  reason text,
  created_at timestamptz not null default now()
);

create table abuse_reports (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references inventory_observations(id),
  reported_by uuid not null,
  reason text not null check (length(reason) <= 1000),
  created_at timestamptz not null default now(),
  unique (observation_id, reported_by)
);

create table audit_log (
  id bigserial primary key,
  actor text not null,
  action text not null,
  subject text,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- notifications
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  product_id uuid not null references products(id),
  store_id uuid references stores(id),          -- null = any verified CT store
  channel text not null check (channel in ('email','web_push','sms')),
  consent_at timestamptz not null,              -- explicit opt-in time
  consent_text_version text not null,
  include_community boolean not null default false,
  cooldown_minutes integer not null default 120 check (cooldown_minutes >= 15),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, product_id, store_id, channel)
);

create table notification_events (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  observation_id uuid not null references inventory_observations(id),
  trigger text not null check (trigger in ('restock','restock_after_expiry','reported_increase')),
  confidence text not null check (confidence in ('high','medium','low')),
  community_reported boolean not null,
  created_at timestamptz not null default now()
);

create table delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  notification_event_id uuid not null references notification_events(id),
  subscription_id uuid not null references subscriptions(id),
  attempt integer not null check (attempt between 1 and 5),
  status text not null check (status in ('queued','sent','failed','suppressed')),
  provider_message_id text,
  error text,
  created_at timestamptz not null default now(),
  unique (notification_event_id, subscription_id, attempt)
);

-- ---------------------------------------------------------------- RLS (Supabase)
-- Public: read catalog, stores, and displayable observations through a view that omits
-- reporter_id. Writes to trusted tables happen only with the service role (server side).
alter table inventory_observations enable row level security;
alter table subscriptions enable row level security;
alter table moderation_actions enable row level security;
alter table abuse_reports enable row level security;
alter table delivery_attempts enable row level security;
alter table notification_events enable row level security;
alter table audit_log enable row level security;

create policy subs_owner_select on subscriptions for select using (user_id = auth.uid());
create policy subs_owner_insert on subscriptions for insert with check (user_id = auth.uid());
create policy subs_owner_update on subscriptions for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy subs_owner_delete on subscriptions for delete using (user_id = auth.uid());

-- No direct client access to observations; community submissions go through the server API,
-- which sets reporter_id from the session, received_at, and verification_status = 'pending'.
create view public_observations with (security_invoker = false) as
  select id, product_id, store_id, source_id, source_type, availability, quantity_kind,
         quantity_exact, quantity_min, quantity_max, source_timestamp, received_at,
         verification_status
  from inventory_observations
  where not is_synthetic
    and (verification_status = 'verified'
         or (source_type = 'community_report' and verification_status = 'accepted'));

commit;
