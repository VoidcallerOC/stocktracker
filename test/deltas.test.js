import test from "node:test";
import assert from "node:assert/strict";
import { computeStockChange, comparability } from "../src/domain/deltas.js";
import { normalizeObservation as N } from "../src/domain/observations.js";
import { SOURCE_POLICIES } from "../src/domain/source-policy.js";
import { obs, T0, HOUR, iso } from "./helpers.js";

const at = (h, q, extra = {}) => N(obs({ quantity: q, sourceTimestamp: iso(T0 + h * HOUR), receivedAt: iso(T0 + h * HOUR), ...extra }));

test("2 -> 12 is a reported increase of 10", () => {
  const c = computeStockChange(at(0, 2), at(1, 12), iso(T0 + HOUR));
  assert.equal(c.delta, 10);
  assert.equal(c.direction, "reported_increase");
  assert.equal(c.previousQuantity, 2);
  assert.equal(c.newQuantity, 12);
});

test("no delta across sources, products, stores, unknown qty, or expired prev", () => {
  const p = at(0, 2);
  assert.equal(computeStockChange(p, at(1, 12, { sourceId: "feed-b" })), null);
  assert.equal(computeStockChange(p, at(1, 12, { productId: "other" })), null);
  assert.equal(computeStockChange(p, at(1, 12, { storeId: "other" })), null);
  assert.equal(computeStockChange(p, at(1, undefined)), null);
  assert.equal(comparability(p, at(30, 12)).reason, "previous observation expired");
  assert.equal(computeStockChange(at(1, 12), p), null, "older observation is not 'next'");
});

test("receipt fallback is required before a missing source timestamp can form a delta", () => {
  const prev = N(obs({ quantity: 2, sourceTimestamp: null, receivedAt: iso(T0) }));
  const next = N(obs({ quantity: 6, sourceTimestamp: null, receivedAt: iso(T0 + HOUR) }));
  assert.equal(comparability(prev, next).reason, "timestamp unknown");
  const policies = {
    "feed-a": { ...SOURCE_POLICIES.synthetic_demo, trustReceiptTime: true, quantityReliability: "exact", retention: { mode: "retain" } },
  };
  const change = computeStockChange(prev, next, iso(T0 + HOUR), undefined, policies);
  assert.equal(change.delta, 4);
  assert.equal(change.direction, "reported_increase");
});

test("status-only sources do not produce a quantity delta", () => {
  const prev = N(obs({
    sourceId: "bestbuy_developer_api", quantity: 2, sourceTimestamp: iso(T0), receivedAt: iso(T0),
  }));
  const next = N(obs({
    sourceId: "bestbuy_developer_api", quantity: 9, sourceTimestamp: iso(T0 + HOUR), receivedAt: iso(T0 + HOUR),
  }));
  assert.equal(comparability(prev, next).reason, "source quantity is not reliable");
  assert.equal(computeStockChange(prev, next, iso(T0 + HOUR)), null);
});

test("no delta from community estimates or identical quantities", () => {
  const c1 = at(0, 2, { sourceType: "community_report", sourceId: "community", reporterId: "u" });
  const c2 = at(1, 9, { sourceType: "community_report", sourceId: "community", reporterId: "u" });
  assert.equal(computeStockChange(c1, c2), null);
  assert.equal(computeStockChange(at(0, 5), at(1, 5)), null);
});
