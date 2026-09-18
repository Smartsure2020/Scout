import assert from "node:assert/strict";
import test from "node:test";

import {
  historicalManifestRecord,
  parseCorrectionOfExtractId,
} from "./scout backend.js";

const VALID_CORRECTION_ID = "8043f9e0-08a9-41de-96be-f50f2f01649c";

test("correction input distinguishes omission from invalid supplied values", () => {
  assert.deepEqual(parseCorrectionOfExtractId({ claims: [] }), {
    supplied: false,
    value: null,
    error: null,
  });

  for (const value of [null, "", "   ", 0, false, true, {}, [], "not-a-uuid"]) {
    assert.deepEqual(
      parseCorrectionOfExtractId({ correctionOfExtractId: value }),
      {
        supplied: true,
        value: null,
        error: "invalid_correction_of_extract_id",
      },
    );
  }

  assert.deepEqual(
    parseCorrectionOfExtractId({
      correctionOfExtractId: VALID_CORRECTION_ID,
    }),
    {
      supplied: true,
      value: VALID_CORRECTION_ID,
      error: null,
    },
  );
});

test("new correction manifests store the resolved genuine predecessor", () => {
  const makeRecord = ({
    extractDate,
    correctionOfExtractId,
    previousManifest,
  }) =>
    historicalManifestRecord({
      checksum: `${extractDate}-checksum`,
      checksumBasis: "claims-json-payload",
      fileName: "extract.csv",
      extractDate,
      effectiveAt: null,
      receivedAt: `${extractDate}T12:00:00.000Z`,
      currentUser: { id: "user-1", email: "admin@example.test" },
      claims: [{}],
      normalized: {
        quality: {
          accepted_claim_count: 1,
          rejected_claim_count: 0,
        },
      },
      quality: { hard_rejection: false },
      previousManifest,
      sourceMetadata: {},
      correctionOfExtractId,
    });

  const p0 = { id: "p0", effective_date: "2026-09-04" };
  const bad14 = { id: "bad14", effective_date: "2026-09-14" };
  const new14 = {
    id: "new14",
    ...makeRecord({
      extractDate: "2026-09-14",
      correctionOfExtractId: bad14.id,
      previousManifest: p0,
    }),
  };
  assert.equal(new14.correction_of_extract_id, bad14.id);
  assert.equal(new14.previous_extract_id, p0.id);

  const o15 = { id: "o15", effective_date: "2026-09-15" };
  const new15 = makeRecord({
    extractDate: "2026-09-15",
    correctionOfExtractId: o15.id,
    previousManifest: new14,
  });
  assert.equal(new15.correction_of_extract_id, o15.id);
  assert.equal(new15.previous_extract_id, new14.id);

  const ordinary15 = { id: "ordinary15", effective_date: "2026-09-15" };
  const ordinary16 = makeRecord({
    extractDate: "2026-09-16",
    correctionOfExtractId: null,
    previousManifest: ordinary15,
  });
  assert.equal(ordinary16.previous_extract_id, ordinary15.id);
  assert.equal(ordinary16.correction_of_extract_id, null);
});
