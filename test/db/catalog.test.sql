-- Directory and catalog checks. Throwaway database only.
-- Probe names are fixtures. They are not Connecticut businesses or real sealed products.
-- constraints.test.sql leaves the database in production and defines expect_error.

update app_settings set environment = 'development';

insert into retailers (id, display_name) values
  ('walmart', 'Walmart'),
  ('target', 'Target'),
  ('gamestop', 'GameStop')
on conflict (id) do nothing;

-- Unverified non-synthetic product must not be readable as verified.
insert into products (id, game_id, canonical_name, category, verification_status, is_synthetic)
values ('00000000-0000-0000-0000-0000000000b1', 'pokemon', 'Probe Unverified Tin', 'tin', 'UNVERIFIED', false);

begin;
insert into products (id, game_id, canonical_name, category, is_synthetic)
values ('00000000-0000-0000-0000-0000000000b2', 'pokemon', 'Probe Verified Tin', 'tin', false);
insert into record_evidence (subject_type, subject_id, field_scope, source_label, verification_status, observed_at, is_synthetic)
values ('product', '00000000-0000-0000-0000-0000000000b2', 'record', 'probe fixture evidence', 'VERIFIED', now(), true);
update products
set verification_status = 'VERIFIED', verified_at = now()
where id = '00000000-0000-0000-0000-0000000000b2';
commit;

select expect_error($$insert into products (game_id, canonical_name, category, verification_status, verified_at, is_synthetic) values ('pokemon','Probe No Evidence','tin','VERIFIED', now(), true)$$, 'verified product without evidence');

-- Unknown identifier stays absent. A present code still needs its own evidence.
do $$ begin
  if exists (select 1 from product_identifiers where product_id = '00000000-0000-0000-0000-0000000000b2') then
    raise exception 'FAIL - identifier was invented for a product';
  end if;
  raise notice 'ok - missing identifier stays absent';
end $$;
select expect_error($$insert into product_identifiers (product_id, id_type, value) values ('00000000-0000-0000-0000-0000000000b2','gtin','')$$, 'empty gtin rejected');
select expect_error($$insert into product_identifiers (product_id, id_type, value, verification_status, verified_at) values ('00000000-0000-0000-0000-0000000000b2','gtin','12345670','VERIFIED', now())$$, 'verified gtin without evidence');

-- Separate chain locations stay separate. The same address does not.
insert into stores (retailer_id, name, address_line, city, zip, is_synthetic) values
  ('bestbuy', 'Probe Chain North', '40 Chain Road', 'Probeville', '06040', true),
  ('bestbuy', 'Probe Chain South', '41 Chain Road', 'Probeville', '06040', true);
select expect_error($$insert into stores (retailer_id, name, address_line, city, zip, is_synthetic) values ('bestbuy','Probe Chain Dup','40 Chain Road','Probeville','06040', true)$$, 'duplicate chain address');
select expect_error($$insert into stores (retailer_id, name, address_line, city, zip, is_synthetic) values ('bestbuy','Probe Chain Spaced','40  Chain   Road','Probeville','06040', true)$$, 'collapsed chain address');
insert into stores (retailer_id, name, address_line, city, zip, is_synthetic)
values ('target', 'Probe Other Banner', '40 Chain Road', 'Probeville', '06040', true);

-- Same name in two languages is two products. A second English row is not.
insert into products (game_id, canonical_name, category, language, is_synthetic) values
  ('pokemon', 'Probe Language Tin', 'tin', 'en', true),
  ('pokemon', 'Probe Language Tin', 'tin', 'ja', true);
select expect_error($$insert into products (game_id, canonical_name, category, language, is_synthetic) values ('pokemon','Probe Language Tin','tin','en', true)$$, 'duplicate language edition');
insert into products (game_id, canonical_name, category, language, packaging_variant, is_synthetic)
values ('pokemon', 'Probe Language Tin', 'tin', 'en', 'case', true);

-- Verified facts cannot be rewritten without owner resolution.
begin;
insert into products (id, import_key, game_id, canonical_name, category, language, region, lifecycle_status, is_synthetic)
values ('00000000-0000-0000-0000-0000000000b3', 'test-lock-product', 'pokemon', 'TEST Synthetic Locked Tin', 'tin', 'en', 'US', 'unknown', true);
insert into record_evidence (subject_type, subject_id, field_scope, source_label, verification_status, observed_at, is_synthetic)
values ('product', '00000000-0000-0000-0000-0000000000b3', 'record', 'lock fixture', 'VERIFIED', '2026-01-15T00:00:00Z', true);
update products
set verification_status = 'VERIFIED', verified_at = '2026-01-15T00:00:00Z'
where import_key = 'test-lock-product';
commit;

select expect_error($$update products set canonical_name = 'TEST Synthetic Locked Tin Renamed' where import_key = 'test-lock-product'$$, 'verified update without resolution');
update products set review_note = 'internal only' where import_key = 'test-lock-product';

create policy products_test_select on products for select to anon using (true);
create policy products_test_update on products for update to anon using (true) with check (true);
grant select (id, canonical_name, import_key, verification_status) on products to anon;
grant update (canonical_name) on products to anon;
set role anon;
select set_config('app.directory_resolution', 'accept_incoming', false);
select expect_error($$update products set canonical_name = 'TEST Synthetic Locked Tin Hijack' where import_key = 'test-lock-product'$$, 'anon cannot resolve verified product');
reset role;
select set_config('app.directory_resolution', '', false);
drop policy products_test_select on products;
drop policy products_test_update on products;
revoke select (import_key) on products from anon;
revoke update (canonical_name) on products from anon;

select set_config('app.directory_resolution', 'accept_incoming', false);
update products set canonical_name = 'TEST Synthetic Locked Tin Owner Edit' where import_key = 'test-lock-product';
update products set canonical_name = 'TEST Synthetic Locked Tin' where import_key = 'test-lock-product';
select set_config('app.directory_resolution', '', false);

-- Public projections hide unverified rows, synthetic rows, review notes, and evidence.
insert into stores (id, retailer_id, name, address_line, city, zip, is_synthetic)
values ('00000000-0000-0000-0000-0000000000c1', 'bestbuy', 'Probe Unverified Store', '31 Probe Road', 'Probeville', '06031', false);
begin;
insert into stores (
  id, retailer_id, name, address_line, city, zip, latitude, longitude, location_source, location_verified_at, is_synthetic
) values (
  '00000000-0000-0000-0000-0000000000c2', 'bestbuy', 'Probe Verified Store', '30 Probe Road', 'Probeville', '06030',
  41.8, -72.5, 'probe coordinate fixture', now(), false
);
insert into record_evidence (subject_type, subject_id, field_scope, source_label, verification_status, observed_at, note, is_synthetic)
values
  ('store', '00000000-0000-0000-0000-0000000000c2', 'record', 'probe store evidence', 'VERIFIED', now(), 'secret evidence note', true),
  ('store', '00000000-0000-0000-0000-0000000000c2', 'coordinates', 'probe coordinate fixture', 'PARTIAL', now(), 'secret coordinate note', true);
update stores
set verification_status = 'VERIFIED',
    verified_at = now(),
    coordinate_verification_status = 'PARTIAL'
where id = '00000000-0000-0000-0000-0000000000c2';
commit;

set role anon;
select expect_error($$select review_note from products$$, 'review_note is not granted');
select expect_error($$select note from record_evidence$$, 'evidence is not granted');
select expect_error($$update public_directory_products set canonical_name = 'nope'$$, 'public product view is not writable');
do $$ begin
  if (select count(*) from public_directory_products) <> 1 then
    raise exception 'FAIL - public products should contain only the verified non-synthetic probe';
  end if;
  if (select canonical_name from public_directory_products) <> 'Probe Verified Tin' then
    raise exception 'FAIL - public product name';
  end if;
  if exists (select 1 from products where verification_status <> 'VERIFIED') then
    raise exception 'FAIL - anon can read an unverified product';
  end if;
  if (select count(*) from public_directory_stores) <> 1 then
    raise exception 'FAIL - public stores should contain only the verified probe';
  end if;
  if (select name from public_directory_stores) <> 'Probe Verified Store' then
    raise exception 'FAIL - public store name';
  end if;
  if (select latitude is null or longitude is null from public_directory_stores) then
    raise exception 'FAIL - sourced coordinates missing from public store';
  end if;
  if exists (select 1 from stores where verification_status <> 'VERIFIED') then
    raise exception 'FAIL - anon can read an unverified store';
  end if;
  raise notice 'ok - public directory hides unverified rows';
end $$;
reset role;

grant select on record_evidence to anon;
set role anon;
do $$ begin
  if (select count(*) from record_evidence) <> 0 then
    raise exception 'FAIL - anon can read evidence rows';
  end if;
  raise notice 'ok - evidence denied by row security';
end $$;
reset role;
revoke select on record_evidence from anon;

update app_settings set environment = 'production';
select expect_error($$insert into businesses (display_name, kind, is_synthetic) values ('TEST Synthetic blocked','independent', true)$$, 'synthetic business blocked in prod');
select expect_error($$insert into record_evidence (subject_type, subject_id, field_scope, source_label, verification_status, observed_at, is_synthetic) values ('product','00000000-0000-0000-0000-0000000000b2','record','x','UNVERIFIED', now(), true)$$, 'synthetic evidence blocked in prod');
update app_settings set environment = 'development';

\echo 'db catalog tests: all passed'
