import assert from "node:assert/strict";
import test from "node:test";
import {
  compareExtractClaims,
  handlerIdentityKey,
  historyMetadata,
  normalizeSourceStatus,
  sameHandlerIdentity,
} from "./claims-qa.mjs";

const isTerminal = (status) =>
  ["closed", "settled"].includes(normalizeSourceStatus(status));

test("source status aliases preserve the intended operational meaning", () => {
  assert.equal(
    normalizeSourceStatus("  SETTLED – Recovery   Pending "),
    "settled - awaiting recovery",
  );
  assert.equal(normalizeSourceStatus("reopen"), "registered");
  assert.equal(
    normalizeSourceStatus("Settled - TP approach pending"),
    "settled - tp approach pending",
  );
});

test("handler identity comparison is dynamic and order-insensitive", () => {
  assert.equal(handlerIdentityKey("De Beer, Bev"), "debeerbev");
  assert.equal(sameHandlerIdentity("De Beer Bev", "Bev De Beer"), true);
  assert.equal(sameHandlerIdentity("Alpha One", "Beta Two"), false);
});

test("extract metadata never stores the full claim payload", () => {
  const metadata = historyMetadata(
    [{ claimNo: "C-1" }, { claimNo: "C-2" }],
    "extract.xlsx",
    "2026-08-27",
    "2026-08-27T08:00:00.000Z",
  );
  assert.deepEqual(metadata, {
    id: "2026-08-27-20260827080000000",
    extractDate: "2026-08-27",
    uploadedAt: "2026-08-27T08:00:00.000Z",
    fileName: "extract.xlsx",
    claimCount: 2,
    schemaVersion: "scout-extract-metadata-v2",
  });
  assert.equal("claims" in metadata, false);
});

test("closed and terminal movement counts only include disappearance or open-to-terminal transitions", () => {
  const result = compareExtractClaims(
    [
      { claimNo: "A", status: "Settled" },
      { claimNo: "B", status: "Closed" },
      { claimNo: "C", status: "Registered", estimate: 10 },
    ],
    [
      { claimNo: "A", status: "Settled" },
      { claimNo: "B", status: "Registered" },
      { claimNo: "C", status: "Registered", estimate: 8 },
      { claimNo: "D", status: "Registered" },
    ],
    isTerminal,
  );
  assert.deepEqual(
    result.closedClaims.map((claim) => claim.claimNo),
    ["B", "D"],
  );
  assert.deepEqual(
    result.estimateChanges.map((item) => item.claim.claimNo),
    ["C"],
  );
});
