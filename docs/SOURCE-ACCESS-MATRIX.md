# Source-Access Matrix (Phase 1)

Checked: 2026-10-11, from official documentation and terms pages only. **No credentials are held and no live API call has been made to any retailer.** For that reason, no automated retailer source is VERIFIED.

Status key: **VERIFIED**: permission and a working, authorized data path have both been demonstrated. **PARTIAL**: some capability is documented, but key requirements are unresolved. **BLOCKED**: access is unavailable or needs an approval we don't have. **UNVERIFIED**: not enough evidence either way.

A documented API is not the same as granted access. An HTTP 200 is not permission to redistribute.

## Retailer inventory

| Retailer | Official path | Store-level data | Quantity | Timestamps | Auth / eligibility | Key terms | Status | Go / no-go |
|---|---|---|---|---|---|---|---|---|
| **Best Buy** | Developer API: [docs](https://bestbuyapis.github.io/api-documentation/), [terms](https://developer.bestbuy.com/legal) | Yes. `GET /v1/products/{sku}/stores.json?postalCode=…` returns only the stores that have the SKU in stock ("Stores not returned do not have that product in stock"). Fields include `storeID`, address and a `lowStock` boolean. The Stores API returns CT store IDs, addresses and lat/lng. | **No.** In-stock status plus `lowStock` only | No per-store timestamp. Docs describe "near real time." | Free developer key (`apiKey`). Not confirmed whether new signups are open. | Must attribute Best Buy. **No caching beyond 72 hours.** Must offer purchase on Best Buy. License is revocable and may be terminated without notice. 50,000 calls/day, 5 calls/s. One SKU per availability call. | **PARTIAL** | **Conditional GO**: get a key, run a read-only check, get counsel's sign-off on the 72-hour cache limit and on use by a public tracker. |
| **Walmart** | Affiliate API: [stores](https://walmart.io/apidocs/affiliates/stores), [product lookup](https://walmart.io/apidocs/affiliates/product-lookup) | The stores endpoint is a locator only. Product Lookup takes `storeId` with the note "Usage needs additional approvals from business team." | No. `stock` is "Available" or "Not available" only | None documented | Walmart.com login, an app, and an RSA key. Store-level use needs extra business approval. Whether Impact affiliate membership is required: not confirmed. | The API terms page did not render, so terms are **not confirmed**. Site terms ban scraping and "data mining, robots." | **BLOCKED** (store level) | **NO-GO** until Walmart grants the storeId approval in writing |
| **Target** | None found ([developer.target.com](https://developer.target.com/) is a JS app; its content could not be read) | No authorized path found. Partners, Roundel and Plus are seller or vendor programs. The "RedSky" endpoints are unofficial and are **not** authorization. | n/a | n/a | n/a | [Site terms](https://www.target.com/c/terms-conditions/-/N-4sr7l) prohibit "data extraction, scraping, mining," and non-approved agents. Use is noncommercial only. | **BLOCKED** | **NO-GO**. Community reports only. |
| **GameStop** | None found. The terms page, robots.txt and the affiliates page all returned 403. The developer subdomain returned 502. | No evidence | n/a | n/a | Affiliate program reportedly on Rakuten, from non-official sources only | Could not read the terms | **UNVERIFIED** | **NO-GO**. Community reports only. Re-check the terms by hand. |

### Launch coverage
- **Automated at launch: none.** Best Buy is the only candidate, and only after the key and legal review below.
- **Community reports / manual verification at launch:** Walmart, Target, GameStop and Best Buy (all four).

### Best Buy: what remains before it can be upgraded to VERIFIED
1. Nick signs up at developer.bestbuy.com and stores the key only as a server env var `BESTBUY_API_KEY`.
2. Run read-only checks:
   - `GET https://api.bestbuy.com/v1/stores(region=CT)?format=json&show=storeId,name,city&apiKey=$BESTBUY_API_KEY`
   - `GET https://api.bestbuy.com/v1/products/{SKU}/stores.json?postalCode=06103&apiKey=$BESTBUY_API_KEY`, then filter to `state=CT`. The postal-code search covers a 250-mile radius.
3. **Counsel review.** The 72-hour cache clause conflicts with keeping long-term "stock history" built from Best Buy content. The proposed handling is to purge or aggregate Best Buy observations after 72 hours (`maxRetentionMs` in `src/domain/sources.js`). Whether even aggregated history is allowed needs a human attorney's reading.
4. **Policy decision.** The docs say a store's absence from the response means "not in stock," so recording `out_of_stock` for absent CT stores is documented behavior. Because the API returns no per-store timestamp, freshness must be set to `trustReceiptTime` for this source only. Approve both before enabling.
5. Then flip `authorizationStatus` to `VERIFIED` in code, with a link to the evidence.

## Product catalog

| Source | Sealed coverage | UPC | Auth / cost | Terms / images | Status | Go / no-go |
|---|---|---|---|---|---|---|
| [API TCG](https://docs.apitcg.com/) | Pokémon and One Piece; `type=sealed` exists. `sealed_type` is "not in use." | No | Free key, `x-api-key`. Numeric limits not published. | **No published terms or license** (the terms page returns 404) | UNVERIFIED | Prototype only. Production needs written terms and image rights from support@apitcg.com. |
| [Pokémon TCG API](https://docs.pokemontcg.io/) | Cards only | No | **Deprecated.** Signups closed, keys stop working 2027-03-01. | n/a | BLOCKED | NO-GO |
| [Scrydex](https://scrydex.com/docs/pokemon/sealed) (pokemontcg.io successor) | `/pokemon/v1/sealed` and `/onepiece/v1/sealed` (One Piece is beta) | No | Paid: $29/mo (5,000 credits), $99 (50,000), $399 (250,000) | Must not "redistribute… or commercially exploit… without prior written authorization." Image copyright is not cleared. | PARTIAL | Conditional GO with written authorization |
| [One Piece official products](https://en.onepiece-cardgame.com/products/) | Official list, no API | No | n/a | "may not be reproduced without permission" | n/a | Manual fact-checking reference only |
| [pokemon.com](https://www.pokemon.com/us/terms-of-use) | Product pages | No | n/a | Personal, noncommercial use; no bots or database building | n/a | Manual fact-checking reference only |
| [Verified by GS1](https://www.gs1.org/services/verified-by-gs1) | Verifies a GTIN you already have | Yes (verify only) | Free, 30 queries/day | GS1 US bulk/API terms not found | PARTIAL | GO for checking UPCs one at a time by hand |

**Catalog recommendation:** start with a curated, hand-verified sealed catalog. Each product records its official reference URL and a `verified_at` date. Leave UPCs empty until verified through GS1 or an authorized retailer response. Use **no third-party product images** until image rights are confirmed in writing (the schema requires `image_provenance` whenever `image_url` is set).

## Connecticut store directory

| Retailer | Source | Status |
|---|---|---|
| Best Buy | Stores API (once the key exists). Subject to the 72-hour cache clause, so refresh periodically. | PARTIAL |
| Walmart, Target, GameStop | No official API. Site terms prohibit automated extraction. **Options:** (a) enter each store by hand, checked against the retailer's own store-locator page, recording the source URL and verified date; or (b) use OpenStreetMap under ODbL, which requires "© OpenStreetMap contributors" attribution and makes the published directory share-alike. | UNVERIFIED (no rows yet) |

No store rows have been created. Nothing is seeded. The schema rejects non-CT ZIP codes and coordinates.

## Product-identifier mapping strategy
- Internal UUID per product; game and category are validated per game.
- `product_identifiers` holds explicit typed mappings: `gtin`, `retailer_sku` (Best Buy SKU), `retailer_item_id` (Walmart item, Target TCIN, GameStop SKU) and `publisher_code` (for example, an OP set code). Each mapping has `verified_at` and `verification_source`.
- A mapping is unique per (type, retailer, value). A product can be missing a UPC.
- Products are never merged on name similarity. Merges are a manual, audited action.

## Operating cost (verified figures only)
- Best Buy API: free key; limit 50,000 calls/day. One SKU per availability call, so 50 SKUs every 15 minutes is 4,800 calls/day.
- Scrydex (if chosen): $29–$399/month, from its pricing page.
- Hosting, DB and notification provider: **not chosen**, so no cost is claimed. Nick's existing Vercel team and Supabase connector are available but untested for this project.

## Things we will not do
Scrape retailer sites, call unofficial or private endpoints (for example RedSky), bypass CAPTCHAs, bot checks or rate limits, or automate carts or checkout.
