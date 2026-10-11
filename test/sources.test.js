import test from "node:test";
import assert from "node:assert/strict";
import { SOURCE_REGISTRY, canRunSource, notificationsEnabled } from "../src/domain/sources.js";

test("no retailer adapter can run, even with its enable flag set", () => {
  const env = {
    SOURCE_WALMART_ENABLED: "1", SOURCE_TARGET_ENABLED: "1",
    SOURCE_GAMESTOP_ENABLED: "1", SOURCE_BESTBUY_ENABLED: "1",
  };
  for (const [id, src] of Object.entries(SOURCE_REGISTRY)) {
    if (!src.retailer) continue;
    const r = canRunSource(id, env);
    assert.equal(r.allowed, false, id);
    assert.match(r.reason, /authorization status/);
  }
});

test("VERIFIED source still needs its enable flag", () => {
  assert.equal(canRunSource("community", {}).allowed, false);
  assert.equal(canRunSource("community", { SOURCE_COMMUNITY_ENABLED: "1" }).allowed, true);
});

test("kill switches override everything", () => {
  const env = { SOURCE_COMMUNITY_ENABLED: "1" };
  assert.equal(canRunSource("community", { ...env, INGEST_KILL_ALL: "1" }).allowed, false);
  assert.equal(canRunSource("community", { ...env, INGEST_KILL_COMMUNITY: "true" }).allowed, false);
  assert.equal(notificationsEnabled({ NOTIFICATIONS_ENABLED: "1", NOTIFICATIONS_KILL: "1" }), false);
  assert.equal(notificationsEnabled({}), false, "notifications are off by default");
});

test("synthetic source is blocked in production", () => {
  const env = { SOURCE_SYNTHETIC_DEMO_ENABLED: "1" };
  assert.equal(canRunSource("synthetic_demo", env).allowed, true);
  assert.equal(canRunSource("synthetic_demo", { ...env, VERCEL_ENV: "production" }).allowed, false);
  assert.equal(canRunSource("synthetic_demo", { ...env, APP_ENV: "production" }).allowed, false);
});

test("unknown sources are denied", () => {
  assert.equal(canRunSource("scraper_xyz", { INGEST_KILL_ALL: "0" }).allowed, false);
});
