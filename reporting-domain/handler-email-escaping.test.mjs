import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

for (const page of ["index.html", "qa-preview-index.html"]) {
  test(`handler email rendering escapes attribute content in ${page}`, () => {
    const source = readFileSync(new URL(`../scout-smartsure/claims/${page}`, import.meta.url), "utf8");
    const escapeFn = source.match(/^function esc\(str\)\s*\{[\s\S]*?^\}/m)?.[0];
    const renderFn = source.match(/^function renderHandlerEmailMap\(\)\s*\{[\s\S]*?^\}/m)?.[0];
    assert.ok(escapeFn, "Missing app HTML escaping function");
    assert.ok(renderFn, "Missing handler-email rendering function");

    const element = { innerHTML: "" };
    const email = 'handler@example.test" autofocus onfocus="alert(1)&';
    const context = {
      scoutSettings: { handler_emails: {} },
      getTeamsConfig: () => ({ handlerEmails: {} }),
      configuredHandlerNames: () => ["Alex Handler"],
      handlerIdentityKey: () => "alexhandler",
      getHandlerEmail: () => email,
      document: { getElementById: (id) => id === "handler-email-map" ? element : null },
      updateBriefingDestinationStatus() {},
    };
    runInNewContext(escapeFn + "\n" + renderFn + "\nrenderHandlerEmailMap();", context, { timeout: 1000 });

    assert.match(element.innerHTML, /value="handler@example\.test&quot; autofocus onfocus=&quot;alert\(1\)&amp;"/);
    assert.doesNotMatch(element.innerHTML, /onfocus="/);
    assert.match(element.innerHTML, /data-handler="alexhandler"/);
  });
}
