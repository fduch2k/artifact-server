import {accessSettings, type ArtifactRecord} from "./model.js";
import type {RestrictedArtifactScope} from "./ports.js";

/**
 * Who a registered agent acts for, resolved from the principal that
 * registered it.
 *
 * An agent always connects through an API key, never through a person's
 * browser session, so it never carries an administrator's reach: a member's
 * agent reads what that member owns or was given, and an agent registered by
 * a service key or the local token reads no restricted artifact. A former
 * member's keys are revoked, so their agent can no longer claim anything.
 */
export type AgentOwner =
  | {
    readonly displayName: string;
    readonly kind: "member";
    readonly principalId: string;
  }
  | {readonly kind: "former-member"; readonly principalId: string}
  | {readonly kind: "service"; readonly principalId: string};

type VisibilityFacts = Pick<
  ArtifactRecord,
  "accessSetting" | "grantedPrincipalIds" | "ownerPrincipalId"
>;

/** Report whether an agent can still claim and read anything it is sent. */
export function agentReceivesWork(owner: AgentOwner): boolean {
  return owner.kind !== "former-member";
}

/** The restricted artifacts an agent of this owner can read. */
export function agentArtifactScope(owner: AgentOwner): RestrictedArtifactScope {
  return owner.kind === "member"
    ? {kind: "member", principalId: owner.principalId}
    : {kind: "none"};
}

/**
 * Report whether an agent of this owner can read one artifact. This is the
 * in-memory twin of the storage check a send applies to every thread.
 */
export function agentCanReadArtifact(
  owner: AgentOwner,
  artifact: VisibilityFacts,
): boolean {
  if (!agentReceivesWork(owner)) return false;
  if (artifact.accessSetting !== accessSettings.restricted) return true;
  const scope = agentArtifactScope(owner);
  return scope.kind === "member" && (
    artifact.ownerPrincipalId === scope.principalId ||
    artifact.grantedPrincipalIds.includes(scope.principalId)
  );
}

/**
 * Report whether a person may see where another principal's agent runs.
 * Working directories and connection keys of another member's agent stay
 * private; agents of service keys and the local token are installation
 * infrastructure and stay described as before.
 */
export function agentLocationVisibleTo(
  owner: AgentOwner,
  viewerPrincipalId: string,
): boolean {
  return owner.kind === "service" || owner.principalId === viewerPrincipalId;
}
