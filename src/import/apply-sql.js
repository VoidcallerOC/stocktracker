// Render one transaction for a plan that has already passed validation.
// Callers must refuse to render when the plan has conflicts or rejected rows.

function quote(value) {
  if (value == null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("refusing to render a non-finite number");
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function setResolution(resolution) {
  if (!resolution) return "";
  return `select set_config('app.directory_resolution', ${quote(resolution)}, true);\n`;
}

function evidenceSql(subjectType, importKey, evidence, isSynthetic) {
  return (evidence ?? []).map((item) => `insert into record_evidence
  (subject_type, subject_id, field_scope, source_label, source_url, verification_status, observed_at, note, is_synthetic)
select ${quote(subjectType)}, id, ${quote(item.fieldScope)}, ${quote(item.sourceLabel)}, ${quote(item.sourceUrl)},
  ${quote(item.verificationStatus)}, ${quote(item.observedAt)}::timestamptz, ${quote(item.note)}, ${quote(isSynthetic)}
from ${subjectType === "product" ? "products" : subjectType === "store" ? "stores" : "businesses"}
where import_key = ${quote(importKey)};`).join("\n");
}

function productInsert(row) {
  const promoted = row.verificationStatus === "VERIFIED" || row.verificationStatus === "PARTIAL";
  const lines = [`insert into products (
  import_key, game_id, canonical_name, category, set_name, language, region, packaging_variant,
  release_date, lifecycle_status, active, official_reference_url, verification_status, verified_at,
  review_note, is_synthetic
) values (
  ${quote(row.importKey)}, ${quote(row.game)}, ${quote(row.canonicalName)}, ${quote(row.category)},
  ${quote(promoted ? null : row.setName)}, ${quote(row.language)}, ${quote(row.region)}, ${quote(row.packagingVariant)},
  ${quote(promoted ? null : row.releaseDate)}::date, ${quote(row.lifecycleStatus)}, ${quote(row.lifecycleStatus !== "discontinued")},
  ${quote(row.officialReferenceUrl)}, ${quote(promoted ? "UNVERIFIED" : row.verificationStatus)}, NULL,
  ${quote(row.reviewNote)}, ${quote(row.isSynthetic)}
);`];
  const evidence = evidenceSql("product", row.importKey, row.evidence, row.isSynthetic);
  if (evidence) lines.push(evidence);
  if (promoted) {
    lines.push(`update products set
  verification_status = ${quote(row.verificationStatus)},
  verified_at = ${quote(row.verifiedAt)}::timestamptz,
  set_name = ${quote(row.setName)},
  release_date = ${quote(row.releaseDate)}::date
where import_key = ${quote(row.importKey)};`);
  }
  lines.push(identifierSql(row));
  return lines.filter(Boolean).join("\n");
}

function identifierSql(row) {
  return (row.identifiers ?? []).map((item) => `insert into product_identifiers (
  product_id, id_type, retailer_id, value, verification_status, verified_at, verification_source
) select id, ${quote(item.idType)}, ${quote(item.retailerId)}, ${quote(item.value)},
  ${quote(item.verificationStatus)}, ${quote(item.verifiedAt)}::timestamptz, ${quote(item.verificationSource)}
from products where import_key = ${quote(row.importKey)}
and not exists (
  select 1 from product_identifiers existing
  where existing.id_type = ${quote(item.idType)}
    and coalesce(existing.retailer_id, '') = coalesce(${quote(item.retailerId)}, '')
    and existing.value = ${quote(item.value)}
);`).join("\n");
}

function productUpdate(row, resolution) {
  return `${setResolution(resolution)}${evidenceSql("product", row.importKey, row.evidence, row.isSynthetic)}
update products set
  game_id = ${quote(row.game)},
  canonical_name = ${quote(row.canonicalName)},
  category = ${quote(row.category)},
  set_name = ${quote(row.setName)},
  language = ${quote(row.language)},
  region = ${quote(row.region)},
  packaging_variant = ${quote(row.packagingVariant)},
  release_date = ${quote(row.releaseDate)}::date,
  lifecycle_status = ${quote(row.lifecycleStatus)},
  active = ${quote(row.lifecycleStatus !== "discontinued")},
  official_reference_url = ${quote(row.officialReferenceUrl)},
  verification_status = ${quote(row.verificationStatus)},
  verified_at = ${quote(row.verifiedAt)}::timestamptz,
  review_note = ${quote(row.reviewNote)},
  is_synthetic = ${quote(row.isSynthetic)}
where import_key = ${quote(row.importKey)};
${identifierSql(row)}`;
}

function businessInsert(row) {
  const promoted = row.verificationStatus === "VERIFIED" || row.verificationStatus === "PARTIAL";
  const lines = [`insert into businesses (
  import_key, display_name, kind, retailer_id, public_website, verification_status, verified_at, review_note, is_synthetic
) values (
  ${quote(row.importKey)}, ${quote(row.displayName)}, ${quote(row.kind)}, ${quote(row.retailerId)},
  NULL, ${quote(promoted ? "UNVERIFIED" : row.verificationStatus)}, NULL, ${quote(row.reviewNote)}, ${quote(row.isSynthetic)}
);`];
  const evidence = evidenceSql("business", row.importKey, row.evidence, row.isSynthetic);
  if (evidence) lines.push(evidence);
  if (promoted) {
    lines.push(`update businesses set
  verification_status = ${quote(row.verificationStatus)},
  verified_at = ${quote(row.verifiedAt)}::timestamptz,
  public_website = ${quote(row.publicWebsite)}
where import_key = ${quote(row.importKey)};`);
  }
  return lines.join("\n");
}

function businessUpdate(row, resolution) {
  return `${setResolution(resolution)}${evidenceSql("business", row.importKey, row.evidence, row.isSynthetic)}
update businesses set
  display_name = ${quote(row.displayName)},
  kind = ${quote(row.kind)},
  retailer_id = ${quote(row.retailerId)},
  public_website = ${quote(row.publicWebsite)},
  verification_status = ${quote(row.verificationStatus)},
  verified_at = ${quote(row.verifiedAt)}::timestamptz,
  review_note = ${quote(row.reviewNote)},
  is_synthetic = ${quote(row.isSynthetic)}
where import_key = ${quote(row.importKey)};`;
}

function storeInsert(row) {
  const promoted = row.verificationStatus === "VERIFIED" || row.verificationStatus === "PARTIAL";
  const deferAddress = row.addressVerificationStatus === "VERIFIED" || row.addressVerificationStatus === "PARTIAL";
  const deferCoordinates = row.coordinateVerificationStatus === "VERIFIED" || row.coordinateVerificationStatus === "PARTIAL";
  const lines = [`insert into stores (
  import_key, business_id, retailer_id, external_store_id, name, address_line, city, state, zip,
  latitude, longitude, location_source, location_verified_at, official_url, public_phone,
  address_verification_status, coordinate_verification_status, store_format, verification_status,
  verified_at, record_status, retired_reason, review_note, is_synthetic
) values (
  ${quote(row.importKey)},
  (select id from businesses where import_key = ${quote(row.businessImportKey)}),
  ${quote(row.retailerId)}, ${quote(row.externalStoreId)}, ${quote(row.name)}, ${quote(row.addressLine)},
  ${quote(row.city)}, 'CT', ${quote(row.zip)},
  ${quote(row.latitude)}, ${quote(row.longitude)}, ${quote(row.locationSource)},
  ${quote(row.locationVerifiedAt)}::timestamptz, NULL, NULL,
  ${quote(deferAddress ? "UNVERIFIED" : row.addressVerificationStatus)},
  ${quote(deferCoordinates ? "UNVERIFIED" : row.coordinateVerificationStatus)},
  ${quote(row.storeFormat)}, ${quote(promoted ? "UNVERIFIED" : row.verificationStatus)},
  NULL, ${quote(row.recordStatus)}, ${quote(row.retiredReason)}, ${quote(row.reviewNote)}, ${quote(row.isSynthetic)}
);`];
  const evidence = evidenceSql("store", row.importKey, row.evidence, row.isSynthetic);
  if (evidence) lines.push(evidence);
  if (promoted || deferAddress || deferCoordinates) {
    lines.push(`update stores set
  verification_status = ${quote(row.verificationStatus)},
  verified_at = ${quote(row.verifiedAt)}::timestamptz,
  address_verification_status = ${quote(row.addressVerificationStatus)},
  coordinate_verification_status = ${quote(row.coordinateVerificationStatus)},
  official_url = ${quote(row.officialUrl)},
  public_phone = ${quote(row.publicPhone)}
where import_key = ${quote(row.importKey)};`);
  }
  lines.push(gameSql(row));
  return lines.filter(Boolean).join("\n");
}

function gameSql(row) {
  return (row.games ?? []).map((game) => `insert into store_game_support (store_id, game_id)
select id, ${quote(game)} from stores where import_key = ${quote(row.importKey)}
on conflict do nothing;`).join("\n");
}

function storeUpdate(row, resolution) {
  return `${setResolution(resolution)}${evidenceSql("store", row.importKey, row.evidence, row.isSynthetic)}
update stores set
  business_id = (select id from businesses where import_key = ${quote(row.businessImportKey)}),
  retailer_id = ${quote(row.retailerId)},
  external_store_id = ${quote(row.externalStoreId)},
  name = ${quote(row.name)},
  address_line = ${quote(row.addressLine)},
  city = ${quote(row.city)},
  state = 'CT',
  zip = ${quote(row.zip)},
  latitude = ${quote(row.latitude)},
  longitude = ${quote(row.longitude)},
  location_source = ${quote(row.locationSource)},
  location_verified_at = ${quote(row.locationVerifiedAt)}::timestamptz,
  official_url = ${quote(row.officialUrl)},
  public_phone = ${quote(row.publicPhone)},
  address_verification_status = ${quote(row.addressVerificationStatus)},
  coordinate_verification_status = ${quote(row.coordinateVerificationStatus)},
  store_format = ${quote(row.storeFormat)},
  verification_status = ${quote(row.verificationStatus)},
  verified_at = ${quote(row.verifiedAt)}::timestamptz,
  record_status = ${quote(row.recordStatus)},
  retired_reason = ${quote(row.retiredReason)},
  review_note = ${quote(row.reviewNote)},
  is_synthetic = ${quote(row.isSynthetic)}
where import_key = ${quote(row.importKey)};
${gameSql(row)}
${row.successorImportKey ? `update stores set successor_store_id = (select id from stores where import_key = ${quote(row.successorImportKey)})
where import_key = ${quote(row.importKey)};` : ""}`;
}

export function renderApplySql(plan) {
  if (!plan?.ok) throw new Error("refusing to render SQL for a plan with conflicts or rejected rows");
  const writes = plan.actions.filter((action) => action.op !== "unchanged");
  const chunks = ["begin;"];
  const order = { business: 0, store: 1, product: 2 };
  const sorted = [...writes].sort((a, b) => order[a.kind] - order[b.kind] || a.importKey.localeCompare(b.importKey));
  for (const action of sorted) {
    if (action.kind === "business" && action.op === "insert") chunks.push(businessInsert(action.row));
    else if (action.kind === "business") chunks.push(businessUpdate(action.row, action.resolution));
    else if (action.kind === "store" && action.op === "insert") chunks.push(storeInsert(action.row));
    else if (action.kind === "store") chunks.push(storeUpdate(action.row, action.resolution));
    else if (action.kind === "product" && action.op === "insert") chunks.push(productInsert(action.row));
    else chunks.push(productUpdate(action.row, action.resolution));
  }
  const successors = sorted.filter((action) => action.kind === "store" && action.op === "insert" && action.row.successorImportKey);
  for (const action of successors) {
    chunks.push(`update stores set successor_store_id = (select id from stores where import_key = ${quote(action.row.successorImportKey)})
where import_key = ${quote(action.row.importKey)};`);
  }
  chunks.push("commit;");
  return `${chunks.join("\n")}\n`;
}
