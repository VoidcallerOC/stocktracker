import test from "node:test";
import assert from "node:assert/strict";
import { resolveStatus } from "../src/domain/status.js";
import { normalizeObservation as N } from "../src/domain/observations.js";
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
});
