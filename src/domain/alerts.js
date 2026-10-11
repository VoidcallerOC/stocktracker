// Restock alert qualification. Pure: decides whether a newly stored observation should
// produce a notification event, and with which idempotency key and label. Delivery,
// cooldowns per subscription and retries live in the notification worker.
//
// An alert NEVER fires for: stale/aging/unknown-freshness observations, unverified or
// rejected reports, synthetic data in production, disabled sources, catalog updates,
// or a product that was already showing as available (unless a reliable exact increase
// meets the configured threshold).

import { createHash } from "node:crypto";
import { classifyFreshness, effectiveObservedAt } from "./freshness.js";
import { observationFingerprint } from "./observations.js";
import { computeStockChange } from "./deltas.js";
import { isDisplayable, resolveStatus } from "./status.js";
import { canRunSource, isProduction, notificationsEnabled } from "./sources.js";

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
export function evaluateAlert({ observation: obs, history, now, env, policy, alertPolicy = DEFAULT_ALERT_POLICY }) {
  if (!notificationsEnabled(env)) return no("notifications disabled");
  if (obs.isSynthetic && isProduction(env)) return no("synthetic observation in production");
  const gate = canRunSource(obs.sourceId, env);
  if (!gate.allowed) return no(`source not allowed: ${gate.reason}`);
  if (!isDisplayable(obs)) return no("observation not verified/accepted");
  if (classifyFreshness(obs, now, policy) !== "FRESH") return no("observation not fresh");
  if (!POSITIVE.has(obs.availability)) return no("not an in-stock observation");

  const observedAt = effectiveObservedAt(obs);
  const prior = history.filter(
    (o) => o.id !== obs.id && (effectiveObservedAt(o) ?? Infinity) < observedAt,
  );
  const before = resolveStatus(prior, observedAt, policy);

  let trigger = null;
  let stockChange = null;
  if (before.state === "unavailable" || before.state === "unknown" || before.state === "uncertain") {
    trigger = "restock";
  } else if (before.state === "stale") {
    trigger = "restock_after_expiry";
  } else if (before.state === "available") {
    const sameSourcePrev = prior
      .filter((o) => o.sourceId === obs.sourceId)
      .sort((a, b) => effectiveObservedAt(b) - effectiveObservedAt(a))[0];
    stockChange = computeStockChange(sameSourcePrev, obs, now, policy);
    if (stockChange && stockChange.delta >= alertPolicy.increaseThreshold) trigger = "reported_increase";
    else return no("already available");
  } else {
    return no(`prior state ${before.state}`);
  }

  const communityReported = obs.sourceType === "community_report";
  const confidence = communityReported ? communityConfidence(obs, history, now, policy, alertPolicy) : "high";
  const idempotencyKey = createHash("sha256")
    .update([obs.productId, obs.storeId, trigger, observationFingerprint(obs)].join("|"))
    .digest("hex");

  return { qualifies: true, trigger, idempotencyKey, confidence, communityReported, observedAt, stockChange };
}

function communityConfidence(obs, history, now, policy, alertPolicy) {
  const reporters = new Set(
    [obs, ...history]
      .filter(
        (o) =>
          o.sourceType === "community_report" &&
          o.verificationStatus === "accepted" &&
          POSITIVE.has(o.availability) &&
          classifyFreshness(o, now, policy) === "FRESH",
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
export function alertMessage({ productName, storeName, trigger, confidence, communityReported, ageMinutes }) {
  const what =
    trigger === "reported_increase" ? "reported a stock increase for" : "has a new in-stock report for";
  const who = communityReported
    ? `Community-reported (${confidence} confidence, ${ageMinutes} min ago, not retailer-confirmed)`
    : `Retailer-reported (${ageMinutes} min ago)`;
  return `${storeName} ${what} ${productName}. ${who}. Availability is not guaranteed and nothing is reserved — check with the store before you go.`;
}

function no(reason) {
  return { qualifies: false, reason };
}
