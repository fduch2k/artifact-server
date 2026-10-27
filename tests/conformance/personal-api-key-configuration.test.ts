import {describe, expect, test} from "vitest";

import {
  defaultPersonalApiKeyMaxDays,
  parsePersonalApiKeyPolicy,
} from "../../src/identity/personal-api-key-policy.js";

describe("personal API key configuration", () => {
  test("AUTH-034: personal keys default off and an enabled policy takes the operator's lifetime", () => {
    expect(parsePersonalApiKeyPolicy(undefined, undefined)).toBeNull();
    expect(parsePersonalApiKeyPolicy("false", "365")).toBeNull();
    expect(parsePersonalApiKeyPolicy("true", undefined))
      .toEqual({maxLifetimeDays: defaultPersonalApiKeyMaxDays});
    expect(parsePersonalApiKeyPolicy("true", "")).toEqual({maxLifetimeDays: 30});
    expect(parsePersonalApiKeyPolicy("true", " 365 ")).toEqual({maxLifetimeDays: 365});
    expect(parsePersonalApiKeyPolicy("true", "99999")).toEqual({maxLifetimeDays: 99_999});
  });

  test("AUTH-034: malformed personal key settings fail startup even while the feature is off", () => {
    for (const enabled of ["yes", "TRUE", "1", " true"]) {
      expect(() => parsePersonalApiKeyPolicy(enabled, undefined))
        .toThrow("ARTIFACT_SERVER_PERSONAL_API_KEYS must be exactly true or false.");
    }
    for (const maxDays of ["0", "-1", "1.5", "30d", "100000", "007"]) {
      expect(() => parsePersonalApiKeyPolicy("false", maxDays))
        .toThrow("ARTIFACT_SERVER_PERSONAL_API_KEY_MAX_DAYS");
    }
  });
});
