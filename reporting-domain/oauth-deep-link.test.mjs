import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const origin = "https://preview.example";

async function loadRouteHelper() {
  const source = await readFile(
    new URL("../scout-smartsure/oauth-route.js", import.meta.url),
    "utf8",
  );
  const context = {
    URL,
    URLSearchParams,
    Set,
    decodeURIComponent,
    window: {},
  };
  vm.runInNewContext(source, context);
  return context.window.ScoutOAuthRoute;
}

test("OAuth relay preserves a claim deep link while callback cleanup keeps only Scout route state", async () => {
  const route = await loadRouteHelper();
  const relayTarget = route.buildOAuthRelayTarget(
    `${origin}/claims/?view=claim&claim=QA-0001&next=https%3A%2F%2Fevil.example`,
    origin,
  );
  assert.equal(relayTarget, "/claims/?view=claim&claim=QA-0001");

  const callbackUrl = route.mergeOAuthCallbackParams(
    relayTarget,
    `${origin}/?code=code-value&state=state-value&session_state=session-value`,
    origin,
  );
  assert.equal(
    callbackUrl,
    "/claims/?view=claim&claim=QA-0001&code=code-value&state=state-value&session_state=session-value",
  );
});

test("OAuth relay normalizes claims and exception routes and rejects external targets", async () => {
  const route = await loadRouteHelper();
  assert.equal(
    route.buildOAuthRelayTarget(
      `${origin}/claims/?view=claims&priority=critical&handler=Blair%20Handler&redirect=https%3A%2F%2Fevil.example`,
      origin,
    ),
    "/claims/?view=claims&handler=Blair+Handler&priority=critical",
  );
  assert.equal(
    route.buildOAuthRelayTarget(
      `${origin}/claims/?view=exceptions&exception=closure`,
      origin,
    ),
    "/claims/?view=exceptions&exception=closure",
  );
  assert.equal(
    route.mergeOAuthCallbackParams(
      "https://evil.example/claims/",
      `${origin}/?code=x`,
      origin,
    ),
    "",
  );
});

test("OAuth relay preserves valid Reports tab and detail state through cold authentication", async () => {
  const route = await loadRouteHelper();
  for (const reportTab of ["weekly", "monthly", "history"]) {
    assert.equal(
      route.buildOAuthRelayTarget(
        `${origin}/claims/?view=reports&reportTab=${reportTab}`,
        origin,
      ),
      `/claims/?view=reports&reportTab=${reportTab}`,
    );
  }
  const relayTarget = route.buildOAuthRelayTarget(
    `${origin}/claims/?view=reports&reportTab=history&report=40000000-0000-0000-0000-000000000002`,
    origin,
  );
  assert.equal(
    relayTarget,
    "/claims/?view=reports&reportTab=history&report=40000000-0000-0000-0000-000000000002",
  );
  assert.equal(
    route.mergeOAuthCallbackParams(
      relayTarget,
      `${origin}/?code=code-value&state=state-value&session_state=session-value`,
      origin,
    ),
    "/claims/?view=reports&reportTab=history&report=40000000-0000-0000-0000-000000000002&code=code-value&state=state-value&session_state=session-value",
  );
});

test("OAuth relay drops invalid Reports substate without corrupting the route", async () => {
  const route = await loadRouteHelper();
  assert.equal(
    route.buildOAuthRelayTarget(
      `${origin}/claims/?view=reports&reportTab=unknown&report=bad`,
      origin,
    ),
    "/claims/?view=reports",
  );
  assert.equal(
    route.buildOAuthRelayTarget(
      `${origin}/claims/?view=reports&reportTab=history&report=https%3A%2F%2Fevil.example`,
      origin,
    ),
    "/claims/?view=reports&reportTab=history",
  );
  assert.equal(
    route.buildOAuthRelayTarget(
      `${origin}/claims/?view=claim&claim=QA-0001&reportTab=history`,
      origin,
    ),
    "/claims/?view=claim&claim=QA-0001",
  );
});
