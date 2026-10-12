// Validation for the store directory and sealed-product catalog.
// Unknown facts stay null. A VERIFIED claim needs its own evidence.
// This module does not talk to retailer APIs and does not invent identifiers.

import {
  AUTH_STATUS,
  BUSINESS_KINDS,
  EVIDENCE_SCOPES,
  GAMES,
  KNOWN_RETAILER_IDS,
  LIFECYCLE_STATUS,
  PRODUCT_CATEGORIES,
  RECORD_VERIFICATION,
  STORE_FORMATS,
  STORE_RECORD_STATUS,
} from "./constants.js";

export const IMPORT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const LANGUAGE_RE = /^[a-z]{2}$/;
const REGION_RE = /^[A-Z]{2}$/;
const ZIP_RE = /^06[0-9]{3}$/;
const GTIN_RE = /^[0-9]{8,14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^[0-9+(). -]{7,40}$/;

export const VERIFICATION_RANK = Object.freeze({
  BLOCKED: 0,
  UNVERIFIED: 1,
  PARTIAL: 2,
  VERIFIED: 3,
});

export function collapseWs(value) {
  if (value == null) return null;
  const collapsed = String(value).trim().replace(/\s+/g, " ");
  return collapsed === "" ? null : collapsed;
}

export function normTime(value) {
  if (value == null || value === "") return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function err(errors, message) {
  errors.push(message);
}

function requireEnum(errors, label, value, allowed) {
  if (!allowed.includes(value)) err(errors, `${label} must be one of ${allowed.join(", ")}`);
}

export function validHttpUrl(value) {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function validIsoDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function evidenceRank(status) {
  return VERIFICATION_RANK[status] ?? -1;
}

function validateEvidenceList(errors, evidence, { rowStatus }) {
  if (evidence == null) return [];
  if (!Array.isArray(evidence)) {
    err(errors, "evidence must be an array");
    return [];
  }
  return evidence.map((item, index) => {
    const prefix = `evidence[${index}]`;
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      err(errors, `${prefix} must be an object`);
      return null;
    }
    const sourceLabel = collapseWs(item.sourceLabel);
    if (!sourceLabel) err(errors, `${prefix}.sourceLabel is required`);
    if (!EVIDENCE_SCOPES.includes(item.fieldScope)) {
      err(errors, `${prefix}.fieldScope must be one of ${EVIDENCE_SCOPES.join(", ")}`);
    }
    if (!AUTH_STATUS.includes(item.verificationStatus)) {
      err(errors, `${prefix}.verificationStatus must be one of ${AUTH_STATUS.join(", ")}`);
    } else if (rowStatus && evidenceRank(item.verificationStatus) > evidenceRank(rowStatus)) {
      err(errors, `${prefix}.verificationStatus cannot outrank the record`);
    }
    const observedAt = normTime(item.observedAt);
    if (!observedAt) err(errors, `${prefix}.observedAt must be an ISO timestamp`);
    let sourceUrl = item.sourceUrl ?? null;
    if (sourceUrl != null) {
      if (!validHttpUrl(sourceUrl)) err(errors, `${prefix}.sourceUrl must be an http(s) URL`);
    }
    const note = item.note == null ? null : collapseWs(item.note);
    let claimKey = item.claimKey == null ? null : String(item.claimKey).trim();
    if (claimKey === "") claimKey = null;
    if (item.fieldScope === "identifier" && !claimKey) {
      err(errors, `${prefix}.claimKey is required for identifier evidence`);
    } else if (item.fieldScope !== "identifier" && claimKey) {
      err(errors, `${prefix}.claimKey is only allowed for identifier evidence`);
    }
    return {
      sourceLabel,
      fieldScope: item.fieldScope,
      verificationStatus: item.verificationStatus,
      observedAt,
      sourceUrl,
      note,
      claimKey,
    };
  }).filter(Boolean);
}

function hasEvidence(evidence, { scope, status, claimKey } = {}) {
  return evidence.some((item) => {
    if (scope === "address") {
      if (item.fieldScope !== "address" && item.fieldScope !== "record") return false;
    } else if (scope && item.fieldScope !== scope) {
      return false;
    }
    if (claimKey != null && (item.claimKey ?? null) !== claimKey) return false;
    if (status === "VERIFIED") return item.verificationStatus === "VERIFIED";
    if (status === "PARTIAL") return item.verificationStatus === "PARTIAL" || item.verificationStatus === "VERIFIED";
    return item.verificationStatus === "PARTIAL" || item.verificationStatus === "VERIFIED";
  });
}

function validateClaimStrength(errors, { status, verifiedAt, evidence }) {
  if (status === "VERIFIED" || status === "PARTIAL") {
    if (!normTime(verifiedAt)) err(errors, `${status} requires verifiedAt`);
    if (!hasEvidence(evidence, { scope: "record", status })) {
      err(errors, `${status} requires record evidence with status ${status === "VERIFIED" ? "VERIFIED" : "PARTIAL or VERIFIED"}`);
    }
  }
  if (status === "BLOCKED") {
    // review note checked by caller
  }
}

export function validateBusiness(input) {
  const errors = [];
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { errors: ["business must be an object"], value: null };
  }
  const importKey = input.importKey;
  if (typeof importKey !== "string" || !IMPORT_KEY_RE.test(importKey)) {
    err(errors, "importKey is required and must match ^[a-z0-9][a-z0-9-]{0,80}$");
  }
  const displayName = collapseWs(input.displayName);
  if (!displayName) err(errors, "displayName is required");
  requireEnum(errors, "kind", input.kind, BUSINESS_KINDS);
  let retailerId = input.retailerId ?? null;
  if (input.kind === "chain_banner") {
    if (!KNOWN_RETAILER_IDS.includes(retailerId)) err(errors, "chain_banner requires a known retailerId");
  } else if (input.kind === "independent") {
    if (retailerId != null) err(errors, "independent business cannot carry a retailerId");
    retailerId = null;
  }
  requireEnum(errors, "verificationStatus", input.verificationStatus, RECORD_VERIFICATION);
  if (typeof input.isSynthetic !== "boolean") err(errors, "isSynthetic must be boolean");
  const evidence = validateEvidenceList(errors, input.evidence ?? [], { rowStatus: input.verificationStatus });
  validateClaimStrength(errors, {
    status: input.verificationStatus,
    verifiedAt: input.verifiedAt,
    evidence,
  });
  const reviewNote = input.reviewNote == null ? null : collapseWs(input.reviewNote);
  if (input.verificationStatus === "BLOCKED" && !reviewNote) err(errors, "BLOCKED requires reviewNote");
  let publicWebsite = input.publicWebsite ?? null;
  if (publicWebsite != null) {
    if (!validHttpUrl(publicWebsite)) err(errors, "publicWebsite must be an http(s) URL");
    if (input.verificationStatus !== "PARTIAL" && input.verificationStatus !== "VERIFIED") {
      err(errors, "publicWebsite requires PARTIAL or VERIFIED");
    } else if (!hasEvidence(evidence, { scope: "website", status: input.verificationStatus })) {
      err(errors, "publicWebsite requires website evidence");
    }
  }
  const resolution = input.resolution ?? null;
  if (resolution != null && resolution !== "accept_incoming" && resolution !== "retire") {
    err(errors, "resolution must be accept_incoming or retire");
  }
  return {
    errors,
    value: errors.length ? null : {
      importKey,
      displayName,
      kind: input.kind,
      retailerId,
      publicWebsite,
      verificationStatus: input.verificationStatus,
      verifiedAt: input.verificationStatus === "PARTIAL" || input.verificationStatus === "VERIFIED"
        ? normTime(input.verifiedAt) : null,
      reviewNote,
      isSynthetic: input.isSynthetic,
      evidence,
      resolution,
    },
  };
}

export function validateProduct(input) {
  const errors = [];
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { errors: ["product must be an object"], value: null };
  }
  const importKey = input.importKey;
  if (typeof importKey !== "string" || !IMPORT_KEY_RE.test(importKey)) {
    err(errors, "importKey is required and must match ^[a-z0-9][a-z0-9-]{0,80}$");
  }
  if (!GAMES.includes(input.game)) err(errors, "game must be pokemon or one_piece");
  const categories = PRODUCT_CATEGORIES[input.game] ?? [];
  if (!categories.includes(input.category)) err(errors, "category is not valid for the game");
  const canonicalName = collapseWs(input.canonicalName);
  if (!canonicalName) err(errors, "canonicalName is required");
  requireEnum(errors, "verificationStatus", input.verificationStatus, RECORD_VERIFICATION);
  requireEnum(errors, "lifecycleStatus", input.lifecycleStatus ?? "unknown", LIFECYCLE_STATUS);
  if (typeof input.isSynthetic !== "boolean") err(errors, "isSynthetic must be boolean");
  if (input.imageUrl != null || input.imageProvenance != null) {
    err(errors, "product images are not accepted by this importer");
  }
  const language = input.language ?? null;
  if (language != null && (typeof language !== "string" || !LANGUAGE_RE.test(language))) {
    err(errors, "language must be a two-letter lowercase code or null");
  }
  const region = input.region ?? null;
  if (region != null && (typeof region !== "string" || !REGION_RE.test(region))) {
    err(errors, "region must be a two-letter uppercase code or null");
  }
  const packagingVariant = input.packagingVariant == null ? null : collapseWs(input.packagingVariant);
  const setName = input.setName == null ? null : collapseWs(input.setName);
  const releaseDate = input.releaseDate ?? null;
  if (releaseDate != null && !validIsoDate(releaseDate)) err(errors, "releaseDate must be YYYY-MM-DD");
  const evidence = validateEvidenceList(errors, input.evidence ?? [], { rowStatus: input.verificationStatus });
  validateClaimStrength(errors, {
    status: input.verificationStatus,
    verifiedAt: input.verifiedAt,
    evidence,
  });
  const reviewNote = input.reviewNote == null ? null : collapseWs(input.reviewNote);
  if (input.verificationStatus === "BLOCKED" && !reviewNote) err(errors, "BLOCKED requires reviewNote");
  if (setName && !hasEvidence(evidence, { scope: "set_name", status: input.verificationStatus === "VERIFIED" ? "VERIFIED" : "PARTIAL" })) {
    err(errors, "setName requires set_name evidence at PARTIAL or VERIFIED");
  }
  if (setName && input.verificationStatus !== "PARTIAL" && input.verificationStatus !== "VERIFIED") {
    err(errors, "setName requires PARTIAL or VERIFIED");
  }
  if (releaseDate && !hasEvidence(evidence, { scope: "release_date", status: input.verificationStatus === "VERIFIED" ? "VERIFIED" : "PARTIAL" })) {
    err(errors, "releaseDate requires release_date evidence at PARTIAL or VERIFIED");
  }
  if (releaseDate && input.verificationStatus !== "PARTIAL" && input.verificationStatus !== "VERIFIED") {
    err(errors, "releaseDate requires PARTIAL or VERIFIED");
  }
  let officialReferenceUrl = input.officialReferenceUrl ?? null;
  if (officialReferenceUrl != null && !validHttpUrl(officialReferenceUrl)) {
    err(errors, "officialReferenceUrl must be an http(s) URL");
  }
  const identifiers = validateIdentifiers(errors, input.identifiers ?? [], {
    rowStatus: input.verificationStatus,
    evidence,
  });
  const resolution = input.resolution ?? null;
  if (resolution != null && resolution !== "accept_incoming" && resolution !== "retire") {
    err(errors, "resolution must be accept_incoming or retire");
  }
  const lifecycleStatus = input.lifecycleStatus ?? "unknown";
  return {
    errors,
    value: errors.length ? null : {
      importKey,
      game: input.game,
      category: input.category,
      canonicalName,
      setName,
      language,
      region,
      packagingVariant,
      releaseDate,
      lifecycleStatus,
      verificationStatus: input.verificationStatus,
      verifiedAt: input.verificationStatus === "PARTIAL" || input.verificationStatus === "VERIFIED"
        ? normTime(input.verifiedAt) : null,
      officialReferenceUrl,
      reviewNote,
      isSynthetic: input.isSynthetic,
      identifiers,
      evidence,
      resolution,
    },
  };
}

function validateIdentifiers(errors, identifiers, { evidence, rowStatus }) {
  if (!Array.isArray(identifiers)) {
    err(errors, "identifiers must be an array");
    return [];
  }
  return identifiers.map((item, index) => {
    const prefix = `identifiers[${index}]`;
    if (item == null || typeof item !== "object") {
      err(errors, `${prefix} must be an object`);
      return null;
    }
    const idType = item.idType;
    if (!["gtin", "retailer_sku", "retailer_item_id", "publisher_code"].includes(idType)) {
      err(errors, `${prefix}.idType is not a known identifier type`);
    }
    if (typeof item.value !== "string" || item.value.trim() === "") {
      err(errors, `${prefix}.value is required and cannot be empty`);
    }
    if (idType === "gtin" && typeof item.value === "string" && !GTIN_RE.test(item.value.trim())) {
      err(errors, `${prefix}.value is not an 8 to 14 digit GTIN`);
    }
    const retailerId = item.retailerId ?? null;
    if (idType && String(idType).startsWith("retailer_")) {
      if (!KNOWN_RETAILER_IDS.includes(retailerId)) err(errors, `${prefix}.retailerId is required for retailer identifiers`);
    } else if (retailerId != null) {
      err(errors, `${prefix}.retailerId is only allowed on retailer identifiers`);
    }
    if (!AUTH_STATUS.includes(item.verificationStatus)) {
      err(errors, `${prefix}.verificationStatus must be one of ${AUTH_STATUS.join(", ")}`);
    } else if (item.verificationStatus !== "PARTIAL" && item.verificationStatus !== "VERIFIED") {
      err(errors, `${prefix} must be omitted when unverified; unknown identifiers stay absent`);
    }
    if ((item.verificationStatus === "PARTIAL" || item.verificationStatus === "VERIFIED") && !normTime(item.verifiedAt)) {
      err(errors, `${prefix}.verifiedAt is required`);
    }
    if (item.verificationStatus === "VERIFIED" && rowStatus !== "VERIFIED") {
      err(errors, `${prefix} cannot be stronger than the product`);
    } else if (item.verificationStatus === "PARTIAL" && rowStatus !== "PARTIAL" && rowStatus !== "VERIFIED") {
      err(errors, `${prefix} cannot be stronger than the product`);
    }
    const identifierValue = typeof item.value === "string" ? item.value.trim() : item.value;
    if (!hasEvidence(evidence, {
      scope: "identifier",
      status: item.verificationStatus === "VERIFIED" ? "VERIFIED" : "PARTIAL",
      claimKey: identifierValue,
    })) {
      err(errors, `${prefix} requires identifier evidence for this value`);
    }
    return {
      idType,
      value: typeof item.value === "string" ? item.value.trim() : item.value,
      retailerId,
      verificationStatus: item.verificationStatus,
      verifiedAt: normTime(item.verifiedAt),
      verificationSource: collapseWs(item.verificationSource),
    };
  }).filter(Boolean);
}

export function validateStore(input) {
  const errors = [];
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { errors: ["store must be an object"], value: null };
  }
  const importKey = input.importKey;
  if (typeof importKey !== "string" || !IMPORT_KEY_RE.test(importKey)) {
    err(errors, "importKey is required and must match ^[a-z0-9][a-z0-9-]{0,80}$");
  }
  const name = collapseWs(input.name);
  if (!name) err(errors, "name is required");
  const addressLine = collapseWs(input.addressLine);
  if (!addressLine) err(errors, "addressLine is required");
  const city = collapseWs(input.city);
  if (!city) err(errors, "city is required");
  if (input.state !== "CT") err(errors, "state must be CT");
  if (typeof input.zip !== "string" || !ZIP_RE.test(input.zip)) err(errors, "zip must be a Connecticut 06xxx ZIP");
  let retailerId = input.retailerId ?? null;
  if (retailerId != null && !KNOWN_RETAILER_IDS.includes(retailerId)) {
    err(errors, "retailerId is not in the known retailer vocabulary");
  }
  const businessImportKey = input.businessImportKey ?? null;
  if (businessImportKey != null && (typeof businessImportKey !== "string" || !IMPORT_KEY_RE.test(businessImportKey))) {
    err(errors, "businessImportKey is invalid");
  }
  if (retailerId == null && businessImportKey == null) {
    err(errors, "store needs a known retailerId or a businessImportKey");
  }
  requireEnum(errors, "verificationStatus", input.verificationStatus, RECORD_VERIFICATION);
  requireEnum(errors, "addressVerificationStatus", input.addressVerificationStatus ?? "UNVERIFIED", RECORD_VERIFICATION);
  requireEnum(errors, "coordinateVerificationStatus", input.coordinateVerificationStatus ?? "UNVERIFIED", RECORD_VERIFICATION);
  requireEnum(errors, "recordStatus", input.recordStatus ?? "active", STORE_RECORD_STATUS);
  if (input.storeFormat != null && !STORE_FORMATS.includes(input.storeFormat)) {
    err(errors, "storeFormat must be big_box, specialty_game_store, other, or null");
  }
  if (typeof input.isSynthetic !== "boolean") err(errors, "isSynthetic must be boolean");
  const games = input.games ?? [];
  if (!Array.isArray(games) || games.some((game) => !GAMES.includes(game))) {
    err(errors, "games must be an array of pokemon and/or one_piece");
  }
  const latitude = input.latitude ?? null;
  const longitude = input.longitude ?? null;
  if ((latitude == null) !== (longitude == null)) err(errors, "latitude and longitude must both be set or both be null");
  if (latitude != null) {
    if (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      err(errors, "coordinates must be finite numbers");
    } else if (latitude < 40.9 || latitude > 42.1 || longitude < -73.8 || longitude > -71.7) {
      err(errors, "coordinates are outside Connecticut bounds");
    }
  }
  const addressStatus = input.addressVerificationStatus ?? "UNVERIFIED";
  const coordinateStatus = input.coordinateVerificationStatus ?? "UNVERIFIED";
  const evidence = validateEvidenceList(errors, input.evidence ?? [], { rowStatus: input.verificationStatus });
  validateClaimStrength(errors, {
    status: input.verificationStatus,
    verifiedAt: input.verifiedAt,
    evidence,
  });
  if (input.verificationStatus === "VERIFIED"
    && addressStatus !== "PARTIAL"
    && addressStatus !== "VERIFIED") {
    err(errors, "VERIFIED store requires address verification");
  }
  if ((addressStatus === "PARTIAL" || addressStatus === "VERIFIED")
    && !hasEvidence(evidence, { scope: "address", status: addressStatus })) {
    err(errors, "address verification requires address evidence");
  }
  if (latitude == null && (coordinateStatus === "PARTIAL" || coordinateStatus === "VERIFIED")) {
    err(errors, "coordinate verification requires coordinates");
  }
  if (latitude != null && coordinateStatus !== "PARTIAL" && coordinateStatus !== "VERIFIED") {
    err(errors, "coordinates require coordinateVerificationStatus PARTIAL or VERIFIED");
  }
  if (latitude != null && !hasEvidence(evidence, { scope: "coordinates", status: coordinateStatus })) {
    err(errors, "coordinates require coordinates evidence");
  }
  if (latitude != null && !collapseWs(input.locationSource)) err(errors, "coordinates require locationSource");
  if (latitude != null && !normTime(input.locationVerifiedAt)) err(errors, "coordinates require locationVerifiedAt");
  const officialUrl = input.officialUrl ?? null;
  const publicPhone = input.publicPhone ?? null;
  if (officialUrl != null) {
    if (!validHttpUrl(officialUrl)) err(errors, "officialUrl must be an http(s) URL");
    if (input.verificationStatus !== "PARTIAL" && input.verificationStatus !== "VERIFIED") {
      err(errors, "officialUrl requires PARTIAL or VERIFIED");
    } else if (!hasEvidence(evidence, { scope: "website", status: input.verificationStatus })) {
      err(errors, "officialUrl requires website evidence");
    }
  }
  if (publicPhone != null) {
    if (typeof publicPhone !== "string" || !PHONE_RE.test(publicPhone)) err(errors, "publicPhone format is invalid");
    if (input.verificationStatus !== "PARTIAL" && input.verificationStatus !== "VERIFIED") {
      err(errors, "publicPhone requires PARTIAL or VERIFIED");
    } else if (!hasEvidence(evidence, { scope: "phone", status: input.verificationStatus })) {
      err(errors, "publicPhone requires phone evidence");
    }
  }
  const recordStatus = input.recordStatus ?? "active";
  const retiredReason = input.retiredReason == null ? null : collapseWs(input.retiredReason);
  if (recordStatus === "retired" && !retiredReason) err(errors, "retired stores require retiredReason");
  if (recordStatus !== "retired" && retiredReason) err(errors, "retiredReason is only allowed when recordStatus is retired");
  const successorImportKey = input.successorImportKey ?? null;
  if (successorImportKey != null && !IMPORT_KEY_RE.test(successorImportKey)) {
    err(errors, "successorImportKey is invalid");
  }
  const reviewNote = input.reviewNote == null ? null : collapseWs(input.reviewNote);
  if (input.verificationStatus === "BLOCKED" && !reviewNote) err(errors, "BLOCKED requires reviewNote");
  const resolution = input.resolution ?? null;
  if (resolution != null && resolution !== "accept_incoming" && resolution !== "retire") {
    err(errors, "resolution must be accept_incoming or retire");
  }
  if (recordStatus === "retired" && input.verificationStatus === "VERIFIED" && resolution !== "retire" && resolution !== "accept_incoming") {
    // Retirement of an already-verified row is decided against existing state in the planner.
  }
  return {
    errors,
    value: errors.length ? null : {
      importKey,
      businessImportKey,
      retailerId,
      externalStoreId: input.externalStoreId == null ? null : collapseWs(input.externalStoreId),
      name,
      addressLine,
      city,
      state: "CT",
      zip: input.zip,
      latitude,
      longitude,
      locationSource: latitude == null ? null : collapseWs(input.locationSource),
      locationVerifiedAt: latitude == null ? null : normTime(input.locationVerifiedAt),
      officialUrl,
      publicPhone,
      addressVerificationStatus: addressStatus,
      coordinateVerificationStatus: latitude == null ? coordinateStatus : coordinateStatus,
      storeFormat: input.storeFormat ?? null,
      games: [...new Set(games)],
      verificationStatus: input.verificationStatus,
      verifiedAt: input.verificationStatus === "PARTIAL" || input.verificationStatus === "VERIFIED"
        ? normTime(input.verifiedAt) : null,
      recordStatus,
      retiredReason,
      successorImportKey,
      reviewNote,
      isSynthetic: input.isSynthetic,
      evidence,
      resolution,
    },
  };
}

export function productIdentityKey(product) {
  return [
    product.game,
    product.category,
    collapseWs(product.canonicalName)?.toLowerCase() ?? "",
    product.language ?? "",
    product.region ?? "",
    collapseWs(product.packagingVariant)?.toLowerCase() ?? "",
  ].join("|");
}

export function storeBranchKey(store) {
  const address = collapseWs(store.addressLine)?.toLowerCase() ?? "";
  const zip = store.zip ?? "";
  if (store.retailerId) return `chain|${store.retailerId}|${address}|${zip}`;
  if (store.businessImportKey) return `independent|${store.businessImportKey}|${address}|${zip}`;
  return `store|${address}|${zip}`;
}
