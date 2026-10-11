import test from "node:test";
import assert from "node:assert/strict";
import { computeStockChange, comparability } from "../src/domain/deltas.js";
import { normalizeObservation as N } from "../src/domain/observations.js";
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

test("no delta from community estimates or identical quantities", () => {
  const c1 = at(0, 2, { sourceType: "community_report", sourceId: "community", reporterId: "u" });
  const c2 = at(1, 9, { sourceType: "community_report", sourceId: "community", reporterId: "u" });
  assert.equal(computeStockChange(c1, c2), null);
  assert.equal(computeStockChange(at(0, 5), at(1, 5)), null);
});
