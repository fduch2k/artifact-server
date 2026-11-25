/** The principal id the local single-user API token acts as. */
export const localTokenPrincipalId = "local-api-token";

/** Prefix of the principal id that an unbound service key acts as. */
export const servicePrincipalIdPrefix = "service:";

/**
 * Who stands behind an owner or publisher id, resolved when it is read.
 *
 * A member is named; anything else carries a label instead of a raw id, so
 * a reader never has to guess what `service:key_…` or `local-api-token`
 * means. A member's email is present only for readers allowed to see the
 * member directory.
 */
export type PrincipalAttribution =
  | {
    readonly displayName: string;
    readonly email: string | null;
    readonly kind: "member";
    readonly label: string;
    readonly principalId: string;
  }
  | {readonly kind: "former-member"; readonly label: string; readonly principalId: string}
  | {
    readonly keyName: string | null;
    readonly kind: "service";
    readonly label: string;
    readonly principalId: string;
  }
  | {readonly kind: "local"; readonly label: string; readonly principalId: string}
  | {readonly kind: "unknown"; readonly label: string; readonly principalId: string};

/** Facts needed to resolve principal ids, gathered once per read. */
export interface PrincipalDirectorySnapshot {
  readonly members: ReadonlyMap<string, {
    readonly active: boolean;
    readonly displayName: string;
    readonly email: string;
  }>;
  readonly serviceKeyNames: ReadonlyMap<string, string>;
}

/**
 * The name written with everything a member-bound API key does: the member
 * first, the key as a qualifier, so readers see both the person and the
 * agent acting for them.
 */
export function memberKeyDisplayName(memberName: string, keyName: string): string {
  return `${memberName} · ${keyName}`;
}

/**
 * Resolve one principal id against a directory snapshot.
 *
 * @param principalId - An owner or publisher id as stored.
 * @param directory - Members and service-key names of the installation.
 * @param includeEmail - Whether the reader may see members' emails.
 */
export function attributePrincipal(
  principalId: string,
  directory: PrincipalDirectorySnapshot,
  includeEmail: boolean,
): PrincipalAttribution {
  if (principalId === localTokenPrincipalId) {
    return {kind: "local", label: "Local API token", principalId};
  }
  const member = directory.members.get(principalId);
  if (member?.active === true) {
    return {
      displayName: member.displayName,
      email: includeEmail ? member.email : null,
      kind: "member",
      label: member.displayName,
      principalId,
    };
  }
  if (member !== undefined) {
    return {kind: "former-member", label: "Former member", principalId};
  }
  if (!principalId.startsWith(servicePrincipalIdPrefix)) {
    return {kind: "unknown", label: "Unknown principal", principalId};
  }
  const keyName = directory.serviceKeyNames.get(principalId) ?? null;
  return {
    keyName,
    kind: "service",
    label: keyName === null ? "Service key" : `Service key · ${keyName}`,
    principalId,
  };
}
