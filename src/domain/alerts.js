// Restock alert qualification. Pure: decides whether a newly stored observation should
// produce a notification event, and with which idempotency key and label. Delivery,
// cooldowns per subscription and retries live in the notification worker.
//
// An alert NEVER fires for: stale/aging/unknown-freshness observations, unverified or
// rejected reports, synthetic data in production, disabled sources, catalog updates,
// or a product that was already showing as available (unless a reliable exact increase
// meets the configured threshold).

import { createHash } from "node:crypto";
import { explainFreshness, effectiveObservedAt, retainedForDisplay } from "./freshness.js";
import { observationFingerprint } from "./observations.js";
import { computeStockChange } from "./deltas.js";
import { isDisplayable, resolveStatus } from "./status.js";
import { canRunSource, isProduction, notificationsEnabled } from "./sources.js";
import { SOURCE_POLICIES, timestampPolicyFor } from "./source-policy.js";

const POSITIVE = new Set(["in_stock", "limited"]);

export const DEFAULT_ALERT_POLICY = Object.freeze({
  // Minimum reported exact increase that alerts while a product already shows available.
  increaseThreshold: 5,
  // Distinct accepted fresh community reports needed for "medium" confidence.
  communityCorroboration: 2,
});

/**
 * @param {object} args
 * @param {object} args.observation  normalized observation that was just stored
 * @param {object[]} args.history    earlier observations for the same product + store
 * @returns {{ qualifies: false, reason: string } |
 *   { qualifies: true, trigger: string, idempotencyKey: string, confidence: string,
 *     communityReported: boolean, observedAt: number, stockChange: object|null }}
 */
export function evaluateAlert({
  observation: obs,
  history,
  now,
  env,
  policy,
  alertPolicy = DEFAULT_ALERT_POLICY,
  sourcePolicies = SOURCE_POLICIES,
}) {
  if (!notificationsEnabled(env)) return no("notifications disabled");
  if (obs.isSynthetic && isProduction(env)) return no("synthetic observation in production");
  if (sourcePolicies[obs.sourceId]?.notifications === false) return no("source cannot generate notifications");
  const gate = canRunSource(obs.sourceId, env, undefined, sourcePolicies);
  if (!gate.allowed) return no(`source not allowed: ${gate.reason}`);
  if (!isDisplayable(obs)) return no("observation not verified/accepted");
  if (!retainedForDisplay(obs, now, sourcePolicies)) return no("outside source retention");

  const cfg = timestampPolicyFor(obs.sourceId, sourcePolicies);
  const detail = explainFreshness(obs, now, policy, cfg);
  if (detail.band !== "FRESH") {
    const unknownAllowed = detail.band === "UNKNOWN" && sourcePolicies[obs.sourceId]?.allowUnknownAgeAlerts === true;
    if (!unknownAllowed) return no(detail.band === "UNKNOWN" ? "unknown age" : "observation not fresh");
  }
  if (!POSITIVE.has(obs.availability)) return no("not an in-stock observation");

  const observedAt = effectiveObservedAt(obs, cfg);
  const combined = resolveStatus([obs, ...history], now, policy, sourcePolicies);
  if (combined.state === "conflicting") return no("unresolved conflict");
  if (combined.state === "blocked") return no("blocked source");

  const prior = history.filter((o) => {
    if (o.id === obs.id) return false;
    const at = effectiveObservedAt(o, timestampPolicyFor(o.sourceId, sourcePolicies));
    return (at ?? Infinity) < (observedAt ?? Infinity);
  });
  const before = resolveStatus(prior, observedAt ?? now, policy, sourcePolicies);

  let trigger = null;
  let stockChange = null;
  if (
    before.state === "unavailable" ||
    before.state === "unknown" ||
    before.state === "uncertain" ||
    before.state === "blocked"
  ) {
    trigger = "restock";
  } else if (before.state === "stale") {
    trigger = "restock_after_expiry";
  } else if (before.state === "available") {
    const sameSourcePrev = prior
      .filter((o) => o.sourceId === obs.sourceId)
      .sort((a, b) => {
        const aAt = effectiveObservedAt(a, timestampPolicyFor(a.sourceId, sourcePolicies)) ?? 0;
        const bAt = effectiveObservedAt(b, timestampPolicyFor(b.sourceId, sourcePolicies)) ?? 0;
        return bAt - aAt;
      })[0];
    stockChange = computeStockChange(sameSourcePrev, obs, now, policy, sourcePolicies);
    if (stockChange && stockChange.delta >= alertPolicy.increaseThreshold) trigger = "reported_increase";
    else return no("already available");
  } else {
    return no(`prior state ${before.state}`);
  }

  const communityReported = obs.sourceType === "community_report";
  const confidence = communityReported
    ? communityConfidence(obs, history, now, policy, alertPolicy, sourcePolicies)
    : "high";
  const idempotencyKey = createHash("sha256")
    .update([obs.productId, obs.storeId, trigger, observationFingerprint(obs)].join("|"))
    .digest("hex");

  return {
    qualifies: true,
    trigger,
    idempotencyKey,
    confidence,
    communityReported,
    observedAt,
    stockChange,
    timeBasis: detail.timeBasis,
  };
}

function communityConfidence(obs, history, now, policy, alertPolicy, sourcePolicies) {
  const reporters = new Set(
    [obs, ...history]
      .filter(
        (o) =>
          o.sourceType === "community_report" &&
          o.verificationStatus === "accepted" &&
          POSITIVE.has(o.availability) &&
          explainFreshness(o, now, policy, timestampPolicyFor(o.sourceId, sourcePolicies)).band === "FRESH",
      )
      .map((o) => o.reporterId),
  );
  // Community reports top out at "medium"; "high" is reserved for trusted sources.
  return reporters.size >= alertPolicy.communityCorroboration ? "medium" : "low";
}

/** Per-subscription cooldown check used by the delivery worker. */
export function withinCooldown(lastSentAt, now, cooldownMs) {
  if (lastSentAt == null) return false;
  return new Date(now).getTime() - new Date(lastSentAt).getTime() < cooldownMs;
}

/** Notification copy. Informational only: never claims reservation or guaranteed stock. */
export function alertMessage({
  productName,
  storeName,
  trigger,
  confidence,
  communityReported,
  ageMinutes,
  timeBasis = "source",
}) {
  const what =
    trigger === "reported_increase" ? "reported a stock increase for" : "has a new in-stock report for";
  let who;
  if (communityReported) {
    who = `Community-reported (${confidence} confidence, ${ageMinutes} min ago, not retailer-confirmed)`;
  } else if (timeBasis === "receipt_fallback") {
    who = `Received by the tracker ${ageMinutes} min ago (the retailer did not provide a check time)`;
  } else if (timeBasis === "unknown") {
    who = "Retailer payload had no check time";
  } else {
    who = `Retailer-reported (${ageMinutes} min ago)`;
  }
  return `${storeName} ${what} ${productName}. ${who}. Availability is not guaranteed and nothing is reserved — check with the store before you go.`;
}

function no(reason) {
  return { qualifies: false, reason };
}
