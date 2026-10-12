-- Integrity checks for directory claims. Throwaway database only.
-- Runs after catalog.test.sql, which defines expect_error and leaves development mode.

-- A set name, release date, phone, or website needs evidence for that field.
insert into products (id, game_id, canonical_name, category, is_synthetic)
values ('00000000-0000-0000-0000-0000000000d1', 'pokemon', 'Probe Field Tin', 'tin', true);
insert into record_evidence (subject_type, subject_id, field_scope, source_label, verification_status, observed_at, is_synthetic)
values ('product', '00000000-0000-0000-0000-0000000000d1', 'record', 'probe record', 'VERIFIED', now(), true);
select expect_error($$update products set verification_status = 'VERIFIED', verified_at = now(), set_name = 'Unevidenced Set' where id = '00000000-0000-0000-0000-0000000000d1'$$, 'set_name without set evidence');
select expect_error($$update products set verification_status = 'VERIFIED', verified_at = now(), release_date = '2024-01-01' where id = '00000000-0000-0000-0000-0000000000d1'$$, 'release date without release evidence');
update products set verification_status = 'VERIFIED', verified_at = now()
where id = '00000000-0000-0000-0000-0000000000d1';

insert into businesses (id, display_name, kind, is_synthetic)
values ('00000000-0000-0000-0000-0000000000d2', 'Probe Field Shop', 'independent', true);
insert into record_evidence (subject_type, subject_id, field_scope, source_label, verification_status, observed_at, is_synthetic)
values ('business', '00000000-0000-0000-0000-0000000000d2', 'record', 'probe business', 'VERIFIED', now(), true);
select expect_error($$update businesses set verification_status = 'VERIFIED', verified_at = now(), public_website = 'https://example.invalid/shop' where id = '00000000-0000-0000-0000-0000000000d2'$$, 'website without website evidence');

insert into stores (id, retailer_id, name, address_line, city, zip, is_synthetic)
values ('00000000-0000-0000-0000-0000000000d3', 'bestbuy', 'Probe Contact Store', '3 Probe Road', 'Probeville', '06003', true);
insert into record_evidence (subject_type, subject_id, field_scope, source_label, verification_status, observed_at, is_synthetic)
values ('store', '00000000-0000-0000-0000-0000000000d3', 'record', 'probe store record', 'VERIFIED', now(), true);
select expect_error($$update stores set verification_status = 'VERIFIED', verified_at = now(), address_verification_status = 'VERIFIED', official_url = 'https://example.invalid/store', public_phone = '860-555-0199' where id = '00000000-0000-0000-0000-0000000000d3'$$, 'phone and website without field evidence');

-- One identifier's evidence does not authorize another code, and it cannot attach to a weaker product.
insert into record_evidence (subject_type, subject_id, field_scope, claim_key, source_label, verification_status, observed_at, is_synthetic)
values ('product', '00000000-0000-0000-0000-0000000000d1', 'identifier', '12345670', 'probe code', 'VERIFIED', now(), true);
insert into product_identifiers (product_id, id_type, value, verification_status, verified_at)
values ('00000000-0000-0000-0000-0000000000d1', 'gtin', '12345670', 'VERIFIED', now());
select expect_error($$insert into product_identifiers (product_id, id_type, value, verification_status, verified_at) values ('00000000-0000-0000-0000-0000000000d1','gtin','87654321','VERIFIED', now())$$, 'second code without its own evidence');
insert into record_evidence (subject_type, subject_id, field_scope, claim_key, source_label, verification_status, observed_at, is_synthetic)
values ('product', '00000000-0000-0000-0000-0000000000b1', 'identifier', '12345670', 'probe weaker product', 'VERIFIED', now(), true);
select expect_error($$insert into product_identifiers (product_id, id_type, value, verification_status, verified_at) values ('00000000-0000-0000-0000-0000000000b1','gtin','11111111','VERIFIED', now())$$, 'verified identifier on unverified product');
select expect_error($$insert into product_identifiers (product_id, id_type, value, verification_status) values ('00000000-0000-0000-0000-0000000000d1','publisher_code','PROBE','UNVERIFIED')$$, 'unverified identifier stays absent');

-- Identity fields and evidence cannot be stripped without an authorized resolution.
select expect_error($$update products set import_key = 'renamed-lock' where import_key = 'test-lock-product'$$, 'import key change requires resolution');
select expect_error($$update products set verified_at = now() where import_key = 'test-lock-product'$$, 'verified_at change requires resolution');
select expect_error($$delete from record_evidence where subject_id = '00000000-0000-0000-0000-0000000000b3' and field_scope = 'record'$$, 'cannot delete the last verified evidence');

-- Packaging that differs only by case is one product.
insert into products (game_id, canonical_name, category, packaging_variant, is_synthetic)
values ('pokemon', 'Probe Case Tin', 'tin', 'Case', true);
select expect_error($$insert into products (game_id, canonical_name, category, packaging_variant, is_synthetic) values ('pokemon','Probe Case Tin','tin','case', true)$$, 'packaging case is the same identity');

-- Public game claims do not attach to an unverified store.
insert into store_game_support (store_id, game_id)
values ('00000000-0000-0000-0000-0000000000c1', 'pokemon');
set role anon;
do $$ begin
  if exists (select 1 from store_game_support where store_id = '00000000-0000-0000-0000-0000000000c1') then
    raise exception 'FAIL - anon can read game support for an unverified store';
  end if;
  if exists (select 1 from public_product_identifiers where value = '12345670') then
    raise exception 'FAIL - synthetic identifier is public';
  end if;
  if exists (select 1 from product_identifiers where value = '12345670') then
    raise exception 'FAIL - anon can read an identifier on a synthetic product through the table';
  end if;
  raise notice 'ok - unverified attachments stay hidden';
end $$;
reset role;

-- 0002 objects are still present after 0003.
do $$ begin
  if to_regclass('public.public_observations') is null then
    raise exception 'FAIL - 0003 removed public_observations';
  end if;
  if (select count(*) from source_retention_policies where source_id in (
    'walmart_affiliate_api', 'target', 'gamestop', 'bestbuy_developer_api', 'community', 'synthetic_demo'
  )) <> 6 then
    raise exception 'FAIL - retention policies did not survive 0003';
  end if;
  if (select mode from source_retention_policies where source_id = 'bestbuy_developer_api') <> 'purge_after' then
    raise exception 'FAIL - Best Buy retention mode changed';
  end if;
  raise notice 'ok - 0002 objects survived 0003';
end $$;
