import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { SOURCE_REGISTRY } from "../src/domain/sources.js";
import { renderApplySql } from "../src/import/apply-sql.js";
import { csvToDirectory, planImport } from "../src/import/plan.js";

const observed = "2026-02-01T00:00:00.000Z";

function evidence(overrides = {}) {
  return {
    sourceLabel: "synthetic unit fixture",
    fieldScope: "record",
    verificationStatus: "VERIFIED",
    observedAt: observed,
    ...overrides,
  };
}

function product(overrides = {}) {
  return {
    importKey: "test-unit-product",
    game: "pokemon",
    category: "booster_box",
    canonicalName: "TEST Synthetic Unit Box",
    language: "en",
    region: "US",
    lifecycleStatus: "unknown",
    verificationStatus: "UNVERIFIED",
    isSynthetic: true,
    identifiers: [],
    evidence: [],
    ...overrides,
  };
}

function store(overrides = {}) {
  return {
    importKey: "test-unit-store",
    businessImportKey: "test-unit-banner",
    retailerId: "bestbuy",
    name: "TEST Synthetic Unit North",
    addressLine: "10 Fixture Lane",
    city: "Fixtureville",
    state: "CT",
    zip: "06010",
    addressVerificationStatus: "UNVERIFIED",
    coordinateVerificationStatus: "UNVERIFIED",
    verificationStatus: "UNVERIFIED",
    recordStatus: "active",
    isSynthetic: true,
    games: ["pokemon"],
    evidence: [],
    ...overrides,
  };
}

const banner = {
  importKey: "test-unit-banner",
  displayName: "TEST Synthetic Unit Banner",
  kind: "chain_banner",
  retailerId: "bestbuy",
  verificationStatus: "UNVERIFIED",
  isSynthetic: true,
  evidence: [],
};

test("unknown identifiers stay absent and empty or unverified codes are rejected", () => {
  const omitted = planImport({ products: [product()] });
  assert.equal(omitted.ok, true);
  assert.deepEqual(omitted.actions[0].row.identifiers, []);

  const empty = planImport({
    products: [product({ identifiers: [{ idType: "gtin", value: "", verificationStatus: "VERIFIED", verifiedAt: observed }] })],
  });
  assert.equal(empty.summary.rejected, 1);
  assert.equal(empty.summary.inserts, 0);

  const unverifiedCode = planImport({
    products: [product({
      identifiers: [{ idType: "gtin", value: "12345670", verificationStatus: "UNVERIFIED" }],
    })],
  });
  assert.equal(unverifiedCode.ok, false);
  assert.match(unverifiedCode.rejected[0].errors.join(" "), /omitted when unverified/);
});

test("a record is not verified without evidence", () => {
  const plan = planImport({
    products: [product({ verificationStatus: "VERIFIED", verifiedAt: observed, evidence: [] })],
  });
  assert.equal(plan.summary.inserts, 0);
  assert.equal(plan.summary.rejected, 1);
  assert.match(plan.rejected[0].errors.join(" "), /requires record evidence/);

  const labeled = planImport({
    products: [product({
      verificationStatus: "VERIFIED",
      verifiedAt: observed,
      evidence: [evidence({ verificationStatus: "UNVERIFIED" })],
    })],
  });
  assert.equal(labeled.ok, false);
});

test("chain locations with different addresses stay separate", () => {
  const plan = planImport({
    businesses: [banner],
    stores: [
      store(),
      store({ importKey: "test-unit-store-south", name: "TEST Synthetic Unit South", addressLine: "20 Fixture Lane", zip: "06011" }),
    ],
  });
  assert.equal(plan.summary.inserts, 3);
  assert.equal(plan.summary.conflicts, 0);

  const sameAddress = planImport({
    businesses: [banner],
    stores: [
      store(),
      store({ importKey: "test-unit-store-dup", name: "TEST Synthetic Unit Dup", addressLine: "10  Fixture   Lane" }),
    ],
  });
  assert.equal(sameAddress.summary.conflicts, 1);
  assert.equal(sameAddress.actions.filter((action) => action.kind === "store" && action.op === "insert").length, 1);
});

test("language, region, and packaging keep similar products apart", () => {
  const plan = planImport({
    products: [
      product({ importKey: "test-unit-en", language: "en" }),
      product({ importKey: "test-unit-ja", language: "ja", canonicalName: "TEST Synthetic Unit Box" }),
      product({ importKey: "test-unit-case", language: "en", packagingVariant: "case" }),
    ],
  });
  assert.equal(plan.summary.inserts, 3);
  assert.equal(plan.summary.conflicts, 0);

  const duplicate = planImport({
    products: [
      product({ importKey: "test-unit-en" }),
      product({ importKey: "test-unit-en-2" }),
    ],
  });
  assert.equal(duplicate.summary.conflicts, 1);
});

test("repeating an import is idempotent and verified conflicts need a resolution", () => {
  const doc = { businesses: [banner], stores: [store()], products: [product()] };
  const first = planImport(doc);
  assert.equal(first.summary.inserts, 3);
  const existing = {
    businesses: first.actions.filter((action) => action.kind === "business").map((action) => action.row),
    stores: first.actions.filter((action) => action.kind === "store").map((action) => action.row),
    products: first.actions.filter((action) => action.kind === "product").map((action) => action.row),
  };
  const second = planImport(doc, existing);
  assert.equal(second.summary.unchanged, 3);
  assert.equal(second.summary.inserts, 0);
  assert.equal(second.summary.updates, 0);

  const verified = product({
    verificationStatus: "VERIFIED",
    verifiedAt: observed,
    evidence: [evidence()],
  });
  const stored = planImport({ products: [verified] }).actions[0].row;
  const conflict = planImport({
    products: [product({
      canonicalName: "TEST Synthetic Unit Box Revised",
      verificationStatus: "VERIFIED",
      verifiedAt: observed,
      evidence: [evidence()],
    })],
  }, { products: [stored] });
  assert.equal(conflict.summary.conflicts, 1);
  assert.equal(conflict.summary.updates, 0);
  assert.throws(() => renderApplySql(conflict), /refusing to render/);

  const weaker = planImport({
    products: [product({ verificationStatus: "UNVERIFIED" })],
  }, { products: [stored] });
  assert.equal(weaker.summary.conflicts, 1);

  const accepted = planImport({
    products: [{
      ...verified,
      canonicalName: "TEST Synthetic Unit Box Revised",
      resolution: "accept_incoming",
    }],
  }, { products: [stored] });
  assert.equal(accepted.summary.updates, 1);
  assert.match(renderApplySql(accepted), /app.directory_resolution/);
  const sql = renderApplySql(first);
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\s*$/);
  assert.doesNotMatch(sql, /product_identifiers/);
});

test("dry-run does not open a database and apply refuses a hosted URL", () => {
  const env = { ...process.env, TEST_DATABASE_URL: "postgres://postgres@db.example.supabase.co:5432/postgres" };
  delete env.DIRECTORY_DATABASE_URL;
  const dry = spawnSync(process.execPath, [
    "scripts/import-directory.mjs", "--dry-run", "--input", "test/fixtures/synthetic-directory.json",
  ], { encoding: "utf8", env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /"mode": "dry-run"/);
  assert.doesNotMatch(`${dry.stdout}\n${dry.stderr}`, /psql|ECONN|password/i);

  const hosted = spawnSync(process.execPath, [
    "scripts/import-directory.mjs", "--apply", "--input", "test/fixtures/synthetic-directory.json",
  ], { encoding: "utf8", env });
  assert.equal(hosted.status, 1);
  assert.match(hosted.stderr, /Refusing/);
});

test("malformed CSV rows are rejected and retailer feeds stay disabled", () => {
  const csv = [
    "record_type,import_key,game,category,canonical_name,verification_status,is_synthetic,state,zip",
    "product,not a key,pokemon,elite_trainer_box,TEST Synthetic CSV,UNVERIFIED,true,,",
    "nope,test-csv-row,pokemon,tin,TEST Synthetic CSV,UNVERIFIED,true,,",
  ].join("\n");
  const plan = planImport(csvToDirectory(csv));
  assert.equal(plan.ok, false);
  assert.ok(plan.summary.rejected >= 2);

  assert.equal(SOURCE_REGISTRY.walmart_affiliate_api.authorizationStatus, "BLOCKED");
  assert.equal(SOURCE_REGISTRY.target.authorizationStatus, "BLOCKED");
  assert.equal(SOURCE_REGISTRY.gamestop.authorizationStatus, "UNVERIFIED");
  assert.equal(SOURCE_REGISTRY.bestbuy_developer_api.authorizationStatus, "PARTIAL");
});

test("field evidence, successors, and identifier ownership stay specific", () => {
  const record = evidence();
  const setOnly = planImport({
    products: [product({
      verificationStatus: "VERIFIED",
      verifiedAt: observed,
      setName: "Probe Set",
      evidence: [evidence({ fieldScope: "set_name" })],
    })],
  });
  assert.equal(setOnly.ok, false);
  assert.match(setOnly.rejected[0].errors.join(" "), /record evidence/);

  const phoneOnly = planImport({
    businesses: [banner],
    stores: [store({
      verificationStatus: "VERIFIED",
      verifiedAt: observed,
      addressVerificationStatus: "VERIFIED",
      publicPhone: "860-555-0100",
      evidence: [evidence({ fieldScope: "phone" })],
    })],
  });
  assert.equal(phoneOnly.ok, false);

  const addressed = planImport({
    businesses: [banner],
    stores: [store({
      verificationStatus: "VERIFIED",
      verifiedAt: observed,
      addressVerificationStatus: "VERIFIED",
      publicPhone: "860-555-0100",
      evidence: [record, evidence({ fieldScope: "phone" })],
    })],
  });
  assert.equal(addressed.ok, true, JSON.stringify(addressed.rejected));

  const missingSuccessor = planImport({
    businesses: [banner],
    stores: [store({ recordStatus: "retired", retiredReason: "moved", successorImportKey: "missing-store" })],
  });
  assert.equal(missingSuccessor.ok, false);
  assert.match(missingSuccessor.rejected.map((row) => row.errors.join(" ")).join(" "), /does not match a store/);

  const selfSuccessor = planImport({
    businesses: [banner],
    stores: [store({ recordStatus: "retired", retiredReason: "loop", successorImportKey: "test-unit-store" })],
  });
  assert.equal(selfSuccessor.ok, false);
  assert.match(selfSuccessor.rejected.map((row) => row.errors.join(" ")).join(" "), /same store/);

  const verifiedPlan = planImport({
    businesses: [banner],
    stores: [store({
      verificationStatus: "VERIFIED",
      verifiedAt: observed,
      addressVerificationStatus: "VERIFIED",
      evidence: [record],
    })],
  });
  assert.equal(verifiedPlan.ok, true, JSON.stringify(verifiedPlan.rejected));
  const verifiedStore = verifiedPlan.actions.find((action) => action.kind === "store").row;
  const existingDirectory = {
    businesses: [banner],
    stores: [verifiedStore],
  };
  const retireAndRename = planImport({
    businesses: [banner],
    stores: [store({
      name: "TEST Synthetic Unit Renamed",
      verificationStatus: "VERIFIED",
      verifiedAt: observed,
      addressVerificationStatus: "VERIFIED",
      recordStatus: "retired",
      retiredReason: "closed",
      resolution: "retire",
      evidence: [record],
    })],
  }, existingDirectory);
  assert.equal(retireAndRename.summary.conflicts, 1);
  const retireOnly = planImport({
    businesses: [banner],
    stores: [store({
      verificationStatus: "VERIFIED",
      verifiedAt: observed,
      addressVerificationStatus: "VERIFIED",
      recordStatus: "retired",
      retiredReason: "closed",
      resolution: "retire",
      evidence: [record],
    })],
  }, existingDirectory);
  assert.equal(retireOnly.summary.updates, 1);
  assert.equal(retireOnly.actions.find((action) => action.kind === "store").resolution, "retire");

  const owned = product({
    importKey: "test-unit-owned",
    verificationStatus: "VERIFIED",
    verifiedAt: observed,
    evidence: [record, evidence({ fieldScope: "identifier", claimKey: "12345670" })],
    identifiers: [{
      idType: "gtin",
      value: "12345670",
      verificationStatus: "VERIFIED",
      verifiedAt: observed,
    }],
  });
  const firstCode = planImport({ products: [owned] });
  assert.equal(firstCode.ok, true, firstCode.rejected);
  const otherCode = planImport({
    products: [product({
      importKey: "test-unit-other-code",
      canonicalName: "TEST Synthetic Other Code",
      verificationStatus: "VERIFIED",
      verifiedAt: observed,
      evidence: [record, evidence({ fieldScope: "identifier", claimKey: "12345670" })],
      identifiers: [{
        idType: "gtin",
        value: "12345670",
        verificationStatus: "VERIFIED",
        verifiedAt: observed,
      }],
    })],
  }, { products: [firstCode.actions[0].row] });
  assert.equal(otherCode.summary.conflicts, 1);
  assert.match(otherCode.conflicts[0].reason, /another product/);

  const quoted = renderApplySql(planImport({
    products: [product({ canonicalName: "TEST O'Brien Tin" })],
  }));
  assert.match(quoted, /TEST O''Brien Tin/);
  assert.doesNotMatch(quoted, /drop table/);
  assert.throws(() => renderApplySql({
    ok: true,
    actions: [{ kind: "store", op: "insert", importKey: "x", resolution: null, row: store({ latitude: Number.NaN, longitude: -72.5 }) }],
  }), /non-finite/);
});

test("malformed CSV quoting and invalid columns fail clearly", () => {
  assert.throws(() => csvToDirectory("record_type,import_key\n\"unclosed,key\n"), /quote is not closed/);
  assert.throws(() => csvToDirectory("record_type,import_key,not_a_column\nproduct,test-csv,secret\n"), /unknown CSV columns/);
  assert.throws(() => csvToDirectory("record_type,record_type\nproduct,product\n"), /duplicate CSV column/);
  assert.throws(
    () => csvToDirectory("record_type,import_key,display_name,kind,verification_status,is_synthetic\nbusiness,probe-biz,TEST Synthetic,independent,UNVERIFIED,YES\n"),
    /is_synthetic must be true or false/,
  );
});

test("the catalog migration does not seed stores, products, or identifiers", () => {
  const sql = readFileSync("db/migrations/0003_store_directory_and_catalog.sql", "utf8").toLowerCase();
  for (const table of ["stores", "products", "businesses", "product_identifiers", "record_evidence"]) {
    assert.equal(sql.includes(`insert into ${table}`), false, table);
  }
});
