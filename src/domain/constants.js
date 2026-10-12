// Shared enumerations. These mirror the CHECK constraints in db/migrations/0001_init.sql;
// keep the two in sync.

export const GAMES = Object.freeze(["pokemon", "one_piece"]);

export const PRODUCT_CATEGORIES = Object.freeze({
  pokemon: [
    "booster_pack",
    "booster_box",
    "elite_trainer_box",
    "booster_bundle",
    "tin",
    "collection",
    "other_sealed",
  ],
  one_piece: [
    "booster_pack",
    "booster_box",
    "starter_deck",
    "double_pack",
    "collection",
    "other_sealed",
  ],
});

export const SOURCE_TYPES = Object.freeze([
  "authorized_feed",
  "community_report",
  "manual_verification",
]);

// Authorization status of an inventory source, per docs/SOURCE-ACCESS-MATRIX.md.
export const AUTH_STATUS = Object.freeze(["VERIFIED", "PARTIAL", "BLOCKED", "UNVERIFIED"]);

export const AVAILABILITY = Object.freeze([
  "in_stock",
  "limited",
  "out_of_stock",
  "uncertain",
  "unknown",
]);

// What the quantity field actually represents. "unknown" is never coerced to 0.
export const QUANTITY_KINDS = Object.freeze(["exact", "estimate", "unknown"]);

export const VERIFICATION_STATUS = Object.freeze([
  "verified", // trusted source (authorized feed / staff manual check)
  "pending", // community report awaiting moderation
  "accepted", // community report accepted by moderation
  "rejected",
  "expired",
]);

export const FRESHNESS = Object.freeze(["FRESH", "AGING", "STALE", "UNKNOWN"]);

export const CONFIDENCE = Object.freeze(["high", "medium", "low"]);

// Directory / catalog claims. Same four authorization words as inventory sources.
// Creating a row, a passing fixture, or a search hit does not make a claim VERIFIED.
export const RECORD_VERIFICATION = AUTH_STATUS;

export const LIFECYCLE_STATUS = Object.freeze(["active", "discontinued", "unknown"]);

export const STORE_RECORD_STATUS = Object.freeze(["active", "retired"]);

export const BUSINESS_KINDS = Object.freeze(["chain_banner", "independent"]);

export const STORE_FORMATS = Object.freeze(["big_box", "specialty_game_store", "other"]);

// Controlled vocabulary for directory imports. These ids do not authorize retailer APIs.
export const KNOWN_RETAILER_IDS = Object.freeze(["walmart", "target", "gamestop", "bestbuy"]);

export const EVIDENCE_SCOPES = Object.freeze([
  "record",
  "address",
  "coordinates",
  "set_name",
  "release_date",
  "identifier",
  "website",
  "phone",
]);
