import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const targets = [
  ["production", "index.html"],
  ["synthetic QA", "qa-preview-index.html"],
];

for (const [label, page] of targets) {
  test(label + " operational claims queue keeps distinct scrollable columns", () => {
    const html = readFileSync(new URL("../scout-smartsure/claims/" + page, import.meta.url), "utf8");

    assert.match(html, /\.grid-claims\s*\{[^}]*grid-template-columns:[^;]*;/);
    assert.match(html, /\.grid-claims\s*\{[^}]*min-width:\s*1320px/);
    assert.match(html, /\.claims-operational-table\s*\{[^}]*overflow-x:\s*auto/);
    assert.match(
      html,
      /<div class="claims-table claims-operational-table" role="region" aria-label="Claims operational queue, horizontally scrollable" tabindex="0">/,
    );

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
}
