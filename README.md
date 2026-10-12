# CT TCG Restock Tracker: inventory provenance core

Tracks retail restock observations for sealed **Pokémon TCG** and **One Piece Card Game** products at Connecticut stores. It shows where every observation came from and how old it is.

**Status: P0/P1 core only. No UI, no deployment, no live retailer integration.** See [`docs/SOURCE-ACCESS-MATRIX.md`](docs/SOURCE-ACCESS-MATRIX.md): no retailer feed is authorized yet, so every retailer adapter is gated off. Public read, retention, and community conflicts are described in [`docs/TRUST-MODEL.md`](docs/TRUST-MODEL.md). The store directory and sealed catalog are described in [`docs/DIRECTORY-AND-CATALOG.md`](docs/DIRECTORY-AND-CATALOG.md). Open items are in [`docs/KNOWN-LIMITATIONS.md`](docs/KNOWN-LIMITATIONS.md).

## What is here
| Path | Purpose |
|---|---|
| `src/domain/observations.js` | Validate and normalize observations. Unknown quantity stays unknown, never 0. Content fingerprints. |
| `src/domain/source-policy.js` | Per-source timestamp, provisional freshness, retention, and notification policy |
| `src/domain/freshness.js` | FRESH / AGING / STALE / UNKNOWN bands. Receipt time is used only when that source allows it |
| `src/domain/deltas.js` | Stock deltas between comparable exact observations. A positive delta is a reported increase, not a delivery |
| `src/domain/status.js` | Current status per product and store, including community conflicts and blocked sources |
| `src/domain/community-conflict.js` | Per-reporter comparison. Disagreement stays `conflicting` |
| `src/domain/sources.js` | Source registry and run gate. An enable flag is not authorization |
| `src/domain/alerts.js` | Restock-alert qualification, idempotency keys, confidence, cooldown, message copy |
| `src/domain/community.js` | Community-report intake: validation, rate limit, duplicates, privacy-safe view |
| `src/domain/directory.js` | Validation for stores, businesses, and sealed products. Unknown facts stay null. |
| `src/import/` | Dry-run planner and transactional apply SQL for directory/catalog files |
| `src/ingest/runner.js` | Adapter runner: gate, timeout, bounded backoff, circuit breaker, all-or-nothing batch writes |
| `db/migrations/0001_init.sql` | Draft Postgres schema with constraints, append-only observations, synthetic-in-prod guard, RLS |
| `db/migrations/0002_public_read_and_retention.sql` | Security-invoker public read and source retention purge |
| `db/migrations/0003_store_directory_and_catalog.sql` | Store-directory and sealed-catalog claims, evidence, and public read views |
| `docs/` | Phase 0 audit, source-access matrix, trust model, directory and catalog rules |

## Commands
```bash
npm run verify                                       # syntax check + unit tests (no deps)
TEST_DATABASE_URL=postgres://postgres@localhost:5432/scratch npm run test:db   # local throwaway DB only
npm run import:directory -- --dry-run --input file.json
```
`test:db` refuses any non-local database URL.

## Rules the code enforces
- A retailer adapter runs only if the registry says `VERIFIED`, its env flag is on and no kill switch is engaged.
- A failed fetch writes nothing. A malformed record aborts the whole batch.
- Stale, unverified, pending, synthetic-in-production or duplicate observations never trigger alerts.
- Community reports are never `verified`, never exact, max confidence "medium", always labeled.
- Alert copy never claims reserved or guaranteed stock.
