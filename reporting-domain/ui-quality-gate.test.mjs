import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const portalHtml = readFileSync(new URL("../scout-smartsure/index.html", import.meta.url), "utf8");
const claimPages = [
  "index.html",
  "qa-preview-index.html",
].map((name) => ({
  name,
  html: readFileSync(new URL("../scout-smartsure/claims/" + name, import.meta.url), "utf8"),
}));

function themeColor(html, name) {
  const match = html.match(new RegExp("--" + name + "\\s*:\\s*(#[0-9a-f]{6})", "i"));
  assert.ok(match, "Missing theme color " + name);
  return match[1];
}

function linearChannel(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const channels = [1, 3, 5].map((offset) =>
    linearChannel(parseInt(hex.slice(offset, offset + 2), 16)),
  );
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("the portal and claims pages keep muted text readable on their light surfaces", () => {
  for (const { name, html } of [{ name: "portal", html: portalHtml }, ...claimPages]) {
    const muted = themeColor(html, "ws-text-muted");
    for (const surface of ["ws-surface", "ws-bg"]) {
      const background = themeColor(html, surface);
      assert.ok(
        contrastRatio(muted, background) >= 4.5,
        name + ": " + muted + " on " + background + " (" + surface + ") falls below 4.5:1",
      );
    }
  }
});

test("the Claims Operations portal card is a native, focus-visible link", () => {
  assert.match(
    portalHtml,
    /<a class="portal-card claims" href="\$\{CONFIG\.claimsUrl\}" aria-label="Open Claims Operations">/,
  );
  assert.match(portalHtml, /<div class="portal-card-btn">Open Claims Portal<\/div>\s*<\/a>/);
  assert.match(portalHtml, /\.portal-card:focus-visible\s*\{[^}]*outline:/);
  assert.doesNotMatch(portalHtml, /class="portal-card claims" onclick=/);
  assert.match(portalHtml, /<div class="portal-card uw" aria-disabled="true">/);
});

test("portal sign-in and action cards fit narrow phone viewports", () => {
  assert.match(portalHtml, /\.auth-card\s*\{[^}]*max-width:\s*calc\(100vw - 32px\)/);
  assert.match(portalHtml, /\.portal-cards\s*\{[^}]*width:\s*100%/);
  assert.match(portalHtml, /\.portal-card\s*\{[^}]*max-width:\s*100%/);
});
test("production and QA reports allow coverage warnings to wrap on mobile", () => {
  for (const { name, html } of claimPages) {
    assert.match(
      html,
      /\.report-coverage-banner > div\s*\{\s*flex-wrap:\s*wrap;\s*white-space:\s*normal;\s*min-width:\s*0;\s*\}/,
      name,
    );
    assert.match(
      html,
      /\.report-coverage-banner > span\s*\{\s*min-width:\s*0;\s*overflow-wrap:\s*anywhere;\s*\}/,
      name,
    );
    assert.match(
      html,
      /@media\s*\(max-width:\s*640px\)\s*\{\s*\.report-period-header,\s*\.report-history-header,\s*\.report-coverage-banner/,
      name,
    );
  }
});
