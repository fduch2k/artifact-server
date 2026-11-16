import {z} from "zod";

const ownerScopedManagementSchema = z.enum(["true", "false"]);

/**
 * Validate the operator's choice to scope people's artifact management to the
 * artifacts they own (ADR 0038); unset keeps every member managing.
 */
export function parseOwnerScopedManagement(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  const parsed = ownerScopedManagementSchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new Error(
      "ARTIFACT_SERVER_OWNER_SCOPED_MANAGEMENT must be exactly true or false.",
    );
  }
  return parsed.data === "true";
}
