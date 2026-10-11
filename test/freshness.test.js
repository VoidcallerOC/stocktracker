import test from "node:test";
import assert from "node:assert/strict";
import { classifyFreshness, effectiveObservedAt } from "../src/domain/freshness.js";
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
  const o = normalizeObservation(obs({ sourceTimestamp: iso(T0 + 2 * HOUR) }));
  assert.equal(classifyFreshness(o, T0), "UNKNOWN");
});

test("community reporters cannot forward-date a sighting", () => {
  const o = normalizeObservation(obs({
    sourceType: "community_report", sourceId: "community", reporterId: "u1",
    sourceTimestamp: iso(T0 + 3 * HOUR), receivedAt: iso(T0),
  }));
  assert.equal(effectiveObservedAt(o), T0);
  const old = normalizeObservation(obs({
    sourceType: "community_report", sourceId: "community", reporterId: "u1",
    sourceTimestamp: iso(T0 - 20 * HOUR), receivedAt: iso(T0),
  }));
  assert.equal(classifyFreshness(old, T0 + MIN), "STALE");
});

test("expired/rejected verification is STALE", () => {
  const o = normalizeObservation(obs({ sourceType: "community_report", sourceId: "community", reporterId: "u1", verificationStatus: "expired" }));
  assert.equal(classifyFreshness(o, T0), "STALE");
});
