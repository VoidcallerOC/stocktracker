import test from "node:test";
import assert from "node:assert/strict";
import { intakeCommunityReport, publicReportView } from "../src/domain/community.js";
import { T0, MIN, HOUR, iso } from "./helpers.js";

const ctx = (extra = {}) => ({
  id: "c1", reporterId: "user-1", now: T0,
  knownProductIds: new Set(["p1"]), verifiedStoreIds: new Set(["s1"]), recentByReporter: [], ...extra,
});
const input = (extra = {}) => ({ productId: "p1", storeId: "s1", availability: "in_stock", sightedAt: iso(T0 - 10 * MIN), ...extra });

test("valid report is pending, server-timestamped, and an estimate", () => {
  const r = intakeCommunityReport(input({ quantity: 6 }), ctx());
  assert.equal(r.ok, true);
  assert.equal(r.observation.verificationStatus, "pending");
  assert.equal(r.observation.receivedAt, iso(T0));
  assert.equal(r.observation.quantity.kind, "estimate");
});

test("rejects unauthenticated, unknown product, unverified store, future/old sightings", () => {
  assert.equal(intakeCommunityReport(input(), ctx({ reporterId: null })).code, "unauthenticated");
  assert.equal(intakeCommunityReport(input({ productId: "zzz" }), ctx()).code, "invalid_product");
  assert.equal(intakeCommunityReport(input({ storeId: "fake" }), ctx()).code, "invalid_store");
  assert.equal(intakeCommunityReport(input({ sightedAt: iso(T0 + HOUR) }), ctx()).code, "invalid_time");
  assert.equal(intakeCommunityReport(input({ sightedAt: iso(T0 - 30 * HOUR) }), ctx()).code, "too_old");
  assert.equal(intakeCommunityReport(input({ availability: "unknown" }), ctx()).code, "invalid_availability");
});

test("duplicate and rate-limit protection", () => {
  const recent = [{ productId: "p1", storeId: "s1", availability: "in_stock", receivedAt: iso(T0 - 5 * MIN) }];
  assert.equal(intakeCommunityReport(input(), ctx({ recentByReporter: recent })).code, "duplicate");
  const many = Array.from({ length: 10 }, (_, i) => ({ productId: "p9", storeId: "s9", availability: "in_stock", receivedAt: iso(T0 - i * MIN) }));
  assert.equal(intakeCommunityReport(input(), ctx({ recentByReporter: many })).code, "rate_limited");
});

test("public view hides reporter identity and labels the source", () => {
  const r = intakeCommunityReport(input(), ctx());
  const v = publicReportView(r.observation);
  assert.equal("reporterId" in v, false);
  assert.match(v.label, /not retailer-confirmed/);
});
