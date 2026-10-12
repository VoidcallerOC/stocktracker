// Import verified directory and catalog records.
// Default is dry-run and does not open a database.
//   node scripts/import-directory.mjs --dry-run --input file.json
//   node scripts/import-directory.mjs --dry-run --database --input file.json
//   node scripts/import-directory.mjs --apply --input file.json
// Apply reads TEST_DATABASE_URL or DIRECTORY_DATABASE_URL, plans, and writes
// only when every row is valid and no verified conflict remains.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderApplySql } from "../src/import/apply-sql.js";
import { csvToDirectory, planImport } from "../src/import/plan.js";
import { normTime } from "../src/domain/directory.js";

const SNAPSHOT_SQL = `
select json_build_object(
  'businesses', coalesce((
    select json_agg(json_build_object(
      'id', id, 'importKey', import_key, 'displayName', display_name, 'kind', kind,
      'retailerId', retailer_id, 'publicWebsite', public_website,
      'verificationStatus', verification_status, 'verifiedAt', verified_at,
      'reviewNote', review_note, 'isSynthetic', is_synthetic
    )) from businesses), '[]'::json),
  'stores', coalesce((
    select json_agg(json_build_object(
      'id', s.id, 'importKey', s.import_key, 'businessImportKey', b.import_key,
      'retailerId', s.retailer_id, 'externalStoreId', s.external_store_id,
      'name', s.name, 'addressLine', s.address_line, 'city', s.city, 'state', s.state, 'zip', s.zip,
      'latitude', s.latitude, 'longitude', s.longitude, 'locationSource', s.location_source,
      'locationVerifiedAt', s.location_verified_at, 'officialUrl', s.official_url,
      'publicPhone', s.public_phone, 'addressVerificationStatus', s.address_verification_status,
      'coordinateVerificationStatus', s.coordinate_verification_status, 'storeFormat', s.store_format,
      'verificationStatus', s.verification_status, 'verifiedAt', s.verified_at,
      'recordStatus', s.record_status, 'retiredReason', s.retired_reason,
      'successorImportKey', succ.import_key, 'reviewNote', s.review_note, 'isSynthetic', s.is_synthetic,
      'games', coalesce((select json_agg(g.game_id order by g.game_id) from store_game_support g where g.store_id = s.id), '[]'::json)
    ))
    from stores s
    left join businesses b on b.id = s.business_id
    left join stores succ on succ.id = s.successor_store_id), '[]'::json),
  'products', coalesce((
    select json_agg(json_build_object(
      'id', p.id, 'importKey', p.import_key, 'game', p.game_id, 'category', p.category,
      'canonicalName', p.canonical_name, 'setName', p.set_name, 'language', p.language,
      'region', p.region, 'packagingVariant', p.packaging_variant, 'releaseDate', p.release_date,
      'lifecycleStatus', p.lifecycle_status, 'verificationStatus', p.verification_status,
      'verifiedAt', p.verified_at, 'officialReferenceUrl', p.official_reference_url,
      'reviewNote', p.review_note, 'isSynthetic', p.is_synthetic,
      'identifiers', coalesce((
        select json_agg(json_build_object(
          'idType', i.id_type, 'retailerId', i.retailer_id, 'value', i.value,
          'verificationStatus', i.verification_status, 'verifiedAt', i.verified_at,
          'verificationSource', i.verification_source
        )) from product_identifiers i where i.product_id = p.id), '[]'::json)
    )) from products p), '[]'::json)
)::text;
`;

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function databaseUrl() {
  return process.env.DIRECTORY_DATABASE_URL || process.env.TEST_DATABASE_URL || "";
}

function assertLocal(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(host) || /supabase|neon|render|vercel/i.test(url)) {
    console.error("Refusing to use a non-local database URL for directory import.");
    process.exit(1);
  }
}

function readInput(path) {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".csv")) return csvToDirectory(text);
  return JSON.parse(text);
}

function hydrate(existing) {
  const stamp = (row, field) => {
    if (row[field] != null) row[field] = normTime(row[field]);
  };
  for (const row of existing.businesses ?? []) stamp(row, "verifiedAt");
  for (const row of existing.stores ?? []) {
    stamp(row, "verifiedAt");
    stamp(row, "locationVerifiedAt");
    if (row.latitude != null) row.latitude = Number(row.latitude);
    if (row.longitude != null) row.longitude = Number(row.longitude);
    row.games ??= [];
  }
  for (const row of existing.products ?? []) {
    stamp(row, "verifiedAt");
    if (row.releaseDate != null) row.releaseDate = String(row.releaseDate).slice(0, 10);
    row.identifiers ??= [];
    for (const identifier of row.identifiers) stamp(identifier, "verifiedAt");
  }
  return existing;
}

function loadDatabase(url) {
  assertLocal(url);
  const json = execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-At", "-c", SNAPSHOT_SQL], {
    encoding: "utf8",
  });
  return hydrate(JSON.parse(json));
}

function report(mode, plan) {
  const body = {
    mode,
    ok: plan.ok,
    summary: plan.summary,
    rejected: plan.rejected,
    conflicts: plan.conflicts,
    actions: plan.actions.map((action) => ({
      kind: action.kind,
      op: action.op,
      importKey: action.importKey,
      resolution: action.resolution,
    })),
  };
  console.log(JSON.stringify(body, null, 2));
  return body;
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: node scripts/import-directory.mjs [--dry-run | --apply] [--database] [--existing file] --input file.json|file.csv");
  process.exit(0);
}
const apply = argv.includes("--apply");
const dryRun = argv.includes("--dry-run") || !apply;
if (apply && argv.includes("--dry-run")) {
  console.error("Choose either --dry-run or --apply.");
  process.exit(1);
}
const inputPath = argValue(argv, "--input");
if (!inputPath) {
  console.error("--input is required");
  process.exit(1);
}
const existingPath = argValue(argv, "--existing");
let existing = { businesses: [], stores: [], products: [] };
if (existingPath) existing = hydrate(JSON.parse(readFileSync(existingPath, "utf8")));
if (argv.includes("--database")) {
  const url = databaseUrl();
  if (!url) {
    console.error("TEST_DATABASE_URL or DIRECTORY_DATABASE_URL is required with --database");
    process.exit(1);
  }
  existing = loadDatabase(url);
}

const plan = planImport(readInput(inputPath), existing);
if (dryRun) {
  const body = report("dry-run", plan);
  process.exit(body.ok ? 0 : 2);
}

const url = databaseUrl();
if (!url) {
  console.error("TEST_DATABASE_URL or DIRECTORY_DATABASE_URL is required for --apply");
  process.exit(1);
}
assertLocal(url);
const live = existingPath || argv.includes("--database") ? existing : loadDatabase(url);
const livePlan = existingPath || argv.includes("--database") ? plan : planImport(readInput(inputPath), live);
const body = report("apply", livePlan);
if (!livePlan.ok) process.exit(2);

const dir = mkdtempSync(join(tmpdir(), "directory-import-"));
const sqlPath = join(dir, "apply.sql");
try {
  writeFileSync(sqlPath, renderApplySql(livePlan));
  const applied = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", sqlPath], { encoding: "utf8" });
  if (applied.stdout) process.stdout.write(applied.stdout);
  if (applied.stderr) process.stderr.write(applied.stderr);
  if (applied.status !== 0) process.exit(applied.status ?? 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ applied: true, summary: body.summary }));
