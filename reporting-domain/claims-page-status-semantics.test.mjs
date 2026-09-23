import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
// The claims page loads its own copy of this module directly in the browser
// (<script type="module" src="./claims-qa.mjs"> in
// scout-smartsure/claims/index.html) - it is NOT the same file as this
// directory's own claims-qa.mjs, and the two have drifted before (the [none]
// missing-status sentinel fix landed here without also landing there). Import
// the actual frontend asset so window.ScoutClaimsQA in the sandbox below is
// exactly what production serves, not a substituted "corrected" copy.
import { normalizeSourceStatus } from "../scout-smartsure/claims/claims-qa.mjs";
import { normalizeSourceStatus as reportingNormalizeSourceStatus } from "./claims-qa.mjs";

// This suite executes the ACTUAL claims-page logic (not a reimplementation)
// by pulling the relevant function/const declarations out of the claims
// page's inline <script> and running them in a sandboxed vm context. Slicing
// (rather than eval-ing the whole 6000+ line inline script) avoids the
// page's real DOM/auth bootstrapping, which top-level-executes at the bottom
// of that script and has no meaning outside a browser.
//
// Each declaration is extracted by brace-balancing from its real source text,
// so a rename or a behavioural change in the page is caught here exactly as
// it would run in production; only the extraction boundary (the list of
// names below) needs to track new dependencies.

function balancedEnd(source, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unbalanced ${openChar}${closeChar} starting at ${openIndex}`);
}

function extractFunction(source, name) {
  const match = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`claims page function not found: ${name}`);
  const funcStart = match.index;
  const parenStart = source.indexOf("(", match.index);
  const parenEnd = balancedEnd(source, parenStart, "(", ")");
  const braceStart = source.indexOf("{", parenEnd);
  const braceEnd = balancedEnd(source, braceStart, "{", "}");
  return source.slice(funcStart, braceEnd + 1);
}

function extractDeclaration(source, name) {
  const match = new RegExp(`\\b(?:const|let)\\s+${name}\\s*=\\s*`).exec(source);
  if (!match) throw new Error(`claims page declaration not found: ${name}`);
  const declStart = match.index;
  const valueStart = match.index + match[0].length;
  const firstChar = source[valueStart];
  let valueEnd;
  if (firstChar === "{") valueEnd = balancedEnd(source, valueStart, "{", "}");
  else if (firstChar === "[") valueEnd = balancedEnd(source, valueStart, "[", "]");
  else if (source.startsWith("new ", valueStart)) {
    const parenStart = source.indexOf("(", valueStart);
    valueEnd = balancedEnd(source, parenStart, "(", ")");
  } else {
    valueEnd = source.indexOf(";", valueStart) - 1;
  }
  const semicolon = source.indexOf(";", valueEnd);
  return source.slice(declStart, semicolon + 1);
}

// Pure status/priority/data-quality logic only. Each name here is either a
// function declaration or a top-level const/let the ones above depend on;
// nothing here touches the DOM, localStorage beyond a simple get/set, or
// network.
const FUNCTIONS = [
  "normaliseStatus",
  "hasSemanticStatus",
  "getStatusRule",
  "isTerminalStatus",
  "isPayment",
  "dataQualityFlagsForClaim",
  "buildDataQualityReport",
  "getExtractChangeDetails",
  "getPreviousProcessedClaimsForCurrent",
  "loadExtractHistory",
  "getPriority",
  "getReadyToCloseCandidate",
  "hasRecoveryPending",
];
const DECLARATIONS = [
  "STATUS_ALIASES",
  "STATUS_RULES",
  "STATUS_RULES_LC",
  "TERMINAL_STATUSES",
  "TERMINAL_STATUSES_LC",
  "MANDATE_THRESHOLD",
  "REPUDIATION_EXPIRY_DAYS",
  "EXTRACT_HISTORY_KEY",
  "MAX_EXTRACT_HISTORY",
  "currentExtractId",
];

async function loadClaimsPageStatusLogic() {
  const html = await readFile(
    new URL("../scout-smartsure/claims/index.html", import.meta.url),
    "utf8",
  );
  const scriptOpen = /\r?\n<script>\r?\n/.exec(html);
  assert.ok(scriptOpen, "claims page inline <script> tag not found");
  const scriptStart = scriptOpen.index + scriptOpen[0].length;
  const scriptEnd = html.lastIndexOf("</script>");
  const inline = html.slice(scriptStart, scriptEnd);

  const assembled = [
    ...DECLARATIONS.map((name) => extractDeclaration(inline, name)),
    ...FUNCTIONS.map((name) => extractFunction(inline, name)),
  ].join("\n\n");

  const store = new Map();
  const context = {
    console,
    window: {
      ScoutClaimsQA: { normalizeSourceStatus },
    },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
  };
  vm.createContext(context);
  vm.runInContext(assembled, context, {
    filename: "scout-smartsure/claims/index.html (extracted status logic)",
  });
  return context;
}

function fixtureClaim(overrides = {}) {
  return {
    status: "Registered",
    estimate: 1000,
    outstanding: 1000,
    handlerEmail: "handler@example.test",
    workingAge: 3,
    ...overrides,
  };
}

test("claims page: normaliseStatus reduces the [none] sentinel to empty", async () => {
  const page = await loadClaimsPageStatusLogic();
  assert.equal(page.normaliseStatus("[none]"), "");
  assert.equal(page.normaliseStatus(" [NONE] "), "");
  assert.equal(page.normaliseStatus("Registered"), "registered");
});

test("claims page: dataQualityFlagsForClaim reports missing status, not unmapped status", async () => {
  const page = await loadClaimsPageStatusLogic();

  const missing = page.dataQualityFlagsForClaim(fixtureClaim({ status: "[none]" }));
  assert.ok(missing.includes("Missing status"), `expected "Missing status" in ${JSON.stringify(missing)}`);
  assert.ok(!missing.includes("Unmapped status"));

  const unmapped = page.dataQualityFlagsForClaim(fixtureClaim({ status: "A status added later" }));
  assert.ok(unmapped.includes("Unmapped status"));
  assert.ok(!unmapped.includes("Missing status"));

  const mapped = page.dataQualityFlagsForClaim(fixtureClaim({ status: "Registered" }));
  assert.ok(!mapped.includes("Missing status"));
  assert.ok(!mapped.includes("Unmapped status"));
});

test("claims page: buildDataQualityReport counts missing and unmapped statuses separately", async () => {
  const page = await loadClaimsPageStatusLogic();
  const data = [
    fixtureClaim({ status: "[none]" }),
    fixtureClaim({ status: "A status added later" }),
    fixtureClaim({ status: "Registered" }),
  ];
  const report = page.buildDataQualityReport(data);
  assert.equal(report.missingStatuses.length, 1);
  assert.equal(report.unmappedStatuses.length, 1);
  // A genuinely unknown status must still be flagged as unmapped.
  assert.equal(report.unmappedStatuses[0].status, "A status added later");
  assert.equal(report.missingStatuses[0].status, "[none]");
});

test("claims page: priority/action for a missing status avoids unmapped-taxonomy language", async () => {
  const page = await loadClaimsPageStatusLogic();

  const missingPriority = page.getPriority(fixtureClaim({ status: "[none]", workingAge: 100 }));
  assert.equal(missingPriority.action, "Capture claim status");
  assert.ok(
    !missingPriority.flags.some((flag) => flag.label.includes("status not mapped")),
    "missing status must not surface a 'status not mapped' flag",
  );
  assert.ok(
    !missingPriority.action.toLowerCase().includes("not yet mapped"),
    "missing status must not use the unmapped-taxonomy action text",
  );

  const unmappedPriority = page.getPriority(fixtureClaim({ status: "A status added later", workingAge: 100 }));
  assert.equal(unmappedPriority.action, "Review  -  status not yet mapped in Scout");
  assert.ok(unmappedPriority.flags.some((flag) => flag.label.includes("status not mapped")));
});

// The frontend (scout-smartsure/claims/claims-qa.mjs, loaded by the browser)
// and this directory's own copy (reporting-domain/claims-qa.mjs, used by the
// backend Worker) must stay in lockstep for shared status-normalization
// logic. This is a direct parity check, not a duplicate reimplementation -
// it exists specifically to catch future drift the way it caught this one:
// the [none] sentinel fix landed in reporting-domain/claims-qa.mjs but not
// in the frontend copy, so the actual browser kept classifying "[none]" as
// unmapped even after the shared/backend fix shipped.
test("frontend and reporting-domain claims-qa normalizers agree on missing-status sentinels and unmapped statuses", () => {
  const cases = [
    ["[none]", ""],
    [" [NONE] ", ""],
    ["Registered", "registered"],
    ["A status added later", "a status added later"],
    // Unevidenced spellings must stay nonempty in BOTH implementations -
    // narrowing/broadening the sentinel set in only one copy is exactly the
    // kind of drift this test exists to catch.
    ["none", "none"],
    ["(none)", "(none)"],
    ["N/A", "n / a"],
  ];
  for (const [input, expected] of cases) {
    const frontendResult = normalizeSourceStatus(input);
    const reportingResult = reportingNormalizeSourceStatus(input);
    assert.equal(
      frontendResult,
      expected,
      `frontend normalizeSourceStatus(${JSON.stringify(input)})`,
    );
    assert.equal(
      reportingResult,
      expected,
      `reporting-domain normalizeSourceStatus(${JSON.stringify(input)})`,
    );
    assert.equal(
      frontendResult,
      reportingResult,
      `frontend/reporting-domain disagree on ${JSON.stringify(input)}`,
    );
  }
  // Explicitly lock in that the unevidenced spellings remain classified as
  // real (nonempty) statuses, not silently swallowed as missing.
  for (const unevidenced of ["none", "(none)", "N/A"]) {
    assert.notEqual(normalizeSourceStatus(unevidenced), "");
    assert.notEqual(reportingNormalizeSourceStatus(unevidenced), "");
  }
});

// Makes future module drift visible: if the claims page ever stops loading
// ./claims-qa.mjs, or this suite ever stops importing that same frontend
// asset, the whole point of the tests above - proving the ACTUAL browser
// module behaves correctly, not a substituted copy - silently stops holding.
test("production import contract: the claims page loads claims-qa.mjs, and this suite tests that same frontend module", async () => {
  const pageSource = await readFile(
    new URL("../scout-smartsure/claims/index.html", import.meta.url),
    "utf8",
  );
  assert.match(
    pageSource,
    /<script type="module" src="\.\/claims-qa\.mjs">/,
    "scout-smartsure/claims/index.html must load claims-qa.mjs as a module",
  );
  const frontendModuleUrl = new URL(
    "../scout-smartsure/claims/claims-qa.mjs",
    import.meta.url,
  );
  const frontendSource = await readFile(frontendModuleUrl, "utf8");
  assert.match(
    frontendSource,
    /export function normalizeSourceStatus/,
    "the frontend module this suite imports must be the real claims-qa.mjs export",
  );
});
