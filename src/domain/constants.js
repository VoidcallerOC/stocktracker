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
