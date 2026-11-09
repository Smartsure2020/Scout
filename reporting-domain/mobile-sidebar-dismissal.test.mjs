import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function classNames(initial = []) {
  const names = new Set(initial);
  return {
    add(name) { names.add(name); },
    remove(name) { names.delete(name); },
    contains(name) { return names.has(name); },
    toggle(name) {
      if (names.has(name)) { names.delete(name); return false; }
      names.add(name);
      return true;
    },
  };
}

for (const name of ["index.html", "qa-preview-index.html"]) {
  test(name + " mobile navigation closes on selection, Escape and viewport resize", () => {
    const source = readFileSync(new URL("../scout-smartsure/claims/" + name, import.meta.url), "utf8");
    assert.match(source, /\.sidebar\.mobile-open:not\(\.sb-collapsed\)\s*\{\s*transform:\s*translateX\(0\)/);
    assert.match(source, /\.sidebar-backdrop\.is-open\s*\{\s*display:\s*block/);
    assert.match(source, /<button class="sidebar-backdrop" id="sidebar-backdrop" type="button" aria-label="Close mobile navigation" onclick="closeMobileSidebar\(true\)"/);
    assert.match(source, /\.sidebar-toggle\[aria-expanded="true"\] \.hamburger/);
    assert.doesNotMatch(source, /\.sidebar-toggle\[aria-expanded="false"\] \.hamburger/);

    const start = source.indexOf('const mobileSidebarMedia = window.matchMedia?.("(max-width: 640px)");');
    const end = source.indexOf("const hr = new Date().getHours();", start);
    assert.ok(start >= 0 && end > start, name + ": missing mobile navigation lifecycle");
    const logic = source.slice(start, end);

    const events = {};
    const mediaListeners = {};
    const sidebar = {
      classList: classNames(),
      inert: false,
      addEventListener(event, callback) { events["sidebar-" + event] = callback; },
    };
    const backdrop = { classList: classNames() };
    const attributes = {};
    let focusCount = 0;
    const button = {
      setAttribute(name, value) { attributes[name] = value; },
      focus() { focusCount += 1; },
    };
    const elements = { "scout-sidebar": sidebar, "sidebar-backdrop": backdrop, "sidebar-toggle": button };
    const media = {
      matches: true,
      addEventListener(event, callback) { mediaListeners[event] = callback; },
    };
    const context = {
      window: { matchMedia: () => media },
      document: {
        getElementById(id) { return elements[id] || null; },
        addEventListener(event, callback) { events["document-" + event] = callback; },
      },
      loadTeamsConfig() {},
    };
    runInNewContext(logic, context, { timeout: 1000 });

    assert.equal(sidebar.classList.contains("sb-collapsed"), true);
    assert.equal(sidebar.inert, true);
    assert.equal(attributes["aria-expanded"], "false");

    context.toggleSidebar();
    assert.equal(sidebar.classList.contains("mobile-open"), true);
    assert.equal(sidebar.inert, false);
    assert.equal(backdrop.classList.contains("is-open"), true);
    assert.equal(attributes["aria-expanded"], "true");

    // Expanding a secondary list does not dismiss the menu.
    events["sidebar-click"]({ type: "click", target: { closest: () => null } });
    assert.equal(sidebar.classList.contains("mobile-open"), true);
    // Choosing a real destination dismisses the menu automatically.
    events["sidebar-click"]({ type: "click", target: { closest: () => ({}) } });
    assert.equal(sidebar.classList.contains("mobile-open"), false);
    assert.equal(backdrop.classList.contains("is-open"), false);
    assert.equal(sidebar.inert, true);
    assert.equal(attributes["aria-expanded"], "false");

    context.toggleSidebar();
    events["sidebar-keydown"]({ type: "keydown", key: "Enter", target: { closest: () => ({}) } });
    assert.equal(sidebar.classList.contains("mobile-open"), false);
    assert.equal(focusCount, 1);

    context.toggleSidebar();
    let prevented = false;
    events["document-keydown"]({ key: "Escape", preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(sidebar.classList.contains("mobile-open"), false);
    assert.equal(focusCount, 2);

    // Resize from desktop to mobile must not leave the desktop sidebar covering content.
    media.matches = false;
    mediaListeners.change();
    assert.equal(sidebar.classList.contains("sb-collapsed"), false);
    assert.equal(sidebar.inert, false);
    assert.equal(backdrop.classList.contains("is-open"), false);
    media.matches = true;
    mediaListeners.change();
    assert.equal(sidebar.classList.contains("sb-collapsed"), true);
    assert.equal(sidebar.inert, true);
  });
}
