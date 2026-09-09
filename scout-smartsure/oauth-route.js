(function () {
  const ALLOWED_VIEWS = new Set([
    "today",
    "claims",
    "claim",
    "exceptions",
    "manager",
    "teams",
    "history",
    "digest-history",
    "settings",
    "reports",
  ]);
  const ALLOWED_EXCEPTIONS = new Set([
    "all",
    "critical",
    "sla-risk",
    "no-movement",
    "zero-estimate",
    "mandate",
    "external-delay",
    "closure",
  ]);
  const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  const REPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  const REPORT_TABS = new Set(["weekly", "monthly", "history"]);
  const ROUTE_VALUES = [
    "handler",
    "search",
    "status",
    "priority",
    "category",
    "insurer",
    "from",
    "to",
    "min",
  ];

  function safeValue(value) {
    const text = String(value || "");
    return text && text.length <= 200 && !/[\u0000-\u001f\u007f]/.test(text)
      ? text
      : "";
  }

  function readHashRoute(url) {
    let hash = (url.hash || "").replace(/^#/, "");
    try {
      hash = decodeURIComponent(hash);
    } catch {
      return {};
    }
    if (hash.startsWith("claim/")) return { view: "claim", claim: hash.slice(6) };
    if (hash.startsWith("exceptions/")) return { view: "exceptions", exception: hash.slice(11) || "all" };
    if (hash.startsWith("claims")) return { view: "claims" };
    return {};
  }

  function buildOAuthRelayTarget(href, origin) {
    const source = new URL(href, origin);
    const target = new URL("/claims/", origin);
    const params = source.searchParams;
    const hashRoute = params.has("view") ? {} : readHashRoute(source);
    let view = params.get("view") || hashRoute.view || "today";
    let claim = params.get("claim") || hashRoute.claim || "";
    const exception = params.get("exception") || hashRoute.exception || "all";

    if (claim) view = "claim";
    if (!ALLOWED_VIEWS.has(view)) view = "today";

    if (view === "claim") {
      claim = safeValue(claim);
      if (!CLAIM_ID.test(claim)) return target.pathname;
      target.searchParams.set("view", "claim");
      target.searchParams.set("claim", claim);
      return target.pathname + target.search;
    }

    if (view === "claims") {
      target.searchParams.set("view", "claims");
      for (const key of ROUTE_VALUES) {
        const value = safeValue(params.get(key));
        if (value && value !== "all") target.searchParams.set(key, value);
      }
      if (params.get("zero") === "1") target.searchParams.set("zero", "1");
      return target.pathname + target.search;
    }

    if (view === "exceptions") {
      target.searchParams.set("view", "exceptions");
      if (ALLOWED_EXCEPTIONS.has(exception) && exception !== "all") {
        target.searchParams.set("exception", exception);
      }
      const handler = safeValue(params.get("handler"));
      if (handler && handler !== "all") target.searchParams.set("handler", handler);
      return target.pathname + target.search;
    }

    if (view === "reports") {
      target.searchParams.set("view", "reports");
      const reportTab = params.get("reportTab");
      if (REPORT_TABS.has(reportTab)) {
        target.searchParams.set("reportTab", reportTab);
        if (reportTab === "history") {
          const report = safeValue(params.get("report"));
          if (report && REPORT_ID.test(report)) target.searchParams.set("report", report);
        }
      }
      return target.pathname + target.search;
    }

    if (view !== "today") target.searchParams.set("view", view);
    return target.pathname + target.search;
  }

  function mergeOAuthCallbackParams(relayTarget, callbackHref, origin) {
    const target = new URL(relayTarget, origin);
    if (target.origin !== origin || target.pathname !== "/claims/") return "";
    const callback = new URL(callbackHref, origin);
    ["code", "state", "session_state", "error", "error_description", "error_uri"].forEach((key) => {
      if (callback.searchParams.has(key)) target.searchParams.set(key, callback.searchParams.get(key));
    });
    return target.pathname + target.search + target.hash;
  }

  window.ScoutOAuthRoute = { buildOAuthRelayTarget, mergeOAuthCallbackParams };
})();
