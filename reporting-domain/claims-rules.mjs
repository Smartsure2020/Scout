import {
  BUSINESS_TIME_ZONE,
  calendarDaysBetween,
  toDateOnly,
  workingDaysBetween,
} from "./date-periods.mjs";
import { normalizeSourceStatus } from "./claims-qa.mjs";

export const CLAIMS_RULE_VERSION = "claims-operations-rules-v1";
export const MANDATE_THRESHOLD = 100000;
export const REPUDIATION_EXPIRY_DAYS = 270;

export function normalizeStatus(status) {
  return normalizeSourceStatus(status);
}

const STATUS_RULE_ENTRIES = [
  ["Registered", 2, 5, "active"],
  ["FNOL Registered", 2, 5, "active"],
  ["Take On Claim", 2, 5, "active"],
  ["Take On Documents Outstanding", 3, 7, "awaiting_docs"],
  ["Notified and awaiting docs", 3, 7, "awaiting_docs"],
  ["Notified", 3, 7, "active"],
  ["All documents received", 2, 5, "active"],
  ["Possible Late Claim - Awaiting Insurer Feedback", 5, 10, "awaiting_docs"],
  ["Awaiting Claim Form", 5, 10, "awaiting_docs"],
  ["Awaiting Claim documents from broker / client", 3, 7, "awaiting_docs"],
  ["Awaiting claim documents or other info from client", 3, 7, "awaiting_docs"],
  ["Supporting Documents Requested", 3, 7, "awaiting_docs"],
  ["Outstanding information from client", 3, 7, "awaiting_docs"],
  ["Awaiting Validation", 3, 7, "awaiting_docs"],
  ["Awaiting signed release from Insured", 3, 7, "awaiting_docs"],
  ["Awaiting signed release from TP", 5, 10, "awaiting_docs"],
  ["Awaiting signed AOL from client", 3, 5, "awaiting_docs"],
  ["Awaiting Agreement of Loss Invoice", 3, 5, "awaiting_docs"],
  ["Awaiting Agreement of Loss / Invoice", 3, 5, "awaiting_docs"],
  ["Agreement of Loss signed", 2, 5, "active"],
  ["Awaiting police case details", 5, 10, "awaiting_docs"],
  ["Awaiting blood alcohol test results", 7, 14, "awaiting_docs"],
  ["Awaiting drivers licence", 5, 10, "awaiting_docs"],
  ["Awaiting drivers licence and PDP", 5, 10, "awaiting_docs"],
  ["Awaiting original registration certificate", 5, 10, "awaiting_docs"],
  ["Awaiting Original deregistration certificate", 5, 10, "awaiting_docs"],
  ["Awaiting vehicle service history", 5, 10, "awaiting_docs"],
  ["Awaiting spare keys to vehicle", 5, 10, "awaiting_docs"],
  ["Awaiting inquest report", 7, 14, "awaiting_docs"],
  ["Awaiting inquest/investigation report", 7, 14, "awaiting_docs"],
  ["Awaiting investigators report", 7, 14, "awaiting_docs"],
  ["Awaiting Damage Report", 5, 10, "awaiting_docs"],
  ["Awaiting proof of surge arrestors", 5, 10, "awaiting_docs"],
  ["POPI - Claims Consent Letter Outstanding", 3, 7, "awaiting_docs"],
  ["Awaiting outstanding finance letter", 5, 10, "awaiting_docs"],
  ["Awaiting write off documents", 5, 10, "awaiting_docs"],
  ["Awaiting vehicle tracking activation report", 5, 10, "awaiting_docs"],
  ["Awaiting post mortem report", 7, 14, "awaiting_docs"],
  ["Awaiting COF and operators card", 5, 10, "awaiting_docs"],
  ["Awaiting Broker Feedback", 3, 7, "awaiting_broker"],
  ["Awaiting reply from broker/client", 3, 7, "awaiting_broker"],
  ["Referral to Broker Claims Manager", 5, 10, "awaiting_broker"],
  ["Awaiting reply from insured", 3, 7, "awaiting_broker"],
  ["Awaiting reply from insurer", 3, 7, "awaiting_broker"],
  ["Awaiting instructions from broker / client", 3, 7, "awaiting_broker"],
  ["Claims Handler to follow-up with Insurer", 2, 5, "awaiting_broker"],
  ["Awaiting insurers claim number", 3, 7, "awaiting_broker"],
  ["Assessor Appointed", 5, 10, "assessor"],
  ["Assessors Appointment Confirmed", 5, 10, "assessor"],
  ["Vehicle being assessed", 3, 7, "assessor"],
  ["Vehicle assessed - Pending assessment report", 3, 7, "assessor"],
  ["Awaiting Assessor Report", 7, 14, "assessor"],
  ["Pending Assessor Feedback", 5, 10, "assessor"],
  ["Assessment Report Queried", 3, 7, "assessor"],
  ["Assessment - Awaiting Client", 3, 7, "assessor"],
  ["Assessment Done", 2, 5, "assessor"],
  ["Technical Assessment Complete", 2, 5, "assessor"],
  ["Adjuster Appointed", 5, 10, "assessor"],
  ["Adjuster Awaits documentation from client", 5, 10, "assessor"],
  ["Awaiting Adjuster's report", 7, 14, "assessor"],
  ["Digital assessor appointed", 3, 7, "assessor"],
  ["External Assessor appointed", 5, 10, "assessor"],
  ["Assessment Report Uploaded", 2, 5, "assessor"],
  ["Estimate Captured", 2, 5, "assessor"],
  ["Agreed Costs Captured", 2, 5, "assessor"],
  ["SAP report requested", 5, 10, "assessor"],
  ["Corresponding with SAP", 5, 10, "assessor"],
  ["Awaiting Engineers Report", 7, 14, "assessor"],
  ["Surveyor report awaited", 7, 14, "assessor"],
  ["Fast Track Appointed", 2, 5, "assessor"],
  ["Awaiting Assessor Appointment", 2, 5, "assessor"],
  ["Claim Merit Assessed", 2, 5, "active"],
  ["Assess Claim Merit", 2, 5, "active"],
  ["Repairs Authorised", 7, 14, "repair"],
  ["Repair - Authorised", 7, 14, "repair"],
  ["Repairs in Progress", 7, 14, "repair"],
  ["Awaiting repair / replacement Invoices", 5, 10, "repair"],
  ["Awaiting repairers invoice", 5, 10, "repair"],
  ["Awaiting repair invoice from Glazier", 5, 10, "repair"],
  ["Awaiting replacement invoice from Glazier", 5, 10, "repair"],
  ["Awaiting replacement invoice from supplier", 5, 10, "repair"],
  ["Awaiting Quotation from the Repairer", 3, 7, "repair"],
  ["Awaiting quotation from client", 5, 10, "repair"],
  ["Awaiting Parts", 7, 14, "repair"],
  ["Booking - Confirmed", 5, 10, "repair"],
  ["Booking - Rescheduled", 3, 7, "repair"],
  ["Booking - Could not secure booking date", 2, 5, "repair"],
  ["Repair - Rescheduled", 3, 7, "repair"],
  ["Repair - Completed", 2, 5, "repair"],
  ["Awaiting post repair audit report", 3, 7, "repair"],
  ["Contractors Appointed", 5, 10, "repair"],
  ["Repair Visit - Onsite - Pre-Inspection in Progress", 3, 7, "repair"],
  ["Authorised for Bodyshop", 3, 7, "repair"],
  ["Awaiting Authorisation", 3, 7, "active"],
  ["Awaiting Claim Authorisation", 3, 7, "active"],
  ["Awaiting Payment Authorisation", 3, 7, "payment"],
  ["Authorised", 3, 7, "active"],
  ["Authorised not sent", 1, 3, "active"],
  ["Authorised Business Decision", 3, 7, "active"],
  ["Cover Confirmed", 2, 5, "active"],
  ["In Progress", 5, 10, "active"],
  ["In Force", 5, 10, "active"],
  ["File Pending", 3, 7, "active"],
  ["Manual Review", 2, 5, "active"],
  ["Claims pending", 3, 7, "active"],
  ["Await quantum to be finalised", 5, 10, "active"],
  ["Payment Requested", 14, null, "payment"],
  ["Payment - Approved", 14, null, "payment"],
  ["Payment Released", 14, null, "payment"],
  ["Payment - Payments Made", 14, null, "payment"],
  ["Payment - Pending Approval", 7, 14, "payment"],
  ["Requested Payment", 14, null, "payment"],
  ["Payment requested for adjuster's fee", 14, null, "payment"],
  ["Payment requested for assessor's fee", 14, null, "payment"],
  ["Payment requested for repairer", 14, null, "payment"],
  ["Payment requested for Glazier", 14, null, "payment"],
  ["Payment requested for Tow operator", 14, null, "payment"],
  ["Payment requested for attorney's fee", 14, null, "payment"],
  ["Payment requested for debris removal", 14, null, "payment"],
  ["Payment requested for clean up costs", 14, null, "payment"],
  ["Payment requested for fire brigade charges", 14, null, "payment"],
  ["Payment requested for recovery costs", 14, null, "payment"],
  ["Awaiting 2nd Payment Authorization", 5, 10, "payment"],
  ["Finance Approved", 5, 10, "payment"],
  ["Finance Payment", 7, 14, "payment"],
  ["Awaiting payment confirmation from insurer", 7, 14, "payment"],
  ["Awaiting Legal Payment", 7, 14, "payment"],
  ["Awaiting Proof of Payment", 5, 10, "payment"],
  ["Awaiting payment for salvage", 7, 14, "payment"],
  ["Awaiting payment for excess buyback", 7, 14, "payment"],
  ["Awaiting excess from client/insured", 7, 14, "payment"],
  ["Release received - await payment", 5, 10, "payment"],
  ["Interim Payment", 7, 14, "payment"],
  ["Settlement Pending", 5, 10, "payment"],
  ["Settlement agreement reached.", 3, 7, "payment"],
  ["Awaiting Settlement Docs", 5, 10, "payment"],
  ["Awaiting Settlement Figures from Insurer", 5, 10, "payment"],
  ["Awaiting Cash in Lieu", 5, 10, "payment"],
  ["Signed Cash in lieu", 3, 7, "payment"],
  ["Mandate Payment Sign Off", 3, 5, "mandate"],
  ["Settled - Awaiting Assessors Invoice", 7, 14, "payment"],
  ["Settled but awaiting excess", 7, 14, "payment"],
  ["Total Loss", 5, 10, "active"],
  ["Total Loss Buyback", 5, 10, "active"],
  ["Write-off", 5, 10, "active"],
  ["Write-off In Process", 5, 10, "active"],
  ["Over Mandate", 1, 3, "mandate"],
  ["Over Mandate Letter Sent", 3, 7, "mandate"],
  ["Not Within Mandate", 1, 3, "mandate"],
  ["Awaiting insurer claim number (mandate)", 3, 7, "mandate"],
  ["Await Salvage", 7, 14, "active"],
  ["Awaiting salvage from client", 7, 14, "active"],
  ["Salvage value awaited", 5, 10, "active"],
  ["Appoint Salvage Contractor", 3, 7, "active"],
  ["Salvage payment awaited", 7, 14, "payment"],
  ["Attorney attending to recovery", 30, 60, "legal"],
  ["Attorney made monthly arrangement", 30, 60, "legal"],
  ["Attorney appointed to handle TP approach", 14, 30, "legal"],
  ["Attorney negotiating settlement", 14, 30, "legal"],
  ["Attorney issuing summons", 14, 30, "legal"],
  ["Attorney handling TP summons", 14, 30, "legal"],
  ["Attorney appointed to issue summons", 14, 30, "legal"],
  ["Attorney awaits trial date", 30, 60, "legal"],
  ["Awaiting Attorney's fees", 14, 30, "legal"],
  ["Summons", 14, 30, "legal"],
  ["Ombudsman / Legal Advice", 7, 14, "legal"],
  ["DORMANT - LEGAL", 30, 60, "legal"],
  ["DORMANT - THIRD PARTY", 30, 60, "legal"],
  ["LOD to third party", 14, 30, "legal"],
  ["Letter of demand addressed to TP", 14, 30, "legal"],
  ["Final demand addressed to TP", 7, 14, "legal"],
  ["Tracing agents appointed", 14, 30, "legal"],
  ["Referred to recovery agent", 14, 30, "legal"],
  ["Insurers refer claim for legal review", 7, 14, "legal"],
  ["Awaiting TP approach", 14, 30, "legal"],
  ["Awaiting TP Claim", 14, 30, "legal"],
  ["Awaiting Third-Party Settlement", 14, 30, "legal"],
  ["Corresponding with TP - TP Claim", 7, 14, "legal"],
  ["Corresponding with TP - recovery", 7, 14, "legal"],
  ["Investigating conflicting merits", 7, 14, "legal"],
  ["CSI Complete - Further Investigation", 5, 10, "legal"],
  ["Fraud", 3, 7, "legal"],
  ["Settled - Awaiting Recovery", 14, 30, "legal"],
  ["Repudiation pending", 3, 7, "repudiated"],
  ["Awaiting Repudiation Letter", 3, 7, "repudiated"],
  ["Repudiated", 14, 30, "repudiated"],
  ["Repudiated - Awaiting Closure", 7, 14, "repudiated"],
  ["Partial Repudiation", 7, 14, "repudiated"],
  ["Partial Rejection", 7, 14, "repudiated"],
  ["Pending Rejection", 3, 7, "repudiated"],
  ["Broker Contests Rejection", 5, 10, "repudiated"],
  ["Ex-Gratia", 5, 10, "active"],
  ["EX Gratia - Pending", 3, 7, "active"],
  ["Ex Gratia Claim Send AOL", 3, 7, "active"],
  ["Ex Gratia - Approved by Insurer", 3, 7, "active"],
];

export const STATUS_RULES = Object.freeze(
  Object.fromEntries(
    STATUS_RULE_ENTRIES.map(([status, stale, critical, category]) => [
      normalizeStatus(status),
      Object.freeze({ stale, critical, category }),
    ]),
  ),
);

const TERMINAL_STATUS_NAMES = [
  "Closed Paid",
  "Closed - finalised",
  "Closed - No cover",
  "Closed - Claim documents outstanding",
  "Closed - over 30days",
  "Closed - Minor Damages",
  "Closed - Third Party Damages Only",
  "Closed - Settled by SASRIA",
  "Closed - Client Abandoned Claim",
  "Closed - Claim Rejected by Insurer",
  "Closed - Broker proceeding with claim",
  "Closed - Handled by Insurer.",
  "Closed - Settled by Insurer",
  "Closed - 180 days",
  "Closed - Cancelled",
  "Closed - No Payments Made",
  "Closed - No Damage - Notification purposes only",
  "Closed - Legal",
  "Closed - Claim handed over to new Broker",
  "Closed - Awaiting Third Party Approach",
  "Closed - AON proceeding with claim",
  "Closed - Awaiting Proof of Payment",
  "Closed - TP Claim within Excess",
  "Closed - Excess greater than claim value",
  "Closed Walkaway",
  "Closed Declined",
  "Not Taken Up",
  "Cancelled",
  "Duplicated",
  "Claim Prescribed",
  "Claim Withdrawn",
  "Rejected",
  "Auto Rejected",
  "Advise only",
  "Claim within Excess",
  "Recovery abandoned : uneconomical",
  "Recovery abandoned : tp man of straw",
  "Recovery abandoned : third party untraceable",
  "Recovery abandoned : conflicting merits",
  "Recovery closed - no third party details",
  "FINALISED - NO FURTHER REPLY FROM TP",
  "Settled",
  "Settled - NTU",
  "Settled, mandate claim",
  "Settled, TP claim repudiated",
  "Settled, OD and TP claim paid",
  "Settled, No TP claim made",
  "Settled, each party bears own costs",
  "Settled, no claim/no cover/no peril",
  "Settled, within excess",
  "Settled, Full Recovery",
  "Settled, partial recovery made",
  "Settled, repudiated",
  "Settled, TP claim Paid",
  "Settled, Cash Payment",
  "Settled, OD paid, TP claim repudiated",
  "Settled & Recovery Abandoned",
  "Settled - TP Claim within Excess",
  "Settled - Excess exceeds claim amount",
  "Settled - Business decision",
  "Settled, no claim from client",
  "Settled, Duplicated",
  "Settled, no claim from client/claim withdrawn/NTU",
  "Settled/Write Off",
  "Knock For Knock Settled",
  "Recovery successful 100%",
  "Recovery successful - apportionment",
  "Ex Gratia - Finalized",
  "Not Taken Up",
  "Knock for Knock Settled",
];

export const TERMINAL_STATUSES = Object.freeze(
  new Set(TERMINAL_STATUS_NAMES.map(normalizeStatus)),
);

export function getStatusRule(status) {
  return STATUS_RULES[normalizeStatus(status)] ?? null;
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(normalizeStatus(status));
}

export function isOpenStatus(status) {
  return !isTerminalStatus(status);
}

export function getStatusEvaluation(status) {
  const normalizedStatus = normalizeStatus(status);
  const rule = getStatusRule(status);
  const terminal = isTerminalStatus(status);
  return {
    status: status ?? null,
    normalizedStatus,
    mapped: Boolean(rule),
    terminal,
    open: !terminal,
    category: rule?.category ?? "unmapped",
    staleThreshold: rule?.stale ?? null,
    criticalThreshold: rule?.critical ?? null,
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function claimAge(claim) {
  return finiteNumber(claim?.workingAge ?? claim?.age_days ?? claim?.age);
}

function claimCalendarAge(claim) {
  return finiteNumber(claim?.calendarAge);
}

export function deriveClaimAges(
  claim,
  { asOfDate, onUnsupported = "throw" } = {},
) {
  const asOf = toDateOnly(asOfDate);
  const registered = toDateOnly(
    claim?.registeredDate ?? claim?.claim_registered ?? claim?.registered_at,
  );
  const dol = toDateOnly(claim?.dolDate ?? claim?.dol ?? claim?.date_of_loss);
  return {
    asOfDate: asOf,
    registeredDate: registered,
    dolDate: dol,
    workingAge:
      claimAge(claim) ??
      (registered && asOf
        ? workingDaysBetween(registered, asOf, { onUnsupported })
        : null),
    calendarAge:
      claimCalendarAge(claim) ??
      (registered && asOf ? calendarDaysBetween(registered, asOf) : null),
  };
}

export function evaluateSla(claim, { asOfDate, onUnsupported = "throw" } = {}) {
  const status = getStatusEvaluation(claim?.status);
  const ages = deriveClaimAges(claim, { asOfDate, onUnsupported });
  const result = {
    ...status,
    workingAge: ages.workingAge,
    state: "unknown",
    classification: "unknown",
    compliant: false,
    breached: false,
    denominatorEligible: false,
    reasonCode: null,
  };

  if (status.terminal) {
    result.state = "not_applicable";
    result.classification = "terminal";
    result.reasonCode = "terminal-status";
    return result;
  }
  if (!status.mapped) {
    result.state = "unmapped";
    result.classification = "unmapped";
    result.reasonCode = "status-not-mapped";
    return result;
  }
  // The claims page deliberately excludes repudiation from generic working-day
  // SLA scoring; its 270-day calendar rule is evaluated separately.
  if (status.category === "repudiated") {
    result.state = "not_applicable";
    result.classification = "repudiated-calendar-rule";
    result.reasonCode = "repudiation-calendar-rule";
    return result;
  }
  if (ages.workingAge === null) {
    result.reasonCode = "working-age-missing";
    return result;
  }
  if (
    status.criticalThreshold !== null &&
    ages.workingAge >= status.criticalThreshold
  ) {
    result.state = "breached";
    result.classification = "critical";
    result.breached = true;
    result.denominatorEligible = true;
    result.reasonCode = "critical-threshold-reached";
    return result;
  }
  if (
    status.staleThreshold !== null &&
    ages.workingAge >= status.staleThreshold
  ) {
    result.state = "breached";
    result.classification = "stale";
    result.breached = true;
    result.denominatorEligible = true;
    result.reasonCode = "stale-threshold-reached";
    return result;
  }
  result.state = "on_track";
  result.classification = "on_track";
  result.compliant = true;
  result.denominatorEligible = true;
  result.reasonCode = "within-sla";
  return result;
}

export function evaluateMovement(claim, { asOfDate } = {}) {
  const status = getStatusEvaluation(claim?.status);
  const explicit = finiteNumber(claim?.daysSinceMovement);
  const movementDate = toDateOnly(
    claim?.movementDate ?? claim?.lastMovementDate ?? claim?.last_updated,
  );
  const asOf = toDateOnly(asOfDate);
  const days =
    explicit ??
    (movementDate && asOf ? calendarDaysBetween(movementDate, asOf) : null);
  const eligible = status.open && status.category !== "legal";
  return {
    daysSinceMovement: days,
    eligible,
    over14: eligible && days !== null && days > 14,
    over30: eligible && days !== null && days > 30,
    reasonCode: days === null ? "movement-date-missing" : null,
  };
}

export function hasRecoveryPending(claim) {
  const text =
    `${claim?.status ?? ""} ${claim?.description ?? ""} ${claim?.comments ?? ""}`.toLowerCase();
  return (
    text.includes("recovery pending") ||
    text.includes("awaiting recovery") ||
    text.includes("recoveries pending")
  );
}

export function getReadyToCloseCandidate(claim) {
  const status = normalizeStatus(claim?.status);
  if (isTerminalStatus(claim?.status) && !status.startsWith("settled"))
    return null;
  const age = finiteNumber(claim?.workingAge ?? claim?.age) ?? 0;
  const estimate = finiteNumber(claim?.estimate) ?? 0;
  const recoveryPending = hasRecoveryPending(claim);
  if (status === "repudiated - awaiting closure" && age > 7) {
    return {
      ruleNo: 1,
      level: "green",
      priority: "P1",
      code: "repudiated_awaiting_closure",
      recoveryPending,
      actionCode: "close_immediately",
    };
  }
  if (status === "payment - payments made" && age > 21) {
    return {
      ruleNo: 2,
      level: recoveryPending ? "amber" : "green",
      priority: "P2",
      code: "payments_confirmed",
      recoveryPending,
      actionCode: recoveryPending
        ? "check_recovery_before_closure"
        : "close_unless_recovery_pending",
    };
  }
  if (status === "payment released" && age > 14) {
    return {
      ruleNo: 3,
      level: "green",
      priority: "P2",
      code: "payment_released",
      recoveryPending,
      actionCode: "close_unless_excess_outstanding",
    };
  }
  if (
    status.startsWith("settled") &&
    status !== "settled - awaiting recovery" &&
    age > 14
  ) {
    return {
      ruleNo: 4,
      level: "green",
      priority: "P2",
      code: "settlement_complete",
      recoveryPending,
      actionCode: "close_claim",
    };
  }
  if (status === "payment requested" && estimate === 0 && age > 30) {
    return {
      ruleNo: 5,
      level: "amber",
      priority: "P2",
      code: "zero_estimate_payment_request",
      recoveryPending,
      actionCode: "review_data_error_or_ntu",
    };
  }
  if (status === "registered" && age > 60) {
    return {
      ruleNo: 6,
      level: "amber",
      priority: "P2",
      code: "dormant_registered_claim",
      recoveryPending,
      actionCode: "review_abandoned_or_ntu",
    };
  }
  return null;
}

export function isZeroEstimateAnomaly(claim) {
  if (isTerminalStatus(claim?.status)) return false;
  const rule = getStatusRule(claim?.status);
  const estimate = finiteNumber(claim?.estimate) ?? 0;
  const outstanding = finiteNumber(claim?.outstanding) ?? 0;
  const paid = finiteNumber(claim?.paid) ?? 0;
  if (estimate !== 0) return false;
  if (outstanding > 0) return true;
  if (!rule) return outstanding === 0 && paid === 0;
  return (
    ["payment", "active", "assessor"].includes(rule.category) ||
    (outstanding === 0 && paid === 0)
  );
}

export function evaluateValueConflicts(claim) {
  const estimate = finiteNumber(claim?.estimate) ?? 0;
  const outstanding = finiteNumber(claim?.outstanding) ?? 0;
  return {
    estimateWithoutOutstanding: estimate > 0 && outstanding === 0,
    outstandingExceedsEstimateBy50:
      outstanding > 0 && estimate > 0 && outstanding > estimate * 1.5,
    zeroEstimateAnomaly: isZeroEstimateAnomaly(claim),
  };
}

export function evaluateOperationalCategories(claim) {
  const status = normalizeStatus(claim?.status);
  const rule = getStatusRule(claim?.status);
  const age = finiteNumber(claim?.workingAge ?? claim?.age) ?? 0;
  const calendarAge = finiteNumber(claim?.calendarAge ?? claim?.age) ?? null;
  const terminal = isTerminalStatus(claim?.status);
  const repudiationAge = finiteNumber(claim?.repudiationAge);
  const repudiationExpired =
    status === "repudiated" &&
    ((calendarAge !== null && calendarAge > REPUDIATION_EXPIRY_DAYS) ||
      (repudiationAge !== null && repudiationAge >= REPUDIATION_EXPIRY_DAYS));
  return {
    assessorOverdue:
      !terminal &&
      rule?.category === "assessor" &&
      (status.includes("report") ||
        status.includes("feedback") ||
        status.includes("assessor")) &&
      age >= 7,
    investigatorOverdue:
      !terminal && status === "awaiting investigators report" && age > 14,
    brokerOverdue:
      !terminal && status === "awaiting broker feedback" && age > 7,
    legalRecovery: !terminal && rule?.category === "legal",
    nfoOmbudsman:
      !terminal && (status.includes("nfo") || status.includes("ombudsman")),
    fraud: !terminal && status === "fraud",
    repudiationExpired: !terminal && repudiationExpired,
    repudiationDateMissing:
      !terminal &&
      rule?.category === "repudiated" &&
      status === "repudiated" &&
      repudiationAge === null &&
      calendarAge === null,
    repudiationApproaching:
      !terminal &&
      rule?.category === "repudiated" &&
      repudiationAge !== null &&
      repudiationAge >= 240 &&
      repudiationAge < REPUDIATION_EXPIRY_DAYS,
  };
}

export function evaluateMandateAndRisk(claim) {
  const status = getStatusEvaluation(claim?.status);
  if (status.terminal)
    return {
      highValue: false,
      mandate: false,
      nfoOrOmbudsman: false,
      fraud: false,
      risk: false,
    };
  const normalized = status.normalizedStatus;
  const outstanding = finiteNumber(claim?.outstanding) ?? 0;
  const highValue = outstanding >= MANDATE_THRESHOLD;
  const mandate =
    status.category === "mandate" ||
    normalized === "over mandate" ||
    normalized === "not within mandate";
  const nfoOrOmbudsman =
    normalized === "ombudsman / legal advice" ||
    normalized.includes("nfo") ||
    normalized.includes("ombudsman");
  const fraud = normalized === "fraud";
  return {
    highValue,
    mandate,
    nfoOrOmbudsman,
    fraud,
    risk: highValue || mandate || nfoOrOmbudsman || fraud,
  };
}

function priorityFlag(code, level, score) {
  return { code, level, score };
}

/** Structured priority output; no UI labels, CSS classes, DOM, or current time. */
export function evaluatePriority(claim) {
  const status = getStatusEvaluation(claim?.status);
  const normalized = status.normalizedStatus;
  if (status.terminal && !normalized.startsWith("settled")) {
    return {
      score: 0,
      flags: [],
      actionCategory: status.category,
      terminal: true,
    };
  }
  const rule = getStatusRule(claim?.status);
  const age = finiteNumber(claim?.workingAge ?? claim?.age) ?? 0;
  const movementDays = finiteNumber(claim?.daysSinceMovement);
  const estimate = finiteNumber(claim?.estimate) ?? 0;
  const outstanding = finiteNumber(claim?.outstanding) ?? 0;
  const flags = [];
  let score = 0;
  let tier1 = 0;
  const tier1Rules = [
    ["fraud", 90, "red"],
    ["ombudsman / legal advice", 90, "red"],
    ["over mandate", 80, "red"],
    ["not within mandate", 80, "red"],
    ["authorised not sent", 75, "red"],
    ["claim older than 60 days", 50, "red"],
  ];
  for (const [value, points, level] of tier1Rules) {
    if (normalized === value) {
      flags.push(priorityFlag(value.replaceAll(" ", "_"), level, points));
      tier1 = Math.max(tier1, points);
    }
  }
  score += tier1;
  if (tier1 === 0 && outstanding >= MANDATE_THRESHOLD) {
    const points = age > 30 ? 90 : 60;
    flags.push(priorityFlag("high_value_mandate_check", "red", points));
    score += points;
  }
  const payment = rule?.category === "payment";
  const activeOrAssessor = ["active", "assessor"].includes(rule?.category);
  if (payment && estimate === 0) {
    flags.push(priorityFlag("payment_zero_estimate", "red", 95));
    score += 95;
  } else if (activeOrAssessor && estimate === 0 && age > 14) {
    flags.push(priorityFlag("active_zero_estimate", "amber", 45));
    score += 45;
  }
  if (outstanding > 0 && estimate === 0) {
    flags.push(priorityFlag("outstanding_without_estimate", "amber", 50));
    score += 50;
  } else if (estimate === 0 && outstanding === 0 && !payment) {
    flags.push(priorityFlag("zero_value_claim", "amber", 35));
    score += 35;
  }
  if (rule && rule.category !== "repudiated") {
    if (rule.critical !== null && age >= rule.critical) {
      const points = Math.min(90, 70 + Math.floor((age - rule.critical) / 3));
      flags.push(priorityFlag("critical_sla", "red", points));
      score += points;
    } else if (rule.stale !== null && age >= rule.stale) {
      const points = Math.min(55, 30 + Math.floor((age - rule.stale) / 2));
      flags.push(priorityFlag("stale_sla", "amber", points));
      score += points;
    }
  }
  if (rule?.category === "mandate" && tier1 < 80) {
    flags.push(priorityFlag("mandate_escalation", "red", 70));
    score += 70;
  }
  if (rule?.category === "repudiated") {
    const calendarAge = finiteNumber(claim?.calendarAge ?? claim?.age);
    const repudiationAge = finiteNumber(claim?.repudiationAge);
    if (
      (normalized === "repudiated" &&
        calendarAge !== null &&
        calendarAge > REPUDIATION_EXPIRY_DAYS) ||
      (repudiationAge !== null && repudiationAge >= REPUDIATION_EXPIRY_DAYS)
    ) {
      flags.push(priorityFlag("repudiation_expired", "red", 90));
      score += 90;
    } else if (repudiationAge === null) {
      flags.push(priorityFlag("repudiation_date_missing", "amber", 20));
      score += 20;
    } else if (repudiationAge >= 240) {
      flags.push(priorityFlag("repudiation_approaching_expiry", "amber", 30));
      score += 30;
    }
  }
  if (rule?.category === "legal") {
    const points = age > 60 ? 45 : 15;
    flags.push(priorityFlag("legal_recovery", "amber", points));
    score += points;
  }
  if (
    rule?.category !== "legal" &&
    movementDays !== null &&
    isOpenStatus(claim?.status)
  ) {
    if (movementDays > 30) {
      flags.push(priorityFlag("no_movement_over_30_days", "red", 45));
      score += 45;
    } else if (movementDays > 14) {
      flags.push(priorityFlag("no_movement_over_14_days", "amber", 25));
      score += 25;
    }
  }
  if (normalized === "awaiting assessor report" && age > 14) {
    flags.push(priorityFlag("assessor_report_overdue", "amber", 45));
    score += 45;
  }
  if (normalized === "awaiting investigators report" && age > 14) {
    flags.push(priorityFlag("investigator_report_overdue", "amber", 45));
    score += 45;
  }
  if (normalized === "awaiting broker feedback" && age > 7) {
    flags.push(priorityFlag("broker_feedback_overdue", "amber", 45));
    score += 45;
  }
  if (normalized === "registered" && age > 5) {
    flags.push(priorityFlag("registered_unactioned", "red", 90));
    score += 90;
  }
  if (claim?.possibleDuplicate) {
    flags.push(priorityFlag("possible_duplicate", "amber", 45));
    score += 45;
  }
  if (outstanding > 0 && estimate > 0 && outstanding > estimate * 1.5) {
    flags.push(priorityFlag("outstanding_exceeds_estimate", "amber", 45));
    score += 45;
  }
  const readyToClose = getReadyToCloseCandidate(claim);
  if (readyToClose) {
    const points = readyToClose.priority === "P1" ? 80 : 40;
    flags.push(
      priorityFlag(
        "ready_to_close",
        readyToClose.priority === "P1" ? "red" : "amber",
        points,
      ),
    );
    score += points;
  }
  return {
    score,
    flags,
    actionCategory: rule?.category ?? "unmapped",
    terminal: status.terminal,
    readyToClose,
  };
}

export function evaluateClaim(claim, options = {}) {
  const status = getStatusEvaluation(claim?.status);
  return {
    ruleVersion: CLAIMS_RULE_VERSION,
    businessTimeZone: BUSINESS_TIME_ZONE,
    status,
    ages: deriveClaimAges(claim, options),
    sla: evaluateSla(claim, options),
    movement: evaluateMovement(claim, options),
    readyToClose: getReadyToCloseCandidate(claim),
    zeroEstimateAnomaly: isZeroEstimateAnomaly(claim),
    valueConflicts: evaluateValueConflicts(claim),
    operationalCategories: evaluateOperationalCategories(claim),
    mandateAndRisk: evaluateMandateAndRisk(claim),
    priority: evaluatePriority(claim),
  };
}
