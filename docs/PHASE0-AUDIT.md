# Phase 0: Repository and Project Audit

Date: 2026-10-11

## State found
- **Repo:** `VoidcallerOC/stocktracker` (public). The remote had **no commits and no branches**. The local branch `claude/amazing-hopper-smlxpl` had no commits.
- **Stack, framework, package manager, DB, hosting, deploy workflow:** none present.
- **Vercel:** team `nickhsousa96-8307's projects` has 21 projects. **None is linked to stocktracker.**
- **War Room MASTER.md** (`VoidcallerOC/war-room`, last updated 2026-09-23): no stocktracker entry. Its rule "Product repos stay code-only" is followed: no board content was copied here.
- **Existing TCG website check:**
  - `ForgeCT` is a web-design agency site, not a TCG catalog.
  - `The-Void`, `supersite` and `tcg-buy-calculator` have no Pokémon, One Piece or stock routes, based on a file-name scan.
  - `Thousand-Sunny-` (private; Vercel project `thousand-sunny-cards`) is a **client** card-shop site and was **not inspected**. If it has the `/one-piece-tcg/` route the brief mentions, building into it is Nick's and the client's call. A big-box restock tracker on a card shop's own site would send that shop's customers to competing retailers.

## Decisions taken (reversible)
- Kept this repo standalone and **framework-free for now**. The core is plain ESM JavaScript tested with `node --test`, with zero dependencies, matching the ForgeCT convention.
- Wrote the schema as PostgreSQL 15+ with Supabase-style RLS. A Supabase connector exists in this environment, but **no database was created or touched**. The migration was only tested against a disposable local Postgres 16.

## Open P0–P2 items
| Pri | Item | Owner |
|---|---|---|
| P0 | Choose hosting, DB and auth (proposed: Vercel + Supabase, matching existing infra) | Nick |
| P0 | Best Buy developer key, then the read-only checks in SOURCE-ACCESS-MATRIX.md | Nick |
| P0 | Attorney read of the Best Buy 72-hour cache clause and "public tracker" use | Human attorney |
| P1 | Verified CT store directory (manual entries or OSM/ODbL decision) | Nick |
| P1 | Curated sealed catalog (no third-party images until rights confirmed) | Nick / agent |
| P1 | Community-report API endpoints, moderation queue, auth | Agent, after the P0 stack decision |
| P2 | Notification provider (email first), sandbox delivery test | After stack decision |
| P2 | UI (game selector, search, store views, freshness labels) | After P1 |
