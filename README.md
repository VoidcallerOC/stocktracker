# CT TCG Restock Tracker: inventory provenance core

Tracks retail restock observations for sealed **Pokémon TCG** and **One Piece Card Game** products at Connecticut stores. It shows where every observation came from and how old it is.

**Status: P0/P1 core only. No UI, no deployment, no live retailer integration.** See [`docs/SOURCE-ACCESS-MATRIX.md`](docs/SOURCE-ACCESS-MATRIX.md): no retailer feed is authorized yet, so every retailer adapter is gated off.

## What is here
| Path | Purpose |
|---|---|
| `src/domain/observations.js` | Validate and normalize observations. Unknown quantity stays unknown, never 0. Content fingerprints. |
| `src/domain/freshness.js` | FRESH / AGING / STALE / UNKNOWN bands, configurable per source type and per source |
| `src/domain/deltas.js` | Stock deltas, computed only between comparable exact observations |
| `src/domain/status.js` | Current status per product and store. Source priority; conflicts are surfaced, never resolved optimistically. |
| `src/domain/sources.js` | Source registry, authorization gate, per-source and global kill switches |
| `src/domain/alerts.js` | Restock-alert qualification, idempotency keys, confidence, cooldown, message copy |
| `src/domain/community.js` | Community-report intake: validation, rate limit, duplicates, privacy-safe view |
| `src/ingest/runner.js` | Adapter runner: gate, timeout, bounded backoff, circuit breaker, all-or-nothing batch writes |
| `db/migrations/0001_init.sql` | Draft Postgres schema with constraints, append-only observations, synthetic-in-prod guard, RLS |
| `docs/` | Phase 0 audit, source-access matrix |

## Commands
```bash
npm run verify                                       # syntax check + unit tests (no deps)
TEST_DATABASE_URL=postgres://postgres@localhost:5432/scratch npm run test:db   # local throwaway DB only
```
`test:db` refuses any non-local database URL.

## Rules the code enforces
- A retailer adapter runs only if the registry says `VERIFIED`, its env flag is on and no kill switch is engaged.
- A failed fetch writes nothing. A malformed record aborts the whole batch.
- Stale, unverified, pending, synthetic-in-production or duplicate observations never trigger alerts.
- Community reports are never `verified`, never exact, max confidence "medium", always labeled.
- Alert copy never claims reserved or guaranteed stock.
