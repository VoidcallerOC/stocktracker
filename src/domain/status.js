// Resolves the displayed inventory status for one product at one store.
//
// 1. Rejected, pending, and expired community reports are never headline status.
// 2. Unauthorized retailer feeds are "blocked". Their availability is not shown.
// 3. Payloads outside their retention rule are ignored.
// 4. STALE / UNKNOWN observations are not current. Unknown quantity stays unknown.
// 5. Trusted sources outrank accepted community reports.
// 6. Trusted sources that disagree on in-stock vs out-of-stock are "conflicting".
// 7. Community reports are compared per reporter. Disagreement is "conflicting".
//    The newest community report is not treated as authoritative.
// 8. A positive stock delta is never a physical delivery (see deltas.js).

import { resolveCommunityClaims } from "./community-conflict.js";
import { effectiveObservedAt, explainFreshness, retainedForDisplay } from "./freshness.js";
import { SOURCE_POLICIES, timestampPolicyFor } from "./source-policy.js";
import { isUnauthorizedRetailerFeed } from "./sources.js";

const POSITIVE = new Set(["in_stock", "limited"]);
const NEGATIVE = new Set(["out_of_stock"]);

export function isDisplayable(obs) {
  if (obs.verificationStatus === "rejected" || obs.verificationStatus === "expired") return false;
  if (obs.sourceType === "community_report") return obs.verificationStatus === "accepted";
  return obs.verificationStatus === "verified";
}

export function latestPerSource(observations, sourcePolicies = SOURCE_POLICIES) {
  const bySource = new Map();
  for (const obs of observations) {
    const cfg = timestampPolicyFor(obs.sourceId, sourcePolicies);
    const cur = bySource.get(obs.sourceId);
    const obsAt = effectiveObservedAt(obs, cfg) ?? -Infinity;
    const curAt = cur ? (effectiveObservedAt(cur, timestampPolicyFor(cur.sourceId, sourcePolicies)) ?? -Infinity) : -Infinity;
    if (!cur || obsAt > curAt) bySource.set(obs.sourceId, obs);
  }
  return [...bySource.values()];
}

/**
 * @returns {{ state: "available"|"unavailable"|"uncertain"|"conflicting"|"stale"|"unknown"|"blocked",
 *   primary: object|null, candidates: object[], freshness: string, timeBasis: string,
 *   thresholdsProvisional: boolean, conflictReason: string|null, independentReporterCount: number|null,
 *   blockedSourceIds?: string[] }}
 */
export function resolveStatus(observations, now, policy, sourcePolicies = SOURCE_POLICIES) {
  const displayable = observations.filter(isDisplayable);
  const unauthorized = displayable.filter((obs) => isUnauthorizedRetailerFeed(obs));
  const eligible = displayable.filter(
    (obs) => !isUnauthorizedRetailerFeed(obs) && retainedForDisplay(obs, now, sourcePolicies),
  );
  const annotated = eligible.map((obs) => annotate(obs, now, policy, sourcePolicies));
  const trusted = annotated.filter((item) => item.obs.sourceType !== "community_report");
  const community = annotated.filter((item) => item.obs.sourceType === "community_report");
  const trustedLatest = latestBy(trusted, (item) => item.obs.sourceId);
  const trustedCurrent = trustedLatest.filter(isCurrent);

  if (trustedCurrent.length) return finishTrusted(trustedCurrent);

  const communityCurrent = community.filter(isCurrent);
  if (communityCurrent.length) {
    const resolved = resolveCommunityClaims(communityCurrent);
    return {
      ...resolved,
      thresholdsProvisional: communityCurrent.some((item) => item.provisional),
    };
  }

  const stale = [
    ...trustedLatest,
    ...latestBy(community, (item) => item.obs.reporterId || item.obs.id),
  ].filter((item) => item.freshness === "STALE");
  if (stale.length) return finishStale(stale);
  if (unauthorized.length) return finishBlocked(unauthorized);
  return unknownResult();
}

export function publicStatusView(result) {
  return {
    ...result,
    primary: stripPrivate(result.primary),
    candidates: (result.candidates ?? []).map(stripPrivate),
  };
}

function annotate(obs, now, policy, sourcePolicies) {
  const cfg = timestampPolicyFor(obs.sourceId, sourcePolicies);
  const detail = explainFreshness(obs, now, policy, cfg);
  return {
    obs,
    freshness: detail.band,
    timeBasis: detail.timeBasis,
    provisional: detail.provisional,
    observedAt: effectiveObservedAt(obs, cfg) ?? -Infinity,
  };
}

function isCurrent(item) {
  return item.freshness === "FRESH" || item.freshness === "AGING";
}

function latestBy(items, keyFn) {
  const byKey = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const prev = byKey.get(key);
    if (!prev || item.observedAt > prev.observedAt) byKey.set(key, item);
  }
  return [...byKey.values()];
}

function finishTrusted(top) {
  const sorted = [...top].sort(byNewest);
  const hasPos = sorted.some((item) => POSITIVE.has(item.obs.availability));
  const hasNeg = sorted.some((item) => NEGATIVE.has(item.obs.availability));
  if (hasPos && hasNeg) {
    return {
      state: "conflicting",
      primary: null,
      candidates: sorted.map((item) => item.obs),
      freshness: worstCurrent(sorted),
      timeBasis: cautiousBasis(sorted),
      thresholdsProvisional: sorted.some((item) => item.provisional),
      conflictReason: "availability",
      independentReporterCount: null,
    };
  }
  const primary = sorted[0];
  const availability = primary.obs.availability;
  const state = POSITIVE.has(availability) ? "available" : NEGATIVE.has(availability) ? "unavailable" : "uncertain";
  return {
    state,
    primary: primary.obs,
    candidates: sorted.map((item) => item.obs),
    freshness: primary.freshness,
    timeBasis: primary.timeBasis,
    thresholdsProvisional: primary.provisional,
    conflictReason: null,
    independentReporterCount: null,
  };
}

function finishStale(items) {
  const sorted = [...items].sort(byNewest);
  return {
    state: "stale",
    primary: sorted[0].obs,
    candidates: sorted.map((item) => item.obs),
    freshness: "STALE",
    timeBasis: cautiousBasis(sorted),
    thresholdsProvisional: sorted.some((item) => item.provisional),
    conflictReason: null,
    independentReporterCount: null,
  };
}

function finishBlocked(observations) {
  return {
    state: "blocked",
    primary: null,
    candidates: [],
    freshness: "UNKNOWN",
    timeBasis: "unknown",
    thresholdsProvisional: true,
    conflictReason: null,
    independentReporterCount: null,
    blockedSourceIds: [...new Set(observations.map((obs) => obs.sourceId))].sort(),
  };
}

function unknownResult() {
  return {
    state: "unknown",
    primary: null,
    candidates: [],
    freshness: "UNKNOWN",
    timeBasis: "unknown",
    thresholdsProvisional: true,
    conflictReason: null,
    independentReporterCount: null,
  };
}

function byNewest(a, b) {
  return b.observedAt - a.observedAt;
}

function worstCurrent(items) {
  return items.some((item) => item.freshness === "AGING") ? "AGING" : "FRESH";
}

function cautiousBasis(items) {
  if (items.some((item) => item.timeBasis === "receipt_fallback" || item.timeBasis === "receipt_clamped")) {
    return "receipt_fallback";
  }
  if (items.some((item) => item.timeBasis === "unknown")) return "unknown";
  return "source";
}

function stripPrivate(obs) {
  if (!obs) return null;
  const out = {};
  for (const [key, value] of Object.entries(obs)) {
    if (key !== "reporterId" && key !== "sourceRecordId") out[key] = value;
  }
  return Object.freeze(out);
}
