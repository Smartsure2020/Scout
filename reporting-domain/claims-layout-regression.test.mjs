import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const targets = [
  ["production", "index.html"],
  ["synthetic QA", "qa-preview-index.html"],
];

for (const [label, page] of targets) {
  test(label + " operational claims queue keeps distinct scrollable columns", () => {
    const html = readFileSync(new URL("../scout-smartsure/claims/" + page, import.meta.url), "utf8");

    assert.match(html, /\.grid-claims\s*\{[^}]*grid-template-columns:[^;]*;/);
    assert.match(html, /\.grid-claims\s*\{[^}]*min-width:\s*1320px/);
    assert.match(html, /\.claims-operational-scroll\s*\{[^}]*overflow-x:\s*auto/);
    assert.match(
      html,
      /<div class="claims-operational-scroll" id="claims-operational-scroll" role="region" aria-label="Claims operational queue, horizontally scrollable" tabindex="0">/,
    );


    assert.match(html, /class="claims-column-nav" role="group" aria-label="Navigate claims table columns"/);
    assert.match(html, /onclick="scrollClaimsColumns\(-1\)" aria-label="Scroll claims table left"/);
    assert.match(html, /onclick="scrollClaimsColumns\(1\)" aria-label="Scroll claims table right"/);
    const navIndex = html.indexOf('class="claims-column-nav"');
    const scrollRegionIndex = html.indexOf('id="claims-operational-scroll"');
    assert.ok(navIndex >= 0 && scrollRegionIndex > navIndex, "Navigation stays above the scrolling content");
    const navFunction = html.match(/^function scrollClaimsColumns\(direction\)\s*\{[\s\S]*?^\}/m)?.[0];
    assert.ok(navFunction, "Missing live claims table horizontal navigation handler");
    const calls = [];
    const sandbox = { document: { getElementById: () => ({
      clientWidth: 700,
      scrollBy: (options) => calls.push(options),
    }) } };
    runInNewContext(navFunction + "\nscrollClaimsColumns(-1);\nscrollClaimsColumns(1);", sandbox, { timeout: 1000 });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].left < 0 && calls[1].left > 0);
    assert.equal(calls[0].behavior, "smooth");
    assert.equal(calls[1].behavior, "smooth");

    // Secondary metadata must occupy its own line and stay inside its grid cell.
    assert.match(
      html,
      /\.grid-claims \.claim-no,\s*\.grid-claims \.insured-name,\s*\.grid-claims \.action-meta\s*\{[^}]*display:\s*block;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/,
    );
    assert.match(html, /\.grid-claims > span\s*\{\s*min-width:\s*0;\s*overflow:\s*hidden;/);
    assert.match(
      html,
      /\.grid-claims \.status-chip,\s*\.grid-claims \.priority-category-badge\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/,
    );

    assert.match(html, /#view-all-claims > \.page-header\s*\{\s*flex-wrap:\s*wrap;/);
    assert.match(html, /#view-all-claims \.page-title\s*\{\s*white-space:\s*nowrap;/);
    assert.match(
      html,
      /@media\s*\(max-width:\s*980px\)\s*\{[\s\S]*?\.grid-claims\s*\{\s*min-width:\s*1320px;\s*\}/,
    );
    assert.doesNotMatch(html, /grid-template-columns:\s*88px 115px 150px/);
    assert.match(html, /<div class="table-head grid-claims">/);
    assert.match(html, /<div class="table-row grid-claims" data-claim-no=/);
  });
  test(label + " manager finance panels stack before their cards are squeezed", () => {
    const html = readFileSync(new URL("../scout-smartsure/claims/" + page, import.meta.url), "utf8");
    assert.match(
      html,
      /<div class="two-col manager-finance-grid">\s*<div>\s*<div class="section-header">\s*<div class="section-title">Mandate authority dashboard/,
    );
    assert.match(
      html,
      /@media\s*\(max-width:\s*1450px\)\s*\{\s*\.manager-finance-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    );
    // Stacking is a presentation-only change; the source renderers retain their output.
    assert.match(html, /function renderMandateDashboard\(active\)/);
    assert.match(html, /function renderPaymentPipeline\(active\)/);
  });

}
