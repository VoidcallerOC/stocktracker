// Community-report comparison for one product at one store.
//
// Deterministic rules (no confidence score):
// - Only current (FRESH or AGING) accepted reports participate. Older reports expire
//   out of the comparison; they do not keep a conflict alive.
// - The latest current report from each reporter replaces that reporter's earlier
//   report. A person correcting themselves is not a disagreement.
// - Reports from different reporters are independent. A second submission by the
//   same reporter is a duplicate, not a second witness.
// - in_stock and limited are the same availability class (positive). out_of_stock
//   is negative. uncertain and unknown assert neither, so they do not contradict.
// - Positive and negative classes from different reporters in the window are
//   CONFLICTING (availability). The newest report is not chosen.
// - Same class with quantity ranges that do not overlap is CONFLICTING (quantity).
//   Unknown quantity overlaps every range: unknown is not zero.
// - Exact quantities are a trusted-source notion. Community intake stores estimates.
// - Retailer observations are not passed to this function. A community conflict
//   cannot outrank or imitate a retailer-confirmed reading.

const POSITIVE = new Set(["in_stock", "limited"]);
const NEGATIVE = new Set(["out_of_stock"]);

export function availabilityClass(availability) {
  if (POSITIVE.has(availability)) return "positive";
  if (NEGATIVE.has(availability)) return "negative";
  return "nonassertive";
}

function bounds(quantity) {
  if (!quantity || quantity.kind === "unknown") return null;
  if (quantity.kind === "exact") return [quantity.value, quantity.value];
  if (quantity.kind === "estimate") return [quantity.min, quantity.max];
  return null;
}

function overlaps(a, b) {
  if (a === null || b === null) return true;
  return a[0] <= b[1] && b[0] <= a[1];
}

export function quantitiesConflict(observations) {
  const ranges = observations.map((obs) => bounds(obs.quantity));
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (!overlaps(ranges[i], ranges[j])) return true;
    }
  }
  return false;
}

function reporterKey(item) {
  return item.obs.reporterId || item.obs.id;
}

function receivedMs(item) {
  const v = item.obs.receivedAt;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

export function combineFreshness(items) {
  if (items.some((item) => item.freshness === "AGING")) return "AGING";
  if (items.length && items.every((item) => item.freshness === "FRESH")) return "FRESH";
  return items[0]?.freshness ?? "UNKNOWN";
}

export function combineTimeBasis(items) {
  if (items.some((item) => item.timeBasis === "receipt_fallback" || item.timeBasis === "receipt_clamped")) {
    return "receipt_fallback";
  }
  if (items.some((item) => item.timeBasis === "unknown")) return "unknown";
  return items[0]?.timeBasis ?? "unknown";
}

/**
 * @param {Array<{ obs: object, freshness: string, timeBasis: string, observedAt: number }>} current
 */
export function resolveCommunityClaims(current) {
  const byReporter = new Map();
  for (const item of current) {
    const key = reporterKey(item);
    const prev = byReporter.get(key);
    if (
      !prev ||
      item.observedAt > prev.observedAt ||
      (item.observedAt === prev.observedAt && receivedMs(item) >= receivedMs(prev))
    ) {
      byReporter.set(key, item);
    }
  }
  const claims = [...byReporter.values()];
  const positives = claims.filter((item) => availabilityClass(item.obs.availability) === "positive");
  const negatives = claims.filter((item) => availabilityClass(item.obs.availability) === "negative");

  if (positives.length && negatives.length) {
    const items = [...positives, ...negatives];
    return result(items, {
      state: "conflicting",
      primary: null,
      conflictReason: "availability",
    });
  }

  const side = positives.length ? positives : negatives;
  if (side.length === 0) {
    return result(claims, {
      state: "uncertain",
      primary: claims.length === 1 ? claims[0].obs : null,
      conflictReason: null,
    });
  }

  if (side.length >= 2 && quantitiesConflict(side.map((item) => item.obs))) {
    return result(side, {
      state: "conflicting",
      primary: null,
      conflictReason: "quantity",
    });
  }

  return result(side, {
    state: positives.length ? "available" : "unavailable",
    primary: side.length === 1 ? side[0].obs : null,
    conflictReason: null,
  });
}

function result(items, fields) {
  return {
    independentReporterCount: items.length,
    candidates: items.map((item) => item.obs),
    freshness: items.length === 1 ? items[0].freshness : combineFreshness(items),
    timeBasis: items.length === 1 ? items[0].timeBasis : combineTimeBasis(items),
    ...fields,
  };
}
