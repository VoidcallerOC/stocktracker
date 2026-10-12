# Trust model

This is the behavior implemented in `src/domain/` and `db/migrations/0002_public_read_and_retention.sql`. It has been exercised against a disposable local Postgres. It has not been applied to a hosted database.

## Public read

`public_observations` is a `security_invoker` / `security_barrier` view. The caller runs the query, so row-level security on `inventory_observations` applies. The old view ran as its owner and bypassed those policies.

`anon` and `authenticated` receive `SELECT` on display columns only. `reporter_id` is not granted and is not in the view. The same predicate, `observation_is_public_row`, is used by the view and by the `SELECT` policy:

- not synthetic
- verified trusted row, or accepted community row
- source `authorization_status` is `VERIFIED` and the kill switch is off
- the source retention rule is not `do_not_retain`, and a `purge_after` row is inside its cache window

The view ends in `OFFSET 0`, so it is not auto-updatable. There is no insert, update, or delete grant and no write policy. A caller cannot file a trusted observation through the view.

`postgres` is a superuser in local tests and still bypasses row-level security. `FORCE ROW LEVEL SECURITY` covers a non-superuser owner. A passing local migration does not prove a hosted project's roles are configured this way.

The view is a row feed. It returns every visible community report. It does not pick a winner. Stock status comes from `resolveStatus`.

## Retention

| Mode | Who | What happens |
|---|---|---|
| `purge_after` | Best Buy, 72 hours from `received_at` | Delete the observation and rows that carry its quantities: stock changes, notification events, delivery attempts, moderation, abuse reports. |
| `do_not_retain` | Walmart, Target, GameStop | Delete any payload on the next purge. Terms are not established. |
| `retain` | Community, synthetic fixtures | Keep the row. Community rows older than the provisional 12-hour display window are marked `expired` and leave the public feed. |

Ordinary `DELETE` still fails. `purge_expired_source_data` is `SECURITY DEFINER`, revoked from `PUBLIC`, and granted to `retention_worker`. The trigger accepts a delete only while the transaction-local purge flag is on and `current_user` is the function owner. An app role with `DELETE`, a permissive delete policy, and the flag set still cannot delete.

The audit row stores source id and counts. It does not store quantities, fingerprints, or moderation text. A second purge is a no-op.

Best Buy's 72-hour figure is the contractual ceiling from its developer terms. It is not permission to call the API. Derived quantities are deleted with the payload. Aggregated history is not kept. The adapter stays disabled.

## Timestamps

`sourceTimestamp` and `receivedAt` stay separate. A source timestamp more than five minutes after receipt is rejected. When a source timestamp exists, freshness uses it, even if receipt fallback is enabled. Receipt time is used only when that source's `trustReceiptTime` is true. The result is labeled `receipt_fallback` and alert copy says the tracker received the row, not that the retailer checked the shelf.

Unknown-age rows do not alert unless that source policy sets `allowUnknownAgeAlerts`. No registered source does.

Best Buy's `trustReceiptTime` remains false until access and policy approval. Wiring the flag does not enable the adapter.

## Community conflicts

For one product at one store, only current (`FRESH` or `AGING`) accepted reports participate.

- The latest report from each reporter replaces that person's earlier report.
- A repeat by the same reporter is one witness.
- `in_stock` and `limited` agree. `out_of_stock` disagrees with both. `uncertain` and `unknown` assert neither.
- Different reporters on opposite sides are `conflicting` / `availability`. The newest report is not chosen.
- Same side with quantity ranges that do not overlap is `conflicting` / `quantity`. Unknown quantity overlaps every range and is not zero.
- When the disagreeing report ages past the provisional community window, the conflict ends and the remaining current report stands.
- Trusted feeds outrank community reports. An unauthorized retailer feed is `blocked` and its availability is not shown.
- A community conflict does not qualify a restock alert and is never labeled retailer-confirmed.

Freshness windows are provisional placeholders. They are not measured retailer latencies.

## Retailer gates

An enable flag is not authorization. A retailer adapter runs only when the registry status is `VERIFIED`, the env flag is on, no kill switch is set, and the policy has a permission reference, `adapterTested`, and `policyApproved`. None of Walmart, Target, GameStop, or Best Buy meet that bar. No retailer HTTP call is part of this change.
