-- Constraint tests for db/migrations/0001_init.sql. Run against a THROWAWAY database only:
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f test/db/00_supabase_stub.sql \
--        -f db/migrations/0001_init.sql -f test/db/constraints.test.sql
-- All fixture rows are flagged is_synthetic and use the 'development' environment.

\set QUIET on
insert into app_settings (environment) values ('development');
insert into games values ('pokemon','Pokémon TCG'), ('one_piece','One Piece Card Game');
insert into retailers values ('bestbuy','Best Buy');
insert into inventory_sources (id, retailer_id, source_type, authorization_status, is_synthetic)
  values ('synthetic_demo', null, 'authorized_feed', 'VERIFIED', true),
         ('community', null, 'community_report', 'VERIFIED', false);
insert into products (id, game_id, canonical_name, category, is_synthetic) values
  ('00000000-0000-0000-0000-000000000001','pokemon','TEST ETB','elite_trainer_box', true),
  ('00000000-0000-0000-0000-000000000002','one_piece','TEST OP Starter','starter_deck', true);
insert into stores (id, retailer_id, external_store_id, name, address_line, city, zip, latitude, longitude, location_source, location_verified_at, is_synthetic)
  values ('00000000-0000-0000-0000-0000000000a1','bestbuy','T1','TEST STORE','1 Test Rd','Testville','06001',41.7,-72.8,'test fixture',now(), true);

create or replace function expect_error(sql text, label text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    raise notice 'ok - % (%)', label, sqlerrm;
    return;
  end;
  raise exception 'FAIL - % : statement succeeded but should have failed', label;
end $$;

-- 1. Games are independent: categories are game-specific.
select expect_error($$insert into products (game_id, canonical_name, category) values ('one_piece','x','elite_trainer_box')$$, 'one piece cannot be ETB');
select expect_error($$insert into products (game_id, canonical_name, category) values ('pokemon','x','starter_deck')$$, 'pokemon cannot be OP starter deck category');

-- Stores must be in Connecticut.
select expect_error($$insert into stores (retailer_id,name,address_line,city,state,zip,latitude,longitude,location_source,location_verified_at) values ('bestbuy','x','x','x','NY','10001',40.7,-74.0,'x',now())$$, 'non-CT store rejected');

-- 3. Unknown quantity cannot carry a number; exact requires a value.
insert into inventory_observations (id, product_id, store_id, source_id, source_type, availability, quantity_kind, source_timestamp, verification_status, fingerprint, is_synthetic)
  values ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','synthetic_demo','authorized_feed','in_stock','unknown',now(),'verified','fp1',true);
select expect_error($$insert into inventory_observations (product_id, store_id, source_id, source_type, availability, quantity_kind, quantity_exact, verification_status, fingerprint) values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','synthetic_demo','authorized_feed','in_stock','unknown',0,'verified','fp2')$$, 'unknown quantity cannot be 0');

-- 6. Fingerprint uniqueness makes retries idempotent.
select expect_error($$insert into inventory_observations (product_id, store_id, source_id, source_type, availability, quantity_kind, verification_status, fingerprint, is_synthetic) values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','synthetic_demo','authorized_feed','in_stock','unknown','verified','fp1',true)$$, 'duplicate fingerprint rejected');

-- 7. Community reports cannot be exact or verified.
select expect_error($$insert into inventory_observations (product_id, store_id, source_id, source_type, availability, quantity_kind, quantity_exact, verification_status, reporter_id, fingerprint) values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','community','community_report','in_stock','exact',3,'pending',gen_random_uuid(),'fp3')$$, 'community exact qty rejected');
select expect_error($$insert into inventory_observations (product_id, store_id, source_id, source_type, availability, quantity_kind, verification_status, reporter_id, fingerprint) values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','community','community_report','in_stock','unknown','verified',gen_random_uuid(),'fp4')$$, 'community verified rejected');

-- 9/11. Observations are append-only; trusted records cannot be edited or re-moderated.
select expect_error($$update inventory_observations set availability='out_of_stock' where fingerprint='fp1'$$, 'observation content immutable');
select expect_error($$update inventory_observations set verification_status='rejected' where fingerprint='fp1'$$, 'trusted observation not re-moderatable');
select expect_error($$delete from inventory_observations where fingerprint='fp1'$$, 'observation delete blocked');

-- Community moderation status can change.
insert into inventory_observations (id, product_id, store_id, source_id, source_type, availability, quantity_kind, quantity_min, quantity_max, verification_status, reporter_id, fingerprint)
  values ('00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','community','community_report','in_stock','estimate',2,4,'pending',gen_random_uuid(),'fp5');
update inventory_observations set verification_status='accepted' where fingerprint='fp5';

-- 6. Notification idempotency.
insert into notification_events (idempotency_key, observation_id, trigger, confidence, community_reported)
  values ('k1','00000000-0000-0000-0000-00000000f001','restock','high',false);
select expect_error($$insert into notification_events (idempotency_key, observation_id, trigger, confidence, community_reported) values ('k1','00000000-0000-0000-0000-00000000f001','restock','high',false)$$, 'duplicate alert rejected');

-- Delta integrity.
select expect_error($$insert into stock_changes (product_id, store_id, source_id, previous_observation_id, new_observation_id, previous_quantity, new_quantity, delta) values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','synthetic_demo','00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-00000000f002',2,12,7)$$, 'delta must equal new - previous');

-- Public view hides reporter_id and pending reports; synthetic excluded.
do $$ begin
  if exists (select 1 from information_schema.columns where table_name='public_observations' and column_name='reporter_id') then
    raise exception 'FAIL - public view exposes reporter_id';
  end if;
  if (select count(*) from public_observations) <> 1 then
    raise exception 'FAIL - public view should show exactly the accepted non-synthetic report';
  end if;
  raise notice 'ok - public view projection';
end $$;

-- 10. Subscriptions: owners only (RLS).
do $$ begin if not exists (select 1 from pg_roles where rolname = 'app_user') then create role app_user nologin; end if; end $$;
grant usage on schema public, auth to app_user;
grant select, insert, update, delete on subscriptions to app_user;
grant select on products to app_user;
insert into subscriptions (id, user_id, product_id, channel, consent_at, consent_text_version)
  values ('00000000-0000-0000-0000-00000000c001','11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-000000000001','email',now(),'v1');
set role app_user;
select set_config('test.uid','22222222-2222-2222-2222-222222222222', false);
do $$ begin
  if (select count(*) from subscriptions) <> 0 then raise exception 'FAIL - other user sees subscription'; end if;
  update subscriptions set active=false;
  raise notice 'ok - RLS hides other users'' subscriptions';
end $$;
select expect_error($$insert into subscriptions (user_id, product_id, channel, consent_at, consent_text_version) values ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-000000000001','sms',now(),'v1')$$, 'cannot subscribe as another user');
select set_config('test.uid','11111111-1111-1111-1111-111111111111', false);
update subscriptions set channel='web_push' where id='00000000-0000-0000-0000-00000000c001';
delete from subscriptions where id='00000000-0000-0000-0000-00000000c001';
do $$ begin
  if (select count(*) from subscriptions) <> 0 then raise exception 'FAIL - owner unsubscribe'; end if;
  raise notice 'ok - owner can change preferences and unsubscribe';
end $$;
select expect_error($$select * from inventory_observations$$, 'app user has no direct observation access');
reset role;
do $$ begin
  if (select active from subscriptions where id='00000000-0000-0000-0000-00000000c001') is not null then
    raise exception 'FAIL - row should be deleted';
  end if;
end $$;

-- 17. Synthetic data cannot enter production.
update app_settings set environment='production';
select expect_error($$insert into products (game_id, canonical_name, category, is_synthetic) values ('pokemon','demo','tin',true)$$, 'synthetic product blocked in prod');
select expect_error($$insert into inventory_observations (product_id, store_id, source_id, source_type, availability, quantity_kind, verification_status, fingerprint, is_synthetic) values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','synthetic_demo','authorized_feed','in_stock','unknown','verified','fp9',true)$$, 'synthetic observation blocked in prod');

\echo 'db constraint tests: all passed'
