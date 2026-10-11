// Community sighting intake: validation, rate limiting and duplicate detection.
//
// The server assigns the receipt time and observation id. A reporter's stated sighting
// time can only make a report older, never fresher (see freshness.effectiveObservedAt).
// Accepted reports are still labeled community-reported and are never shown as
// retailer-confirmed. Evidence uploads are NOT implemented in this MVP core.

import { normalizeObservation, ObservationError } from "./observations.js";

export const DEFAULT_COMMUNITY_POLICY = Object.freeze({
  maxReportsPerHour: 10,
  duplicateWindowMs: 30 * 60 * 1000,
  maxSightingAgeMs: 24 * 60 * 60 * 1000,
  futureSkewMs: 5 * 60 * 1000,
  reportableAvailability: ["in_stock", "limited", "out_of_stock", "uncertain"],
});

/**
 * @param {object} input  untrusted client payload: { productId, storeId, availability,
 *                        quantity?, sightedAt }
 * @param {object} ctx    trusted server context: { id, reporterId, now, recentByReporter,
 *                        knownProductIds: Set, verifiedStoreIds: Set }
 * @returns {{ ok: true, observation: object } | { ok: false, code: string, message: string }}
 */
export function intakeCommunityReport(input, ctx, policy = DEFAULT_COMMUNITY_POLICY) {
  const now = new Date(ctx.now).getTime();
  if (!ctx.reporterId) return fail("unauthenticated", "sign in to report");
  if (!ctx.knownProductIds.has(input.productId)) return fail("invalid_product", "unknown product");
  if (!ctx.verifiedStoreIds.has(input.storeId)) return fail("invalid_store", "store is not in the verified directory");
  if (!policy.reportableAvailability.includes(input.availability)) {
    return fail("invalid_availability", "choose in stock, out of stock or uncertain");
  }

  const sighted = Date.parse(input.sightedAt);
  if (!Number.isFinite(sighted)) return fail("invalid_time", "sighting time required");
  if (sighted - now > policy.futureSkewMs) return fail("invalid_time", "sighting time is in the future");
  if (now - sighted > policy.maxSightingAgeMs) return fail("too_old", "sighting is too old to report");

  const recent = ctx.recentByReporter ?? [];
  const lastHour = recent.filter((r) => now - Date.parse(r.receivedAt) < 60 * 60 * 1000);
  if (lastHour.length >= policy.maxReportsPerHour) return fail("rate_limited", "too many reports; try later");

  const dup = recent.find(
    (r) =>
      r.productId === input.productId &&
      r.storeId === input.storeId &&
      r.availability === input.availability &&
      now - Date.parse(r.receivedAt) < policy.duplicateWindowMs,
  );
  if (dup) return fail("duplicate", "you already reported this recently");

  try {
    const observation = normalizeObservation({
      id: ctx.id,
      productId: input.productId,
      storeId: input.storeId,
      sourceId: "community",
      sourceType: "community_report",
      availability: input.availability,
      quantity: input.quantity,
      sourceTimestamp: new Date(sighted).toISOString(),
      receivedAt: new Date(now).toISOString(),
      verificationStatus: "pending",
      reporterId: ctx.reporterId,
    });
    return { ok: true, observation };
  } catch (err) {
    if (err instanceof ObservationError) return fail("invalid", err.message);
    throw err;
  }
}

/** Public projection: never exposes reporter identity or contact details. */
export function publicReportView(obs) {
  return {
    id: obs.id,
    productId: obs.productId,
    storeId: obs.storeId,
    availability: obs.availability,
    quantity: obs.quantity,
    sightedAt: obs.sourceTimestamp,
    receivedAt: obs.receivedAt,
    status: obs.verificationStatus,
    label: "Community report — not retailer-confirmed",
  };
}

function fail(code, message) {
  return { ok: false, code, message };
}
