// Freshness policy: classifies an observation as FRESH / AGING / STALE / UNKNOWN.
//
// Thresholds are provisional placeholders, not measured latencies. Per-source
// timestamp and retention rules live in source-policy.js. Receipt time is used
// only when that source's policy sets trustReceiptTime. A receipt fallback is
// the time we stored the row, not the time a retailer checked the shelf.

import { PROVISIONAL_FRESHNESS_BY_TYPE, SOURCE_POLICIES, timestampPolicyFor } from "./source-policy.js";

const MIN = 60 * 1000;

export const MAX_FUTURE_SKEW_MS = 5 * MIN;

export const DEFAULT_FRESHNESS_POLICY = Object.freeze({
  bySourceType: PROVISIONAL_FRESHNESS_BY_TYPE,
  bySourceId: {},
  futureSkewMs: MAX_FUTURE_SKEW_MS,
});

/**
 * Timestamp freshness is measured from, or null when age cannot be established.
 * Community sightings are clamped to receipt time so a reporter cannot forward-date.
 */
export function effectiveObservedAt(obs, sourceConfig) {
  const cfg = sourceConfig ?? timestampPolicyFor(obs.sourceId);
  const received = toMs(obs.receivedAt);
  if (received === null) return null;
  const stated = toMs(obs.sourceTimestamp);

  if (obs.sourceType === "community_report") {
    if (stated === null) return received;
    return Math.min(stated, received);
  }
  if (stated !== null) return stated;
  return cfg.trustReceiptTime === true ? received : null;
}

export function thresholdsFor(obs, policy = DEFAULT_FRESHNESS_POLICY) {
  if (policy?.bySourceId?.[obs.sourceId]) return policy.bySourceId[obs.sourceId];
  if (policy === DEFAULT_FRESHNESS_POLICY) {
    const specific = SOURCE_POLICIES[obs.sourceId]?.freshness;
    if (specific) return specific;
  }
  return policy?.bySourceType?.[obs.sourceType] ?? null;
}

/**
 * True while a stored payload is still inside its source retention rule.
 * Unknown sources are retained; do_not_retain sources never are. purge_after
 * drops the payload once receipt age reaches maxRetentionMs (the cache clock
 * starts when we stored the row).
 */
export function retainedForDisplay(obs, now, policies = SOURCE_POLICIES) {
  const retention = policies[obs.sourceId]?.retention;
  if (!retention) return true;
  if (retention.mode === "do_not_retain") return false;
  if (retention.mode === "purge_after") {
    const received = toMs(obs.receivedAt);
    const nowMs = toMs(now);
    if (received === null || nowMs === null || retention.maxRetentionMs == null) return false;
    return nowMs - received < retention.maxRetentionMs;
  }
  return true;
}

/**
 * @returns {"FRESH"|"AGING"|"STALE"|"UNKNOWN"}
 */
export function classifyFreshness(obs, now, policy = DEFAULT_FRESHNESS_POLICY, sourceConfig) {
  const cfg = sourceConfig ?? timestampPolicyFor(obs.sourceId);
  const nowMs = toMs(now);
  const thresholds = thresholdsFor(obs, policy);
  const observed = effectiveObservedAt(obs, cfg);
  if (nowMs === null || !thresholds || observed === null) return "UNKNOWN";
  if (observed - nowMs > (policy?.futureSkewMs ?? 0)) return "UNKNOWN";
  if (obs.verificationStatus === "expired" || obs.verificationStatus === "rejected") return "STALE";
  const age = Math.max(0, nowMs - observed);
  if (age <= thresholds.freshMs) return "FRESH";
  if (age <= thresholds.maxMs) return "AGING";
  return "STALE";
}

/**
 * band plus which clock it used. receipt_fallback must not be labeled as a
 * retailer check time. provisional is true while the window is a placeholder.
 */
export function explainFreshness(obs, now, policy = DEFAULT_FRESHNESS_POLICY, sourceConfig) {
  const cfg = sourceConfig ?? timestampPolicyFor(obs.sourceId);
  const thresholds = thresholdsFor(obs, policy);
  return {
    band: classifyFreshness(obs, now, policy, cfg),
    timeBasis: timeBasisFor(obs, cfg),
    provisional: thresholds?.provisional === true,
    note: thresholds?.provisional ? thresholds.note ?? null : null,
  };
}

export function timeBasisFor(obs, sourceConfig) {
  const cfg = sourceConfig ?? timestampPolicyFor(obs.sourceId);
  const stated = toMs(obs.sourceTimestamp);
  const received = toMs(obs.receivedAt);
  if (obs.sourceType === "community_report") {
    if (stated === null) return "receipt_fallback";
    if (received !== null && stated > received) return "receipt_clamped";
    return "source";
  }
  if (stated !== null) return "source";
  if (cfg.trustReceiptTime === true) return "receipt_fallback";
  return "unknown";
}

export function toMs(v) {
  if (v === null || v === undefined || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}
