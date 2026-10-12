# Store directory and sealed-product catalog

This is the claim model for Connecticut trading-card locations and for sealed Pokémon TCG and One Piece Card Game products. It is not an inventory feed. A row here does not mean a store has stock, and it does not authorize a retailer API.

No real store and no real product is shipped with the migration. Coverage of Connecticut is not established.

## Verification states

These are the same four words used for source authorization:

| State | Meaning |
|---|---|
| `UNVERIFIED` | A draft claim. It is not public. It must not be described as checked. |
| `PARTIAL` | Some cited evidence exists, and a requirement is still open. It is not public. |
| `VERIFIED` | The claim has a `verified_at` timestamp and a `VERIFIED` evidence row with field scope `record`. Public views can show it. Another field's evidence does not verify the record. |
| `BLOCKED` | A reviewer recorded why the claim must not be used. `reviewNote` is required on import. It is not public. |

Creating a row, passing a test, or seeing a name in a search result does not verify it. Store existence, street address, coordinates, retailer identity, product identity, set name, release date, and each identifier are separate claims.

`review_note` and `record_evidence` are internal. Anonymous and authenticated roles have no grant and no policy that returns evidence rows.

## What a public row can show

`public_directory_stores`, `public_directory_products`, `public_directory_businesses`, `public_store_games`, and `public_product_identifiers` are `security_invoker` views. They return a row only when that row's own verification status is `VERIFIED`, the row is not synthetic, and a store is still `active`. Coordinates are selected only when coordinate verification is `PARTIAL` or `VERIFIED`. Identifiers are selected only when that identifier row is `VERIFIED` and the product is public.

Direct table reads by `anon` use the same predicates. Unverified rows are not returned, so they cannot be labeled verified by a public query.

## Stores

One business can have many locations. Each location is its own `stores` row.

- Chain locations keep `retailer_id` (`walmart`, `target`, `gamestop`, or `bestbuy`). Those ids are a vocabulary. They are not API approval.
- An independent shop uses a `businesses` row with `kind = independent` and a null `retailer_id`.
- The same chain plus the same address and ZIP is one active location. A second street address is a different branch and must not be merged.
- A different retailer at the same address stays a different row.
- Coordinates are optional. The importer accepts them only with `locationSource`, `locationVerifiedAt`, coordinate status `PARTIAL` or `VERIFIED`, and coordinates evidence. Latitude and longitude are both present or both null. Values must fall inside the Connecticut bounds already enforced by the database.
- `official_url` and `public_phone` are accepted only on a `PARTIAL` or `VERIFIED` store, with website or phone evidence.
- `store_game_support` lists games the location is recorded as carrying. An empty set means unknown, not "does not sell the game".
- `store_format` is `big_box`, `specialty_game_store`, `other`, or null when unknown.

The database still accepts a legacy store that already has coordinates and `location_source` with coordinate status `UNVERIFIED`. Those rows are not publicly verified. New imports cannot add that combination.

### Correction and retirement

Do not reuse a location row for a different shop, and do not overwrite a moved shop's address in place.

- Closed: import the same `importKey` with `recordStatus: "retired"` and a `retiredReason`. If the row was `VERIFIED`, set `resolution: "retire"`.
- Relocated: retire the old `importKey` and insert a new `importKey` for the new address. `successorImportKey` can point at the new key.
- Misidentified: set `verificationStatus: "BLOCKED"` with a `reviewNote`, or retire the row with a reason that says it was misidentified. A `VERIFIED` identity change also requires `resolution: "accept_incoming"`.

`app.directory_resolution` must be `accept_incoming` or `retire`, and the database role must own the table. Setting the custom variable as `anon` does not authorize the change. A weaker status, a different verified value, `verified_at`, or `import_key` is a conflict until that resolution is present. `resolution: "retire"` can retire a verified store and set its reason and successor. It cannot rewrite the store's identity. `review_note` can be edited without a resolution. A successor key must name a different active store that already exists in the file or the directory.

## Products

Pokémon and One Piece share one `products` table. Categories already in the schema:

- Pokémon: `booster_pack`, `booster_box`, `elite_trainer_box`, `booster_bundle`, `tin`, `collection`, `other_sealed`
- One Piece: `booster_pack`, `booster_box`, `starter_deck`, `double_pack`, `collection`, `other_sealed`

Gift collections and other sealed collections use `collection` or `other_sealed`. There is no separate gift-collection table.

Identity is game, category, canonical name, language, region, and packaging variant. A Japanese edition is not the English edition. A case pack is not the loose box. The importer does not fuzzy-match names.

- Language is a two-letter lowercase code or null. Null means unknown, not English.
- Region is a two-letter uppercase code or null.
- `setName` and `releaseDate` are stored only with `PARTIAL` or `VERIFIED` and matching evidence (`set_name`, `release_date`).
- `lifecycleStatus` is `active`, `discontinued`, or `unknown`. The default is `unknown`.
- Product images are rejected by the importer. The schema still requires `image_provenance` before any future `image_url`.

### Identifiers

`product_identifiers` may hold `gtin` (UPC/EAN, 8 to 14 digits), `retailer_sku`, `retailer_item_id`, or `publisher_code`. Omit the identifier when it is unknown. An empty string is rejected. A code whose own status is `UNVERIFIED` is rejected rather than stored as if it were a real identifier. Do not copy a code from a similar product, a search snippet, or a naming pattern.

Public identifier rows require `verification_status = VERIFIED` on that identifier.

## Import file

JSON is the full format. Unknown top-level fields are rejected. `fixtureNotice` is allowed so fixtures can label themselves.

```json
{
  "fixtureNotice": "SYNTHETIC TEST FIXTURE. Not a real store or product.",
  "businesses": [],
  "stores": [],
  "products": []
}
```

Each record needs `importKey` matching `^[a-z0-9][a-z0-9-]{0,80}$` and boolean `isSynthetic`. Test fixtures must set `isSynthetic` to true. The database rejects synthetic rows when `app_settings.environment` is `production`.

A `VERIFIED` or `PARTIAL` record needs `verifiedAt` and evidence:

```json
{
  "sourceLabel": "description of the public page or document that was checked",
  "sourceUrl": "https://example.com/page",
  "fieldScope": "record",
  "verificationStatus": "VERIFIED",
  "observedAt": "2026-01-15T00:00:00.000Z",
  "note": "internal note, not shown publicly"
}
```

`fieldScope` is one of `record`, `address`, `coordinates`, `set_name`, `release_date`, `identifier`, `website`, `phone`. A `VERIFIED` or `PARTIAL` record needs `record` evidence. Address evidence may also use `record`. Set name, release date, coordinates, website, phone, and each identifier need their own scope. Identifier evidence sets `claimKey` to that identifier's value. Evidence status cannot outrank the record. `sourceUrl` is optional and, when present, must be `http` or `https`. The importer does not fetch it.

CSV is a flat alternative for drafts and for a single evidence item per row. Identifiers are JSON-only, so a spreadsheet cannot smuggle a code without the evidence object. Headers:

```text
record_type,import_key,display_name,kind,retailer_id,name,address_line,city,state,zip,game,category,canonical_name,language,region,packaging_variant,lifecycle_status,verification_status,verified_at,is_synthetic,review_note,business_import_key,games,record_status,retired_reason,resolution,evidence_source_label,evidence_source_url,evidence_field_scope,evidence_status,evidence_observed_at,evidence_note
```

`games` uses `|` between ids, for example `pokemon|one_piece`. `is_synthetic` is the text `true` or `false`.

## CLI

```bash
npm run import:directory -- --dry-run --input test/fixtures/synthetic-directory.json
npm run import:directory -- --dry-run --database --input file.json
npm run import:directory -- --apply --input file.json
```

`--dry-run` is the default. It does not open a database. It plans against an empty directory, or against `--existing snapshot.json`. Exit `0` when the plan is clean, `2` when a row is rejected or conflicts, `1` on usage errors.

`--dry-run --database` loads the current local database with a read-only snapshot and still does not write. `--apply` loads that snapshot itself, then writes only if the plan is clean.

Apply reads `DIRECTORY_DATABASE_URL` or `TEST_DATABASE_URL`. It refuses any host other than localhost and any URL that mentions Supabase, Neon, Render, or Vercel. The write is one `begin` / `commit` script. A conflict or a rejected row aborts before that script is built. Importing the same clean file again reports `unchanged` and does not insert a second copy.

`test/fixtures/synthetic-directory.json` is synthetic. The names are prefixed `TEST Synthetic` and the street is `Fixture Lane`. It is not a list of Connecticut shops.

## Source and licensing

Do not import API TCG, Scrydex, pokemontcg.io, retailer product pages, or official site dumps through this tool. Their statuses are in `docs/SOURCE-ACCESS-MATRIX.md`: API TCG is `UNVERIFIED` with no license, Scrydex forbids redistribution without written authorization, and the official Pokémon and One Piece pages are manual references rather than a database feed. GS1 is a manual check for a code you already have, not a catalog download.

No third-party catalog provider is enabled. No retailer adapter is enabled. Best Buy stays `PARTIAL`, Walmart stays `BLOCKED`, Target stays `BLOCKED`, and GameStop stays `UNVERIFIED`.

OpenStreetMap is not seeded here. Using it later requires ODbL attribution and share-alike, recorded on the evidence row, and still does not verify a shop by itself.

## Coverage

The schema accepts every Connecticut ZIP (`06xxx`) and rejects other states. That constraint is statewide. The table contents are not. There is no researched store in any Connecticut city, including Hartford. There is no researched sealed product. Until a person checks a public source and records the evidence fields, the directory is empty of real rows.
