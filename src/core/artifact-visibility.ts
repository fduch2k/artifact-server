import {Effect} from "effect";

import {ArtifactNotFound, AuthorizationDenied} from "./errors.js";
import {
  isHumanAdministrator,
  principalKinds,
  type Principal,
} from "./identity.js";
import {accessSettings, type ArtifactRecord} from "./model.js";
import type {RestrictedArtifactScope} from "./ports.js";

type VisibilityFacts = Pick<
  ArtifactRecord,
  "accessSetting" | "grantedPrincipalIds" | "ownerPrincipalId"
>;

/**
 * Report whether one principal may see an artifact at all.
 *
 * Only `restricted` artifacts narrow visibility: their owner and the members
 * it is shared with, through any of their own channels, and installation
 * administrators see them. Service principals never do, whatever their
 * capabilities. Every other access setting leaves the decision to the
 * ordinary capability checks.
 */
export function canSeeArtifact(
  principal: Principal,
  artifact: VisibilityFacts,
): boolean {
  if (artifact.accessSetting !== accessSettings.restricted) return true;
  return isHumanAdministrator(principal) || ownsArtifact(principal, artifact) ||
    isGrantedArtifact(principal, artifact);
}

/** Fail exactly like a missing artifact when the principal may not see it. */
export function requireArtifactVisible(
  principal: Principal,
  artifact: VisibilityFacts,
): Effect.Effect<void, ArtifactNotFound> {
  return canSeeArtifact(principal, artifact)
    ? Effect.void
    : Effect.fail(new ArtifactNotFound({message: "The artifact does not exist."}));
}

/**
 * Refuse a change to a restricted artifact by anyone but its owner or an
 * administrator. Members it is shared with may read and comment, not change it.
 */
export function requireArtifactChangeable(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "accessSetting" | "ownerPrincipalId">,
): Effect.Effect<void, AuthorizationDenied> {
  return artifact.accessSetting !== accessSettings.restricted ||
      mayChangeRestriction(principal, artifact)
    ? Effect.void
    : Effect.fail(new AuthorizationDenied({
      message: "Only the owner or an administrator can change this artifact.",
    }));
}

/**
 * Report whether a principal may move an artifact to or from `restricted` and
 * choose the members it is shared with.
 */
export function mayChangeRestriction(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "ownerPrincipalId">,
): boolean {
  return isHumanAdministrator(principal) || ownsArtifact(principal, artifact);
}

/** The restricted artifacts one principal may list. */
export function restrictedArtifactScope(
  principal: Principal,
): RestrictedArtifactScope {
  if (isHumanAdministrator(principal)) return {kind: "all"};
  if (principal.kind === principalKinds.human) {
    return {kind: "member", principalId: principal.id};
  }
  return {kind: "none"};
}

/** Report whether a person, directly or through their own key, owns an artifact. */
export function ownsArtifact(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "ownerPrincipalId">,
): boolean {
  // A member-bound API key carries the member's id, so it counts as the owner.
  return principal.kind === principalKinds.human &&
    artifact.ownerPrincipalId !== null &&
    artifact.ownerPrincipalId === principal.id;
}

function isGrantedArtifact(
  principal: Principal,
  artifact: Pick<ArtifactRecord, "grantedPrincipalIds">,
): boolean {
  // Grants name members, so a member-bound API key shares its member's grants.
  return principal.kind === principalKinds.human &&
    artifact.grantedPrincipalIds.includes(principal.id);
}
