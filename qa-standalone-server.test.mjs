import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createQaServer } from "./qa-standalone-server.mjs";

test("synthetic review server serves only fixtures and blocks real APIs", async () => {
  const server = createQaServer();
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const origin = "http://127.0.0.1:" + server.address().port;
    const root = await fetch(origin + "/", { redirect: "manual" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/claims/");

    const page = await fetch(origin + "/claims/");
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /SYNTHETIC QA DATA/);
    assert.match(html, /https:\/\/scout-qa\.invalid/);
    assert.doesNotMatch(html, /scout-backend\.marketing-854\.workers\.dev/);
    assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.match(page.headers.get("x-robots-tag"), /noindex/);

    const config = await (await fetch(origin + "/claims/qa-preview-config.js")).text();
    assert.match(config, /fixtureMode: true/);

    const mock = await (await fetch(origin + "/claims/qa-fixtures.js")).text();
    assert.match(mock, /hostname === "scout-qa\.invalid"/);
    assert.doesNotMatch(mock, /hostname === "scout-backend\.marketing-854\.workers\.dev"/);

    for (const asset of ["/claims/reporting-ui.mjs", "/claims/ux-model.mjs", "/claims/claims-qa.mjs", "/claims/briefing-model.mjs", "/oauth-route.js"]) {
      const response = await fetch(origin + asset);
      assert.equal(response.status, 200, asset);
    }
    assert.equal((await fetch(origin + "/claims/upload", { method: "POST" })).status, 403);
    assert.equal((await fetch(origin + "/reports")).status, 404);
    assert.equal((await fetch(origin + "/claims/qa-fixtures.js", { method: "DELETE" })).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
