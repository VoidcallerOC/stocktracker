-- 0003_store_directory_and_catalog.sql
-- Store directory and sealed-product catalog claims for Pokémon TCG and One Piece Card Game.
--
-- Apply with psql after 0001_init.sql. This file does not read or modify objects introduced
-- by an unmerged retention/public-read migration (source_retention_policies, observation_is_public_row,
-- purge_expired_source_data, or the replaced public_observations view). It can be applied
-- before or after that migration.
--
-- No store, product, business, identifier, or evidence row is inserted here.
-- A directory row is not inventory and does not authorize a retailer API.
-- Legacy rows stay UNVERIFIED. Creating a row does not verify it.
--
-- psql meta-command below is intentional: CREATE ROLE cannot run inside a transaction.

select format('create role %I nologin', r)
from (values ('anon'), ('authenticated')) as roles(r)
where not exists (select 1 from pg_roles where rolname = r)
\gexec

begin;

-- ---------------------------------------------------------------- businesses
create table businesses (
  id uuid primary key default gen_random_uuid(),
  import_key text unique check (import_key is null or import_key ~ '^[a-z0-9][a-z0-9-]{0,80}$'),
  display_name text not null check (length(btrim(display_name)) > 0),
  kind text not null check (kind in ('chain_banner', 'independent')),
  retailer_id text references retailers (id),
  public_website text,
  verification_status text not null default 'UNVERIFIED'
    check (verification_status in ('VERIFIED', 'PARTIAL', 'BLOCKED', 'UNVERIFIED')),
  verified_at timestamptz,
  review_note text,
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  check (
    (kind = 'chain_banner' and retailer_id is not null)
    or (kind = 'independent' and retailer_id is null)
  ),
  check (verification_status not in ('PARTIAL', 'VERIFIED') or verified_at is not null),
  check (public_website is null or verification_status in ('PARTIAL', 'VERIFIED'))
);

create trigger businesses_no_synth before insert or update on businesses
  for each row execute function reject_synthetic_in_prod();

-- ---------------------------------------------------------------- stores: one row per location
alter table stores alter column retailer_id drop not null;
alter table stores alter column latitude drop not null;
alter table stores alter column longitude drop not null;
alter table stores alter column location_source drop not null;
alter table stores alter column location_verified_at drop not null;

alter table stores add column business_id uuid references businesses (id);
alter table stores add column import_key text check (import_key is null or import_key ~ '^[a-z0-9][a-z0-9-]{0,80}$');
alter table stores add column address_verification_status text not null default 'UNVERIFIED'
  check (address_verification_status in ('VERIFIED', 'PARTIAL', 'BLOCKED', 'UNVERIFIED'));
alter table stores add column coordinate_verification_status text not null default 'UNVERIFIED'
  check (coordinate_verification_status in ('VERIFIED', 'PARTIAL', 'BLOCKED', 'UNVERIFIED'));
alter table stores add column record_status text not null default 'active'
  check (record_status in ('active', 'retired'));
alter table stores add column retired_reason text;
alter table stores add column successor_store_id uuid references stores (id);
alter table stores add column public_phone text;
alter table stores add column review_note text;
alter table stores add column verification_status text not null default 'UNVERIFIED'
  check (verification_status in ('VERIFIED', 'PARTIAL', 'BLOCKED', 'UNVERIFIED'));
alter table stores add column verified_at timestamptz;
alter table stores add column store_format text
  check (store_format is null or store_format in ('big_box', 'specialty_game_store', 'other'));

alter table stores add constraint stores_verified_at_ck
  check (verification_status not in ('PARTIAL', 'VERIFIED') or verified_at is not null);
alter table stores add constraint stores_public_contact_ck
  check (
    (official_url is null and public_phone is null)
    or verification_status in ('PARTIAL', 'VERIFIED')
  );
alter table stores add constraint stores_retired_reason_ck
  check ((record_status = 'retired') = (retired_reason is not null));
alter table stores add constraint stores_successor_ck
  check (successor_store_id is null or successor_store_id <> id);

create unique index stores_import_key_uidx on stores (import_key) where import_key is not null;
-- Same chain, same normalized address: one active location. A different address is a different branch.
create unique index stores_chain_address_uidx
  on stores (retailer_id, lower(address_line), zip)
  where retailer_id is not null and record_status = 'active';
create unique index stores_independent_address_uidx
  on stores (business_id, lower(address_line), zip)
  where business_id is not null and retailer_id is null and record_status = 'active';
create index stores_verification_idx on stores (verification_status) where record_status = 'active';

-- ---------------------------------------------------------------- products
alter table products add column import_key text check (import_key is null or import_key ~ '^[a-z0-9][a-z0-9-]{0,80}$');
alter table products add column verification_status text not null default 'UNVERIFIED'
  check (verification_status in ('VERIFIED', 'PARTIAL', 'BLOCKED', 'UNVERIFIED'));
alter table products add column verified_at timestamptz;
alter table products add column lifecycle_status text not null default 'unknown'
  check (lifecycle_status in ('active', 'discontinued', 'unknown'));
alter table products add column language text check (language is null or language ~ '^[a-z]{2}$');
alter table products add column region text check (region is null or region ~ '^[A-Z]{2}$');
alter table products add column release_date date;
alter table products add column packaging_variant text;
alter table products add column review_note text;

alter table products add constraint products_verified_at_ck
  check (verification_status not in ('PARTIAL', 'VERIFIED') or verified_at is not null);
alter table products add constraint products_set_name_ck
  check (set_name is null or verification_status in ('PARTIAL', 'VERIFIED'));
alter table products add constraint products_release_date_ck
  check (release_date is null or verification_status in ('PARTIAL', 'VERIFIED'));
alter table products add constraint products_name_nonempty_ck
  check (length(btrim(canonical_name)) > 0);

create unique index products_import_key_uidx on products (import_key) where import_key is not null;
-- Different language, region, or packaging is a different product. Names are not fuzzy-merged.
create unique index products_identity_uidx on products (
  game_id,
  category,
  lower(canonical_name),
  coalesce(language, ''),
  coalesce(region, ''),
  coalesce(packaging_variant, '')
);
create index products_verification_idx on products (game_id, verification_status);

alter table product_identifiers add column verification_status text not null default 'UNVERIFIED'
  check (verification_status in ('VERIFIED', 'PARTIAL', 'BLOCKED', 'UNVERIFIED'));
alter table product_identifiers add constraint product_identifiers_status_verified_at_ck
  check (verification_status not in ('PARTIAL', 'VERIFIED') or verified_at is not null);
alter table product_identifiers add constraint product_identifiers_value_nonempty_ck
  check (length(btrim(value)) > 0);

-- Empty game support means unknown, not "does not sell this game".
create table store_game_support (
  store_id uuid not null references stores (id),
  game_id text not null references games (id),
  primary key (store_id, game_id)
);

-- Internal provenance. No public policy and no public grant.
create table record_evidence (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('product', 'store', 'business', 'product_identifier')),
  subject_id uuid not null,
  field_scope text not null check (field_scope in (
    'record', 'address', 'coordinates', 'set_name', 'release_date', 'identifier', 'website', 'phone'
  )),
  source_label text not null check (length(btrim(source_label)) > 0),
  source_url text,
  verification_status text not null check (verification_status in ('VERIFIED', 'PARTIAL', 'BLOCKED', 'UNVERIFIED')),
  observed_at timestamptz not null,
  note text,
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now()
);
create index record_evidence_subject_idx on record_evidence (subject_type, subject_id);
create trigger record_evidence_no_synth before insert or update on record_evidence
  for each row execute function reject_synthetic_in_prod();

-- ---------------------------------------------------------------- row guards
create or replace function directory_prepare_text()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'products' then
    new.canonical_name := nullif(regexp_replace(btrim(new.canonical_name), '\s+', ' ', 'g'), '');
    if new.set_name is not null then
      new.set_name := nullif(regexp_replace(btrim(new.set_name), '\s+', ' ', 'g'), '');
    end if;
    if new.packaging_variant is not null then
      new.packaging_variant := nullif(regexp_replace(btrim(new.packaging_variant), '\s+', ' ', 'g'), '');
    end if;
  elsif tg_table_name = 'stores' then
    new.name := nullif(regexp_replace(btrim(new.name), '\s+', ' ', 'g'), '');
    new.address_line := nullif(regexp_replace(btrim(new.address_line), '\s+', ' ', 'g'), '');
    new.city := nullif(regexp_replace(btrim(new.city), '\s+', ' ', 'g'), '');
    if new.latitude is null and new.longitude is null then
      return new;
    end if;
    if new.latitude is null or new.longitude is null then
      raise exception 'latitude and longitude must both be set or both be null';
    end if;
    if new.location_source is null then
      raise exception 'coordinates require location_source';
    end if;
    if new.verification_status = 'VERIFIED'
       and new.coordinate_verification_status not in ('PARTIAL', 'VERIFIED') then
      raise exception 'verified store cannot keep unverified coordinates';
    end if;
  end if;
  return new;
end $$;

create trigger products_prepare before insert or update on products
  for each row execute function directory_prepare_text();
create trigger stores_prepare before insert or update on stores
  for each row execute function directory_prepare_text();

create or replace function directory_claim_needs_evidence()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  claim_subject text := tg_argv[0];
begin
  if claim_subject = 'product_identifier' then
    if new.verification_status in ('PARTIAL', 'VERIFIED') and not exists (
      select 1 from record_evidence e
      where e.subject_type = 'product'
        and e.subject_id = new.product_id
        and e.field_scope = 'identifier'
        and (
          (new.verification_status = 'VERIFIED' and e.verification_status = 'VERIFIED')
          or (new.verification_status = 'PARTIAL' and e.verification_status in ('PARTIAL', 'VERIFIED'))
        )
    ) then
      raise exception 'identifier verification requires identifier evidence on the product';
    end if;
    return null;
  end if;

  if new.verification_status = 'VERIFIED' and not exists (
    select 1 from record_evidence e
    where e.subject_type = claim_subject
      and e.subject_id = new.id
      and e.verification_status = 'VERIFIED'
  ) then
    raise exception 'VERIFIED % requires a VERIFIED evidence row', claim_subject;
  end if;
  if new.verification_status = 'PARTIAL' and not exists (
    select 1 from record_evidence e
    where e.subject_type = claim_subject
      and e.subject_id = new.id
      and e.verification_status in ('PARTIAL', 'VERIFIED')
  ) then
    raise exception 'PARTIAL % requires evidence', claim_subject;
  end if;

  if claim_subject = 'store' then
    if new.address_verification_status = 'VERIFIED' and not exists (
      select 1 from record_evidence e
      where e.subject_type = 'store' and e.subject_id = new.id
        and e.field_scope in ('address', 'record') and e.verification_status = 'VERIFIED'
    ) then
      raise exception 'VERIFIED address requires address evidence';
    end if;
    if new.address_verification_status = 'PARTIAL' and not exists (
      select 1 from record_evidence e
      where e.subject_type = 'store' and e.subject_id = new.id
        and e.field_scope in ('address', 'record') and e.verification_status in ('PARTIAL', 'VERIFIED')
    ) then
      raise exception 'PARTIAL address requires address evidence';
    end if;
    if new.coordinate_verification_status in ('PARTIAL', 'VERIFIED') and not exists (
      select 1 from record_evidence e
      where e.subject_type = 'store' and e.subject_id = new.id
        and e.field_scope = 'coordinates'
        and (
          (new.coordinate_verification_status = 'VERIFIED' and e.verification_status = 'VERIFIED')
          or (new.coordinate_verification_status = 'PARTIAL' and e.verification_status in ('PARTIAL', 'VERIFIED'))
        )
    ) then
      raise exception 'coordinate verification requires coordinates evidence';
    end if;
  end if;
  return null;
end $$;

create trigger products_claim_evidence
  after insert or update on products
  for each row execute function directory_claim_needs_evidence('product');
create trigger stores_claim_evidence
  after insert or update on stores
  for each row execute function directory_claim_needs_evidence('store');
create trigger businesses_claim_evidence
  after insert or update on businesses
  for each row execute function directory_claim_needs_evidence('business');
create trigger identifiers_claim_evidence
  after insert or update on product_identifiers
  for each row execute function directory_claim_needs_evidence('product_identifier');

-- A VERIFIED identity change requires an explicit resolution GUC and the table owner.
-- anon can set custom GUCs, so the owner check is the actual gate.
create or replace function guard_verified_directory_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  resolution text := current_setting('app.directory_resolution', true);
  owner_name text;
  identity_changed boolean := false;
begin
  if old.verification_status is distinct from 'VERIFIED' then
    return new;
  end if;
  if tg_table_name = 'products' then
    identity_changed :=
      new.canonical_name is distinct from old.canonical_name
      or new.category is distinct from old.category
      or new.set_name is distinct from old.set_name
      or new.language is distinct from old.language
      or new.region is distinct from old.region
      or new.packaging_variant is distinct from old.packaging_variant
      or new.release_date is distinct from old.release_date
      or new.game_id is distinct from old.game_id
      or new.lifecycle_status is distinct from old.lifecycle_status
      or new.verification_status is distinct from old.verification_status
      or new.official_reference_url is distinct from old.official_reference_url
      or new.is_synthetic is distinct from old.is_synthetic;
  elsif tg_table_name = 'stores' then
    identity_changed :=
      new.name is distinct from old.name
      or new.address_line is distinct from old.address_line
      or new.city is distinct from old.city
      or new.zip is distinct from old.zip
      or new.latitude is distinct from old.latitude
      or new.longitude is distinct from old.longitude
      or new.retailer_id is distinct from old.retailer_id
      or new.external_store_id is distinct from old.external_store_id
      or new.official_url is distinct from old.official_url
      or new.public_phone is distinct from old.public_phone
      or new.business_id is distinct from old.business_id
      or new.verification_status is distinct from old.verification_status
      or new.record_status is distinct from old.record_status
      or new.address_verification_status is distinct from old.address_verification_status
      or new.coordinate_verification_status is distinct from old.coordinate_verification_status
      or new.is_synthetic is distinct from old.is_synthetic;
  elsif tg_table_name = 'businesses' then
    identity_changed :=
      new.display_name is distinct from old.display_name
      or new.kind is distinct from old.kind
      or new.retailer_id is distinct from old.retailer_id
      or new.public_website is distinct from old.public_website
      or new.verification_status is distinct from old.verification_status
      or new.is_synthetic is distinct from old.is_synthetic;
  else
    identity_changed := true;
  end if;
  if not identity_changed then
    return new;
  end if;
  select pg_get_userbyid(c.relowner) into owner_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = tg_table_schema and c.relname = tg_table_name;
  if resolution is null
     or resolution not in ('accept_incoming', 'retire')
     or current_user is distinct from owner_name then
    raise exception 'verified % update requires directory resolution by the table owner', tg_table_name;
  end if;
  if tg_table_name = 'stores' then
    if resolution = 'retire' and new.record_status is distinct from 'retired' then
      raise exception 'retire resolution requires record_status retired';
    end if;
  end if;
  return new;
end $$;

-- Names sort before the synthetic-row triggers so the owner check runs first.
create trigger a_guard_products_verified before update on products
  for each row execute function guard_verified_directory_update();
create trigger a_guard_stores_verified before update on stores
  for each row execute function guard_verified_directory_update();
create trigger a_guard_businesses_verified before update on businesses
  for each row execute function guard_verified_directory_update();

-- ---------------------------------------------------------------- public read
-- security_invoker plus RLS: anon sees a verified row only when the row itself is verified.
-- OFFSET 0 keeps the views from being updatable targets.
create view public_directory_products
with (security_invoker = true, security_barrier = true) as
select id, game_id, canonical_name, category, set_name, language, region, packaging_variant,
       release_date, lifecycle_status, verification_status, verified_at, official_reference_url
from products
where verification_status = 'VERIFIED'
  and not is_synthetic
offset 0;

create view public_directory_stores
with (security_invoker = true, security_barrier = true) as
select id, name, address_line, city, state, zip,
       case when coordinate_verification_status in ('PARTIAL', 'VERIFIED') then latitude else null end as latitude,
       case when coordinate_verification_status in ('PARTIAL', 'VERIFIED') then longitude else null end as longitude,
       official_url, public_phone, retailer_id, business_id, store_format,
       address_verification_status, coordinate_verification_status, verification_status, verified_at
from stores
where verification_status = 'VERIFIED'
  and record_status = 'active'
  and not is_synthetic
offset 0;

create view public_directory_businesses
with (security_invoker = true, security_barrier = true) as
select id, display_name, kind, retailer_id, public_website, verification_status, verified_at
from businesses
where verification_status = 'VERIFIED'
  and not is_synthetic
offset 0;

create view public_store_games
with (security_invoker = true, security_barrier = true) as
select store_id, game_id
from store_game_support g
where exists (
  select 1 from stores s
  where s.id = g.store_id
    and s.verification_status = 'VERIFIED'
    and s.record_status = 'active'
    and not s.is_synthetic
)
offset 0;

create view public_product_identifiers
with (security_invoker = true, security_barrier = true) as
select i.id, i.product_id, i.id_type, i.retailer_id, i.value, i.verification_status, i.verified_at
from product_identifiers i
where i.verification_status = 'VERIFIED'
  and exists (
    select 1 from products p
    where p.id = i.product_id
      and p.verification_status = 'VERIFIED'
      and not p.is_synthetic
  )
offset 0;

alter table businesses enable row level security;
alter table stores enable row level security;
alter table products enable row level security;
alter table product_identifiers enable row level security;
alter table store_game_support enable row level security;
alter table record_evidence enable row level security;

create policy businesses_public_read on businesses
  for select to anon, authenticated
  using (verification_status = 'VERIFIED' and not is_synthetic);
create policy stores_public_read on stores
  for select to anon, authenticated
  using (verification_status = 'VERIFIED' and record_status = 'active' and not is_synthetic);
create policy products_public_read on products
  for select to anon, authenticated
  using (verification_status = 'VERIFIED' and not is_synthetic);
create policy identifiers_public_read on product_identifiers
  for select to anon, authenticated
  using (
    verification_status = 'VERIFIED'
    and exists (
      select 1 from products p
      where p.id = product_identifiers.product_id
        and p.verification_status = 'VERIFIED'
        and not p.is_synthetic
    )
  );
create policy store_games_public_read on store_game_support
  for select to anon, authenticated
  using (
    exists (
      select 1 from stores s
      where s.id = store_game_support.store_id
        and s.verification_status = 'VERIFIED'
        and s.record_status = 'active'
        and not s.is_synthetic
    )
  );

grant usage on schema public to anon, authenticated;

grant select (
  id, game_id, canonical_name, category, set_name, language, region, packaging_variant,
  release_date, lifecycle_status, verification_status, verified_at, official_reference_url, is_synthetic
) on products to anon, authenticated;
grant select (
  id, name, address_line, city, state, zip, latitude, longitude, official_url, public_phone,
  retailer_id, business_id, store_format, address_verification_status, coordinate_verification_status,
  verification_status, verified_at, record_status, is_synthetic
) on stores to anon, authenticated;
grant select (
  id, display_name, kind, retailer_id, public_website, verification_status, verified_at, is_synthetic
) on businesses to anon, authenticated;
grant select (id, product_id, id_type, retailer_id, value, verification_status, verified_at)
  on product_identifiers to anon, authenticated;
grant select (store_id, game_id) on store_game_support to anon, authenticated;
grant select on public_directory_products, public_directory_stores, public_directory_businesses,
  public_store_games, public_product_identifiers to anon, authenticated;

commit;
