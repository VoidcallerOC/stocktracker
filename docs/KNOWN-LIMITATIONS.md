# Known Limitations and Open Blockers

Recorded from the PR #1 review on 2026-10-11. None of these is fixed yet. Each fix must be scoped, tested and reviewed in its own PR.

## Must be resolved before Best Buy can be VERIFIED
1. **The 72-hour retention rule conflicts with append-only observations.** Best Buy's API terms forbid caching content for more than 72 hours. But the `obs_guard` trigger in `db/migrations/0001_init.sql` blocks every `DELETE` on `inventory_observations`, so Best Buy rows can never be purged. We need a retention mechanism first, for example a separate table that expires, or a privileged purge path that is audited.
2. **`trustReceiptTime` is not wired through.** `status.js`, `alerts.js` and `deltas.js` call `classifyFreshness` without passing a source config. Best Buy returns no timestamp per store, so its observations would stay `UNKNOWN` and never alert. That fails safe, but it must be wired up and tested before Best Buy is enabled.

## Other open items
3. **Community reports aren't compared to each other.** `latestPerSource` groups every community report under one source. If two reporters disagree, the result isn't marked `conflicting`; the newest accepted report wins.
4. **`public_observations` is a definer-rights view** (`security_invoker = false`). It bypasses RLS on purpose so it can hide `reporter_id`. The Supabase advisor will flag it, and it has no grants to `anon` yet.
5. **Freshness thresholds are placeholders.** They are not based on measured source latency.
6. **`alertMessage` returns plain text.** Escaping must happen in whichever channel renders it.
7. **The schema is a draft.** It has not been applied to any real database.

## Retailer gates (unchanged)
Walmart is BLOCKED, Target is BLOCKED, GameStop is UNVERIFIED and Best Buy is PARTIAL. `canRunSource()` denies all four even when their enable flags are set. Holding an API key does not make a source VERIFIED. See `docs/SOURCE-ACCESS-MATRIX.md`.
