// Resolves the displayed inventory status for one product at one store from its
// observation history, applying the documented source-priority and conflict policy:
//
// 1. Rejected/pending community reports are never used for the headline status.
// 2. For each source, only its latest observation counts.
// 3. STALE / UNKNOWN-freshness observations do not count as current. If nothing current
//    remains, the status is "unknown" (or "stale" when stale data exists) — never zero.
// 4. Among current observations, trusted sources (authorized feed, manual verification)
//    outrank accepted community reports.
// 5. If current observations at the top tier disagree on in-stock vs out-of-stock, the
//    status is "conflicting" and every candidate is returned. The most optimistic report
//    is never chosen automatically.

import { classifyFreshness, effectiveObservedAt } from "./freshness.js";

const TIER = { authorized_feed: 0, manual_verification: 0, community_report: 1 };
const POSITIVE = new Set(["in_stock", "limited"]);
const NEGATIVE = new Set(["out_of_stock"]);

export function isDisplayable(obs) {
  if (obs.verificationStatus === "rejected") return false;
  if (obs.sourceType === "community_report") return obs.verificationStatus === "accepted";
  return obs.verificationStatus === "verified";
}

export function latestPerSource(observations) {
  const bySource = new Map();
  for (const o of observations) {
    const cur = bySource.get(o.sourceId);
    if (!cur || (effectiveObservedAt(o) ?? -Infinity) > (effectiveObservedAt(cur) ?? -Infinity)) {
      bySource.set(o.sourceId, o);
    }
  }
  return [...bySource.values()];
}

/**
 * @returns {{ state: "available"|"unavailable"|"uncertain"|"conflicting"|"stale"|"unknown",
 *   primary: object|null, candidates: object[], freshness: string }}
 */
export function resolveStatus(observations, now, policy) {
  const usable = latestPerSource(observations.filter(isDisplayable)).map((o) => ({
    obs: o,
    freshness: classifyFreshness(o, now, policy),
  }));
  const current = usable.filter((u) => u.freshness === "FRESH" || u.freshness === "AGING");

  if (current.length === 0) {
    const stale = usable.filter((u) => u.freshness === "STALE");
    if (stale.length) {
      const newest = stale.sort(byNewest)[0];
      return { state: "stale", primary: newest.obs, candidates: stale, freshness: "STALE" };
    }
    return { state: "unknown", primary: null, candidates: [], freshness: "UNKNOWN" };
  }

  const bestTier = Math.min(...current.map((u) => TIER[u.obs.sourceType]));
  const top = current.filter((u) => TIER[u.obs.sourceType] === bestTier).sort(byNewest);
  const hasPos = top.some((u) => POSITIVE.has(u.obs.availability));
  const hasNeg = top.some((u) => NEGATIVE.has(u.obs.availability));

  if (hasPos && hasNeg) {
    return { state: "conflicting", primary: null, candidates: top, freshness: top[0].freshness };
  }
  const primary = top[0];
  const a = primary.obs.availability;
  const state = POSITIVE.has(a) ? "available" : NEGATIVE.has(a) ? "unavailable" : "uncertain";
  return { state, primary: primary.obs, candidates: top, freshness: primary.freshness };
}

function byNewest(a, b) {
  return (effectiveObservedAt(b.obs) ?? 0) - (effectiveObservedAt(a.obs) ?? 0);
}
