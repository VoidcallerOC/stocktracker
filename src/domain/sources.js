// Inventory source registry and run gate.
//
// An automated adapter may run ONLY when all of the following hold:
//   - its authorization status in the registry is VERIFIED (documented permission AND a
//     tested, authorized data path — see docs/SOURCE-ACCESS-MATRIX.md);
//   - it is explicitly enabled by a server-side environment flag;
//   - its per-source kill switch is not engaged;
//   - it is not a synthetic/demo source running in production.
//
// No retailer source is VERIFIED today, so no retailer adapter can run.

export const SOURCE_REGISTRY = Object.freeze({
  // Affiliate API storeId lookups need extra business approval; status-only, no quantity.
  walmart_affiliate_api: {
    retailer: "walmart",
    sourceType: "authorized_feed",
    authorizationStatus: "BLOCKED",
    envFlag: "SOURCE_WALMART_ENABLED",
  },
  // No public developer API found; site terms prohibit scraping.
  target: {
    retailer: "target",
    sourceType: "authorized_feed",
    authorizationStatus: "BLOCKED",
    envFlag: "SOURCE_TARGET_ENABLED",
  },
  // No official API found; terms could not be read (403).
  gamestop: {
    retailer: "gamestop",
    sourceType: "authorized_feed",
    authorizationStatus: "UNVERIFIED",
    envFlag: "SOURCE_GAMESTOP_ENABLED",
  },
  // Documented store availability (status only, no quantity, no per-store timestamp).
  // Terms: attribution required; content may not be cached > 72 hours. No key held yet.
  bestbuy_developer_api: {
    retailer: "bestbuy",
    sourceType: "authorized_feed",
    authorizationStatus: "PARTIAL",
    envFlag: "SOURCE_BESTBUY_ENABLED",
    maxRetentionMs: 72 * 60 * 60 * 1000,
    attribution: "Inventory data from Best Buy",
  },
  community: {
    retailer: null,
    sourceType: "community_report",
    authorizationStatus: "VERIFIED", // first-party user submissions; no third-party terms
    envFlag: "SOURCE_COMMUNITY_ENABLED",
  },
  synthetic_demo: {
    retailer: null,
    sourceType: "authorized_feed",
    authorizationStatus: "VERIFIED",
    envFlag: "SOURCE_SYNTHETIC_DEMO_ENABLED",
    synthetic: true,
  },
});

const TRUE = new Set(["1", "true", "yes", "on"]);
const flag = (env, name) => TRUE.has(String(env?.[name] ?? "").toLowerCase());

export function isProduction(env) {
  return env?.APP_ENV === "production" || env?.VERCEL_ENV === "production";
}

/**
 * Kill switches: INGEST_KILL_ALL=1 stops every source; INGEST_KILL_<SOURCE_ID>=1 stops one.
 * @returns {{ allowed: true } | { allowed: false, reason: string }}
 */
export function canRunSource(sourceId, env = {}, registry = SOURCE_REGISTRY) {
  const src = registry[sourceId];
  if (!src) return deny("unknown source");
  if (flag(env, "INGEST_KILL_ALL")) return deny("global ingestion kill switch engaged");
  if (flag(env, `INGEST_KILL_${sourceId.toUpperCase()}`)) return deny("source kill switch engaged");
  if (src.synthetic && isProduction(env)) return deny("synthetic source blocked in production");
  if (src.authorizationStatus !== "VERIFIED") {
    return deny(`authorization status is ${src.authorizationStatus}`);
  }
  if (!flag(env, src.envFlag)) return deny(`${src.envFlag} not enabled`);
  return { allowed: true };
}

/** Global notification kill switch: NOTIFICATIONS_KILL=1 suppresses all outbound alerts. */
export function notificationsEnabled(env = {}) {
  return !flag(env, "NOTIFICATIONS_KILL") && flag(env, "NOTIFICATIONS_ENABLED");
}

function deny(reason) {
  return { allowed: false, reason };
}
