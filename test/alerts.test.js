import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAlert, withinCooldown, alertMessage } from "../src/domain/alerts.js";
import { normalizeObservation as N } from "../src/domain/observations.js";
import { obs, T0, HOUR, MIN, iso, ENV_ON } from "./helpers.js";

const feed = (h, availability, quantity, extra = {}) => N(obs({
  sourceId: "synthetic_demo", availability, quantity,
  sourceTimestamp: iso(T0 + h * HOUR), receivedAt: iso(T0 + h * HOUR), ...extra,
}));
const comm = (h, availability, extra = {}) => N(obs({
  sourceId: "community", sourceType: "community_report", reporterId: "u1", availability,
  verificationStatus: "accepted", sourceTimestamp: iso(T0 + h * HOUR), receivedAt: iso(T0 + h * HOUR), ...extra,
}));
const ev = (observation, history, now, env = ENV_ON) => evaluateAlert({ observation, history, now: now ?? Date.parse(observation.receivedAt) + MIN, env });

test("out-of-stock -> in-stock fires a restock alert", () => {
  const prev = feed(0, "out_of_stock", 0);
  const next = feed(1, "in_stock", 4);
  const r = ev(next, [prev]);
  assert.equal(r.qualifies, true);
  assert.equal(r.trigger, "restock");
  assert.equal(r.confidence, "high");
});

test("no prior data -> in-stock fires restock; stale prior -> restock_after_expiry", () => {
  assert.equal(ev(feed(1, "in_stock"), []).trigger, "restock");
  const old = feed(0, "in_stock", 3);
  assert.equal(ev(feed(30, "in_stock", 3), [old]).trigger, "restock_after_expiry");
});

test("stale observation never alerts", () => {
  const stale = feed(0, "in_stock", 5);
  const r = ev(stale, [], T0 + 20 * HOUR);
  assert.equal(r.qualifies, false);
  assert.equal(r.reason, "observation not fresh");
});

test("already-available product only alerts on threshold increase from comparable data", () => {
  const prev = feed(0, "in_stock", 2);
  assert.equal(ev(feed(1, "in_stock", 4), [prev]).qualifies, false);
  const r = ev(feed(1, "in_stock", 12), [prev]);
  assert.equal(r.trigger, "reported_increase");
  assert.equal(r.stockChange.delta, 10);
  // Unknown quantities never compute an increase.
  assert.equal(ev(feed(1, "in_stock"), [feed(0, "in_stock")]).qualifies, false);
});

test("retried ingestion yields the same idempotency key", () => {
  const prev = feed(0, "out_of_stock", 0);
  const a = feed(1, "in_stock", 4, { sourceRecordId: "r1", id: "a" });
  const b = feed(1, "in_stock", 4, { sourceRecordId: "r1", id: "b", receivedAt: iso(T0 + HOUR + 2 * MIN) });
  assert.equal(ev(a, [prev]).idempotencyKey, ev(b, [prev], T0 + HOUR + 3 * MIN).idempotencyKey);
});

test("duplicate community reports do not create a second alert", () => {
  const first = comm(1, "in_stock", { reporterId: "u1" });
  const second = comm(1.2, "in_stock", { reporterId: "u2" });
  assert.equal(ev(first, []).qualifies, true);
  const r = ev(second, [first]);
  assert.equal(r.qualifies, false);
  assert.equal(r.reason, "already available");
});

test("unverified/pending community reports cannot alert; accepted ones are labeled community", () => {
  const pending = comm(1, "in_stock", { verificationStatus: "pending" });
  assert.equal(ev(pending, []).qualifies, false);
  const ok = ev(comm(1, "in_stock"), []);
  assert.equal(ok.communityReported, true);
  assert.notEqual(ok.confidence, "high");
});

test("community confidence rises to medium (never high) with corroboration", () => {
  const a = comm(1, "in_stock", { reporterId: "u1" });
  const b = comm(1.1, "in_stock", { reporterId: "u2", id: "late" });
  const r = evaluateAlert({ observation: a, history: [b], now: T0 + 1.2 * HOUR, env: ENV_ON });
  assert.equal(r.confidence, "medium");
});

test("kill switch, disabled notifications, and production synthetic data block alerts", () => {
  const o = feed(1, "in_stock", 3);
  assert.equal(ev(o, [], undefined, { ...ENV_ON, NOTIFICATIONS_KILL: "1" }).qualifies, false);
  assert.equal(ev(o, [], undefined, {}).qualifies, false);
  assert.equal(ev(o, [], undefined, { ...ENV_ON, VERCEL_ENV: "production" }).qualifies, false);
});

test("a stale in-stock report cannot alert even though prior state was out of stock", () => {
  const prev = feed(0, "out_of_stock", 0);
  const late = feed(1, "in_stock", 2);
  assert.equal(ev(late, [prev], T0 + 4 * HOUR).qualifies, false);
});

test("cooldown and copy", () => {
  assert.equal(withinCooldown(null, T0, HOUR), false);
  assert.equal(withinCooldown(T0, T0 + 30 * MIN, HOUR), true);
  const msg = alertMessage({ productName: "ETB", storeName: "Store", trigger: "restock", confidence: "low", communityReported: true, ageMinutes: 5 });
  assert.match(msg, /not retailer-confirmed/);
  assert.match(msg, /not guaranteed/);
  assert.doesNotMatch(msg, /reserved for you|guaranteed in stock/i);
});
