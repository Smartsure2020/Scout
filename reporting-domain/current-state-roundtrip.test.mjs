import assert from "node:assert/strict";
import test from "node:test";

import { buildCurrentStateClaimRecord } from "../scout backend.js";
import { mapCardinalRows } from "../scout-smartsure/claims/cardinal-ingestion.mjs";
import {
  businessDateFromInstant,
  currentStateRowToClaim,
} from "../scout-smartsure/claims/current-state-adapter.mjs";
import { deriveClaimAges, evaluateClaim } from "./claims-rules.mjs";

const AS_OF_DATE = "2026-10-01";
const users = [
  {
    id: "handler-1",
    email: "handler.one@example.test",
    display_name: "Handler One",
    role: "handler",
    active: true,
  },
];

const rows = [
  {
    "Claim No.": "NORMAL-RAND",
    "Claims Status": "Awaiting Assessor Report",
    "Claim Handler": "Handler One",
    Age: "12",
    Insurer: "Example Insurer",
    "Claim Registered": "15/09/2026",
    DOL: "14/09/2026",
    "Original Estimate": "R 25,000.50",
    Outstanding: "R 20,000.25",
    Paid: "R 1,250.00",
    Mandate: "R 100,000",
    "Nett Claim": "R 21,250.25",
    "Sum Insured": "R 500,000",
    RepudiateAmount: "R 0",
    "Last Updated": "29/09/2026",
    Peril: "Storm",
    "Description of Loss": "Roof damage",
    Insured: "Normal Client",
    Comments: "Normal value and formatted Rand fixture",
  },
  {
    "Claim No.": "EXPLICIT-ZERO",
    "Claims Status": "Registered",
    "Claim Handler": "Handler One",
    Age: "0",
    Insurer: "Example Insurer",
    "Claim Registered": "01/10/2026",
    "Original Estimate": "0",
    Outstanding: "0",
    Paid: "0",
    Peril: "Other",
  },
  {
    "Claim No.": "MISSING-MONEY",
    "Claims Status": "Registered",
    "Claim Handler": "Handler One",
    Age: "2",
    Insurer: "Example Insurer",
    "Claim Registered": "29/09/2026",
    "Original Estimate": "",
    Outstanding: "",
    Paid: "",
    Peril: "Other",
  },
  {
    "Claim No.": "MALFORMED-MONEY",
    "Claims Status": "Registered",
    "Claim Handler": "Handler One",
    Age: "3",
    Insurer: "Example Insurer",
    "Claim Registered": "28/09/2026",
    "Original Estimate": "not money",
    Outstanding: "R ???",
    Paid: "invalid",
    Mandate: "bad mandate",
    Peril: "Other",
  },
  {
    "Claim No.": "REPUDIATED-DATES",
    "Claims Status": "Repudiated",
    "Claim Handler": "Handler One",
    Age: "250",
    Insurer: "Example Insurer",
    "Claim Registered": "24/12/2025",
    DOL: "20/12/2025",
    "Repudiation Date": "25/01/2026",
    "Last Modified": "30/09/2026",
    "Original Estimate": "R 5,000",
    Outstanding: "R 5,000",
    Paid: "0",
    Peril: "Theft",
  },
  {
    "Claim No.": "PAID-CLOSE",
    "Claims Status": "Payment - Payments made",
    "Claim Handler": "Handler One",
    Age: "25",
    Insurer: "Example Insurer",
    "Claim Registered": "27/08/2026",
    "Settled Date": "30/09/2026",
    "Original Estimate": "R 8,000",
    Outstanding: "0",
    Paid: "R 8,000",
    Peril: "Accident",
  },
  {
    "Claim No.": "PAYMENT-ZERO",
    "Claims Status": "Payment Requested",
    "Claim Handler": "Handler One",
    Age: "35",
    Insurer: "Example Insurer",
    "Original Estimate": "0",
    Outstanding: "R 2,500",
    Paid: "0",
    Peril: "Accident",
  },
  {
    "Claim No.": "HIGH-VALUE",
    "Claims Status": "Assessment of Claim",
    "Claim Handler": "Handler One",
    Age: "20",
    Insurer: "Example Insurer",
    "Original Estimate": "R 150,000",
    Outstanding: "R 125,000",
    Paid: "0",
    Peril: "Fire",
  },
  {
    "Claim No.": "MANDATE-STATUS",
    "Claims Status": "Over Mandate",
    "Claim Handler": "Handler One",
    Age: "4",
    Insurer: "Example Insurer",
    "Original Estimate": "R 40,000",
    Outstanding: "R 40,000",
    Paid: "0",
    Mandate: "R 35,000",
    Peril: "Water",
  },
];

function calendarDaysBetween(start, end) {
  if (!start || !end) return null;
  return Math.max(
    0,
    Math.round(
      (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) /
        86400000,
    ),
  );
}

function operationalClaim(claim) {
  const calculated = deriveClaimAges(
    { ...claim, age: null, workingAge: null, calendarAge: null },
    { asOfDate: AS_OF_DATE },
  );
  const workingAge = calculated.workingAge ?? claim.age;
  const calendarAge = calculated.calendarAge ?? claim.age;
  const lastUpdated = claim.lastUpdated || null;
  const repudiationDate = claim.repudiationDate || null;
  return {
    ...claim,
    workingAge,
    calendarAge,
    daysSinceMovement: calendarDaysBetween(lastUpdated, AS_OF_DATE),
    repudiationAge: calendarDaysBetween(repudiationDate, AS_OF_DATE),
  };
}

function uploadCanonical(claim) {
  return {
    ...claim,
    lastUpdated: claim.lastUpdated || null,
    lastUpdatedSource: claim.lastUpdated ? "cardinal" : "unavailable",
  };
}

const operationalFields = [
  "age",
  "ageProvided",
  "handler",
  "claimNo",
  "status",
  "registeredDate",
  "dol",
  "repudiationDate",
  "settledDate",
  "lastUpdated",
  "lastUpdatedSource",
  "description",
  "insured",
  "outstanding",
  "estimate",
  "paid",
  "peril",
  "insurer",
  "comments",
  "ingestionQualityFlags",
];

function pick(source, fields) {
  return Object.fromEntries(fields.map((field) => [field, source[field] ?? null]));
}

test("upload dates use the Johannesburg business date at the UTC day boundary", () => {
  assert.equal(
    businessDateFromInstant("2026-09-30T22:30:00.000Z"),
    "2026-10-01",
  );
});

test("Cardinal claims survive the current-state persistence and frontend reload contract", () => {
  const canonical = mapCardinalRows(rows).map(uploadCanonical);
  const reconstructed = canonical.map((claim) =>
    currentStateRowToClaim(
      buildCurrentStateClaimRecord(claim, AS_OF_DATE, users).record,
    ),
  );

  assert.equal(reconstructed.length, rows.length);
  canonical.forEach((claim, index) => {
    assert.deepEqual(
      pick(reconstructed[index], operationalFields),
      pick(claim, operationalFields),
      claim.claimNo,
    );
  });

  const zero = reconstructed.find((claim) => claim.claimNo === "EXPLICIT-ZERO");
  const missing = reconstructed.find((claim) => claim.claimNo === "MISSING-MONEY");
  const malformed = reconstructed.find((claim) => claim.claimNo === "MALFORMED-MONEY");
  assert.deepEqual(pick(zero, ["estimate", "outstanding", "paid"]), {
    estimate: 0,
    outstanding: 0,
    paid: 0,
  });
  assert.deepEqual(pick(missing, ["estimate", "outstanding", "paid"]), {
    estimate: null,
    outstanding: null,
    paid: null,
  });
  assert.deepEqual(pick(malformed, ["estimate", "outstanding", "paid"]), {
    estimate: null,
    outstanding: null,
    paid: null,
  });
  assert.deepEqual(malformed.ingestionQualityFlags.sort(), [
    "source_parse_failure:estimate",
    "source_parse_failure:mandate",
    "source_parse_failure:outstanding",
    "source_parse_failure:paid",
  ]);
});

test("operational classifications are identical before persistence and after reload", () => {
  const canonical = mapCardinalRows(rows).map(uploadCanonical);
  canonical.forEach((claim) => {
    const before = operationalClaim(claim);
    const row = buildCurrentStateClaimRecord(before, AS_OF_DATE, users).record;
    const after = operationalClaim(currentStateRowToClaim(row));
    assert.equal(after.age, claim.age, `${claim.claimNo}: Cardinal age`);
    const beforeRules = evaluateClaim(before, { asOfDate: AS_OF_DATE });
    const afterRules = evaluateClaim(after, { asOfDate: AS_OF_DATE });

    assert.deepEqual(afterRules.status, beforeRules.status, `${claim.claimNo}: status`);
    assert.deepEqual(afterRules.ages, beforeRules.ages, `${claim.claimNo}: ages`);
    assert.deepEqual(afterRules.sla, beforeRules.sla, `${claim.claimNo}: SLA`);
    assert.deepEqual(afterRules.priority, beforeRules.priority, `${claim.claimNo}: priority`);
    assert.deepEqual(afterRules.readyToClose, beforeRules.readyToClose, `${claim.claimNo}: ready to close`);
    assert.equal(afterRules.zeroEstimateAnomaly, beforeRules.zeroEstimateAnomaly, `${claim.claimNo}: zero estimate`);
    assert.deepEqual(afterRules.operationalCategories, beforeRules.operationalCategories, `${claim.claimNo}: categories`);
    assert.deepEqual(afterRules.mandateAndRisk, beforeRules.mandateAndRisk, `${claim.claimNo}: mandate/risk`);
  });
});

test("Cardinal-only financial evidence stays out of scout_claims while history retains it", () => {
  const [claim] = mapCardinalRows(rows);
  const row = buildCurrentStateClaimRecord(claim, AS_OF_DATE, users).record;
  for (const field of ["mandate", "nett_claim", "sum_insured", "repudiate_amount"])
    assert.equal(field in row, false, field);
  assert.equal(claim.mandate, 100000);
  assert.equal(claim.nettClaim, 21250.25);
  assert.equal(claim.sumInsured, 500000);
  assert.equal(claim.repudiateAmount, 0);
});
