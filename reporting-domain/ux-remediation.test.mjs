import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  comparisonUnavailableLabel,
  getFreshnessModel,
  hasValidComparison,
} from "../scout-smartsure/claims/ux-model.mjs";
import { buildBriefingModel } from "../scout-smartsure/claims/briefing-model.mjs";

test("freshness model distinguishes current, stale, warning and unavailable extracts", () => {
  const now = new Date("2026-09-02T09:00:00+02:00");
  assert.equal(
    getFreshnessModel({ claimsAvailable: true, extractDate: "2026-09-02", now }).state,
    "current",
  );
  assert.equal(
    getFreshnessModel({ claimsAvailable: true, extractDate: "2026-09-01", now }).state,
    "stale",
  );
  assert.equal(
    getFreshnessModel({ claimsAvailable: true, extractDate: "2026-09-02", warningCount: 1, now }).state,
    "warning",
  );
  assert.equal(
    getFreshnessModel({ claimsAvailable: true, now }).state,
    "warning",
  );
  assert.equal(getFreshnessModel({ claimsAvailable: false, now }).state, "unavailable");
});

test("comparison requires a real previous extract, including a valid empty one", () => {
  assert.equal(hasValidComparison([{ claimNo: "A" }], []), true);
  assert.equal(hasValidComparison([{ claimNo: "A" }], null), false);
  assert.equal(comparisonUnavailableLabel([{ claimNo: "A" }], null), "Comparison unavailable");
  assert.equal(comparisonUnavailableLabel([{ claimNo: "A" }], []), "");
});

test("claims shell contains the no-baseline comparison and freshness safeguards", async () => {
  const source = await readFile(
    new URL("../scout-smartsure/claims/index.html", import.meta.url),
    "utf8",
  );
  assert.match(source, /Comparison unavailable/);
  assert.match(source, /claimsAvailable: claimsLoaded/);
  assert.match(source, /Delivery scope:/);
  assert.match(source, /if \(!summary\.canSend\) return/);
  assert.doesNotMatch(source, /new since yesterday/);
  assert.doesNotMatch(source, /showDataBanner\(`Showing data from/);
  const worker = await readFile(
    new URL("../worker.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(worker, /new since yesterday/);
  assert.match(worker, /comparisonAvailable/);
});

test("checkpoint 1 keeps operational intelligence while reducing visible competition", async () => {
  const source = await readFile(
    new URL("../scout-smartsure/claims/index.html", import.meta.url),
    "utf8",
  );
  assert.match(source, /id="stat-needs-action"/);
  assert.match(source, /id="stat-exceptions"/);
  assert.match(source, /id="stat-closure-candidates"/);
  assert.match(source, /Counts can overlap/);
  assert.match(source, /const PRIORITY_PAGE_SIZE = 25/);
  assert.match(source, /other exception/);
  assert.match(source, /id="claims-more-filters"/);
  assert.match(source, /id="active-claims-filters"/);
  assert.match(source, /setClaimsDensity\('compact'\)/);
  assert.match(source, /Next action/);
  assert.match(source, /Close after final checks/);
  assert.match(source, /Management review/);
  assert.match(source, /function canonicalClaimLabel/);
});

test("checkpoint 2 provides an exceptions workbench, role-aware navigation and stable operational routes", async () => {
  const source = await readFile(
    new URL("../scout-smartsure/claims/index.html", import.meta.url),
    "utf8",
  );
  assert.match(source, /id="nav-today"/);
  assert.match(source, /id="nav-claims"/);
  assert.match(source, /id="nav-exceptions"/);
  assert.match(source, /id="nav-reports-group"/);
  assert.match(source, /Administration &amp; compliance/);
  assert.match(source, /id="view-exceptions"/);
  assert.match(source, /Critical SLA/);
  assert.match(source, /SLA at risk/);
  assert.match(source, /No movement/);
  assert.match(source, /Zero estimate/);
  assert.match(source, /Mandate \/ authority/);
  assert.match(source, /External-party delay/);
  assert.match(source, /Closure candidates/);
  assert.match(source, /Counts overlap/);
  assert.match(source, /function isNoMovementException/);
  assert.match(source, /function exceptionMatches/);
  assert.match(source, /function renderExceptions/);
  assert.match(source, /function readScoutUrlState/);
  assert.match(source, /function syncClaimsUrlState/);
  assert.match(source, /function syncExceptionsUrlState/);
  assert.match(source, /function scoutUrlForClaim/);
  assert.match(source, /history\.pushState/);
  assert.match(source, /history\.replaceState/);
  assert.match(source, /window\.addEventListener\("popstate"/);
  assert.match(source, /function buildClaimTimeline/);
  assert.match(source, /class="detail-next-action"/);
  assert.match(source, /No claim movement chronology is available/);
  assert.match(source, /role="dialog" aria-modal="true" aria-labelledby="dp-claim-no"/);
});

test("shared briefing model suppresses invalid comparisons and deduplicates handler items", () => {
  const claims = [
    { claimNo: "C-1", handler: "Jane Doe", score: 80, outstanding: 100000, critical: true, zero: true },
    { claimNo: "C-2", handler: "Jane Doe", score: 50, stale: true, awaiting: true },
    { claimNo: "C-3", handler: "Jane Doe", score: 30, payment: true },
  ];
  const helpers = {
    getClaimNo: (c) => c.claimNo,
    getHandler: (c) => c.handler,
    getInsured: () => "Insured",
    getScore: (c) => c.score,
    getOutstanding: (c) => c.outstanding || 0,
    isCritical: (c) => c.critical,
    isStale: (c) => c.stale,
    isZeroEstimate: (c) => c.zero,
    isRisk: (c) => c.critical,
    isMandate: (c) => c.outstanding >= 100000,
    isAwaitingExternal: (c) => c.awaiting,
    isPayment: (c) => c.payment,
    getPrimaryReason: (c) => c.critical ? "Critical SLA breach" : "Review claim progress",
    getNextAction: () => "Review and progress claim",
    claimUrl: (c) => `https://scout.test/claims/?view=claim&claim=${c.claimNo}`,
    handlerUrl: (h) => `https://scout.test/claims/?view=claims&handler=${encodeURIComponent(h)}`,
    exceptionUrl: (e) => `https://scout.test/claims/?view=exceptions&exception=${e}`,
  };
  const unavailable = buildBriefingModel(claims, helpers, {
    comparisonAvailable: false,
    previousClaims: null,
    extractDate: "2026-09-01",
  });
  assert.equal(unavailable.comparisonAvailable, false);
  assert.equal(unavailable.extractDate, "2026-09-01");
  assert.equal(unavailable.metrics.newClaims, null);
  assert.equal(unavailable.comparisonLabel, "Comparison unavailable");
  assert.equal(unavailable.handler.items.filter((item) => item.claimNo === "C-1").length, 1);
  assert.match(unavailable.topRisks.items[0]?.url || "", /view=claim/);
  const available = buildBriefingModel(claims, helpers, { comparisonAvailable: true, previousClaims: [] });
  assert.equal(available.comparisonAvailable, true);
  assert.notEqual(available.metrics.newClaims, null);
});

test("checkpoint 3 uses one briefing model for Outlook-safe email, Teams and deep links", async () => {
  const source = await readFile(
    new URL("../scout-smartsure/claims/index.html", import.meta.url),
    "utf8",
  );
  const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
  const model = await readFile(new URL("../scout-smartsure/claims/briefing-model.mjs", import.meta.url), "utf8");
  assert.match(source, /briefing-model\.mjs/);
  assert.match(source, /function getSharedBriefingModel/);
  assert.match(source, /buildBriefingModel/);
  assert.match(source, /data-preview-mode="manager-email"/);
  assert.match(source, /data-preview-mode="handler-email"/);
  assert.match(source, /data-preview-mode="narrow-email"/);
  assert.match(source, /data-preview-mode="teams"/);
  assert.match(source, /iframe id="briefing-email-preview-frame"/);
  assert.match(source, /srcdoc = briefingPreviewMode/);
  assert.match(source, /scoutUrlForClaim/);
  assert.match(source, /scoutUrlForException/);
  assert.match(source, /scoutUrlForHandler/);
  assert.match(source, /Comparison unavailable/);
  assert.match(source, /deliveryModes\[0\].*only/);
  assert.match(source, /Teams destinations/);
  assert.match(worker, /import \{ buildBriefingModel \}/);
  assert.match(worker, /SCOUT_CLAIMS_URL/);
  assert.match(worker, /workerScoutUrl/);
  assert.match(worker, /role="table"/);
  assert.match(worker, /Open Morning Action Board/);
  assert.match(model, /totalHandlerItems: 15/);
  assert.match(model, /comparisonAvailable/);
});

test("checkpoint 4 makes high-frequency navigation and claim controls keyboard reachable", async () => {
  const source = await readFile(
    new URL("../scout-smartsure/claims/index.html", import.meta.url),
    "utf8",
  );
  assert.match(source, /id="scout-sidebar"/);
  assert.match(source, /aria-controls="scout-sidebar"/);
  assert.match(source, /id="nav-today"[^>]*role="button"[^>]*tabindex="0"/);
  assert.match(source, /function trapClaimDetailFocus/);
  assert.match(source, /restoreDetailOriginFocus/);
  assert.match(source, /aria-describedby="detail-body"/);
  assert.match(source, /role="button" tabindex="0" aria-label="Open claim/);
  assert.match(source, /return `<a class="exception-row"/);
  assert.doesNotMatch(source, /exception-row-primary"><a class="exception-row-link"/);
  assert.doesNotMatch(source, /<button class="filter-chip[^>]*>.*<button/s);
  assert.match(source, /claims-table \{ overflow-x: auto; \}/);
  assert.match(source, /\.main \{[\s\S]*?min-width: 0;/);
  assert.match(source, /aria-current/, "navigation state should be announced");
  assert.match(source, /function openUploadOverlay/);
  assert.match(source, /overlay\.setAttribute\("aria-hidden", "false"\)/);
  assert.match(source, /backdrop\.setAttribute\("aria-hidden", "false"\)/);
  assert.match(source, /trapOverlayFocus/);
  const reports = await readFile(
    new URL("../scout-smartsure/claims/reporting-ui.mjs", import.meta.url),
    "utf8",
  );
  assert.match(reports, /role="tab" aria-selected=.*aria-controls="reports-tabpanel"/);
  assert.match(reports, /role="tabpanel" tabindex="-1"/);
  assert.match(reports, /confirmOriginFocus/);
  assert.match(reports, /drillOriginFocus/);
  assert.match(reports, /trapDialogFocus/);
  assert.match(reports, /backdrop\.setAttribute\("aria-hidden", "false"\)/);
  assert.match(reports, /panel\.setAttribute\("aria-hidden", "false"\)/);
});

test("frontend packages the required claims QA helper referenced by the shell", async () => {
  const source = await readFile(
    new URL("../scout-smartsure/claims/index.html", import.meta.url),
    "utf8",
  );
  const helper = await readFile(
    new URL("../scout-smartsure/claims/claims-qa.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /src="\.\/claims-qa\.mjs"/);
  assert.match(helper, /export function normalizeSourceStatus/);
  assert.match(helper, /window\.ScoutClaimsQA/);
  assert.match(helper, /export function compareExtractClaims/);
});
