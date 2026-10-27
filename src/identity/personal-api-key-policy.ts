import {z} from "zod";

import type {PersonalApiKeyPolicy} from "../core/installation-identity.js";

/** Lifetime a personal key may have when the operator does not choose one. */
export const defaultPersonalApiKeyMaxDays = 30;

const enabledSchema = z.enum(["true", "false"]);
const maxDaysSchema = z.string().regex(/^[1-9][0-9]{0,4}$/u);

/** Validate operator settings for member self-service personal API keys. */
export function parsePersonalApiKeyPolicy(
  enabled: string | undefined,
  maxDays: string | undefined,
): PersonalApiKeyPolicy | null {
  const parsedEnabled = enabledSchema.safeParse(enabled ?? "false");
  if (!parsedEnabled.success) {
    throw new Error("ARTIFACT_SERVER_PERSONAL_API_KEYS must be exactly true or false.");
  }
  const parsedMaxDays = maxDays === undefined || maxDays.trim() === ""
    ? null
    : maxDaysSchema.safeParse(maxDays.trim());
  if (parsedMaxDays !== null && !parsedMaxDays.success) {
    throw new Error(
      "ARTIFACT_SERVER_PERSONAL_API_KEY_MAX_DAYS must be a whole number of days from 1 to 99999.",
    );
  }
  if (parsedEnabled.data === "false") return null;
  return {
    maxLifetimeDays: parsedMaxDays === null
      ? defaultPersonalApiKeyMaxDays
      : Number(parsedMaxDays.data),
  };
}
