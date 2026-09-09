import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
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
    getFreshnessModel({ claimsAvailable: true, extractDate: "2026-09-02", now })
      .state,
    "current",
  );
  assert.equal(
    getFreshnessModel({ claimsAvailable: true, extractDate: "2026-09-01", now })
      .state,
    "stale",
  );
  assert.equal(
    getFreshnessModel({
      claimsAvailable: true,
      extractDate: "2026-09-02",
      warningCount: 1,
      now,
    }).state,
    "warning",
  );
  assert.equal(
    getFreshnessModel({ claimsAvailable: true, now }).state,
    "warning",
  );
  assert.equal(
    getFreshnessModel({ claimsAvailable: false, now }).state,
    "unavailable",
  );
});

test("comparison requires a real previous extract, including a valid empty one", () => {
  assert.equal(hasValidComparison([{ claimNo: "A" }], []), true);
  assert.equal(hasValidComparison([{ claimNo: "A" }], null), false);
  assert.equal(
    comparisonUnavailableLabel([{ claimNo: "A" }], null),
    "Comparison unavailable",
  );
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
  assert.match(
    source,
    /role="dialog" aria-modal="true" aria-labelledby="dp-claim-no"/,
  );
});

test("shared briefing model suppresses invalid comparisons and deduplicates handler items", () => {
  const claims = [
    {
      claimNo: "C-1",
      handler: "Jane Doe",
      score: 80,
      outstanding: 100000,
      critical: true,
      zero: true,
    },
    {
      claimNo: "C-2",
      handler: "Jane Doe",
      score: 50,
      stale: true,
      awaiting: true,
    },
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
    getPrimaryReason: (c) =>
      c.critical ? "Critical SLA breach" : "Review claim progress",
    getNextAction: () => "Review and progress claim",
    claimUrl: (c) => `https://scout.test/claims/?view=claim&claim=${c.claimNo}`,
    handlerUrl: (h) =>
      `https://scout.test/claims/?view=claims&handler=${encodeURIComponent(h)}`,
    exceptionUrl: (e) =>
      `https://scout.test/claims/?view=exceptions&exception=${e}`,
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
  assert.equal(
    unavailable.handler.items.filter((item) => item.claimNo === "C-1").length,
    1,
  );
  assert.match(unavailable.topRisks.items[0]?.url || "", /view=claim/);
  const available = buildBriefingModel(claims, helpers, {
    comparisonAvailable: true,
    previousClaims: [],
  });
  assert.equal(available.comparisonAvailable, true);
  assert.notEqual(available.metrics.newClaims, null);
});

test("checkpoint 3 uses one briefing model for Outlook-safe email, Teams and deep links", async () => {
  const source = await readFile(
    new URL("../scout-smartsure/claims/index.html", import.meta.url),
    "utf8",
  );
  const worker = await readFile(
    new URL("../worker.js", import.meta.url),
    "utf8",
  );
  const model = await readFile(
    new URL("../scout-smartsure/claims/briefing-model.mjs", import.meta.url),
    "utf8",
  );
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
  assert.doesNotMatch(
    source,
    /exception-row-primary"><a class="exception-row-link"/,
  );
  assert.doesNotMatch(source, /<button class="filter-chip[^>]*>.*<button/s);
  assert.match(source, /claims-table \{ overflow-x: auto; \}/);
  assert.match(source, /\.main \{[\s\S]*?min-width: 0;/);
  assert.match(
    source,
    /\.date-badge \{ display: none; \}/,
    "mobile header should remove the duplicate date badge before controls wrap",
  );
  assert.match(
    source,
    /\.user-pill \{ width: 34px; flex: 0 0 34px; padding: 5px 3px; justify-content: center; \}/,
    "mobile header should compact the user control without removing it",
  );
  assert.match(
    source,
    /#user-display-name, #user-role-badge \{ display: none; \}/,
    "mobile header should keep the user control accessible while compact",
  );
  assert.match(
    source,
    /@media \(min-width: 641px\) and \(max-width: 829px\) \{[\s\S]*?\.topnav \{ min-width: 0; padding: 10px 12px; \}[\s\S]*?\.nav-right \{ min-width: 0; gap: 8px; \}[\s\S]*?\.date-badge \{ display: none; \}[\s\S]*?\.user-pill \{ width: 34px; flex: 0 0 34px; padding: 5px 3px; justify-content: center; \}[\s\S]*?#user-display-name, #user-role-badge \{ display: none; \}/,
    "tablet header should compact only the duplicate date and user presentation",
  );
  assert.match(
    source,
    /id="notification-button"/,
    "tablet header should retain the notification control",
  );
  assert.match(
    source,
    /id="upload-btn"/,
    "tablet header should retain the upload control",
  );
  assert.match(source, /aria-current/, "navigation state should be announced");
  assert.match(source, /function openUploadOverlay/);
  assert.match(
    source,
    /if \(!options\.fromRoute && !detailOriginFocus\)/,
    "claim opening should retain a focusable queue origin",
  );
  assert.match(source, /overlay\.setAttribute\("aria-hidden", "false"\)/);
  assert.match(source, /backdrop\.setAttribute\("aria-hidden", "false"\)/);
  assert.match(source, /trapOverlayFocus/);
  const reports = await readFile(
    new URL("../scout-smartsure/claims/reporting-ui.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    reports,
    /role="tab" aria-selected=.*aria-controls="reports-tabpanel"/,
  );
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

test("synthetic QA fixtures are deterministic, non-identifying and comparison-aware", async () => {
  const source = await readFile(
    new URL("../scout-smartsure/claims/qa-fixtures.js.txt", import.meta.url),
    "utf8",
  );
  const context = {
    URL,
    URLSearchParams,
    Response,
    JSON,
    window: {
      ScoutQAConfig: { fixtureMode: true },
      location: { search: "" },
      fetch: async () => new Response("{}"),
    },
  };
  vm.runInNewContext(source, context);
  const fixture = context.window.ScoutSyntheticQA.getFixture();
  assert.ok(fixture.claims.length >= 75 && fixture.claims.length <= 120);
  assert.equal(fixture.history.length, 2);
  assert.equal(fixture.reports.length, 3);
  assert.ok(fixture.claims.every((claim) => /^QA-\d{4}$/.test(claim.claim_no)));
  assert.ok(
    fixture.claims.every((claim) =>
      claim.insured_name.startsWith("Synthetic Insured "),
    ),
  );
  assert.ok(
    fixture.claims.every((claim) =>
      claim.handler_email.endsWith("@synthetic.invalid"),
    ),
  );
  assert.ok(
    fixture.claims.some((claim) => claim.status === "Awaiting Assessor Report"),
  );
  assert.ok(
    fixture.claims.some(
      (claim) => claim.status === "Payment Requested" && claim.estimate === 0,
    ),
  );
  assert.ok(fixture.claims.some((claim) => claim.outstanding >= 100000));
  assert.doesNotMatch(
    JSON.stringify(fixture),
    /scout-backend\.marketing-854\.workers\.dev/,
  );

  context.window.location.search = "?qa-scenario=no-comparison";
  const unavailable = context.window.ScoutSyntheticQA.getFixture();
  assert.equal(unavailable.history.length, 1);

  const readAttempt = await context.window.fetch(
    "https://scout-backend.marketing-854.workers.dev/claims",
  );
  const writeAttempt = await context.window.fetch(
    "https://scout-backend.marketing-854.workers.dev/notes/QA-0001",
    { method: "PUT" },
  );
  assert.equal(readAttempt.status, 200);
  assert.equal(writeAttempt.status, 403);
  assert.equal(context.window.ScoutSyntheticQA.getNetworkLog().length, 2);
});

test("production assets exclude preview-only artifacts while retaining shared helpers", async () => {
  const shell = await readFile(
    new URL("../scout-smartsure/claims/index.html", import.meta.url),
    "utf8",
  );
  const helper = await readFile(
    new URL("../scout-smartsure/claims/claims-qa.mjs", import.meta.url),
    "utf8",
  );
  const assetsIgnore = await readFile(
    new URL("../scout-smartsure/.assetsignore", import.meta.url),
    "utf8",
  );
  const qaShell = await readFile(
    new URL("../scout-smartsure/claims/qa-preview-index.html", import.meta.url),
    "utf8",
  );
  const qaFixtures = await readFile(
    new URL("../scout-smartsure/claims/qa-fixtures.js.txt", import.meta.url),
    "utf8",
  );
  assert.match(shell, /src="\.\/claims-qa\.mjs"/);
  assert.match(helper, /export function normalizeSourceStatus/);
  assert.match(qaShell, /UX REMEDIATION PREVIEW · SYNTHETIC QA DATA/);
  assert.match(qaFixtures, /window\.ScoutSyntheticQA/);
  assert.doesNotMatch(shell, /qa-preview-config/);
  assert.doesNotMatch(shell, /qa-fixtures/);
  assert.doesNotMatch(shell, /ScoutSyntheticQA/);
  assert.doesNotMatch(shell, /ScoutQAConfig/);
  assert.doesNotMatch(shell, /QA_FIXTURE_MODE/);
  assert.doesNotMatch(shell, /synthetic-qa-banner/);
  assert.doesNotMatch(shell, /UX REMEDIATION PREVIEW/);
  for (const path of [
    "/qa-preview-worker.js",
    "/remediation-preview-worker.js",
    "/claims/qa-preview-index.html",
    "/claims/qa-fixtures.js.txt",
    "/claims/qa-preview-config.js",
    "/claims/qa-fixtures.js",
  ]) {
    assert.match(assetsIgnore, new RegExp(`\\${path}`));
  }
  await assert.rejects(
    readFile(
      new URL(
        "../scout-smartsure/claims/qa-preview-config.js",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await assert.rejects(
    readFile(
      new URL("../scout-smartsure/claims/qa-fixtures.js", import.meta.url),
      "utf8",
    ),
  );
});

test("QA Worker serves isolated preview assets and falls through for shared assets", async () => {
  const workerSource = await readFile(
    new URL("../scout-smartsure/qa-preview-worker.js", import.meta.url),
    "utf8",
  );
  const qaShell = await readFile(
    new URL("../scout-smartsure/claims/qa-preview-index.html", import.meta.url),
    "utf8",
  );
  const qaFixtures = await readFile(
    new URL("../scout-smartsure/claims/qa-fixtures.js.txt", import.meta.url),
    "utf8",
  );
  const executable = workerSource
    .replace(
      'import qaPreviewHtml from "./claims/qa-preview-index.html";',
      `const qaPreviewHtml = ${JSON.stringify(qaShell)};`,
    )
    .replace(
      'import qaFixtures from "./claims/qa-fixtures.js.txt";',
      `const qaFixtures = ${JSON.stringify(qaFixtures)};`,
    )
    .replace("export default", "const worker =");
  const context = { URL, Response, Set };
  vm.runInNewContext(`${executable}\nthis.worker = worker;`, context);
  const fallthrough = [];
  const env = {
    SCOUT_QA_FIXTURE_MODE: "true",
    SCOUT_BASE_URL:
      "https://scout-smartsure-ux-qa.marketing-854.workers.dev/claims/",
    ASSETS: {
      fetch: async (request) => {
        fallthrough.push(new URL(request.url).pathname);
        return new Response("shared asset", { status: 200 });
      },
    },
  };
  for (const path of ["/claims", "/claims/", "/claims/index.html"]) {
    const response = await context.worker.fetch(
      new Request(`https://qa.example.test${path}`),
      env,
    );
    assert.equal(response.status, 200);
    assert.match(
      await response.text(),
      /UX REMEDIATION PREVIEW · SYNTHETIC QA DATA/,
    );
    assert.equal(
      response.headers.get("content-type"),
      "text/html; charset=UTF-8",
    );
  }
  const configResponse = await context.worker.fetch(
    new Request("https://qa.example.test/claims/qa-preview-config.js"),
    env,
  );
  assert.equal(configResponse.status, 200);
  const configText = await configResponse.text();
  assert.match(configText, /"fixtureMode":true/);
  assert.match(configText, /scout-smartsure-ux-qa/);
  const fixtureResponse = await context.worker.fetch(
    new Request("https://qa.example.test/claims/qa-fixtures.js"),
    env,
  );
  assert.equal(fixtureResponse.status, 200);
  assert.match(await fixtureResponse.text(), /window\.ScoutSyntheticQA/);
  assert.equal(
    fixtureResponse.headers.get("content-type"),
    "application/javascript; charset=UTF-8",
  );
  const sharedResponse = await context.worker.fetch(
    new Request("https://qa.example.test/oauth-route.js"),
    env,
  );
  assert.equal(sharedResponse.status, 200);
  assert.deepEqual(fallthrough, ["/oauth-route.js"]);
  const reports = await readFile(
    new URL("../scout-smartsure/claims/reporting-ui.mjs", import.meta.url),
    "utf8",
  );
  assert.match(reports, /isSyntheticQa\(\)/);
  assert.match(
    reports,
    /Report changes are disabled in the synthetic QA preview/,
  );
  assert.match(workerSource, /SCOUT_BASE_URL/);
  assert.match(workerSource, /qaPreviewHtml/);
  assert.match(workerSource, /qaFixtures/);
});
