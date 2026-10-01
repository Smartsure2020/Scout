const FIELD_ALIASES = Object.freeze({
  claimNo: Object.freeze(["Claim No.", "Claim No"]),
  status: Object.freeze(["Claims Status", "Status"]),
  handler: Object.freeze(["Claim Handler"]),
  age: Object.freeze(["Age"]),
  insurer: Object.freeze(["Insurer"]),
  registeredDate: Object.freeze(["Claim Registered"]),
  dol: Object.freeze(["DOL"]),
  description: Object.freeze(["Description of Loss"]),
  insured: Object.freeze(["Insured"]),
  repudiationDate: Object.freeze([
    "Repudiation Date",
    "Repudiation Notification Date",
    "Repudiation Letter Date",
    "Date Repudiated",
    "Manual Repudiation Date",
  ]),
  settledDate: Object.freeze(["Settled Date"]),
  movementDate: Object.freeze([
    "Last Updated",
    "Status Updated",
    "Status Date",
    "Last Movement Date",
    "Last Modified",
    "Modified Date",
    "Updated At",
  ]),
  estimate: Object.freeze([
    "Origional Estimate",
    "Original Estimate",
    "Own Damage Original Estimate",
  ]),
  outstanding: Object.freeze(["Outstanding"]),
  nettClaim: Object.freeze(["Nett Claim"]),
  paid: Object.freeze(["Paid"]),
  mandate: Object.freeze(["Mandate"]),
  sumInsured: Object.freeze(["Sum Insured"]),
  repudiateAmount: Object.freeze(["RepudiateAmount"]),
  peril: Object.freeze(["Peril"]),
  settled: Object.freeze(["Settled"]),
  comments: Object.freeze(["Comments"]),
  claimValue: Object.freeze(["Claim Value", "Value"]),
  repudiatedIndicator: Object.freeze(["Repudiated"]),
});

export const CARDINAL_FIELD_ALIASES = FIELD_ALIASES;
export const REQUIRED_CARDINAL_FIELDS = Object.freeze([
  "claimNo",
  "status",
  "handler",
  "age",
  "insurer",
]);
export const MOVEMENT_COLUMNS = FIELD_ALIASES.movementDate;
export const KNOWN_CARDINAL_COLUMNS = Object.freeze(
  [...new Set(Object.values(FIELD_ALIASES).flat())],
);

function hasSourceValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function firstSourceValue(row, aliases) {
  for (const alias of aliases) {
    if (hasSourceValue(row?.[alias])) return row[alias];
  }
  return null;
}

export function parseNullableNumber(value) {
  if (!hasSourceValue(value)) return { value: null, state: "missing" };
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { value, state: "known" }
      : { value: null, state: "malformed" };
  }
  let text = String(value).trim();
  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[Rr]\s?/g, "").replace(/\s/g, "").replace(/,/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    return { value: null, state: "malformed" };
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return { value: null, state: "malformed" };
  return { value: negative ? -parsed : parsed, state: "known" };
}

export function parseNullableDate(value) {
  if (!hasSourceValue(value)) return { value: null, state: "missing" };
  if (typeof value === "boolean") return { value: null, state: "malformed" };
  const text = String(value).trim();
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(text);
  const localDate = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(text);
  const parts = isoDate
    ? [Number(isoDate[1]), Number(isoDate[2]), Number(isoDate[3])]
    : localDate
      ? [Number(localDate[3]), Number(localDate[2]), Number(localDate[1])]
      : null;
  if (parts) {
    const [year, month, day] = parts;
    const check = new Date(Date.UTC(year, month - 1, day));
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) {
      return { value: null, state: "malformed" };
    }
    return {
      value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      state: "known",
    };
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return { value: null, state: "malformed" };
  return {
    value: `${String(parsed.getFullYear()).padStart(4, "0")}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`,
    state: "known",
  };
}

function parseFirstDate(row, aliases) {
  let sawMalformed = false;
  for (const alias of aliases) {
    if (!hasSourceValue(row?.[alias])) continue;
    const result = parseNullableDate(row[alias]);
    if (result.state === "known") return result;
    sawMalformed = true;
  }
  return { value: null, state: sawMalformed ? "malformed" : "missing" };
}

function qualityFlag(field, state) {
  return state === "malformed" ? `source_parse_failure:${field}` : null;
}

export function validateCardinalColumns(columns = []) {
  const supplied = new Set(columns);
  const missingFields = REQUIRED_CARDINAL_FIELDS.filter(
    (field) => !FIELD_ALIASES[field].some((alias) => supplied.has(alias)),
  );
  return {
    missingFields,
    missingGroups: missingFields.map((field) => ({
      field,
      aliases: [...FIELD_ALIASES[field]],
    })),
    unmappedColumns: [...supplied].filter(
      (column) => !KNOWN_CARDINAL_COLUMNS.includes(column),
    ),
    hasMovementColumn: MOVEMENT_COLUMNS.some((column) => supplied.has(column)),
  };
}

export function mapCardinalRow(
  row = {},
  { normalizeHandler = (value) => value, normalizeStatus = (value) => value } = {},
) {
  const financial = Object.fromEntries(
    ["outstanding", "estimate", "paid", "mandate", "nettClaim", "sumInsured", "repudiateAmount"].map(
      (field) => [field, parseNullableNumber(firstSourceValue(row, FIELD_ALIASES[field]))],
    ),
  );
  const age = parseNullableNumber(firstSourceValue(row, FIELD_ALIASES.age));
  const registeredDate = parseFirstDate(row, FIELD_ALIASES.registeredDate);
  const dol = parseFirstDate(row, FIELD_ALIASES.dol);
  const repudiationDate = parseFirstDate(row, FIELD_ALIASES.repudiationDate);
  const settledDate = parseFirstDate(row, FIELD_ALIASES.settledDate);
  const movementDate = parseFirstDate(row, FIELD_ALIASES.movementDate);
  const handlerRaw = String(firstSourceValue(row, FIELD_ALIASES.handler) ?? "").trim();
  const quality = [
    qualityFlag("age", age.state),
    qualityFlag("registered_date", registeredDate.state),
    qualityFlag("dol_date", dol.state),
    qualityFlag("repudiation_date", repudiationDate.state),
    qualityFlag("movement_date", movementDate.state),
    ...Object.entries(financial).map(([field, result]) => qualityFlag(field, result.state)),
  ].filter(Boolean);
  const settledValue = firstSourceValue(row, FIELD_ALIASES.settled);
  return {
    age: age.value,
    ageProvided: age.state === "known",
    handler: normalizeHandler(handlerRaw),
    handlerRaw,
    claimNo: String(firstSourceValue(row, FIELD_ALIASES.claimNo) ?? "").trim(),
    status: normalizeStatus(String(firstSourceValue(row, FIELD_ALIASES.status) ?? "")),
    registeredDate: registeredDate.value,
    dol: dol.value,
    repudiationDate: repudiationDate.value,
    settledDate: settledDate.value,
    lastUpdated: movementDate.value,
    description: String(firstSourceValue(row, FIELD_ALIASES.description) ?? ""),
    insured: String(firstSourceValue(row, FIELD_ALIASES.insured) ?? ""),
    outstanding: financial.outstanding.value,
    estimate: financial.estimate.value,
    paid: financial.paid.value,
    mandate: financial.mandate.value,
    nettClaim: financial.nettClaim.value,
    sumInsured: financial.sumInsured.value,
    repudiateAmount: financial.repudiateAmount.value,
    peril: String(firstSourceValue(row, FIELD_ALIASES.peril) ?? ""),
    settled:
      settledValue === true ||
      ["true", "yes", "y", "1"].includes(String(settledValue ?? "").trim().toLowerCase()),
    insurer: String(firstSourceValue(row, FIELD_ALIASES.insurer) ?? ""),
    comments: String(firstSourceValue(row, FIELD_ALIASES.comments) ?? ""),
    ingestionQualityFlags: [...new Set(quality)],
  };
}

export function mapCardinalRows(rows = [], options = {}) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => mapCardinalRow(row, options))
    .filter((claim) => claim.claimNo);
}

if (typeof window !== "undefined") {
  window.ScoutCardinalIngestion = {
    CARDINAL_FIELD_ALIASES,
    KNOWN_CARDINAL_COLUMNS,
    MOVEMENT_COLUMNS,
    REQUIRED_CARDINAL_FIELDS,
    mapCardinalRow,
    mapCardinalRows,
    parseNullableDate,
    parseNullableNumber,
    validateCardinalColumns,
  };
}
