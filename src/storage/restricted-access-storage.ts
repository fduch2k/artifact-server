import {accessSettings, type AccessSetting} from "../core/model.js";
import type {RestrictedArtifactScope} from "../core/ports.js";

/** The stored pair behind one API access setting. */
export interface StoredAccessSetting {
  /** The value kept in the `access_setting` column and its CHECK constraint. */
  readonly accessSetting: "account_required" | "public_link";
  /** Whether the artifact is limited to its owner and administrators. */
  readonly restricted: boolean;
}

/**
 * Split an API access setting into the stored column pair.
 *
 * `restricted` is kept as a flag beside `access_setting` rather than a third
 * CHECK value, so SQLite and D1 need no rebuild of the `artifacts` table.
 */
export function storedAccessSetting(setting: AccessSetting): StoredAccessSetting {
  return setting === accessSettings.restricted
    ? {accessSetting: accessSettings.accountRequired, restricted: true}
    : {accessSetting: setting, restricted: false};
}

/** SQL that reads the stored pair back as one API access setting. */
export function accessSettingSql(
  alias = "",
  dialect: "postgres" | "sqlite" = "sqlite",
): string {
  const prefix = alias === "" ? "" : `${alias}.`;
  // Postgres stores a real boolean; SQLite and D1 store 0 or 1.
  const flag = dialect === "postgres"
    ? `${prefix}restricted`
    : `${prefix}restricted = 1`;
  return `CASE WHEN ${flag} THEN '${accessSettings.restricted}' ELSE ${prefix}access_setting END`;
}

/**
 * SQL that keeps an artifact row its reader may see. Bind
 * `restrictedScopeParameters` to the placeholders in order.
 */
export function restrictedScopeSql(
  alias: string,
  placeholders: readonly [string, string, string] = ["?", "?", "?"],
): string {
  const [all, owner, grantee] = placeholders;
  return `(${alias}.restricted = 0 OR ${all} = 1 OR ${alias}.owner_principal_id = ${owner}
    OR EXISTS (
      SELECT 1 FROM artifact_grants access_grant
      WHERE access_grant.artifact_id = ${alias}.id
        AND access_grant.principal_id = ${grantee}
    ))`;
}

/** Bind values for `restrictedScopeSql`: everything, one member's, or nothing. */
export function restrictedScopeParameters(
  scope: RestrictedArtifactScope,
): readonly [number, string | null, string | null] {
  if (scope.kind === "all") return [1, null, null];
  if (scope.kind === "member") return [0, scope.principalId, scope.principalId];
  return [0, null, null];
}
