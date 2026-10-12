# Known limitations and open blockers

Updated 2026-10-12 from the live repository, not from the earlier baseline note.

## Repository state checked

PRs #1 through #4 are merged. An earlier copy of this section named the PR #2 SHA; that note is historical. Read the commit under test with `git rev-parse HEAD` and its Actions run. Do not treat a previous green run as proof for a newer commit.

- `main` was not protected (`protected: false`) when last checked. The ruleset list was empty.
- The token used for that check received HTTP 403 on the branch-protection endpoint, so protection was not changed.

### Branch protection still has to be turned on by an admin

GitHub → Settings → Rules → Rulesets (or Branches) for `VoidcallerOC/stocktracker`:

1. Add a ruleset targeting `main`.
2. Require a pull request before merging.
3. Require the status checks `Syntax + unit tests` and `Database constraint tests`.
4. Do not allow bypass for administrators unless you intend that explicitly.

An admin token can also `PUT /repos/VoidcallerOC/stocktracker/rulesets`. This agent cannot.

## Fixed in the trust-model change

These are fixed in code and covered by unit tests plus disposable Postgres tests. They are not proof that a hosted database matches this migration.

1. **Public observations no longer use a definer view.** `public_observations` is `security_invoker` and `security_barrier`. Anonymous callers get display columns only, under a row-level policy. They cannot insert or change observations through the view. See `docs/TRUST-MODEL.md`.
2. **Retention can delete cached payloads.** `purge_expired_source_data` removes Best Buy rows after 72 hours, including derived quantities and notification rows, and deletes Walmart, Target, and GameStop payloads immediately. Community history is kept. Ordinary users cannot call the purge. Best Buy is still not enabled.
3. **`trustReceiptTime` is wired through freshness, status, deltas, and alerts.** It stays false for Best Buy. Unknown-age rows do not alert. Receipt fallback is labeled as receipt time.
4. **Community reports are compared per reporter.** Disagreement is `conflicting`. The newest report does not win.

## Still open

1. **Freshness windows are provisional.** They are not measured source latencies. `resolveStatus` reports `thresholdsProvisional`.
2. **`alertMessage` returns plain text.** The channel that renders it must escape the product and store names.
3. **The schema has not been applied to a hosted database.** Local `npm run test:db` uses a throwaway Postgres only.
4. **Retailer gates are unchanged.** Walmart is BLOCKED, Target is BLOCKED, GameStop is UNVERIFIED, and Best Buy is PARTIAL. `canRunSource()` denies all four even when their enable flags are set. An enable flag, by itself, is not authorization. See `docs/SOURCE-ACCESS-MATRIX.md`.
5. **No UI, notification delivery, or production deploy.**

## Store directory and sealed catalog

Migration `0003_store_directory_and_catalog.sql` and `docs/DIRECTORY-AND-CATALOG.md` add the claim model and import workflow. They do not add real Connecticut stores or real sealed products. The ZIP check accepts any Connecticut `06xxx` code; that is not statewide coverage. No city has been researched. A directory row is not stock and does not authorize a retailer API.

`0003` does not replace `0002_public_read_and_retention.sql`. Observation reads stay security-invoker, the retention purge stays restricted to its owner and `retention_worker`, and community disagreement stays `conflicting`. Retailer gates are unchanged: Best Buy remains PARTIAL, Walmart and Target remain BLOCKED, and GameStop remains UNVERIFIED. No catalog provider listed in the source-access matrix is enabled for import or redistribution.
