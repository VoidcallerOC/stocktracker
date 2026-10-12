import test from "node:test";
import assert from "node:assert/strict";
import { SOURCE_REGISTRY } from "../src/domain/sources.js";
import { PROVISIONAL_FRESHNESS_NOTE, SOURCE_POLICIES } from "../src/domain/source-policy.js";

const RETAILERS = ["walmart_affiliate_api", "target", "gamestop", "bestbuy_developer_api"];

test("every registry source has a policy, and no retailer is approved to run or notify", () => {
  for (const id of Object.keys(SOURCE_REGISTRY)) {
    assert.ok(SOURCE_POLICIES[id], id);
    assert.equal(SOURCE_POLICIES[id].allowUnknownAgeAlerts, false, id);
    assert.equal(SOURCE_POLICIES[id].freshness.provisional, true, id);
    assert.match(SOURCE_POLICIES[id].freshness.note, /provisional/);
  }
  assert.equal(PROVISIONAL_FRESHNESS_NOTE.length > 0, true);
  for (const id of RETAILERS) {
    const policy = SOURCE_POLICIES[id];
    assert.equal(policy.authorized, false, id);
    assert.equal(policy.notifications, false, id);
    assert.equal(policy.trustReceiptTime, false, id);
    assert.equal(policy.policyApproved, false, id);
    assert.equal(policy.adapterTested, false, id);
    assert.equal(policy.permissionRef, null, id);
    assert.equal(SOURCE_REGISTRY[id].authorizationStatus === "VERIFIED", false, id);
  }
});

test("Best Buy retention is the documented 72 hour ceiling and other retailers are not retained", () => {
  const bestBuy = SOURCE_POLICIES.bestbuy_developer_api;
  assert.equal(bestBuy.retention.mode, "purge_after");
  assert.equal(bestBuy.retention.maxRetentionMs, 72 * 60 * 60 * 1000);
  assert.equal(bestBuy.retention.provisional, false);
  assert.equal(bestBuy.quantityReliability, "status_only");
  for (const id of ["walmart_affiliate_api", "target", "gamestop"]) {
    assert.equal(SOURCE_POLICIES[id].retention.mode, "do_not_retain", id);
  }
  assert.equal(SOURCE_POLICIES.community.retention.mode, "retain");
  assert.equal(SOURCE_POLICIES.community.notifications, true);
  assert.match(SOURCE_POLICIES.community.attribution, /not retailer-confirmed/);
});
