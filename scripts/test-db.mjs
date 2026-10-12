// Runs the SQL constraint tests against a THROWAWAY Postgres database.
// Usage: TEST_DATABASE_URL=postgres://... npm run test:db
// Refuses hosted databases so it can never touch a real project by accident.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("TEST_DATABASE_URL is not set; skipping (needs a disposable local Postgres 15+).");
  process.exit(1);
}
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "::1", ""].includes(host) || /supabase|neon|render|vercel/i.test(url)) {
  console.error("Refusing to run destructive DB tests against a non-local database.");
  process.exit(1);
}
// The SQL files create schemas from scratch. Reset the disposable database first so a
// local rerun does not collide with the previous migration. Remote URLs are refused above.
// Migrations run in filename order, so 0002 public-read/retention applies before 0003.

function psql(args) {
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", ...args], { stdio: "inherit" });
}

function scalar(query) {
  return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-At", "-c", query], { encoding: "utf8" }).trim();
}

function runNode(args, expectCode) {
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== expectCode) {
    console.error(`expected exit ${expectCode}, got ${result.status} for: node ${args.join(" ")}`);
    process.exit(1);
  }
}

function applyJson(document, expectCode) {
  const dir = mkdtempSync(join(tmpdir(), "directory-audit-"));
  const path = join(dir, "input.json");
  writeFileSync(path, JSON.stringify(document));
  runNode(["scripts/import-directory.mjs", "--apply", "--input", path], expectCode);
}

// Upgrade rehearsal: 0001 allowed set_name and official_url with no verification
// column. 0003 must install on that data, keep the text internal, and leave it unverified.
psql(["-c", "drop schema if exists public cascade; create schema public; drop schema if exists auth cascade;"]);
psql(["-f", "test/db/00_supabase_stub.sql", "-f", "db/migrations/0001_init.sql", "-f", "db/migrations/0002_public_read_and_retention.sql"]);
psql(["-c", `
insert into games values ('pokemon','Pokémon TCG'), ('one_piece','One Piece Card Game');
insert into retailers (id, display_name) values ('bestbuy','Best Buy');
insert into products (game_id, canonical_name, category, set_name)
values ('pokemon', 'UPGRADE PROBE TIN', 'tin', 'UPGRADE PROBE SET');
insert into stores (
  retailer_id, name, address_line, city, zip, latitude, longitude, official_url, location_source, location_verified_at
) values (
  'bestbuy', 'UPGRADE PROBE STORE', '1 Fixture Lane', 'Fixtureville', '06001',
  41.70, -72.80, 'https://example.invalid/upgrade-probe', 'upgrade probe', now()
);
`]);
psql(["-f", "db/migrations/0003_store_directory_and_catalog.sql"]);
if (scalar("select coalesce(set_name, '') from products where canonical_name = 'UPGRADE PROBE TIN'") !== "") {
  console.error("legacy set_name stayed on an unverified product");
  process.exit(1);
}
if (!scalar("select review_note from products where canonical_name = 'UPGRADE PROBE TIN'").includes("UPGRADE PROBE SET")) {
  console.error("legacy set_name was not kept on the internal review note");
  process.exit(1);
}
if (scalar("select verification_status from products where canonical_name = 'UPGRADE PROBE TIN'") !== "UNVERIFIED") {
  console.error("legacy product was marked verified by 0003");
  process.exit(1);
}
if (scalar("select coalesce(official_url, '') from stores where name = 'UPGRADE PROBE STORE'") !== "") {
  console.error("legacy official_url stayed on an unverified store");
  process.exit(1);
}
if (!scalar("select review_note from stores where name = 'UPGRADE PROBE STORE'").includes("example.invalid/upgrade-probe")) {
  console.error("legacy official_url was not kept on the internal review note");
  process.exit(1);
}
psql(["-c", `
set role anon;
do $$ begin
  if (select count(*) from stores) <> 0 or (select count(*) from products) <> 0 then
    raise exception 'anon can read an unverified legacy directory row';
  end if;
end $$;
`]);
console.log("migration upgrade rehearsal passed");

psql(["-c", "drop schema if exists public cascade; create schema public; drop schema if exists auth cascade;"]);

const migrations = readdirSync("db/migrations").filter((name) => name.endsWith(".sql")).sort();
psql(["-f", "test/db/00_supabase_stub.sql", ...migrations.flatMap((name) => ["-f", `db/migrations/${name}`])]);
for (const table of ["stores", "products", "businesses", "product_identifiers", "record_evidence"]) {
  if (scalar(`select count(*) from ${table}`) !== "0") {
    console.error(`${table} was not empty after migrations`);
    process.exit(1);
  }
}
psql(["-f", "test/db/constraints.test.sql", "-f", "test/db/catalog.test.sql", "-f", "test/db/directory-integrity.test.sql"]);

const storesBefore = scalar("select count(*) from stores");
const evidenceBefore = scalar("select count(*) from record_evidence");
runNode([
  "scripts/import-directory.mjs", "--dry-run", "--input", "test/fixtures/synthetic-directory.json",
], 0);
if (scalar("select count(*) from stores") !== storesBefore || scalar("select count(*) from record_evidence") !== evidenceBefore) {
  console.error("dry-run changed directory tables");
  process.exit(1);
}

runNode([
  "scripts/import-directory.mjs", "--dry-run", "--database", "--input", "test/fixtures/synthetic-directory.json",
], 0);
if (scalar("select count(*) from stores") !== storesBefore) {
  console.error("database dry-run changed stores");
  process.exit(1);
}

runNode(["scripts/import-directory.mjs", "--apply", "--input", "test/fixtures/synthetic-directory.json"], 0);
const imported = scalar("select count(*) from stores where import_key like 'test-synthetic-%'");
if (imported !== "2") {
  console.error(`expected 2 synthetic fixture stores, found ${imported}`);
  process.exit(1);
}
const productsImported = scalar("select count(*) from products where import_key like 'test-synthetic-%'");
if (productsImported !== "2") {
  console.error(`expected 2 synthetic fixture products, found ${productsImported}`);
  process.exit(1);
}
runNode(["scripts/import-directory.mjs", "--apply", "--input", "test/fixtures/synthetic-directory.json"], 0);
if (scalar("select count(*) from stores where import_key like 'test-synthetic-%'") !== imported) {
  console.error("repeat import was not idempotent");
  process.exit(1);
}

const locked = scalar("select canonical_name from products where import_key = 'test-lock-product'");
runNode(["scripts/import-directory.mjs", "--apply", "--input", "test/fixtures/conflict-unresolved.json"], 2);
if (scalar("select canonical_name from products where import_key = 'test-lock-product'") !== locked) {
  console.error("conflicting apply overwrote a verified product");
  process.exit(1);
}
if (scalar("select count(*) from stores where import_key = 'test-conflict-sibling'") !== "0") {
  console.error("conflicting apply inserted an unrelated store");
  process.exit(1);
}
runNode(["scripts/import-directory.mjs", "--apply", "--input", "test/fixtures/conflict-accept.json"], 0);
const accepted = scalar("select canonical_name from products where import_key = 'test-lock-product'");
if (accepted !== "TEST Synthetic Locked Tin Accepted") {
  console.error(`explicit resolution did not apply, name is ${accepted}`);
  process.exit(1);
}

const observed = "2026-03-01T00:00:00.000Z";
const recordEvidence = {
  sourceLabel: "synthetic audit fixture",
  fieldScope: "record",
  verificationStatus: "VERIFIED",
  observedAt: observed,
};
applyJson({
  fixtureNotice: "SYNTHETIC TEST FIXTURE. Not a real product.",
  products: [{
    importKey: "test-evidence-idem",
    game: "pokemon",
    category: "tin",
    canonicalName: "TEST Synthetic Evidence Tin",
    language: "en",
    region: "US",
    lifecycleStatus: "unknown",
    verificationStatus: "VERIFIED",
    verifiedAt: observed,
    isSynthetic: true,
    evidence: [recordEvidence],
    identifiers: [],
  }],
}, 0);
const evidenceCount = () => scalar("select count(*) from record_evidence e join products p on p.id = e.subject_id where p.import_key = 'test-evidence-idem'");
if (evidenceCount() !== "1") {
  console.error("verified import did not record one evidence row");
  process.exit(1);
}
applyJson({
  fixtureNotice: "SYNTHETIC TEST FIXTURE. Not a real product.",
  products: [{
    importKey: "test-evidence-idem",
    game: "pokemon",
    category: "tin",
    canonicalName: "TEST Synthetic Evidence Tin",
    language: "en",
    region: "US",
    lifecycleStatus: "unknown",
    verificationStatus: "VERIFIED",
    verifiedAt: observed,
    isSynthetic: true,
    reviewNote: "internal repeat",
    evidence: [recordEvidence],
    identifiers: [],
  }],
}, 0);
if (evidenceCount() !== "1") {
  console.error("repeat import duplicated evidence");
  process.exit(1);
}
const addedEvidence = {
  sourceLabel: "synthetic audit fixture addition",
  fieldScope: "record",
  verificationStatus: "VERIFIED",
  observedAt: observed,
};
applyJson({
  fixtureNotice: "SYNTHETIC TEST FIXTURE. Not a real product.",
  products: [{
    importKey: "test-evidence-idem",
    game: "pokemon",
    category: "tin",
    canonicalName: "TEST Synthetic Evidence Tin",
    language: "en",
    region: "US",
    lifecycleStatus: "unknown",
    verificationStatus: "VERIFIED",
    verifiedAt: observed,
    isSynthetic: true,
    reviewNote: "internal repeat",
    evidence: [recordEvidence, addedEvidence],
    identifiers: [],
  }],
}, 0);
if (evidenceCount() !== "2") {
  console.error("new evidence was not recorded");
  process.exit(1);
}
applyJson({
  fixtureNotice: "SYNTHETIC TEST FIXTURE. Not a real product.",
  products: [{
    importKey: "test-evidence-idem",
    game: "pokemon",
    category: "tin",
    canonicalName: "TEST Synthetic Evidence Tin",
    language: "en",
    region: "US",
    lifecycleStatus: "unknown",
    verificationStatus: "VERIFIED",
    verifiedAt: observed,
    isSynthetic: true,
    reviewNote: "internal repeat",
    evidence: [recordEvidence],
    identifiers: [],
  }],
}, 0);
if (evidenceCount() !== "2") {
  console.error("omitted evidence was deleted");
  process.exit(1);
}

applyJson({
  fixtureNotice: "SYNTHETIC TEST FIXTURE. Not a real store.",
  stores: [{
    importKey: "test-games-sync",
    retailerId: "bestbuy",
    name: "TEST Synthetic Games Store",
    addressLine: "50 Fixture Lane",
    city: "Fixtureville",
    state: "CT",
    zip: "06050",
    verificationStatus: "UNVERIFIED",
    isSynthetic: true,
    games: ["pokemon", "one_piece"],
    evidence: [],
  }],
}, 0);
const gameCount = () => scalar("select count(*) from store_game_support g join stores s on s.id = g.store_id where s.import_key = 'test-games-sync'");
if (gameCount() !== "2") {
  console.error("store game support was not recorded");
  process.exit(1);
}
applyJson({
  fixtureNotice: "SYNTHETIC TEST FIXTURE. Not a real store.",
  stores: [{
    importKey: "test-games-sync",
    retailerId: "bestbuy",
    name: "TEST Synthetic Games Store",
    addressLine: "50 Fixture Lane",
    city: "Fixtureville",
    state: "CT",
    zip: "06050",
    verificationStatus: "UNVERIFIED",
    isSynthetic: true,
    games: ["pokemon"],
    evidence: [],
  }],
}, 0);
if (gameCount() !== "1") {
  console.error(`store game support was not kept consistent, count ${gameCount()}`);
  process.exit(1);
}

applyJson({
  fixtureNotice: "SYNTHETIC TEST FIXTURE. Not a real product.",
  products: [{
    importKey: "test-quote-product",
    game: "pokemon",
    category: "tin",
    canonicalName: "TEST Synthetic O'Brien Tin",
    verificationStatus: "UNVERIFIED",
    isSynthetic: true,
    evidence: [],
    identifiers: [],
  }],
}, 0);
if (scalar("select canonical_name from products where import_key = 'test-quote-product'") !== "TEST Synthetic O'Brien Tin") {
  console.error("quoted product name was not stored safely");
  process.exit(1);
}

const codeEvidence = {
  sourceLabel: "synthetic code fixture",
  fieldScope: "identifier",
  claimKey: "5901234123457",
  verificationStatus: "VERIFIED",
  observedAt: observed,
};
applyJson({
  fixtureNotice: "SYNTHETIC TEST FIXTURE. Not a real product.",
  products: [{
    importKey: "test-code-owner",
    game: "pokemon",
    category: "tin",
    canonicalName: "TEST Synthetic Code Owner",
    verificationStatus: "VERIFIED",
    verifiedAt: observed,
    isSynthetic: true,
    evidence: [recordEvidence, codeEvidence],
    identifiers: [{ idType: "gtin", value: "5901234123457", verificationStatus: "VERIFIED", verifiedAt: observed }],
  }],
}, 0);
applyJson({
  fixtureNotice: "SYNTHETIC TEST FIXTURE. Not a real product.",
  products: [{
    importKey: "test-code-other",
    game: "pokemon",
    category: "booster_box",
    canonicalName: "TEST Synthetic Code Other",
    verificationStatus: "VERIFIED",
    verifiedAt: observed,
    isSynthetic: true,
    evidence: [recordEvidence, codeEvidence],
    identifiers: [{ idType: "gtin", value: "5901234123457", verificationStatus: "VERIFIED", verifiedAt: observed }],
  }],
}, 2);
if (scalar("select count(*) from products where import_key = 'test-code-other'") !== "0") {
  console.error("identifier conflict inserted the other product");
  process.exit(1);
}

const rollbackPath = join(tmpdir(), "directory-rollback.sql");
writeFileSync(rollbackPath, `begin;
insert into products (game_id, canonical_name, category, is_synthetic)
values ('pokemon', 'TEST Synthetic Rollback Tin', 'tin', true);
select 1/0;
commit;
`);
const failed = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", rollbackPath], { encoding: "utf8" });
if (failed.status === 0) {
  console.error("rollback probe should have failed");
  process.exit(1);
}
if (scalar("select count(*) from products where canonical_name = 'TEST Synthetic Rollback Tin'") !== "0") {
  console.error("failed transaction left a partial product");
  process.exit(1);
}

console.log("directory import checks passed");
