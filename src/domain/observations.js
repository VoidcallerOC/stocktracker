// Inventory observation validation and normalization.
//
// An observation is an immutable historical event. Normalization never invents data:
// a missing quantity stays { kind: "unknown" } and is never turned into 0.

import { createHash } from "node:crypto";
import {
  AVAILABILITY,
  QUANTITY_KINDS,
  SOURCE_TYPES,
  VERIFICATION_STATUS,
} from "./constants.js";
import { toMs } from "./freshness.js";

export class ObservationError extends Error {}

const MAX_QTY = 10_000;

/**
 * Normalizes a raw quantity into { kind, value?, min?, max? }.
 * Accepts: undefined/null -> unknown; integer -> exact; { min, max } -> estimate.
 * Community reports can never claim "exact" (they become estimates of [n, n]).
 */
export function normalizeQuantity(raw, sourceType) {
  if (raw === undefined || raw === null || raw === "") return { kind: "unknown" };
  if (typeof raw === "object" && raw.kind === "unknown") return { kind: "unknown" };

  if (typeof raw === "number" || (typeof raw === "object" && raw.kind === "exact")) {
    const v = typeof raw === "number" ? raw : raw.value;
    assertQty(v);
    if (sourceType === "community_report") return { kind: "estimate", min: v, max: v };
    return { kind: "exact", value: v };
  }
  if (typeof raw === "object" && (raw.kind === "estimate" || ("min" in raw && "max" in raw))) {
    assertQty(raw.min);
    assertQty(raw.max);
    if (raw.min > raw.max) throw new ObservationError("quantity estimate min > max");
    return { kind: "estimate", min: raw.min, max: raw.max };
  }
  throw new ObservationError("unrecognized quantity");
}

function assertQty(v) {
  if (!Number.isInteger(v) || v < 0 || v > MAX_QTY) {
    throw new ObservationError(`quantity must be an integer 0..${MAX_QTY}`);
  }
}

/**
 * Validates and returns a frozen, normalized observation.
 * `receivedAt` must be supplied by the server, never by the client.
 */
export function normalizeObservation(input) {
  const req = ["id", "productId", "storeId", "sourceId", "sourceType", "receivedAt"];
  for (const k of req) {
    if (input[k] === undefined || input[k] === null || input[k] === "") {
      throw new ObservationError(`missing ${k}`);
    }
  }
  if (!SOURCE_TYPES.includes(input.sourceType)) throw new ObservationError("bad sourceType");
  const availability = input.availability ?? "unknown";
  if (!AVAILABILITY.includes(availability)) throw new ObservationError("bad availability");
  if (toMs(input.receivedAt) === null) throw new ObservationError("bad receivedAt");
  if (input.sourceTimestamp != null && toMs(input.sourceTimestamp) === null) {
    throw new ObservationError("bad sourceTimestamp");
  }

  const verificationStatus =
    input.verificationStatus ?? (input.sourceType === "community_report" ? "pending" : "verified");
  if (!VERIFICATION_STATUS.includes(verificationStatus)) {
    throw new ObservationError("bad verificationStatus");
  }
  // Only trusted source types may carry "verified"; community reports go through moderation.
  if (input.sourceType === "community_report" && verificationStatus === "verified") {
    throw new ObservationError("community reports cannot be marked verified");
  }

  const quantity = normalizeQuantity(input.quantity, input.sourceType);
  if (!QUANTITY_KINDS.includes(quantity.kind)) throw new ObservationError("bad quantity kind");

  // An exact positive quantity contradicting out_of_stock is rejected rather than "fixed".
  if (quantity.kind === "exact" && quantity.value > 0 && availability === "out_of_stock") {
    throw new ObservationError("quantity > 0 contradicts out_of_stock");
  }

  return Object.freeze({
    id: String(input.id),
    productId: String(input.productId),
    storeId: String(input.storeId),
    sourceId: String(input.sourceId),
    sourceType: input.sourceType,
    availability,
    quantity: Object.freeze(quantity),
    sourceTimestamp: input.sourceTimestamp ?? null,
    receivedAt: input.receivedAt,
    verificationStatus,
    sourceRecordId: input.sourceRecordId ?? null,
    reporterId: input.reporterId ?? null,
    isSynthetic: input.isSynthetic === true,
  });
}

/**
 * Content fingerprint used for idempotent ingestion: a retried feed record or a
 * re-submitted identical observation maps to the same fingerprint.
 */
export function observationFingerprint(obs) {
  const q = obs.quantity;
  const parts = [
    obs.productId,
    obs.storeId,
    obs.sourceId,
    obs.availability,
    q.kind,
    q.value ?? "",
    q.min ?? "",
    q.max ?? "",
    obs.sourceRecordId ?? "",
    obs.sourceTimestamp ? new Date(toMs(obs.sourceTimestamp)).toISOString() : "",
    obs.sourceType === "community_report" ? (obs.reporterId ?? "") : "",
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** Human-facing quantity label; never shows a number the source did not supply. */
export function describeQuantity(q) {
  if (q.kind === "exact") return `${q.value} reported`;
  if (q.kind === "estimate") return q.min === q.max ? `~${q.min} (estimate)` : `~${q.min}–${q.max} (estimate)`;
  return "Quantity unknown";
}
