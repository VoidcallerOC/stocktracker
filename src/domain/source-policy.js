// Per-source timestamp, freshness, retention, and notification policy.
//
// Freshness windows are provisional placeholders. They are not measured retailer
// latencies and must not be described as retailer behavior. Retention modes are
// separate: Best Buy's 72-hour figure comes from its developer terms; other
// retailer terms are not established, so those sources are do_not_retain and
// stay disabled in the source registry.

const HOUR = 60 * 60 * 1000;

export const PROVISIONAL_FRESHNESS_NOTE =
  "Freshness windows are provisional placeholders. They are not measured source latencies.";

function window(freshHours, maxHours) {
  return Object.freeze({
    freshMs: freshHours * HOUR,
    maxMs: maxHours * HOUR,
    provisional: true,
    note: PROVISIONAL_FRESHNESS_NOTE,
  });
}

export const PROVISIONAL_FRESHNESS_BY_TYPE = Object.freeze({
  authorized_feed: window(2, 12),
  manual_verification: window(4, 24),
  community_report: window(3, 12),
});

const BEST_BUY_RETENTION_MS = 72 * HOUR;

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function source(fields) {
  return freeze({
    timestampPolicy: "source_time",
    trustReceiptTime: false,
    receiptFallbackApproved: false,
    allowUnknownAgeAlerts: false,
    freshness: PROVISIONAL_FRESHNESS_BY_TYPE.authorized_feed,
    retention: {
      mode: "do_not_retain",
      maxRetentionMs: null,
      displayMaxAgeMs: null,
      basis: "Retailer terms are not established. Do not keep retailer payloads.",
      provisional: true,
    },
    quantityReliability: "unavailable",
    authorized: false,
    notifications: false,
    permissionRef: null,
    adapterTested: false,
    policyApproved: false,
    attribution: null,
    sourceLinks: [],
    ...fields,
  });
}

export const SOURCE_POLICIES = Object.freeze({
  walmart_affiliate_api: source({
    sourceLinks: ["https://walmart.io/apidocs/affiliates/stores"],
    retention: {
      mode: "do_not_retain",
      maxRetentionMs: null,
      displayMaxAgeMs: null,
      basis: "Store-level Walmart access is BLOCKED. API terms were not readable. Do not retain payloads.",
      provisional: true,
    },
  }),
  target: source({
    sourceLinks: ["https://www.target.com/c/terms-conditions/-/N-4sr7l"],
    retention: {
      mode: "do_not_retain",
      maxRetentionMs: null,
      displayMaxAgeMs: null,
      basis: "No authorized Target inventory path. Site terms prohibit scraping. Do not retain payloads.",
      provisional: true,
    },
  }),
  gamestop: source({
    retention: {
      mode: "do_not_retain",
      maxRetentionMs: null,
      displayMaxAgeMs: null,
      basis: "GameStop terms could not be read. Access is UNVERIFIED. Do not retain payloads.",
      provisional: true,
    },
  }),
  bestbuy_developer_api: source({
    timestampPolicy: "source_time_or_approved_receipt_fallback",
    // Receipt fallback is implemented and stays off until counsel and access review approve it.
    trustReceiptTime: false,
    receiptFallbackApproved: false,
    allowUnknownAgeAlerts: false,
    quantityReliability: "status_only",
    attribution: "Inventory data from Best Buy",
    sourceLinks: [
      "https://bestbuyapis.github.io/api-documentation/",
      "https://developer.bestbuy.com/legal",
    ],
    retention: {
      mode: "purge_after",
      maxRetentionMs: BEST_BUY_RETENTION_MS,
      displayMaxAgeMs: null,
      basis: "Best Buy developer terms prohibit caching API content for more than 72 hours. Observations, derived quantities, and notification rows that reference them are deleted. Aggregated history is not kept. The adapter stays disabled.",
      provisional: false,
    },
  }),
  community: source({
    timestampPolicy: "reporter_sighting_clamped_to_receipt",
    freshness: PROVISIONAL_FRESHNESS_BY_TYPE.community_report,
    quantityReliability: "estimate_or_binary",
    authorized: true,
    notifications: true,
    adapterTested: true,
    policyApproved: true,
    attribution: "Community report — not retailer-confirmed",
    retention: {
      mode: "retain",
      maxRetentionMs: null,
      displayMaxAgeMs: PROVISIONAL_FRESHNESS_BY_TYPE.community_report.maxMs,
      basis: "First-party sightings. Rows are kept. The public display window is provisional, not a retailer cache limit.",
      provisional: true,
    },
  }),
  synthetic_demo: source({
    quantityReliability: "exact",
    authorized: true,
    notifications: true,
    adapterTested: true,
    policyApproved: true,
    attribution: "Synthetic demo data",
    retention: {
      mode: "retain",
      maxRetentionMs: null,
      displayMaxAgeMs: null,
      basis: "Synthetic fixtures are rejected in production by the database trigger and are not a retailer feed.",
      provisional: true,
    },
  }),
});

export function timestampPolicyFor(sourceId, policies = SOURCE_POLICIES) {
  const policy = policies[sourceId];
  return {
    trustReceiptTime: policy?.trustReceiptTime === true,
    allowUnknownAgeAlerts: policy?.allowUnknownAgeAlerts === true,
  };
}

export function notificationsAllowed(sourceId, policies = SOURCE_POLICIES) {
  return policies[sourceId]?.notifications === true;
}
