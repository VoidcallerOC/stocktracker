// Runs the SQL constraint tests against a THROWAWAY Postgres database.
// Usage: TEST_DATABASE_URL=postgres://... npm run test:db
// Refuses hosted databases so it can never touch a real project by accident.
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

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

psql(["-c", "drop schema if exists public cascade; create schema public; drop schema if exists auth cascade;"]);

const migrations = readdirSync("db/migrations").filter((name) => name.endsWith(".sql")).sort();
const files = ["test/db/00_supabase_stub.sql", ...migrations.map((name) => `db/migrations/${name}`), "test/db/constraints.test.sql", "test/db/catalog.test.sql"];
psql(files.flatMap((file) => ["-f", file]));

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
runNode(["scripts/import-directory.mjs", "--apply", "--input", "test/fixtures/conflict-accept.json"], 0);
const accepted = scalar("select canonical_name from products where import_key = 'test-lock-product'");
if (accepted !== "TEST Synthetic Locked Tin Accepted") {
  console.error(`explicit resolution did not apply, name is ${accepted}`);
  process.exit(1);
}

console.log("directory import checks passed");
