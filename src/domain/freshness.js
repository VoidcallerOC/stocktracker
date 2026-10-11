// Freshness policy: classifies an observation as FRESH / AGING / STALE / UNKNOWN.
//
// Thresholds are configurable per source type and, optionally, per source id. The defaults
// below are conservative placeholders, NOT measured latencies: no retailer feed has been
// authorized yet (see docs/SOURCE-ACCESS-MATRIX.md). Tune them from observed source latency
// and documented polling limits once a source is VERIFIED.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export const DEFAULT_FRESHNESS_POLICY = Object.freeze({
  bySourceType: {
    authorized_feed: { freshMs: 2 * HOUR, maxMs: 12 * HOUR },
    manual_verification: { freshMs: 4 * HOUR, maxMs: 24 * HOUR },
    community_report: { freshMs: 3 * HOUR, maxMs: 12 * HOUR },
  },
  bySourceId: {},
  // Tolerated clock skew for source timestamps slightly ahead of our receipt time.
  futureSkewMs: 5 * MIN,
});

/**
 * Returns the timestamp that freshness is measured from, or null if it cannot be established.
 *
 * - Authorized feeds / manual checks: the source-provided timestamp. If the source supplies
 *   none, the observation's age is UNKNOWN unless the source config explicitly opts in to
 *   using receipt time (`trustReceiptTime`) because the feed is documented as real-time.
 * - Community reports: the reporter's stated sighting time, clamped to the server receipt
 *   time. A reporter can make a report older (staler), never newer than when we received it.
 */
export function effectiveObservedAt(obs, sourceConfig = {}) {
  const received = toMs(obs.receivedAt);
  if (received === null) return null;
  const stated = toMs(obs.sourceTimestamp);

  if (obs.sourceType === "community_report") {
    if (stated === null) return received;
    return Math.min(stated, received);
  }
  if (stated !== null) return stated;
  return sourceConfig.trustReceiptTime === true ? received : null;
}

export function thresholdsFor(obs, policy = DEFAULT_FRESHNESS_POLICY) {
  return policy.bySourceId?.[obs.sourceId] ?? policy.bySourceType[obs.sourceType] ?? null;
}

/**
 * @returns {"FRESH"|"AGING"|"STALE"|"UNKNOWN"}
 */
export function classifyFreshness(obs, now, policy = DEFAULT_FRESHNESS_POLICY, sourceConfig = {}) {
  const nowMs = toMs(now);
  const t = thresholdsFor(obs, policy);
  const observed = effectiveObservedAt(obs, sourceConfig);
  if (nowMs === null || !t || observed === null) return "UNKNOWN";
  // A timestamp meaningfully in the future is unreliable, not "extra fresh".
  if (observed - nowMs > (policy.futureSkewMs ?? 0)) return "UNKNOWN";
  if (obs.verificationStatus === "expired" || obs.verificationStatus === "rejected") return "STALE";
  const age = Math.max(0, nowMs - observed);
  if (age <= t.freshMs) return "FRESH";
  if (age <= t.maxMs) return "AGING";
  return "STALE";
}

export function toMs(v) {
  if (v === null || v === undefined || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}
