// Ingestion runner for automated inventory adapters.
//
// Guarantees:
//   - an adapter that is not authorized/enabled never executes (see canRunSource);
//   - each fetch is bounded by a timeout, with bounded exponential-backoff retries;
//   - a per-source circuit breaker stops hammering a failing source;
//   - on any failure NOTHING is written: no zero-stock rows, no overwrites. The previous
//     observations stay intact and simply age into AGING/STALE in the UI.
//   - records are normalized and deduplicated by content fingerprint before storage, so a
//     retried batch cannot create duplicate observations (and therefore duplicate alerts).

import { SOURCE_REGISTRY, canRunSource, isProduction } from "../domain/sources.js";
import { normalizeObservation, observationFingerprint } from "../domain/observations.js";

export class CircuitBreaker {
  constructor({ failureThreshold = 3, cooldownMs = 15 * 60 * 1000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.openedAt = null;
  }
  isOpen(now) {
    if (this.openedAt === null) return false;
    if (now - this.openedAt >= this.cooldownMs) return false; // half-open: allow one try
    return true;
  }
  recordSuccess() {
    this.failures = 0;
    this.openedAt = null;
  }
  recordFailure(now) {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.openedAt = now;
  }
}

export async function withTimeout(promiseFactory, ms) {
  const ac = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promiseFactory(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} args
 * @param {string} args.sourceId
 * @param {(signal: AbortSignal) => Promise<object[]>} args.fetchRecords  adapter fetch
 * @param {(record: object) => object} args.mapRecord  maps a source record to observation input
 * @param {{ insertObservations: (obs: object[]) => Promise<number> }} args.store
 * @returns {Promise<{ ok: boolean, reason?: string, inserted?: number, skipped?: number }>}
 */
export async function runIngestion({
  sourceId,
  fetchRecords,
  mapRecord,
  store,
  env = {},
  breaker,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = 10_000,
  maxAttempts = 3,
  baseDelayMs = 1_000,
}) {
  const gate = canRunSource(sourceId, env);
  if (!gate.allowed) return { ok: false, reason: gate.reason };
  if (breaker?.isOpen(now())) return { ok: false, reason: "circuit open" };

  let records;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      records = await withTimeout(fetchRecords, timeoutMs);
      if (!Array.isArray(records)) throw new Error("adapter returned non-array");
      break;
    } catch (err) {
      lastErr = err;
      records = undefined;
      if (attempt < maxAttempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  if (!records) {
    breaker?.recordFailure(now());
    return { ok: false, reason: `fetch failed: ${lastErr?.message ?? "unknown"}` };
  }

  // Validate the whole batch before writing anything; one malformed record aborts the batch
  // rather than letting partial or fabricated data through.
  const receivedAt = new Date(now()).toISOString();
  let normalized;
  try {
    normalized = records.map((r) => {
      // sourceId, sourceType and receivedAt are set here, never by the adapter.
      const o = normalizeObservation({
        ...mapRecord(r),
        sourceId,
        sourceType: SOURCE_REGISTRY[sourceId].sourceType,
        receivedAt,
      });
      if (o.isSynthetic && isProduction(env)) throw new Error("synthetic record in production");
      return o;
    });
  } catch (err) {
    breaker?.recordFailure(now());
    return { ok: false, reason: `invalid batch: ${err.message}` };
  }

  const seen = new Set();
  const unique = normalized.filter((o) => {
    const fp = observationFingerprint(o);
    if (seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });

  // The store must enforce fingerprint uniqueness too (db unique index), so cross-run
  // retries are idempotent. It returns how many rows were newly inserted.
  const inserted = await store.insertObservations(unique);
  breaker?.recordSuccess();
  return { ok: true, inserted, skipped: normalized.length - inserted };
}
