import test from "node:test";
import assert from "node:assert/strict";
import { normalizeObservation, normalizeQuantity, describeQuantity, observationFingerprint, ObservationError } from "../src/domain/observations.js";
import { obs } from "./helpers.js";

test("missing quantity stays unknown, never zero", () => {
  for (const raw of [undefined, null, ""]) {
    assert.deepEqual(normalizeQuantity(raw, "authorized_feed"), { kind: "unknown" });
  }
  const o = normalizeObservation(obs({ availability: "in_stock" }));
  assert.equal(o.quantity.kind, "unknown");
  assert.equal(o.quantity.value, undefined);
  assert.equal(describeQuantity(o.quantity), "Quantity unknown");
});

test("exact zero is preserved as exact zero (distinct from unknown)", () => {
  const o = normalizeObservation(obs({ availability: "out_of_stock", quantity: 0 }));
  assert.deepEqual({ ...o.quantity }, { kind: "exact", value: 0 });
});

test("community reports cannot claim exact quantity or verified status", () => {
  const o = normalizeObservation(obs({ sourceType: "community_report", sourceId: "community", reporterId: "u1", quantity: 4 }));
  assert.equal(o.quantity.kind, "estimate");
  assert.equal(o.verificationStatus, "pending");
  assert.throws(
    () => normalizeObservation(obs({ sourceType: "community_report", sourceId: "community", verificationStatus: "verified" })),
    ObservationError,
  );
});

test("rejects invalid quantities and contradictions", () => {
  assert.throws(() => normalizeQuantity(-1, "authorized_feed"), ObservationError);
  assert.throws(() => normalizeQuantity(1.5, "authorized_feed"), ObservationError);
  assert.throws(() => normalizeQuantity({ min: 5, max: 2 }, "authorized_feed"), ObservationError);
  assert.throws(() => normalizeObservation(obs({ availability: "out_of_stock", quantity: 3 })), ObservationError);
  assert.throws(() => normalizeObservation(obs({ receivedAt: undefined })), ObservationError);
});

test("observations are immutable and traceable to source + timestamps", () => {
  const o = normalizeObservation(obs({ sourceRecordId: "rec-9", quantity: 2 }));
  assert.ok(Object.isFrozen(o));
  assert.throws(() => { o.quantity.value = 99; });
  for (const k of ["sourceId", "sourceType", "sourceTimestamp", "receivedAt", "sourceRecordId"]) assert.ok(o[k], k);
});

test("fingerprint is stable for retried identical records", () => {
  const base = { sourceRecordId: "rec-1", quantity: 2 };
  const a = normalizeObservation(obs({ ...base, id: "x1" }));
  const b = normalizeObservation(obs({ ...base, id: "x2", receivedAt: "2026-10-11T12:05:00Z" }));
  assert.equal(observationFingerprint(a), observationFingerprint(b));
  const c = normalizeObservation(obs({ ...base, quantity: 3 }));
  assert.notEqual(observationFingerprint(a), observationFingerprint(c));
});
