export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/claims/qa-preview-config.js") {
      const enabled = String(env.SCOUT_QA_FIXTURE_MODE || "").toLowerCase() === "true";
      const config = {
        fixtureMode: enabled,
        baseUrl: env.SCOUT_CLAIMS_URL || env.SCOUT_BASE_URL || `${url.origin}/claims/`,
        label: "UX REMEDIATION PREVIEW · SYNTHETIC QA DATA",
      };
      return new Response(`window.ScoutQAConfig = Object.freeze(${JSON.stringify(config)});`, {
        headers: {
          "Content-Type": "application/javascript; charset=UTF-8",
          "Cache-Control": "no-store",
        },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
