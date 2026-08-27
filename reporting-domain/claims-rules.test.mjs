import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarAgeBand,
  calendarDaysBetween,
  containsTimestamp,
  monthlyPeriod,
  toDateOnly,
  UnsupportedCalendarCoverageError,
  weeklyPeriod,
  workingDaysBetween,
} from "./date-periods.mjs";
import {
  CLAIMS_RULE_VERSION,
  evaluateClaim,
  evaluateMandateAndRisk,
  evaluateMovement,
  evaluateOperationalCategories,
  evaluatePriority,
  evaluateSla,
  getReadyToCloseCandidate,
  getStatusEvaluation,
  getStatusRule,
  isTerminalStatus,
  isZeroEstimateAnomaly,
  normalizeStatus,
} from "./claims-rules.mjs";
import { claimIdentity, normalizeClaim } from "./claims-contract.mjs";
import {
  canManageAllClaims,
  normalizeRole,
  resolveActiveScoutUsers,
  resolveClaimScope,
  resolveCurrentUser,
  stableUserKey,
} from "./roles.mjs";

test("status normalization, terminal/open, mapped, and unmapped states", () => {
  assert.equal(normalizeStatus("  REGISTERED  "), "registered");
  assert.equal(
    normalizeStatus("SETTLED – Recovery   Pending"),
    "settled - awaiting recovery",
  );
  assert.equal(normalizeStatus("reopen"), "registered");
  assert.equal(isTerminalStatus("reopen"), false);
  assert.equal(getStatusRule("registered").category, "active");
  assert.equal(isTerminalStatus(" Closed Paid "), true);
  assert.equal(getStatusEvaluation("Closed Paid").open, false);
  assert.equal(getStatusEvaluation("A status added later").mapped, false);
  assert.equal(
    getStatusEvaluation("A status added later").category,
    "unmapped",
  );
});

test("calendar age and management bands use explicit as-of dates", () => {
  assert.equal(calendarDaysBetween("2026-01-01", "2026-01-01"), 0);
  assert.equal(calendarDaysBetween("2026-01-01", "2026-01-31"), 30);
  assert.equal(calendarDaysBetween("2026-01-01", "2026-02-01"), 31);
  assert.equal(calendarDaysBetween("2026-01-01", "2026-03-02"), 60);
  assert.equal(calendarDaysBetween("2026-01-01", "2026-03-03"), 61);
  assert.equal(calendarDaysBetween("2026-01-01", "2026-04-01"), 90);
  assert.equal(calendarDaysBetween("2026-01-01", "2026-04-02"), 91);
  assert.deepEqual([0, 30, 31, 60, 61, 90, 91].map(calendarAgeBand), [
    "0-30",
    "0-30",
    "31-60",
    "31-60",
    "61-90",
    "61-90",
    "91+",
  ]);
});

test("working age matches the existing Mon-Fri, start-inclusive semantics", () => {
  assert.equal(workingDaysBetween("2026-02-02", "2026-02-02"), 0);
  assert.equal(workingDaysBetween("2026-02-06", "2026-02-09"), 1);
  assert.equal(workingDaysBetween("2026-04-02", "2026-04-08"), 2);
  assert.equal(
    workingDaysBetween("2026-04-02", "2026-04-08", {
      onUnsupported: "assume-weekday",
    }),
    2,
  );
  assert.equal(workingDaysBetween("2026-08-07", "2026-08-11"), 1);
  assert.throws(
    () => workingDaysBetween("2028-01-02", "2028-01-05"),
    UnsupportedCalendarCoverageError,
  );
});

test("period utilities use Johannesburg local half-open boundaries", () => {
  const week = weeklyPeriod("2026-08-25");
  assert.equal(week.startLocalDate, "2026-08-24");
  assert.equal(week.endLocalDateExclusive, "2026-08-29");
  assert.equal(week.start.toISOString(), "2026-08-23T22:00:00.000Z");
  assert.equal(week.end.toISOString(), "2026-08-28T22:00:00.000Z");
  assert.equal(containsTimestamp("2026-08-28T21:59:59.999Z", week), true);
  assert.equal(containsTimestamp("2026-08-28T22:00:00.000Z", week), false);
  const month = monthlyPeriod("2026-08-25");
  assert.equal(month.startLocalDate, "2026-08-01");
  assert.equal(month.endLocalDateExclusive, "2026-09-01");
  assert.equal(toDateOnly(new Date("2026-08-25T12:00:00.000Z")), "2026-08-25");
});

test("SLA states distinguish on-track, stale, critical, unknown, and unmapped", () => {
  assert.equal(
    evaluateSla({ status: "Registered", workingAge: 1 }).state,
    "on_track",
  );
  assert.equal(
    evaluateSla({ status: "Registered", workingAge: 2 }).state,
    "breached",
  );
  assert.equal(
    evaluateSla({ status: "Registered", workingAge: 2 }).classification,
    "stale",
  );
  assert.equal(
    evaluateSla({ status: "Registered", workingAge: 5 }).classification,
    "critical",
  );
  assert.equal(
    evaluateSla({ status: "Future status", workingAge: 99 }).state,
    "unmapped",
  );
  assert.equal(evaluateSla({ status: "Registered" }).state, "unknown");
  assert.equal(
    evaluateSla({ status: "Repudiated", workingAge: 99 }).denominatorEligible,
    false,
  );
  assert.equal(
    evaluateSla({ status: "Closed Paid", workingAge: 99 }).state,
    "not_applicable",
  );
});

test("movement boundaries preserve exact greater-than semantics", () => {
  assert.equal(
    evaluateMovement({ status: "Registered", daysSinceMovement: 14 }).over14,
    false,
  );
  assert.equal(
    evaluateMovement({ status: "Registered", daysSinceMovement: 15 }).over14,
    true,
  );
  assert.equal(
    evaluateMovement({ status: "Registered", daysSinceMovement: 30 }).over30,
    false,
  );
  assert.equal(
    evaluateMovement({ status: "Registered", daysSinceMovement: 31 }).over30,
    true,
  );
  assert.equal(
    evaluateMovement({
      status: "Attorney attending to recovery",
      daysSinceMovement: 99,
    }).eligible,
    false,
  );
  assert.equal(
    evaluateMovement({ status: "Closed Paid", daysSinceMovement: 99 }).eligible,
    false,
  );
});

test("all six Ready to Close rules and near misses are deterministic", () => {
  const cases = [
    [{ status: "Repudiated - Awaiting Closure", workingAge: 8 }, 1],
    [
      {
        status: "Payment - Payments Made",
        workingAge: 22,
        comments: "No recovery pending",
      },
      2,
    ],
    [{ status: "Payment Released", workingAge: 15 }, 3],
    [{ status: "Settled", workingAge: 15 }, 4],
    [{ status: "Payment Requested", workingAge: 31, estimate: 0 }, 5],
    [{ status: "Registered", workingAge: 61 }, 6],
  ];
  for (const [claim, ruleNo] of cases)
    assert.equal(getReadyToCloseCandidate(claim).ruleNo, ruleNo);
  assert.equal(
    getReadyToCloseCandidate({ status: "Registered", workingAge: 60 }),
    null,
  );
  assert.equal(
    getReadyToCloseCandidate({ status: "Payment Released", workingAge: 14 }),
    null,
  );
  assert.equal(
    getReadyToCloseCandidate({ status: "Closed Paid", workingAge: 99 }),
    null,
  );
  assert.equal(
    getReadyToCloseCandidate({ status: "Payment Requested", estimate: 0 }),
    null,
  );
  assert.equal(
    getReadyToCloseCandidate({
      status: "Settled - Awaiting Recovery",
      workingAge: 99,
    }),
    null,
  );
});

test("zero-estimate and value-conflict rules preserve current claims-page cases", () => {
  assert.equal(
    isZeroEstimateAnomaly({
      status: "Registered",
      estimate: 0,
      outstanding: 100,
    }),
    true,
  );
  assert.equal(
    isZeroEstimateAnomaly({
      status: "Registered",
      estimate: 0,
      outstanding: 0,
      paid: 1,
    }),
    true,
  );
  assert.equal(
    isZeroEstimateAnomaly({
      status: "Attorney attending to recovery",
      estimate: 0,
      outstanding: 0,
      paid: 1,
    }),
    false,
  );
  assert.equal(
    isZeroEstimateAnomaly({
      status: "Closed Paid",
      estimate: 0,
      outstanding: 100,
    }),
    false,
  );
  const evaluation = evaluateClaim({
    status: "Registered",
    estimate: 100,
    outstanding: 160,
    workingAge: 1,
  });
  assert.equal(evaluation.valueConflicts.outstandingExceedsEstimateBy50, true);
  assert.equal(evaluation.valueConflicts.estimateWithoutOutstanding, false);
});

test("operational categories cover overdue parties, legal/recovery, NFO, fraud, and repudiation", () => {
  assert.deepEqual(
    evaluateOperationalCategories({
      status: "Awaiting Assessor Report",
      workingAge: 7,
    }).assessorOverdue,
    true,
  );
  assert.equal(
    evaluateOperationalCategories({
      status: "Awaiting Investigators Report",
      workingAge: 15,
    }).investigatorOverdue,
    true,
  );
  assert.equal(
    evaluateOperationalCategories({
      status: "Awaiting Broker Feedback",
      workingAge: 8,
    }).brokerOverdue,
    true,
  );
  assert.equal(
    evaluateOperationalCategories({
      status: "Attorney attending to recovery",
      workingAge: 1,
    }).legalRecovery,
    true,
  );
  assert.equal(
    evaluateOperationalCategories({
      status: "Ombudsman / Legal Advice",
      workingAge: 1,
    }).nfoOmbudsman,
    true,
  );
  assert.equal(
    evaluateOperationalCategories({ status: "Fraud", workingAge: 1 }).fraud,
    true,
  );
  assert.equal(
    evaluateOperationalCategories({ status: "Repudiated", calendarAge: 271 })
      .repudiationExpired,
    true,
  );
  assert.equal(
    evaluateOperationalCategories({ status: "Repudiated" })
      .repudiationDateMissing,
    true,
  );
  assert.equal(
    evaluateMandateAndRisk({ status: "Registered", outstanding: 100000 })
      .highValue,
    true,
  );
});

test("role resolution is active-user based and uses id before normalized email", () => {
  assert.equal(normalizeRole("Administrator"), "admin");
  assert.deepEqual(stableUserKey({ id: "db-1", email: "Example@Scout.test" }), {
    kind: "database_id",
    value: "db-1",
  });
  assert.deepEqual(stableUserKey({ email: "Example@Scout.test" }), {
    kind: "email",
    value: "example@scout.test",
  });
  const users = resolveActiveScoutUsers([
    { id: "db-1", email: "handler@scout.test", role: "handler", active: true },
    { id: "db-2", email: "manager@scout.test", role: "manager", active: true },
    { id: "db-3", email: "inactive@scout.test", role: "admin", active: false },
    { id: "db-4", email: "unknown@scout.test", role: "viewer", active: true },
    { id: "db-5", email: "missing-active@scout.test", role: "handler" },
  ]);
  assert.equal(users.length, 2);
  assert.equal(
    resolveCurrentUser(users, { id: "db-2", email: "wrong@scout.test" }).role,
    "manager",
  );
  assert.deepEqual(resolveClaimScope(users[0]), {
    kind: "handler",
    userKey: { kind: "database_id", value: "db-1" },
    email: "handler@scout.test",
  });
  assert.equal(canManageAllClaims(users[1]), true);
  assert.equal(resolveCurrentUser(users, "inactive@scout.test"), null);
});

test("contract keeps database identity, source number, and provenance separate", () => {
  assert.deepEqual(claimIdentity({ id: "row-1", claim_no: "C-1" }), {
    databaseId: "row-1",
    sourceClaimNumber: "C-1",
    canonicalClaimId: null,
  });
  const claim = normalizeClaim({
    claim_no: "C-1",
    status: " REGISTERED ",
    registered_at: "2026-01-01",
    event_at: null,
  });
  assert.equal(claim.normalizedStatus, "registered");
  assert.equal(claim.canonicalClaimId, null);
  assert.equal(claim.provenance.derivation, "source");
});

test("parity guardrails protect current claims-page boundary behavior", () => {
  assert.equal(CLAIMS_RULE_VERSION, "claims-operations-rules-v1");
  assert.equal(
    evaluatePriority({ status: "Registered", workingAge: 5 }).flags.some(
      ({ code }) => code === "critical_sla",
    ),
    true,
  );
  assert.equal(
    evaluatePriority({
      status: "Registered",
      workingAge: 1,
      daysSinceMovement: 14,
    }).flags.some(({ code }) => code === "no_movement_over_14_days"),
    false,
  );
  assert.equal(
    evaluatePriority({
      status: "Registered",
      workingAge: 1,
      daysSinceMovement: 15,
    }).flags.some(({ code }) => code === "no_movement_over_14_days"),
    true,
  );
});
