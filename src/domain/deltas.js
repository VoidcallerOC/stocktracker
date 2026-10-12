// Stock-change (delta) computation. A delta is only computed between two comparable
// observations: same product, same store, same source, both exact quantities from a
// trusted source type, neither stale, and strictly ordered in time.
//
// A positive delta is a "reported increase" — never a confirmed physical delivery.

import { classifyFreshness, effectiveObservedAt, retainedForDisplay } from "./freshness.js";
import { SOURCE_POLICIES, timestampPolicyFor } from "./source-policy.js";

const TRUSTED = new Set(["authorized_feed", "manual_verification"]);
const UNRELIABLE_QUANTITY = new Set(["status_only", "unavailable", "estimate_or_binary"]);

/**
 * @returns {{ comparable: true } | { comparable: false, reason: string }}
 */
export function comparability(prev, next, policy, sourcePolicies = SOURCE_POLICIES) {
  if (!prev || !next) return no("missing observation");
  if (prev.productId !== next.productId) return no("different product");
  if (prev.storeId !== next.storeId) return no("different store");
  if (prev.sourceId !== next.sourceId) return no("different source");
  if (!TRUSTED.has(prev.sourceType) || !TRUSTED.has(next.sourceType)) {
    return no("untrusted source type");
  }
  if (UNRELIABLE_QUANTITY.has(sourcePolicies[next.sourceId]?.quantityReliability)) {
    return no("source quantity is not reliable");
  }
  if (prev.quantity.kind !== "exact" || next.quantity.kind !== "exact") {
    return no("quantity not exact");
  }
  const prevCfg = timestampPolicyFor(prev.sourceId, sourcePolicies);
  const nextCfg = timestampPolicyFor(next.sourceId, sourcePolicies);
  const tPrev = effectiveObservedAt(prev, prevCfg);
  const tNext = effectiveObservedAt(next, nextCfg);
  if (tPrev === null || tNext === null) return no("timestamp unknown");
  if (tNext <= tPrev) return no("not newer");
  if (!retainedForDisplay(prev, tNext, sourcePolicies) || !retainedForDisplay(next, tNext, sourcePolicies)) {
    return no("outside source retention");
  }
  // The previous observation must still have been within its acceptable window when the
  // new one was observed; otherwise the gap hides unknown history.
  const prevAtNext = classifyFreshness(prev, tNext, policy, prevCfg);
  if (prevAtNext === "STALE" || prevAtNext === "UNKNOWN") return no("previous observation expired");
  if (prev.verificationStatus !== "verified" || next.verificationStatus !== "verified") {
    return no("unverified");
  }
  return { comparable: true };
}

/**
 * @returns {null | { productId, storeId, sourceId, previousObservationId, newObservationId,
 *   previousQuantity, newQuantity, delta, direction, detectedAt }}
 */
export function computeStockChange(prev, next, detectedAt, policy, sourcePolicies = SOURCE_POLICIES) {
  if (!comparability(prev, next, policy, sourcePolicies).comparable) return null;
  const delta = next.quantity.value - prev.quantity.value;
  if (delta === 0) return null;
  return Object.freeze({
    productId: next.productId,
    storeId: next.storeId,
    sourceId: next.sourceId,
    previousObservationId: prev.id,
    newObservationId: next.id,
    previousQuantity: prev.quantity.value,
    newQuantity: next.quantity.value,
    delta,
    direction: delta > 0 ? "reported_increase" : "reported_decrease",
    detectedAt,
  });
}

function no(reason) {
  return { comparable: false, reason };
}
