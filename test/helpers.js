// Controlled fixtures. Everything here is synthetic test data and is flagged as such.
export const T0 = Date.parse("2026-10-11T12:00:00Z");
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const iso = (ms) => new Date(ms).toISOString();

let n = 0;
export function obs(overrides = {}) {
  n += 1;
  return {
    id: `obs-${n}`,
    productId: "prod-etb-1",
    storeId: "store-1",
    sourceId: "feed-a",
    sourceType: "authorized_feed",
    availability: "in_stock",
    quantity: undefined,
    sourceTimestamp: iso(T0),
    receivedAt: iso(T0),
    verificationStatus: undefined,
    isSynthetic: true,
    ...overrides,
  };
}

// Test-only registry overlay: a fake authorized feed so alert/ingest logic can be exercised.
export const ENV_ON = { NOTIFICATIONS_ENABLED: "1", SOURCE_COMMUNITY_ENABLED: "1", SOURCE_SYNTHETIC_DEMO_ENABLED: "1" };
