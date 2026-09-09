(function installSyntheticQa(window) {
  "use strict";

  const EXTRACT_DATE = "2026-09-03";
  const RECEIVED_AT = "2026-09-03T06:30:00+02:00";
  const PREVIOUS_DATE = "2026-09-02";
  const HANDLERS = [
    "Alex Handler",
    "Blair Handler",
    "Casey Handler",
    "Devon Handler",
    "Evan Handler",
  ];
  const INSURERS = ["Synthetic Mutual", "QA General", "Example Assurance"];
  const PERILS = ["Storm", "Water damage", "Vehicle collision", "Theft", "Fire"];
  const SAFE_STATUSES = [
    "In Progress",
    "Repairs in Progress",
    "Awaiting Claim Form",
    "Assessors Appointment Confirmed",
    "Awaiting Authorisation",
    "Payment - Approved",
  ];

  function dateBefore(days) {
    const date = new Date(`${EXTRACT_DATE}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - Number(days || 0));
    return date.toISOString().slice(0, 10);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function idFor(index) {
    return `QA-${String(index).padStart(4, "0")}`;
  }

  function claimRecord(index, overrides = {}) {
    const age = Number(overrides.age ?? (3 + (index * 7) % 25));
    const movementDays = Number(overrides.movementDays ?? Math.min(age, 2));
    const handler = overrides.handler || HANDLERS[(index - 1) % HANDLERS.length];
    const outstanding = Number(overrides.outstanding ?? (8500 + ((index * 1375) % 48000)));
    const estimate = Number(overrides.estimate ?? Math.round(outstanding * 1.12));
    return {
      claim_id: `qa-internal-${String(index).padStart(4, "0")}`,
      claim_no: idFor(index),
      insured_name: overrides.insured || `Synthetic Insured ${String(index).padStart(2, "0")}`,
      handler_name: handler,
      handler_email: `${handler.split(" ")[0].toLowerCase()}@synthetic.invalid`,
      insurer: overrides.insurer || INSURERS[(index - 1) % INSURERS.length],
      peril: overrides.peril || PERILS[(index - 1) % PERILS.length],
      status: overrides.status || SAFE_STATUSES[(index - 1) % SAFE_STATUSES.length],
      registered_date: overrides.registered || dateBefore(age),
      last_updated: overrides.lastUpdated || dateBefore(movementDays),
      last_updated_source: overrides.lastUpdatedSource || "synthetic-qa-fixture",
      description: overrides.description || "Synthetic QA claim for frontend acceptance only.",
      comments: overrides.comments || "Synthetic QA context; no operational record exists.",
      outstanding,
      estimate,
      cardinal_estimate: estimate,
      dol: overrides.dol || dateBefore(age + 1),
      due_date: overrides.dueDate || "",
      settled_date: overrides.settledDate || "",
      repudiation_date: overrides.repudiationDate || "",
    };
  }

  function buildClaims() {
    const claims = [];
    const add = (status, options = {}) => {
      const index = claims.length + 1;
      claims.push(claimRecord(index, { ...options, status }));
    };

    // Explicit operating conditions. These are ordinary records selected to
    // exercise the existing rule engine; no scoring or rule is changed here.
    [
      ["Awaiting Assessor Report", 22], ["Awaiting Broker Feedback", 15],
      ["Awaiting investigators report", 19], ["Over Mandate", 8],
      ["In Progress", 42], ["Awaiting Authorisation", 18],
      ["Payment - Pending Approval", 22], ["Awaiting Claim Form", 16],
    ].forEach(([status, age], offset) => add(status, {
      age,
      movementDays: age > 25 ? 24 : 10,
      outstanding: offset === 4 ? 225000 : 28000 + offset * 9000,
      estimate: offset === 6 ? 0 : 42000 + offset * 7000,
      description: offset === 4 ? "High-value authority decision required." : undefined,
    }));

    [
      ["Awaiting Assessor Report", 9], ["Awaiting Broker Feedback", 4],
      ["Awaiting investigators report", 9], ["Repairs in Progress", 9],
      ["In Progress", 7], ["Awaiting Claim Form", 7],
      ["Awaiting Authorisation", 4], ["Payment - Pending Approval", 8],
    ].forEach(([status, age], offset) => add(status, {
      age,
      movementDays: Math.max(1, age - 1),
      outstanding: 12000 + offset * 4600,
    }));

    [10, 11, 12, 13, 14, 15].forEach((age, offset) => add("Payment Requested", {
      age,
      movementDays: Math.min(age, 6),
      outstanding: 18000 + offset * 2400,
      estimate: 0,
      description: "Payment-stage claim requiring estimate validation.",
    }));

    [11, 15, 19, 24, 33, 38].forEach((age, offset) => add("In Progress", {
      age,
      movementDays: 8 + (offset % 4),
      outstanding: 145000 + offset * 17000,
      estimate: 165000 + offset * 15000,
      description: "High-value claim requiring mandate authority review.",
    }));

    [12, 18, 23, 31, 36, 44].forEach((age, offset) => add("Repairs in Progress", {
      age,
      movementDays: 9 + (offset % 5),
      outstanding: 18000 + offset * 3900,
      estimate: 24000 + offset * 4200,
    }));

    [
      ["Awaiting Assessor Report", "assessor"],
      ["Awaiting investigators report", "investigator"],
      ["Awaiting Broker Feedback", "broker/client"],
      ["Awaiting Claim Form", "broker/client"],
      ["Pending Assessor Feedback", "assessor"],
      ["Awaiting reply from insurer", "insurer"],
    ].forEach(([status, party], offset) => add(status, {
      age: 13 + offset * 3,
      movementDays: 11 + offset,
      outstanding: 22000 + offset * 5000,
      description: `Awaiting ${party} response in synthetic QA data.`,
    }));

    [
      ["Payment - Payments Made", 40, false],
      ["Payment - Payments Made", 40, true],
      ["Payment Released", 21, false],
      ["Repudiated - Awaiting Closure", 12, false],
      ["Payment Requested", 50, false],
      ["Registered", 90, false],
    ].forEach(([status, age, recovery], offset) => add(status, {
      age,
      movementDays: age,
      outstanding: recovery ? 3200 : offset === 4 ? 44000 : 0,
      estimate: status === "Payment Requested" ? 0 : 0,
      comments: recovery ? "Recovery pending; management review required." : "Final checks remain before closure.",
      description: recovery ? "Recovery pending." : "Synthetic closure candidate for QA.",
    }));

    // New claims are deliberately recent and marked as first observed for the
    // comparison/briefing UI. The previous fixture omits these identifiers.
    ["Registered", "FNOL Registered", "Take On Claim", "Notified", "All documents received"].forEach((status, offset) => add(status, {
      age: 0,
      movementDays: 0,
      lastUpdatedSource: "new-claim",
      outstanding: 5000 + offset * 2100,
      estimate: 8000 + offset * 3000,
    }));

    // Quiet portfolio members prevent QA from becoming an artificial wall of
    // red and amber states.
    while (claims.length < 100) {
      const offset = claims.length;
      add(SAFE_STATUSES[offset % SAFE_STATUSES.length], {
        age: 1 + (offset % 4),
        movementDays: offset % 2,
        outstanding: 6000 + (offset % 8) * 1750,
        estimate: 9000 + (offset % 8) * 2100,
      });
    }

    // A few settled records exercise terminal handling without pretending the
    // portfolio is all unresolved work.
    ["Closed Paid", "Closed Paid", "Payment Released", "Closed Paid"].forEach((status, offset) => {
      const index = claims.length + 1;
      claims.push(claimRecord(index, {
        status,
        age: 8 + offset,
        movementDays: 1,
        outstanding: 0,
        estimate: 0,
        settledDate: dateBefore(2 + offset),
        description: "Synthetic completed claim.",
        comments: "No production record; fixture only.",
      }));
    });
    return claims;
  }

  function toFrontendClaim(raw) {
    return {
      claimNo: raw.claim_no,
      status: raw.status,
      handler: raw.handler_name,
      handlerEmail: raw.handler_email,
      registered: raw.registered_date,
      lastUpdated: raw.last_updated,
      outstanding: raw.outstanding,
      estimate: raw.estimate,
      insured: raw.insured_name,
      insurer: raw.insurer,
      peril: raw.peril,
      description: raw.description,
      comments: raw.comments,
      age: raw.age_days,
    };
  }

  function buildPreviousClaims(current) {
    return current.slice(0, 87).map((claim, index) => {
      const copy = toFrontendClaim(claim);
      if (index % 9 === 0) copy.status = "In Progress";
      if (index % 11 === 0) copy.estimate = Number(copy.estimate || 0) + 5000;
      return copy;
    }).concat([
      toFrontendClaim(claimRecord(901, { status: "Closed Paid", age: 20, outstanding: 0, estimate: 0 })),
      toFrontendClaim(claimRecord(902, { status: "Payment Released", age: 18, outstanding: 0, estimate: 0 })),
    ]);
  }

  function metric(value, precision = "snapshot_exact", warnings = []) {
    return {
      value,
      availability: "available",
      precision,
      coverage_warnings: warnings,
    };
  }

  function reportSnapshot(type, periodStart, claims, warning = false) {
    const active = claims.filter((claim) => !["Closed Paid"].includes(claim.status));
    const exposure = active.reduce((sum, claim) => sum + Number(claim.outstanding || 0), 0);
    const handlers = HANDLERS.map((handler) => {
      const own = active.filter((claim) => claim.handler_name === handler);
      return {
        handler_name: handler,
        handler_email: `${handler.split(" ")[0].toLowerCase()}@synthetic.invalid`,
        open_claims: own.length,
        claims_60_plus: own.filter((claim) => claim.age_days >= 60).length,
        claims_91_plus: 0,
        sla_breaches: own.filter((claim) => claim.age_days >= 14).length,
        no_movement_over_14: own.filter((claim) => claim.age_days >= 14).length,
        no_movement_over_30: own.filter((claim) => claim.age_days >= 30).length,
        ready_to_close: own.filter((claim) => ["Payment - Payments Made", "Payment Released"].includes(claim.status)).length,
      };
    });
    const warningList = warning ? ["unknown_registration_dates"] : [];
    return {
      report_type: type,
      period_start_local_date: periodStart,
      period_end_local_date: type === "weekly" ? "2026-08-30" : "2026-10-01",
      coverage_status: warning ? "usable_with_warnings" : "complete",
      coverage: {
        accepted_extract_count: warning ? 1 : 2,
        warning_quality_extract_count: warning ? 1 : 0,
        historical_capability_start_date: "2026-07-01",
        warnings: warningList,
      },
      metrics: {
        opening_inventory: metric(Math.max(0, active.length - 4)),
        closing_inventory: metric(active.length),
        new_claims_registered: metric(5),
        new_claims_first_observed: metric(0),
        claims_closed: metric(4, "observed_period"),
        net_inventory_movement: metric(4),
        open_claims_60_plus: metric(active.filter((claim) => claim.age_days >= 60).length),
        open_claims_91_plus: metric(0),
        sla_compliance: metric(0.78),
        ready_to_close: metric(6),
        ageing_distribution: metric({ "0-30": 63, "31-60": 27, "61-90": 10, "91+": 0, unknown: 0 }),
        sla_summary: metric({ compliant: 78, unmapped: 0 }),
        sla_breaches: metric(22),
        operational_health: metric({ assessor_overdue: 8, investigator_overdue: 5, broker_overdue: 7, high_value_mandate_attention: 12, legal_recovery: 2, nfo_ombudsman: 0, fraud: 0, repudiation_expired: 1 }),
        handler_performance: metric({ handlers, manager_held_other: { count: 0 }, unassigned_unresolved: { count: 0 } }),
        financial_open_outstanding: metric(exposure, "snapshot_exact"),
        financial_estimate_total: metric(Math.round(exposure * 1.12), "snapshot_exact"),
        financial_paid_total: metric(325000, "observed_period"),
        assignment_activity: metric(3, "observed_period"),
      },
    };
  }

  function buildReports(claims) {
    const weekly = reportSnapshot("weekly", "2026-08-24", claims);
    const monthly = reportSnapshot("monthly", "2026-09-01", claims, true);
    const history = reportSnapshot("weekly", "2026-08-17", claims, true);
    return [
      { id: "qa-weekly-2026-08-24", report_type: "weekly", status: "finalised", period_start_local_date: "2026-08-24", period_end_local_date: "2026-08-30", generated_at: RECEIVED_AT, finalised_at: RECEIVED_AT, generated_by: "Synthetic QA", coverage_status: weekly.coverage_status, coverage_metadata: weekly.coverage, metrics_snapshot: weekly },
      { id: "qa-monthly-2026-09-01", report_type: "monthly", status: "draft", period_start_local_date: "2026-09-01", period_end_local_date: "2026-10-01", generated_at: RECEIVED_AT, finalised_at: null, generated_by: "Synthetic QA", coverage_status: monthly.coverage_status, coverage_metadata: monthly.coverage, metrics_snapshot: monthly },
      { id: "qa-history-2026-08-17", report_type: "weekly", status: "archived", period_start_local_date: "2026-08-17", period_end_local_date: "2026-08-23", generated_at: RECEIVED_AT, finalised_at: RECEIVED_AT, generated_by: "Synthetic QA", coverage_status: history.coverage_status, coverage_metadata: history.coverage, metrics_snapshot: history },
    ];
  }

  function fixtureForScenario() {
    const scenario = new URLSearchParams(window.location.search).get("qa-scenario") || "full";
    const claims = buildClaims();
    const previous = scenario === "no-comparison" ? null : buildPreviousClaims(claims);
    const currentHistory = {
      id: "qa-extract-2026-09-03",
      effective_date: EXTRACT_DATE,
      extractDate: EXTRACT_DATE,
      received_at: RECEIVED_AT,
      source_file_name: "synthetic-qa-current.csv",
      claim_count: claims.length,
      status: "accepted",
      historical_persisted: true,
      current_state_updated: true,
      quality_summary: scenario === "warning" ? { issueCount: 1, warnings: ["unknown_registration_dates"] } : { issueCount: 0, warnings: [] },
      claims: claims.map(toFrontendClaim),
    };
    const history = [currentHistory];
    if (previous) history.push({
      id: "qa-extract-2026-09-02",
      effective_date: PREVIOUS_DATE,
      extractDate: PREVIOUS_DATE,
      received_at: "2026-09-02T06:30:00+02:00",
      source_file_name: "synthetic-qa-previous.csv",
      claim_count: previous.length,
      status: "accepted",
      historical_persisted: true,
      current_state_updated: true,
      claims: previous,
    });
    return {
      scenario,
      claims,
      history,
      extractDate: EXTRACT_DATE,
      extractId: currentHistory.id,
      fileName: currentHistory.source_file_name,
      quality: currentHistory.quality_summary,
      reports: buildReports(claims),
      users: HANDLERS.map((name) => ({ name, email: `${name.split(" ")[0].toLowerCase()}@synthetic.invalid`, role: "handler" })),
      settings: { manager_email: "", handler_emails: {}, send_time: "07:30", include_terminal_claims: false, retention_days: 90 },
    };
  }

  function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" },
    });
  }

  function installFetchGuard(fixture) {
    if (window.__scoutSyntheticFetchGuard) return;
    const nativeFetch = window.fetch.bind(window);
    const log = [];
    window.__scoutSyntheticFetchGuard = true;
    window.fetch = async function syntheticFetch(input, init = {}) {
      const rawUrl = typeof input === "string" ? input : input?.url;
      const url = new URL(rawUrl || window.location.href, window.location.href);
      const method = String(init.method || input?.method || "GET").toUpperCase();
      const isBackend = url.hostname === "scout-backend.marketing-854.workers.dev";
      const isGraph = url.hostname === "graph.microsoft.com";
      if (isBackend) {
        log.push({ method, url: url.toString(), blocked: true });
        if (method !== "GET") return json({ error: "Disabled in synthetic QA preview. No production write was attempted." }, 403);
        return responseForBackendPath(url, fixture);
      }
      if (isGraph || url.origin !== window.location.origin) {
        log.push({ method, url: url.toString(), blocked: true });
        return json({ error: method === "GET" ? "External operational API blocked in synthetic QA preview." : "Disabled in synthetic QA preview. No delivery was attempted." }, method === "GET" ? 503 : 403);
      }
      return nativeFetch(input, init);
    };
    window.ScoutSyntheticQA.networkLog = log;
    window.ScoutSyntheticQA.getNetworkLog = () => log.slice();
    window.ScoutSyntheticQA.nativeFetch = nativeFetch;
    window.ScoutSyntheticQA.fixture = fixture;
  }

  function responseForBackendPath(url, fixture) {
    const path = url.pathname.replace(/^\/api/, "");
    if (path === "/claims") {
      return json({ claims: fixture.claims, extractDate: fixture.extractDate, extractId: fixture.extractId, fileName: fixture.fileName });
    }
    if (path === "/history/extracts") return json({ extracts: fixture.history });
    if (path === "/notifications") return json({ notifications: [] });
    if (path === "/settings") return json({ settings: fixture.settings, retention_days: 90 });
    if (path === "/management-workflow/users") return json({ users: fixture.users });
    if (path === "/management-attention" || path === "/management-actions") return json({ items: [] });
    if (path === "/reports") return json({ reports: fixture.reports });
    if (path.startsWith("/reports/") && path.endsWith("/pdf")) return json({ error: "PDF export is disabled in synthetic QA preview." }, 403);
    const reportMatch = path.match(/^\/reports\/([^/]+)$/);
    if (reportMatch) {
      const report = fixture.reports.find((item) => item.id === decodeURIComponent(reportMatch[1]));
      return report ? json({ report }) : json({ error: "Synthetic report not found." }, 404);
    }
    if (path.match(/^\/reports\/[^/]+\/metrics\/[^/]+\/claims$/)) return json({ claims: [] });
    if (path === "/briefing-runs" || path === "/digest-log" || path === "/audit") return json({ runs: [], entries: [], log: [] });
    if (path.startsWith("/notes/")) return json({ note: "", savedBy: null, savedAt: null });
    return json({ error: "Synthetic QA endpoint unavailable." }, 404);
  }

  const enabled = window.ScoutQAConfig?.fixtureMode === true;
  const api = {
    enabled,
    user: () => ({ email: "qa.manager@synthetic.invalid", name: "Synthetic QA Manager", role: "manager", msToken: "synthetic-qa-session" }),
    getFixture: fixtureForScenario,
    getClaims: () => fixtureForScenario().claims,
    getHistory: () => fixtureForScenario().history,
    isWriteDisabled: () => enabled,
    getNetworkLog: () => [],
  };
  window.ScoutSyntheticQA = api;
  if (enabled) installFetchGuard(fixtureForScenario());
})(window);
