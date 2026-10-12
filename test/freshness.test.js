import test from "node:test";
import assert from "node:assert/strict";
import { classifyFreshness, effectiveObservedAt, explainFreshness, retainedForDisplay } from "../src/domain/freshness.js";
import { normalizeObservation } from "../src/domain/observations.js";
import { obs, T0, HOUR, MIN, iso } from "./helpers.js";

test("freshness bands for authorized feed", () => {
  const o = normalizeObservation(obs());
  assert.equal(classifyFreshness(o, T0 + 1 * HOUR), "FRESH");
  assert.equal(classifyFreshness(o, T0 + 5 * HOUR), "AGING");
  assert.equal(classifyFreshness(o, T0 + 13 * HOUR), "STALE");
});

test("stale data cannot be presented as fresh even if received recently", () => {
  const o = normalizeObservation(obs({ sourceTimestamp: iso(T0 - 20 * HOUR), receivedAt: iso(T0) }));
  assert.equal(classifyFreshness(o, T0), "STALE");
});

test("feed without a source timestamp is UNKNOWN unless explicitly trusted", () => {
  const o = normalizeObservation(obs({ sourceTimestamp: null }));
  assert.equal(classifyFreshness(o, T0), "UNKNOWN");
  assert.equal(classifyFreshness(o, T0, undefined, { trustReceiptTime: true }), "FRESH");
});

test("future timestamps are UNKNOWN, not extra fresh", () => {
  assert.throws(
    () => normalizeObservation(obs({ sourceTimestamp: iso(T0 + 2 * HOUR), receivedAt: iso(T0) })),
    /source timestamp is after receipt/,
  );
  const ahead = normalizeObservation(obs({
    sourceTimestamp: iso(T0 + 2 * HOUR),
    receivedAt: iso(T0 + 2 * HOUR),
  }));
  assert.equal(classifyFreshness(ahead, T0), "UNKNOWN");
});

test("community reporters cannot forward-date a sighting", () => {
  assert.throws(
    () => normalizeObservation(obs({
      sourceType: "community_report", sourceId: "community", reporterId: "u1",
      sourceTimestamp: iso(T0 + 3 * HOUR), receivedAt: iso(T0),
    })),
    /source timestamp is after receipt/,
  );
  const slight = normalizeObservation(obs({
    sourceType: "community_report", sourceId: "community", reporterId: "u1",
    sourceTimestamp: iso(T0 + 4 * MIN), receivedAt: iso(T0),
  }));
  assert.equal(effectiveObservedAt(slight), T0);
  const old = normalizeObservation(obs({
    sourceType: "community_report", sourceId: "community", reporterId: "u1",
    sourceTimestamp: iso(T0 - 20 * HOUR), receivedAt: iso(T0),
  }));
  assert.equal(classifyFreshness(old, T0 + MIN), "STALE");
});

test("a real source timestamp wins over receipt fallback", () => {
  const o = normalizeObservation(obs({ sourceTimestamp: iso(T0 - 20 * HOUR), receivedAt: iso(T0) }));
  const explained = explainFreshness(o, T0, undefined, { trustReceiptTime: true });
  assert.equal(explained.band, "STALE");
  assert.equal(explained.timeBasis, "source");
});

test("receipt fallback is labeled as receipt time and stays off unless configured", () => {
  const o = normalizeObservation(obs({ sourceTimestamp: null, receivedAt: iso(T0) }));
  assert.equal(explainFreshness(o, T0 + HOUR).timeBasis, "unknown");
  assert.equal(explainFreshness(o, T0 + HOUR).band, "UNKNOWN");
  const fallback = explainFreshness(o, T0 + HOUR, undefined, { trustReceiptTime: true });
  assert.equal(fallback.band, "FRESH");
  assert.equal(fallback.timeBasis, "receipt_fallback");
  assert.equal(fallback.provisional, true);
});

test("retention age is measured from receipt, including the 72 hour boundary", () => {
  const bestBuy = (receivedAt) => normalizeObservation(obs({
    sourceId: "bestbuy_developer_api",
    sourceTimestamp: receivedAt,
    receivedAt,
  }));
  assert.equal(retainedForDisplay(bestBuy(iso(T0)), T0 + 72 * HOUR - 1), true);
  assert.equal(retainedForDisplay(bestBuy(iso(T0)), T0 + 72 * HOUR), false);
  assert.equal(retainedForDisplay(normalizeObservation(obs({ sourceId: "walmart_affiliate_api" })), T0), false);
});

test("expired/rejected verification is STALE", () => {
  const o = normalizeObservation(obs({ sourceType: "community_report", sourceId: "community", reporterId: "u1", verificationStatus: "expired" }));
  assert.equal(classifyFreshness(o, T0), "STALE");
});
