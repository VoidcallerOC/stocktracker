// Pure import planner. Dry-run and apply both use this so a dry-run cannot write.
// Conflicts are reported. A previously VERIFIED identity is not overwritten quietly.

import {
  productIdentityKey,
  storeBranchKey,
  validateBusiness,
  validateProduct,
  validateStore,
} from "../domain/directory.js";

const PRODUCT_IDENTITY_FIELDS = [
  "game",
  "category",
  "canonicalName",
  "setName",
  "language",
  "region",
  "packagingVariant",
  "releaseDate",
  "lifecycleStatus",
  "verificationStatus",
  "verifiedAt",
  "officialReferenceUrl",
  "isSynthetic",
];

const STORE_IDENTITY_FIELDS = [
  "businessImportKey",
  "retailerId",
  "externalStoreId",
  "name",
  "addressLine",
  "city",
  "state",
  "zip",
  "latitude",
  "longitude",
  "locationSource",
  "locationVerifiedAt",
  "officialUrl",
  "publicPhone",
  "addressVerificationStatus",
  "coordinateVerificationStatus",
  "storeFormat",
  "verificationStatus",
  "verifiedAt",
  "recordStatus",
  "retiredReason",
  "successorImportKey",
  "isSynthetic",
];

const BUSINESS_IDENTITY_FIELDS = [
  "displayName",
  "kind",
  "retailerId",
  "publicWebsite",
  "verificationStatus",
  "verifiedAt",
  "isSynthetic",
];

function blankExisting(existing) {
  return {
    businesses: existing?.businesses ?? [],
    stores: existing?.stores ?? [],
    products: existing?.products ?? [],
  };
}

function sameList(left, right, keyFn) {
  const a = [...(left ?? [])].map(keyFn).sort();
  const b = [...(right ?? [])].map(keyFn).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function changedFields(before, after, fields) {
  return fields.filter((field) => (before[field] ?? null) !== (after[field] ?? null));
}

function identifierKey(item) {
  return [item.idType, item.retailerId ?? "", item.value, item.verificationStatus].join("|");
}

function identifierOwnerKey(item) {
  return [item.idType, item.retailerId ?? "", item.value].join("|");
}

function evidenceKey(item) {
  return JSON.stringify([
    item.fieldScope ?? null,
    item.claimKey ?? null,
    item.sourceLabel ?? null,
    item.sourceUrl ?? null,
    item.verificationStatus ?? null,
    item.observedAt ?? null,
    item.note ?? null,
  ]);
}

function evidenceAdditions(before, after) {
  const have = new Set((before.evidence ?? []).map(evidenceKey));
  return (after.evidence ?? []).some((item) => !have.has(evidenceKey(item)));
}

function productContentChanged(before, after) {
  return changedFields(before, after, PRODUCT_IDENTITY_FIELDS)
    .concat((before.reviewNote ?? null) !== (after.reviewNote ?? null) ? ["reviewNote"] : [])
    .concat(sameList(before.identifiers, after.identifiers, identifierKey) ? [] : ["identifiers"])
    .concat(evidenceAdditions(before, after) ? ["evidence"] : []);
}

function storeContentChanged(before, after) {
  return changedFields(before, after, STORE_IDENTITY_FIELDS)
    .concat((before.reviewNote ?? null) !== (after.reviewNote ?? null) ? ["reviewNote"] : [])
    .concat(sameList(before.games, after.games, (game) => game) ? [] : ["games"])
    .concat(evidenceAdditions(before, after) ? ["evidence"] : []);
}

function businessContentChanged(before, after) {
  return changedFields(before, after, BUSINESS_IDENTITY_FIELDS)
    .concat((before.reviewNote ?? null) !== (after.reviewNote ?? null) ? ["reviewNote"] : [])
    .concat(evidenceAdditions(before, after) ? ["evidence"] : []);
}

function classify(kind, incoming, before, changed) {
  if (!before) return { op: "insert", resolution: null };
  if (changed.length === 0) return { op: "unchanged", resolution: null };
  const identityChanged = changed.some((field) => field !== "reviewNote" && field !== "evidence");
  if (before.verificationStatus === "VERIFIED" && identityChanged) {
    const retireFields = new Set(["recordStatus", "retiredReason", "successorImportKey", "reviewNote", "evidence"]);
    const retiring = kind === "store"
      && incoming.recordStatus === "retired"
      && incoming.resolution === "retire"
      && changed.every((field) => retireFields.has(field));
    if (retiring) return { op: "update", resolution: "retire" };
    if (incoming.resolution === "accept_incoming") return { op: "update", resolution: "accept_incoming" };
    return { op: "conflict", resolution: null };
  }
  return { op: "update", resolution: null };
}

function pushRejected(rejected, kind, importKey, errors) {
  rejected.push({ kind, importKey: importKey ?? null, errors });
}

function takeValid(list, validate, kind, rejected) {
  const valid = [];
  const seen = new Set();
  for (const [index, row] of (list ?? []).entries()) {
    const importKey = row && typeof row === "object" ? row.importKey : null;
    if (importKey && seen.has(importKey)) {
      pushRejected(rejected, kind, importKey, [`duplicate importKey in ${kind} batch`]);
      continue;
    }
    if (importKey) seen.add(importKey);
    const result = validate(row);
    if (result.errors.length) {
      pushRejected(rejected, kind, importKey, result.errors.map((message) => `row ${index}: ${message}`));
      continue;
    }
    valid.push(result.value);
  }
  return valid;
}

function addIdentityConflict(conflicts, kind, importKey, otherKey, identity) {
  conflicts.push({
    kind,
    importKey,
    conflictsWith: otherKey,
    identity,
    reason: "same identity as another record; editions, languages, regions, packaging, and chain locations stay separate and are not merged",
  });
}

export function planImport(input, existing = {}) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return summarize([{ kind: "document", importKey: null, errors: ["document must be an object"] }], [], []);
  }
  const unknown = Object.keys(input).filter((key) => !["businesses", "stores", "products", "fixtureNotice"].includes(key));
  const rejected = [];
  if (unknown.length) {
    rejected.push({ kind: "document", importKey: null, errors: [`unknown document fields: ${unknown.join(", ")}`] });
  }
  const prior = blankExisting(existing);
  const businesses = takeValid(input.businesses, validateBusiness, "business", rejected);
  const stores = takeValid(input.stores, validateStore, "store", rejected);
  const products = takeValid(input.products, validateProduct, "product", rejected);

  const businessKeys = new Set(prior.businesses.map((row) => row.importKey).concat(businesses.map((row) => row.importKey)));
  const knownStores = new Map();
  for (const row of prior.stores) knownStores.set(row.importKey, row);
  for (const row of stores) knownStores.set(row.importKey, row);
  for (const store of stores) {
    if (store.businessImportKey && !businessKeys.has(store.businessImportKey)) {
      pushRejected(rejected, "store", store.importKey, ["businessImportKey does not match a business in the document or the existing directory"]);
    }
    if (!store.successorImportKey) continue;
    if (store.successorImportKey === store.importKey) {
      pushRejected(rejected, "store", store.importKey, ["successorImportKey cannot reference the same store"]);
      continue;
    }
    const target = knownStores.get(store.successorImportKey);
    if (!target || target.importKey === store.importKey) {
      pushRejected(rejected, "store", store.importKey, ["successorImportKey does not match a store in the document or the existing directory"]);
      continue;
    }
    if ((target.recordStatus ?? "active") !== "active") {
      pushRejected(rejected, "store", store.importKey, ["successorImportKey cannot reference a retired store"]);
    }
  }
  const rejectedKeys = new Set(rejected.map((row) => `${row.kind}:${row.importKey}`));

  const actions = [];
  const conflicts = [];
  const plannedBusinesses = businesses.filter((row) => !rejectedKeys.has(`business:${row.importKey}`));
  const plannedStores = stores.filter((row) => !rejectedKeys.has(`store:${row.importKey}`));
  const plannedProducts = products.filter((row) => !rejectedKeys.has(`product:${row.importKey}`));

  const businessByKey = new Map(prior.businesses.map((row) => [row.importKey, row]));
  const storeByKey = new Map(prior.stores.map((row) => [row.importKey, row]));
  const productByKey = new Map(prior.products.map((row) => [row.importKey, row]));
  const branchOwners = new Map();
  for (const row of prior.stores) {
    if ((row.recordStatus ?? "active") !== "active") continue;
    branchOwners.set(storeBranchKey(row), row.importKey ?? row.id ?? "existing");
  }
  const productOwners = new Map();
  const identifierOwners = new Map();
  for (const row of prior.products) {
    productOwners.set(productIdentityKey(row), row.importKey ?? row.id ?? "existing");
    for (const item of row.identifiers ?? []) identifierOwners.set(identifierOwnerKey(item), row.importKey ?? row.id ?? "existing");
  }

  for (const row of plannedBusinesses) {
    const before = businessByKey.get(row.importKey) ?? null;
    const changed = before ? businessContentChanged(before, row) : [];
    const decision = classify("business", row, before, changed);
    if (decision.op === "conflict") {
      conflicts.push({
        kind: "business",
        importKey: row.importKey,
        reason: "verified record would change without an explicit resolution",
        fields: changed,
      });
      continue;
    }
    actions.push({ kind: "business", op: decision.op, importKey: row.importKey, resolution: decision.resolution, row });
  }

  for (const row of plannedStores) {
    const before = storeByKey.get(row.importKey) ?? null;
    const branch = storeBranchKey(row);
    const owner = branchOwners.get(branch);
    if ((row.recordStatus ?? "active") === "active" && owner && owner !== row.importKey) {
      addIdentityConflict(conflicts, "store", row.importKey, owner, branch);
      continue;
    }
    const changed = before ? storeContentChanged(before, row) : [];
    const decision = classify("store", row, before, changed);
    if (decision.op === "conflict") {
      conflicts.push({
        kind: "store",
        importKey: row.importKey,
        reason: "verified record would change without an explicit resolution",
        fields: changed,
      });
      continue;
    }
    if ((row.recordStatus ?? "active") === "active") branchOwners.set(branch, row.importKey);
    actions.push({ kind: "store", op: decision.op, importKey: row.importKey, resolution: decision.resolution, row });
  }

  for (const row of plannedProducts) {
    const before = productByKey.get(row.importKey) ?? null;
    const identity = productIdentityKey(row);
    const owner = productOwners.get(identity);
    if (owner && owner !== row.importKey) {
      addIdentityConflict(conflicts, "product", row.importKey, owner, identity);
      continue;
    }
    let identifierConflict = false;
    for (const item of row.identifiers ?? []) {
      const key = identifierOwnerKey(item);
      const identifierOwner = identifierOwners.get(key);
      if (identifierOwner && identifierOwner !== row.importKey) {
        conflicts.push({
          kind: "product",
          importKey: row.importKey,
          conflictsWith: identifierOwner,
          identity: key,
          reason: "identifier already belongs to another product",
        });
        identifierConflict = true;
      }
    }
    if (identifierConflict) continue;
    const changed = before ? productContentChanged(before, row) : [];
    const decision = classify("product", row, before, changed);
    if (decision.op === "conflict") {
      conflicts.push({
        kind: "product",
        importKey: row.importKey,
        reason: "verified record would change without an explicit resolution",
        fields: changed,
      });
      continue;
    }
    productOwners.set(identity, row.importKey);
    for (const item of row.identifiers ?? []) identifierOwners.set(identifierOwnerKey(item), row.importKey);
    actions.push({ kind: "product", op: decision.op, importKey: row.importKey, resolution: decision.resolution, row });
  }

  return summarize(rejected, conflicts, actions);
}

function summarize(rejected, conflicts, actions) {
  const summary = {
    inserts: actions.filter((action) => action.op === "insert").length,
    updates: actions.filter((action) => action.op === "update").length,
    unchanged: actions.filter((action) => action.op === "unchanged").length,
    conflicts: conflicts.length,
    rejected: rejected.length,
  };
  return {
    ok: summary.conflicts === 0 && summary.rejected === 0,
    summary,
    actions,
    conflicts,
    rejected,
  };
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const source = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else inQuotes = false;
      } else cell += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  if (inQuotes) throw new Error("CSV quote is not closed");
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((columns) => columns.some((column) => column.trim() !== ""));
}

const CSV_COLUMNS = new Set([
  "record_type", "import_key", "display_name", "kind", "retailer_id", "public_website",
  "name", "address_line", "city", "state", "zip", "latitude", "longitude", "location_source",
  "location_verified_at", "official_url", "public_phone", "address_verification_status",
  "coordinate_verification_status", "store_format", "game", "category", "canonical_name",
  "set_name", "language", "region", "packaging_variant", "release_date", "lifecycle_status",
  "official_reference_url", "verification_status", "verified_at", "is_synthetic", "review_note",
  "business_import_key", "games", "record_status", "retired_reason", "successor_import_key",
  "resolution", "evidence_source_label", "evidence_source_url", "evidence_field_scope",
  "evidence_status", "evidence_observed_at", "evidence_note",
]);

function csvValue(raw) {
  const value = raw?.trim() ?? "";
  return value === "" ? null : value;
}

function csvEvidence(record) {
  const sourceLabel = csvValue(record.evidence_source_label);
  if (!sourceLabel) return [];
  return [{
    sourceLabel,
    sourceUrl: csvValue(record.evidence_source_url),
    fieldScope: csvValue(record.evidence_field_scope) ?? "record",
    verificationStatus: csvValue(record.evidence_status),
    observedAt: csvValue(record.evidence_observed_at),
    note: csvValue(record.evidence_note),
  }];
}

export function csvToDirectory(text) {
  const table = parseCsv(text);
  if (!table.length) return { businesses: [], stores: [], products: [] };
  const header = table[0].map((column) => column.trim());
  const seenHeaders = new Set();
  const unknown = [];
  for (const column of header) {
    if (!column || !CSV_COLUMNS.has(column)) unknown.push(column || "(blank)");
    if (seenHeaders.has(column)) throw new Error(`duplicate CSV column: ${column || "(blank)"}`);
    seenHeaders.add(column);
  }
  if (unknown.length) throw new Error(`unknown CSV columns: ${unknown.join(", ")}`);
  const records = table.slice(1).map((columns) => {
    const record = {};
    header.forEach((key, index) => {
      record[key] = columns[index] ?? "";
    });
    return record;
  });
  const businesses = [];
  const stores = [];
  const products = [];
  for (const record of records) {
    const type = csvValue(record.record_type);
    const syntheticText = record.is_synthetic == null ? "" : String(record.is_synthetic).trim();
    if (syntheticText !== "true" && syntheticText !== "false") {
      throw new Error(`is_synthetic must be true or false for ${csvValue(record.import_key) ?? "a CSV row"}`);
    }
    const shared = {
      importKey: csvValue(record.import_key),
      verificationStatus: csvValue(record.verification_status),
      verifiedAt: csvValue(record.verified_at),
      isSynthetic: syntheticText === "true",
      reviewNote: csvValue(record.review_note),
      evidence: csvEvidence(record),
      resolution: csvValue(record.resolution),
    };
    if (type === "business") {
      businesses.push({
        ...shared,
        displayName: csvValue(record.display_name),
        kind: csvValue(record.kind),
        retailerId: csvValue(record.retailer_id),
        publicWebsite: csvValue(record.public_website),
      });
    } else if (type === "store") {
      const games = csvValue(record.games);
      stores.push({
        ...shared,
        businessImportKey: csvValue(record.business_import_key),
        retailerId: csvValue(record.retailer_id),
        name: csvValue(record.name),
        addressLine: csvValue(record.address_line),
        city: csvValue(record.city),
        state: csvValue(record.state),
        zip: csvValue(record.zip),
        latitude: csvValue(record.latitude) == null ? null : Number(record.latitude),
        longitude: csvValue(record.longitude) == null ? null : Number(record.longitude),
        locationSource: csvValue(record.location_source),
        locationVerifiedAt: csvValue(record.location_verified_at),
        officialUrl: csvValue(record.official_url),
        publicPhone: csvValue(record.public_phone),
        addressVerificationStatus: csvValue(record.address_verification_status) ?? "UNVERIFIED",
        coordinateVerificationStatus: csvValue(record.coordinate_verification_status) ?? "UNVERIFIED",
        storeFormat: csvValue(record.store_format),
        games: games ? games.split("|").filter(Boolean) : [],
        recordStatus: csvValue(record.record_status) ?? "active",
        retiredReason: csvValue(record.retired_reason),
        successorImportKey: csvValue(record.successor_import_key),
      });
    } else if (type === "product") {
      products.push({
        ...shared,
        game: csvValue(record.game),
        category: csvValue(record.category),
        canonicalName: csvValue(record.canonical_name),
        setName: csvValue(record.set_name),
        language: csvValue(record.language),
        region: csvValue(record.region),
        packagingVariant: csvValue(record.packaging_variant),
        releaseDate: csvValue(record.release_date),
        lifecycleStatus: csvValue(record.lifecycle_status) ?? "unknown",
        officialReferenceUrl: csvValue(record.official_reference_url),
        identifiers: [],
      });
    } else {
      products.push({ importKey: csvValue(record.import_key), game: null });
    }
  }
  return { businesses, stores, products };
}
