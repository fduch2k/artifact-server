import {z} from "zod";

import type {SlidingSessionPolicy} from "../core/installation-identity.js";

const idleDaysSchema = z.string().regex(/^[1-9][0-9]{0,2}$/u)
  .refine((value) => Number(value) <= 365);

/** Validate the operator's sliding browser-session window; unset keeps fixed sessions. */
export function parseSlidingSessionPolicy(
  idleDays: string | undefined,
): SlidingSessionPolicy | null {
  if (idleDays === undefined || idleDays.trim() === "") return null;
  const parsed = idleDaysSchema.safeParse(idleDays.trim());
  if (!parsed.success) {
    throw new Error(
      "ARTIFACT_SERVER_SESSION_IDLE_DAYS must be a whole number of days from 1 to 365.",
    );
  }
  return {idleLifetimeDays: Number(parsed.data)};
}
