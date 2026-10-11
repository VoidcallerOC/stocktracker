import test from "node:test";
import assert from "node:assert/strict";
import { runIngestion, CircuitBreaker } from "../src/ingest/runner.js";
import { T0, iso } from "./helpers.js";

function memoryStore() {
  const rows = new Map();
  const fp = (o) => `${o.productId}|${o.storeId}|${o.availability}|${JSON.stringify(o.quantity)}|${o.sourceRecordId}`;
  return {
    rows,
    async insertObservations(list) {
      let n = 0;
      for (const o of list) if (!rows.has(fp(o))) { rows.set(fp(o), o); n++; }
      return n;
    },
  };
}
const ENV = { SOURCE_SYNTHETIC_DEMO_ENABLED: "1", SOURCE_BESTBUY_ENABLED: "1" };
const rec = (id, qty) => ({ id, sku: "s1", store: "st1", qty, ts: iso(T0) });
const map = (r) => ({ id: r.id, productId: r.sku, storeId: r.store, availability: r.qty > 0 ? "in_stock" : "out_of_stock", quantity: r.qty, sourceTimestamp: r.ts, sourceRecordId: r.id, isSynthetic: true });
const base = { sourceId: "synthetic_demo", mapRecord: map, env: ENV, now: () => T0, sleep: async () => {} };

test("unauthorized retailer adapter never executes its fetch", async () => {
  let called = false;
  const r = await runIngestion({ ...base, sourceId: "bestbuy_developer_api", store: memoryStore(), fetchRecords: async () => { called = true; return []; } });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test("failed source writes nothing and leaves prior observations intact", async () => {
  const store = memoryStore();
  await runIngestion({ ...base, store, fetchRecords: async () => [rec("a", 3)] });
  assert.equal(store.rows.size, 1);
  let attempts = 0;
  const r = await runIngestion({ ...base, store, fetchRecords: async () => { attempts++; throw new Error("503"); } });
  assert.equal(r.ok, false);
  assert.equal(attempts, 3, "bounded retries");
  assert.equal(store.rows.size, 1);
  assert.equal([...store.rows.values()][0].quantity.value, 3, "no zero overwrite");
});

test("malformed record aborts the whole batch", async () => {
  const store = memoryStore();
  const r = await runIngestion({ ...base, store, fetchRecords: async () => [rec("a", 3), rec("b", -4)] });
  assert.equal(r.ok, false);
  assert.equal(store.rows.size, 0);
});

test("retries and duplicates are idempotent", async () => {
  const store = memoryStore();
  const fetchRecords = async () => [rec("a", 3), rec("a", 3)];
  const r1 = await runIngestion({ ...base, store, fetchRecords });
  const r2 = await runIngestion({ ...base, store, fetchRecords });
  assert.equal(r1.inserted, 1);
  assert.equal(r2.inserted, 0);
});

test("timeout counts as failure", async () => {
  const r = await runIngestion({ ...base, store: memoryStore(), timeoutMs: 10, maxAttempts: 1, fetchRecords: () => new Promise(() => {}) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /timed out/);
});

test("circuit breaker opens after repeated failures", async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
  const fail = { ...base, store: memoryStore(), breaker, maxAttempts: 1, fetchRecords: async () => { throw new Error("x"); } };
  await runIngestion(fail);
  await runIngestion(fail);
  const r = await runIngestion(fail);
  assert.equal(r.reason, "circuit open");
});

test("synthetic records cannot be ingested in production", async () => {
  const store = memoryStore();
  const r = await runIngestion({ ...base, store, env: { ...ENV, APP_ENV: "production" }, fetchRecords: async () => [rec("a", 1)] });
  assert.equal(r.ok, false);
  assert.equal(store.rows.size, 0);
});
