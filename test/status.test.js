import test from "node:test";
import assert from "node:assert/strict";
import { publicStatusView, resolveStatus } from "../src/domain/status.js";
import { normalizeObservation as N } from "../src/domain/observations.js";
import { SOURCE_POLICIES } from "../src/domain/source-policy.js";
import { obs, T0, HOUR, iso } from "./helpers.js";

const comm = (h, availability, extra = {}) => N(obs({
  sourceType: "community_report", sourceId: "community", reporterId: "u1", availability,
  verificationStatus: "accepted", sourceTimestamp: iso(T0 + h * HOUR), receivedAt: iso(T0 + h * HOUR), ...extra,
}));

test("no observations -> unknown (not zero / not out of stock)", () => {
  const s = resolveStatus([], T0);
  assert.equal(s.state, "unknown");
  assert.equal(s.primary, null);
});

test("only stale data -> stale state", () => {
  const s = resolveStatus([N(obs())], T0 + 30 * HOUR);
  assert.equal(s.state, "stale");
  assert.equal(s.freshness, "STALE");
});

test("pending or rejected community reports never set status", () => {
  const pend = comm(0, "in_stock", { verificationStatus: "pending" });
  const rej = comm(0, "in_stock", { verificationStatus: "rejected" });
  assert.equal(resolveStatus([pend, rej], T0).state, "unknown");
});

test("trusted feed outranks accepted community report", () => {
  const feed = N(obs({ availability: "out_of_stock", quantity: 0 }));
  const c = comm(0.5, "in_stock");
  const s = resolveStatus([feed, c], T0 + HOUR);
  assert.equal(s.state, "unavailable");
  assert.equal(s.primary.sourceType, "authorized_feed");
});

test("conflicting trusted sources are surfaced, not resolved optimistically", () => {
  const a = N(obs({ sourceId: "feed-a", availability: "in_stock", quantity: 20 }));
  const b = N(obs({ sourceId: "feed-b", availability: "out_of_stock", quantity: 0 }));
  const s = resolveStatus([a, b], T0 + HOUR);
  assert.equal(s.state, "conflicting");
  assert.equal(s.candidates.length, 2);
  assert.equal(s.primary, null);
});

test("community-only status is labeled by source type", () => {
  const s = resolveStatus([comm(0, "in_stock")], T0 + HOUR);
  assert.equal(s.state, "available");
  assert.equal(s.primary.sourceType, "community_report");
  assert.equal(s.thresholdsProvisional, true);
});

test("unknown quantity stays unknown on an available reading", () => {
  const s = resolveStatus([N(obs({ quantity: undefined }))], T0 + HOUR);
  assert.equal(s.state, "available");
  assert.equal(s.primary.quantity.kind, "unknown");
  assert.equal(s.primary.quantity.value, undefined);
});

test("disagreeing community reporters are conflicting, duplicates are not", () => {
  const inn = comm(0, "in_stock", { reporterId: "u1", quantity: { min: 1, max: 2 } });
  const again = comm(0.2, "in_stock", { reporterId: "u1", id: "dup", quantity: { min: 1, max: 2 } });
  const out = comm(0.3, "out_of_stock", { reporterId: "u2", quantity: { min: 0, max: 0 } });
  const conflict = resolveStatus([inn, again, out], T0 + HOUR);
  assert.equal(conflict.state, "conflicting");
  assert.equal(conflict.conflictReason, "availability");
  assert.equal(conflict.primary, null);
  assert.equal(conflict.independentReporterCount, 2);
  const samePerson = resolveStatus([inn, again], T0 + HOUR);
  assert.equal(samePerson.state, "available");
  assert.equal(samePerson.independentReporterCount, 1);
  assert.equal(samePerson.primary.id, again.id);
});

test("non-overlapping community quantities conflict; unknown quantity does not", () => {
  const low = comm(0, "in_stock", { reporterId: "u1", quantity: { min: 1, max: 2 } });
  const high = comm(0.1, "in_stock", { reporterId: "u2", quantity: { min: 10, max: 12 } });
  const qty = resolveStatus([low, high], T0 + HOUR);
  assert.equal(qty.state, "conflicting");
  assert.equal(qty.conflictReason, "quantity");
  const unknown = comm(0.1, "in_stock", { reporterId: "u2" });
  const ok = resolveStatus([low, unknown], T0 + HOUR);
  assert.equal(ok.state, "available");
  assert.equal(ok.primary, null);
  assert.equal(ok.independentReporterCount, 2);
});

test("a community conflict clears when the disagreeing report expires out of the window", () => {
  const inn = comm(0, "in_stock", { reporterId: "u1" });
  const out = comm(10, "out_of_stock", { reporterId: "u2" });
  assert.equal(resolveStatus([inn, out], T0 + 11 * HOUR).state, "conflicting");
  const recovered = resolveStatus([inn, out], T0 + 13 * HOUR);
  assert.equal(recovered.state, "unavailable");
  assert.equal(recovered.primary.reporterId, "u2");
});

test("an expired or duplicate report does not create a retailer-looking status", () => {
  const expired = comm(0, "out_of_stock", { reporterId: "u1", verificationStatus: "expired" });
  const current = comm(0.5, "in_stock", { reporterId: "u2" });
  const s = resolveStatus([expired, current], T0 + HOUR);
  assert.equal(s.state, "available");
  assert.equal(s.primary.reporterId, "u2");
  const pub = publicStatusView(s);
  assert.equal("reporterId" in pub.primary, false);
  assert.equal(JSON.stringify(pub).includes("u2"), false);
});

test("an unapproved retailer feed is blocked and does not hide a community report", () => {
  const bestBuy = N(obs({
    sourceId: "bestbuy_developer_api",
    availability: "in_stock",
    quantity: undefined,
    sourceTimestamp: iso(T0),
    receivedAt: iso(T0),
  }));
  const blocked = resolveStatus([bestBuy], T0 + HOUR);
  assert.equal(blocked.state, "blocked");
  assert.deepEqual(blocked.blockedSourceIds, ["bestbuy_developer_api"]);
  assert.equal(blocked.candidates.length, 0);
  const withCommunity = resolveStatus([bestBuy, comm(0, "in_stock")], T0 + HOUR);
  assert.equal(withCommunity.state, "available");
  assert.equal(withCommunity.primary.sourceType, "community_report");
});

test("receipt fallback reaches status only when the source policy allows it", () => {
  const row = N(obs({ sourceTimestamp: null, receivedAt: iso(T0) }));
  assert.equal(resolveStatus([row], T0 + HOUR).state, "unknown");
  const policies = {
    "feed-a": {
      ...SOURCE_POLICIES.synthetic_demo,
      trustReceiptTime: true,
      retention: { mode: "retain" },
    },
  };
  const s = resolveStatus([row], T0 + HOUR, undefined, policies);
  assert.equal(s.state, "available");
  assert.equal(s.freshness, "FRESH");
  assert.equal(s.timeBasis, "receipt_fallback");
});
