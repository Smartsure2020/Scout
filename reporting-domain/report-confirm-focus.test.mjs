// Behavioural regressions for the report-confirm dialog accessibility fix:
// focus must leave the dialog BEFORE aria-hidden="true" is applied, so a
// focused descendant is never retained under an aria-hidden subtree
// (the "Blocked aria-hidden on an element because its descendant retained
// focus" warning).
import test from "node:test";
import assert from "node:assert/strict";
import { ReportsController } from "../scout-smartsure/claims/reporting-ui.mjs";

function harness() {
  const events = [];
  const confirmButton = {
    blur() {
      events.push("active-blur");
    },
  };
  const origin = {
    isConnected: true,
    getClientRects: () => [{}],
    focus() {
      events.push("origin-focus");
    },
  };
  const backdrop = {
    classList: {
      remove() {
        events.push("show-remove");
      },
    },
    setAttribute(name, value) {
      if (name === "aria-hidden") events.push(`aria-hidden:${value}`);
    },
    contains(node) {
      return node === confirmButton;
    },
  };
  const document = {
    activeElement: confirmButton,
    getElementById(id) {
      return id === "report-confirm-backdrop" ? backdrop : null;
    },
    addEventListener() {},
    querySelector() {
      return null;
    },
  };
  const controller = new ReportsController({
    document,
    getContext: () => ({ user: { role: "manager" }, freshness: null }),
  });
  return { controller, events, origin, confirmButton };
}

test("10. closeConfirm moves focus out of the dialog before aria-hidden=true", () => {
  const { controller, events, origin } = harness();
  controller.confirmOriginFocus = origin;
  controller.confirmResolver = () => {};

  controller.closeConfirm(true);

  const focusIndex = events.indexOf("origin-focus");
  const hiddenIndex = events.indexOf("aria-hidden:true");
  assert.ok(focusIndex >= 0, "origin focus should be restored synchronously");
  assert.ok(hiddenIndex >= 0, "aria-hidden=true should be applied");
  assert.ok(
    focusIndex < hiddenIndex,
    "focus must leave the dialog before aria-hidden=true",
  );
});

test("10b. when the origin is gone, the focused dialog element is blurred first", () => {
  const { controller, events } = harness();
  controller.confirmOriginFocus = null; // origin no longer focusable
  controller.confirmResolver = () => {};

  controller.closeConfirm(false);

  const blurIndex = events.indexOf("active-blur");
  const hiddenIndex = events.indexOf("aria-hidden:true");
  assert.ok(blurIndex >= 0, "focused dialog element should be blurred");
  assert.ok(blurIndex < hiddenIndex, "blur must precede aria-hidden=true");
});

test("11. origin focus is restored (synchronously and via the deferred restore)", async () => {
  const { controller, events, origin } = harness();
  controller.confirmOriginFocus = origin;
  controller.confirmResolver = () => {};

  controller.closeConfirm(true);
  assert.ok(events.includes("origin-focus"), "origin focus restored");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    events.filter((event) => event === "origin-focus").length >= 1,
    "deferred restore keeps origin focus",
  );
});

test("12. existing confirm behaviour still resolves with the result and hides the dialog", () => {
  const { controller, events, origin } = harness();
  controller.confirmOriginFocus = origin;
  let resolved;
  controller.confirmResolver = (value) => {
    resolved = value;
  };

  controller.closeConfirm(true);

  assert.equal(resolved, true, "confirmation resolves with the chosen result");
  assert.ok(events.includes("show-remove"), "the show class is removed");
  assert.ok(events.includes("aria-hidden:true"), "the dialog is hidden");
  assert.equal(controller.confirmResolver, null, "resolver is cleared");
  assert.equal(controller.confirmOriginFocus, null, "origin focus is cleared");
});
