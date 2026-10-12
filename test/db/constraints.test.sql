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

-- Public read is security invoker, hides reporter identity, and is not writable.
do $$
declare
  opts text[];
begin
  select reloptions into opts from pg_class where oid = 'public_observations'::regclass;
  if opts is null or not (opts @> array['security_invoker=true'] and opts @> array['security_barrier=true']) then
    raise exception 'FAIL - public_observations must be security_invoker and security_barrier, got %', opts;
  end if;
  if pg_get_viewdef('public_observations'::regclass) ilike '%reporter_id%' then
    raise exception 'FAIL - public view references reporter_id';
  end if;
  if has_column_privilege('anon', 'inventory_observations', 'reporter_id', 'select') then
    raise exception 'FAIL - anon can select reporter_id';
  end if;
  if not has_column_privilege('anon', 'inventory_observations', 'availability', 'select') then
    raise exception 'FAIL - anon cannot select public availability column';
  end if;
  if has_table_privilege('anon', 'subscriptions', 'select')
     or has_table_privilege('anon', 'audit_log', 'select') then
    raise exception 'FAIL - anon can read private tables';
  end if;
  raise notice 'ok - public view ownership options and column grants';
end $$;

set role anon;
select expect_error($$insert into public_observations (id, product_id, store_id, source_id, source_type, availability, quantity_kind, quantity_exact, quantity_min, quantity_max, source_timestamp, received_at, verification_status, community_reported) values ('00000000-0000-0000-0000-00000000f0aa','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','community','community_report','in_stock','estimate',null,1,1,now(),now(),'accepted',true)$$, 'anon cannot insert through public view');
select expect_error($$update public_observations set availability = 'out_of_stock'$$, 'anon cannot update public view');
select expect_error($$delete from public_observations$$, 'anon cannot delete public view');
select expect_error($$select reporter_id from inventory_observations$$, 'anon cannot read reporter_id');
select expect_error($$insert into inventory_observations (product_id, store_id, source_id, source_type, availability, quantity_kind, verification_status, fingerprint) values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','synthetic_demo','authorized_feed','in_stock','unknown','verified','fp-anon')$$, 'anon cannot insert observations');
select expect_error($$select * from subscriptions$$, 'anon cannot read subscriptions');
select expect_error($$select * from purge_expired_source_data(now())$$, 'anon cannot purge');
do $$ begin
  if (select count(*) from public_observations) <> 1 then
    raise exception 'FAIL - anon should see only the accepted community report';
  end if;
  if (select community_reported from public_observations) is not true then
    raise exception 'FAIL - community report must be distinguishable';
  end if;
  raise notice 'ok - anon public read';
end $$;
reset role;

-- Contradictory community reports stay visible and keep reporter ids off the public surface.
insert into inventory_observations (id, product_id, store_id, source_id, source_type, availability, quantity_kind, quantity_min, quantity_max, verification_status, reporter_id, fingerprint, received_at)
values
  ('00000000-0000-0000-0000-00000000f011','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','community','community_report','in_stock','estimate',1,2,'accepted','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','fp-conflict-in', clock_timestamp()),
  ('00000000-0000-0000-0000-00000000f012','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','community','community_report','out_of_stock','estimate',0,0,'accepted','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','fp-conflict-out', clock_timestamp()),
  ('00000000-0000-0000-0000-00000000f013','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','community','community_report','in_stock','estimate',1,2,'accepted','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','fp-dup-same-reporter', clock_timestamp());
do $$ begin
  if (select count(*) from public_observations where id in (
    '00000000-0000-0000-0000-00000000f011',
    '00000000-0000-0000-0000-00000000f012',
    '00000000-0000-0000-0000-00000000f013')) <> 3 then
    raise exception 'FAIL - contradictory and duplicate community rows must remain visible to the resolver';
  end if;
  raise notice 'ok - contradictory community rows are not collapsed in the public feed';
end $$;
update inventory_observations set verification_status = 'expired' where fingerprint = 'fp-conflict-out';
do $$ begin
  if exists (select 1 from public_observations where id = '00000000-0000-0000-0000-00000000f012') then
    raise exception 'FAIL - expired community report still public';
  end if;
  if not exists (select 1 from inventory_observations where fingerprint = 'fp-conflict-out') then
    raise exception 'FAIL - expiring a community report must not delete history';
  end if;
  raise notice 'ok - expired community report hidden, row kept';
end $$;

-- Retention: authorization, exact 72h boundary, derived payload removal, repeat, and failed purge.
insert into retailers values ('walmart','Walmart');
insert into inventory_sources (id, retailer_id, source_type, authorization_status) values
  ('bestbuy_developer_api','bestbuy','authorized_feed','PARTIAL'),
  ('walmart_affiliate_api','walmart','authorized_feed','VERIFIED'),
  ('retention_fixture', null, 'authorized_feed', 'VERIFIED');
insert into source_retention_policies (source_id, mode, max_age, contractual_basis, provisional)
values ('retention_fixture','purge_after', interval '72 hours', 'test fixture for retention boundary', true);

insert into inventory_observations (id, product_id, store_id, source_id, source_type, availability, quantity_kind, quantity_exact, verification_status, fingerprint, received_at)
values
  ('00000000-0000-0000-0000-00000000f021','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','bestbuy_developer_api','authorized_feed','in_stock','exact',42,'verified','fp-bb-old', clock_timestamp() - interval '72 hours'),
  ('00000000-0000-0000-0000-00000000f022','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','bestbuy_developer_api','authorized_feed','in_stock','exact',7,'verified','fp-bb-young', clock_timestamp() - interval '71 hours'),
  ('00000000-0000-0000-0000-00000000f023','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','retention_fixture','authorized_feed','in_stock','exact',3,'verified','fp-fix-old', clock_timestamp() - interval '72 hours'),
  ('00000000-0000-0000-0000-00000000f024','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','retention_fixture','authorized_feed','in_stock','exact',4,'verified','fp-fix-young', clock_timestamp() - interval '72 hours' + interval '1 minute'),
  ('00000000-0000-0000-0000-00000000f025','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','walmart_affiliate_api','authorized_feed','in_stock','exact',9,'verified','fp-wmt-fresh', clock_timestamp());

insert into stock_changes (product_id, store_id, source_id, previous_observation_id, new_observation_id, previous_quantity, new_quantity, delta)
values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','bestbuy_developer_api','00000000-0000-0000-0000-00000000f021','00000000-0000-0000-0000-00000000f022',2,42,40);
insert into notification_events (id, idempotency_key, observation_id, trigger, confidence, community_reported)
values ('00000000-0000-0000-0000-00000000e021','k-bb-old','00000000-0000-0000-0000-00000000f021','restock','high',false);
insert into moderation_actions (observation_id, moderator_id, action, reason)
values ('00000000-0000-0000-0000-00000000f021','cccccccc-cccc-cccc-cccc-cccccccccccc','accept','secret-payload-42');

insert into inventory_observations (id, product_id, store_id, source_id, source_type, availability, quantity_kind, verification_status, reporter_id, fingerprint, received_at)
values
  ('00000000-0000-0000-0000-00000000f031','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','community','community_report','in_stock','unknown','accepted','dddddddd-dddd-dddd-dddd-dddddddddddd','fp-comm-old', clock_timestamp() - interval '12 hours'),
  ('00000000-0000-0000-0000-00000000f032','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','community','community_report','out_of_stock','unknown','accepted','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','fp-comm-young', clock_timestamp() - interval '12 hours' + interval '1 minute');

set role anon;
do $$ begin
  if exists (select 1 from public_observations where source_id = 'bestbuy_developer_api') then
    raise exception 'FAIL - partial Best Buy rows must not be public';
  end if;
  if exists (select 1 from public_observations where source_id = 'walmart_affiliate_api') then
    raise exception 'FAIL - do_not_retain rows must not be public';
  end if;
  if exists (select 1 from public_observations where id = '00000000-0000-0000-0000-00000000f023') then
    raise exception 'FAIL - observation at the 72h boundary is still public';
  end if;
  if not exists (select 1 from public_observations where id = '00000000-0000-0000-0000-00000000f024') then
    raise exception 'FAIL - observation inside the retention window should be public';
  end if;
  raise notice 'ok - anon retention and authorization filters';
end $$;
reset role;

select * from purge_expired_source_data(clock_timestamp());

do $$ begin
  if exists (select 1 from inventory_observations where fingerprint in ('fp-bb-old','fp-fix-old','fp-wmt-fresh')) then
    raise exception 'FAIL - expired or do-not-retain payloads were not deleted';
  end if;
  if not exists (select 1 from inventory_observations where fingerprint in ('fp-bb-young','fp-fix-young')) then
    raise exception 'FAIL - in-window observations were deleted';
  end if;
  if exists (select 1 from stock_changes where new_quantity = 42 or previous_quantity = 2 and source_id = 'bestbuy_developer_api') then
    raise exception 'FAIL - derived Best Buy quantities survived purge';
  end if;
  if exists (select 1 from notification_events where idempotency_key = 'k-bb-old') then
    raise exception 'FAIL - notification row for purged observation survived';
  end if;
  if exists (select 1 from moderation_actions where reason = 'secret-payload-42') then
    raise exception 'FAIL - moderation payload survived purge';
  end if;
  if exists (
    select 1
    from audit_log,
         jsonb_array_elements(detail->'sources') src
    where action = 'retention_purge'
      and (
        detail::text like '%secret-payload%'
        or detail::text like '%fp-bb-old%'
        or src - array['source_id','deleted','expired'] <> '{}'::jsonb
      )
  ) then
    raise exception 'FAIL - purge audit stored retailer payload';
  end if;
  if (select verification_status from inventory_observations where fingerprint = 'fp-comm-old') <> 'expired' then
    raise exception 'FAIL - old community report should be expired, not deleted';
  end if;
  if (select verification_status from inventory_observations where fingerprint = 'fp-comm-young') <> 'accepted' then
    raise exception 'FAIL - community report inside the display window was expired';
  end if;
  if not exists (select 1 from public_observations where id = '00000000-0000-0000-0000-00000000f024') then
    raise exception 'FAIL - in-window fixture disappeared from the public feed';
  end if;
  if exists (select 1 from public_observations where id = '00000000-0000-0000-0000-00000000f031') then
    raise exception 'FAIL - expired community report is public after purge';
  end if;
  raise notice 'ok - retention purge boundaries';
end $$;

select * from purge_expired_source_data(clock_timestamp());
do $$ begin
  if exists (
    select 1 from purge_expired_source_data(clock_timestamp())
    where deleted_observations <> 0 or expired_observations <> 0
  ) then
    raise exception 'FAIL - repeat purge was not a no-op';
  end if;
  raise notice 'ok - repeat purge is a no-op';
end $$;

-- Give app_user the table privileges and an RLS delete policy a mistaken grant would
-- confer. The trigger must still reject the delete because the caller is not the
-- purge function owner.
create policy observations_app_select on inventory_observations for select to app_user using (true);
create policy observations_app_delete on inventory_observations for delete to app_user using (true);
grant select, delete on inventory_observations to app_user;
set role app_user;
select set_config('app.retention_purge', 'on', true);
select expect_error($$delete from inventory_observations where fingerprint = 'fp-fix-young'$$, 'app user cannot purge even with the retention flag');
reset role;
revoke select, delete on inventory_observations from app_user;
drop policy observations_app_select on inventory_observations;
drop policy observations_app_delete on inventory_observations;
do $$ begin
  if not exists (select 1 from inventory_observations where fingerprint = 'fp-fix-young') then
    raise exception 'FAIL - failed purge attempt removed a row';
  end if;
  raise notice 'ok - failed purge left rows in place';
end $$;

set role retention_worker;
select * from purge_expired_source_data(clock_timestamp());
reset role;

-- 17. Synthetic data cannot enter production.
update app_settings set environment='production';
select expect_error($$insert into products (game_id, canonical_name, category, is_synthetic) values ('pokemon','demo','tin',true)$$, 'synthetic product blocked in prod');
select expect_error($$insert into inventory_observations (product_id, store_id, source_id, source_type, availability, quantity_kind, verification_status, fingerprint, is_synthetic) values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','synthetic_demo','authorized_feed','in_stock','unknown','verified','fp9',true)$$, 'synthetic observation blocked in prod');

\echo 'db constraint tests: all passed'
