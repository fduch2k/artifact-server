import { createHash } from "node:crypto";

import { Context, DateTime, Effect, Layer } from "effect";

import type { ApplicationClock } from "./application-clock.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import { parseIdempotencyKey } from "./idempotency-key.js";
import {
  normalizeArtifactTag,
  parseArtifactTags,
} from "./artifact-tags.js";
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";
import { InstallationAccessService } from "./installation-access.js";
import {
  ArtifactNotFound,
  type ArtifactMutationConflict,
  type ArtifactRepositoryFailure,
  AuthorizationDenied,
  type IdempotencyConflict,
  type IdentityNotFound,
  type IdentityRepositoryFailure,
  type InvalidArtifactTags,
  type InvalidIdempotencyKey,
  InvalidPagination,
  VersionNotFound,
} from "../core/errors.js";
import {
  mayChangeRestriction,
  requireArtifactChangeable,
  requireArtifactVisible,
  restrictedArtifactScope,
} from "../core/artifact-visibility.js";
import type { Principal } from "../core/identity.js";
import {
  accessSettings,
  type AccessSetting,
  type ArtifactActionPage,
  type ArtifactDeletion,
  type ArtifactGrant,
  type ArtifactPage,
  type ArtifactRecord,
  type ArtifactState,
  type ArtifactVersion,
  type PageCursor,
  type VersionRecord,
} from "../core/model.js";
import type {
  ArtifactGrantChange,
  ChangeArtifactAccessSetting,
  ChangeArtifactTags,
  DeleteArtifact,
  GrantArtifactAccess,
  ListArtifactActions,
  ListArtifacts,
  RestoreArtifactVersion,
  RevokeArtifactAccess,
} from "../core/ports.js";

const maximumPageSize = 100;

/** One artifact and the complete record for its current saved version. */
export interface ArtifactDetails {
  readonly artifact: ArtifactRecord;
  readonly current: ArtifactVersion;
}

/** One artifact and one exact saved version selected for a version-level action. */
export interface ArtifactVersionDetails {
  readonly artifact: ArtifactRecord;
  readonly saved: ArtifactVersion;
}

/** Input for reading one artifact through authenticated application policy. */
export interface ReadArtifactCommand {
  readonly artifactId: string;
  readonly principal: Principal;
  readonly projectId: string | null;
}

/** Input for reading one exact saved version. */
export interface ReadArtifactVersionCommand extends ReadArtifactCommand {
  readonly versionId: string;
}

/** Input for restoring one existing saved version as the current version. */
export interface RestoreArtifactVersionCommand extends ReadArtifactVersionCommand {
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
}

/** Input for changing one artifact's read setting. */
export interface ChangeArtifactAccessCommand extends ReadArtifactCommand {
  readonly accessSetting: AccessSetting;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
}

/** Input for replacing one artifact's complete tag set. */
export interface ChangeArtifactTagsCommand extends ReadArtifactCommand {
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly tags: readonly string[];
}

/** Input for listing active artifacts visible to one principal. */
export interface ListArtifactsCommand {
  readonly comments?: "all" | "with" | "without";
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly principal: Principal;
  readonly projectId: string | null;
  readonly search: string | null;
  readonly sort?: "comments" | "newest";
  readonly tags: readonly string[];
}

/** Input for listing one artifact's attributed mutation history. */
export interface ListArtifactActionsCommand extends ReadArtifactCommand {
  readonly cursor: PageCursor | null;
  readonly limit: number;
}

/** Input for sharing one artifact with, or no longer with, one member. */
export interface ChangeArtifactGrantCommand extends ReadArtifactCommand {
  readonly idempotencyKey: string;
  readonly memberId: string;
}

/** One member an artifact is shared with, as its owner or an administrator sees them. */
export interface SharedMember {
  /** Null when the member is no longer active; the grant stays until revoked. */
  readonly displayName: string | null;
  readonly email: string | null;
  readonly grantedAt: string;
  readonly grantedByPrincipalId: string;
  readonly principalId: string;
}

/** Input for atomically tombstoning one artifact. */
export interface DeleteArtifactCommand extends ReadArtifactCommand {
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
}

/** Repository capabilities required by artifact management. */
export interface ArtifactManagementRepository {
  readonly changeAccessSetting: (
    command: ChangeArtifactAccessSetting,
  ) => Effect.Effect<
    ArtifactState,
    | ArtifactMutationConflict
    | ArtifactNotFound
    | IdempotencyConflict
    | ArtifactRepositoryFailure
  >;
  readonly changeTags: (
    command: ChangeArtifactTags,
  ) => Effect.Effect<
    ArtifactState,
    | ArtifactMutationConflict
    | ArtifactNotFound
    | IdempotencyConflict
    | ArtifactRepositoryFailure
  >;
  readonly deleteArtifact: (
    command: DeleteArtifact,
  ) => Effect.Effect<
    ArtifactDeletion,
    | ArtifactMutationConflict
    | ArtifactNotFound
    | IdempotencyConflict
    | ArtifactRepositoryFailure
  >;
  readonly findArtifact: (
    projectId: string,
    artifactId: string,
  ) => Effect.Effect<ArtifactRecord | null, ArtifactRepositoryFailure>;
  readonly findArtifactForAdministration: (
    projectId: string,
    artifactId: string,
  ) => Effect.Effect<ArtifactRecord | null, ArtifactRepositoryFailure>;
  readonly findVersionRecord: (
    projectId: string,
    artifactId: string,
    versionId: string,
  ) => Effect.Effect<ArtifactVersion | null, ArtifactRepositoryFailure>;
  readonly listArtifactVersions: (
    projectId: string,
    artifactId: string,
  ) => Effect.Effect<readonly VersionRecord[], ArtifactRepositoryFailure>;
  readonly listArtifactActions: (
    command: ListArtifactActions,
  ) => Effect.Effect<ArtifactActionPage, ArtifactRepositoryFailure>;
  readonly listArtifacts: (
    command: ListArtifacts,
  ) => Effect.Effect<ArtifactPage, ArtifactRepositoryFailure>;
  readonly restoreVersion: (
    command: RestoreArtifactVersion,
  ) => Effect.Effect<
    ArtifactState,
    | ArtifactMutationConflict
    | ArtifactNotFound
    | IdempotencyConflict
    | VersionNotFound
    | ArtifactRepositoryFailure
  >;
  readonly grantArtifactAccess: (
    command: GrantArtifactAccess,
  ) => Effect.Effect<
    ArtifactGrantChange,
    ArtifactNotFound | IdempotencyConflict | ArtifactRepositoryFailure
  >;
  readonly revokeArtifactAccess: (
    command: RevokeArtifactAccess,
  ) => Effect.Effect<
    ArtifactGrantChange,
    ArtifactNotFound | IdempotencyConflict | ArtifactRepositoryFailure
  >;
  readonly listArtifactGrants: (
    projectId: string,
    artifactId: string,
  ) => Effect.Effect<readonly ArtifactGrant[], ArtifactNotFound | ArtifactRepositoryFailure>;
}

/** Dependencies used to construct artifact management operations. */
export interface ArtifactManagementDependencies {
  readonly clock: ApplicationClock;
  readonly repository: ArtifactManagementRepository;
}

/** Expected failures produced by artifact management. */
export type ArtifactManagementFailure =
  | ArtifactNotFound
  | VersionNotFound
  | ArtifactMutationConflict
  | IdempotencyConflict
  | InvalidIdempotencyKey
  | InvalidArtifactTags
  | InvalidPagination
  | AuthorizationDenied
  | ArtifactRepositoryFailure
  | IdentityNotFound
  | IdentityRepositoryFailure
  | ProjectManagementFailure;

interface ArtifactManagementOperations {
  readonly changeAccess: (
    command: ChangeArtifactAccessCommand,
  ) => Effect.Effect<ArtifactState, ArtifactManagementFailure>;
  readonly changeTags: (
    command: ChangeArtifactTagsCommand,
  ) => Effect.Effect<ArtifactState, ArtifactManagementFailure>;
  readonly deleteArtifact: (
    command: DeleteArtifactCommand,
  ) => Effect.Effect<ArtifactDeletion, ArtifactManagementFailure>;
  readonly getArtifact: (
    command: ReadArtifactCommand,
  ) => Effect.Effect<ArtifactDetails, ArtifactManagementFailure>;
  readonly getVersion: (
    command: ReadArtifactVersionCommand,
  ) => Effect.Effect<ArtifactVersion, ArtifactManagementFailure>;
  readonly getVersionDetails: (
    command: ReadArtifactVersionCommand,
  ) => Effect.Effect<ArtifactVersionDetails, ArtifactManagementFailure>;
  readonly listVersions: (
    command: ReadArtifactCommand,
  ) => Effect.Effect<readonly VersionRecord[], ArtifactManagementFailure>;
  readonly listArtifactActions: (
    command: ListArtifactActionsCommand,
  ) => Effect.Effect<ArtifactActionPage, ArtifactManagementFailure>;
  readonly listArtifacts: (
    command: ListArtifactsCommand,
  ) => Effect.Effect<ArtifactPage, ArtifactManagementFailure>;
  readonly restoreVersion: (
    command: RestoreArtifactVersionCommand,
  ) => Effect.Effect<ArtifactState, ArtifactManagementFailure>;
  /** Share an artifact with one more active member; repeating it changes nothing. */
  readonly grantAccess: (
    command: ChangeArtifactGrantCommand,
  ) => Effect.Effect<ArtifactGrantChange, ArtifactManagementFailure>;
  /** Stop sharing an artifact with one member; repeating it changes nothing. */
  readonly revokeAccess: (
    command: ChangeArtifactGrantCommand,
  ) => Effect.Effect<ArtifactGrantChange, ArtifactManagementFailure>;
  /** The members an artifact is shared with, for its owner or an administrator. */
  readonly listSharedMembers: (
    command: ReadArtifactCommand,
  ) => Effect.Effect<readonly SharedMember[], ArtifactManagementFailure>;
}

/** Reads and mutates artifact metadata without changing committed versions. */
export class ArtifactManagementService extends Context.Service<
  ArtifactManagementService,
  ArtifactManagementOperations
>()("artifact-server/application/ArtifactManagementService") {
  /** Construct artifact management from deployment-neutral persistence. */
  static readonly layer = (
    dependencies: ArtifactManagementDependencies,
  ): Layer.Layer<
    ArtifactManagementService,
    never,
    AuthorizationService | InstallationAccessService | ProjectManagementService
  > =>
    Layer.effect(
      ArtifactManagementService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const members = yield* InstallationAccessService;
        const projects = yield* ProjectManagementService;
        return makeArtifactManagementService(
          dependencies,
          authorization,
          members,
          projects,
        );
      }),
    );
}

function normalizeArtifactSearch(candidate: string | null): string | null {
  if (candidate === null) return null;
  const normalized = normalizeArtifactTag(candidate);
  return normalized === "" ? null : normalized;
}

function makeArtifactManagementService(
  dependencies: ArtifactManagementDependencies,
  authorization: AuthorizationOperations,
  members: InstallationAccessService["Service"],
  projects: ProjectManagementService["Service"],
): ArtifactManagementOperations {
  const resolveProjectForRead = Effect.fn(
    "ArtifactManagementService.resolveProjectForRead",
  )(function*(principal: Principal, projectId: string | null) {
    return projectId === null
      ? yield* projects.resolveActiveProject({principal, projectId})
      : yield* projects.getProject({principal, projectId});
  });

  const requireArtifact = Effect.fn("ArtifactManagementService.requireArtifact")(
    function*(projectId: string, artifactId: string): Effect.fn.Return<
      ArtifactRecord,
      ArtifactNotFound | ArtifactRepositoryFailure
    > {
      const artifact = yield* dependencies.repository.findArtifact(
        projectId,
        artifactId,
      );
      if (artifact !== null) return artifact;
      return yield* new ArtifactNotFound({message: "The artifact does not exist."});
    },
  );

  const requireArtifactForAdministration = Effect.fn(
    "ArtifactManagementService.requireArtifactForAdministration",
  )(function*(projectId: string, artifactId: string): Effect.fn.Return<
    ArtifactRecord,
    ArtifactNotFound | ArtifactRepositoryFailure
  > {
    const artifact = yield* dependencies.repository
      .findArtifactForAdministration(projectId, artifactId);
    if (artifact !== null) return artifact;
    return yield* new ArtifactNotFound({message: "The artifact does not exist."});
  });

  const requirePageSize = Effect.fn("ArtifactManagementService.requirePageSize")(
    function*(limit: number) {
      if (Number.isInteger(limit) && limit >= 1 && limit <= maximumPageSize) {
        return limit;
      }
      return yield* new InvalidPagination({
        message: `A page must contain between 1 and ${maximumPageSize} records.`,
      });
    },
  );

  const requireVersion = Effect.fn("ArtifactManagementService.requireVersion")(
    function*(
      projectId: string,
      artifactId: string,
      versionId: string,
    ): Effect.fn.Return<ArtifactVersion, VersionNotFound | ArtifactRepositoryFailure> {
      const version = yield* dependencies.repository.findVersionRecord(
        projectId,
        artifactId,
        versionId,
      );
      if (version !== null) return version;
      return yield* new VersionNotFound({
        message: "The saved version does not exist on this artifact.",
      });
    },
  );

  const getArtifact = Effect.fn("ArtifactManagementService.getArtifact")(
    function*(command: ReadArtifactCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      yield* requireArtifactVisible(command.principal, artifact);
      yield* authorization.requireArtifactRead(command.principal);
      const current = yield* requireVersion(
        project.id,
        artifact.id,
        artifact.currentVersionId,
      );
      return {artifact, current};
    },
  );

  const getVersionDetails = Effect.fn("ArtifactManagementService.getVersionDetails")(
    function*(command: ReadArtifactVersionCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      // The artifact and version reads are independent, so they run in one
      // round of concurrent queries; existence and authorization checks keep
      // their original order below.
      const [artifact, version] = yield* Effect.all([
        dependencies.repository.findArtifact(project.id, command.artifactId),
        dependencies.repository.findVersionRecord(
          project.id,
          command.artifactId,
          command.versionId,
        ),
      ], {concurrency: 2});
      if (artifact === null) {
        return yield* new ArtifactNotFound({message: "The artifact does not exist."});
      }
      yield* requireArtifactVisible(command.principal, artifact);
      yield* authorization.requireArtifactRead(command.principal);
      if (version === null) {
        return yield* new VersionNotFound({
          message: "The saved version does not exist on this artifact.",
        });
      }
      return {artifact, saved: version};
    },
  );

  const getVersion = Effect.fn("ArtifactManagementService.getVersion")(
    function*(command: ReadArtifactVersionCommand) {
      const details = yield* getVersionDetails(command);
      return details.saved;
    },
  );

  const listVersions = Effect.fn("ArtifactManagementService.listVersions")(
    function*(command: ReadArtifactCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      // The artifact read and the version listing are independent, so they
      // run concurrently; existence and authorization checks keep their
      // original order below.
      const [artifact, versions] = yield* Effect.all([
        dependencies.repository.findArtifact(project.id, command.artifactId),
        dependencies.repository.listArtifactVersions(
          project.id,
          command.artifactId,
        ),
      ], {concurrency: 2});
      if (artifact === null) {
        return yield* new ArtifactNotFound({message: "The artifact does not exist."});
      }
      yield* requireArtifactVisible(command.principal, artifact);
      yield* authorization.requireArtifactRead(command.principal);
      return versions;
    },
  );

  const listArtifacts = Effect.fn("ArtifactManagementService.listArtifacts")(
    function*(command: ListArtifactsCommand) {
      const limit = yield* requirePageSize(command.limit);
      const comments = command.comments ?? "all";
      const sort = command.sort ?? "newest";
      if (sort === "comments" && command.cursor !== null && command.cursor.rank === undefined) {
        return yield* new InvalidPagination({
          message: "The artifact page cursor does not match the selected sort.",
        });
      }
      yield* authorization.requireArtifactListing(command.principal);
      const tags = yield* parseArtifactTags(command.tags);
      const search = normalizeArtifactSearch(command.search);
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      return yield* dependencies.repository.listArtifacts({
        comments,
        cursor: command.cursor,
        limit,
        projectId: project.id,
        restrictedScope: restrictedArtifactScope(command.principal),
        search,
        sort,
        tags,
      });
    },
  );

  const listArtifactActions = Effect.fn(
    "ArtifactManagementService.listArtifactActions",
  )(function*(command: ListArtifactActionsCommand) {
    const limit = yield* requirePageSize(command.limit);
    const project = yield* resolveProjectForRead(
      command.principal,
      command.projectId,
    );
    const artifact = yield* requireArtifactForAdministration(
      project.id,
      command.artifactId,
    );
    yield* requireArtifactVisible(command.principal, artifact);
    yield* authorization.requireArtifactManagement(command.principal, artifact);
    yield* requireArtifactChangeable(command.principal, artifact);
    return yield* dependencies.repository.listArtifactActions({
      artifactId: artifact.id,
      cursor: command.cursor,
      limit,
      projectId: project.id,
    });
  });

  const restoreVersion = Effect.fn("ArtifactManagementService.restoreVersion")(
    function*(command: RestoreArtifactVersionCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      yield* requireArtifactVisible(command.principal, artifact);
      yield* authorization.requireArtifactManagement(command.principal, artifact);
      yield* requireArtifactChangeable(command.principal, artifact);
      yield* requireVersion(project.id, artifact.id, command.versionId);
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.restoreVersion({
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        createdAt,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        idempotencyKey,
        inputDigest: managementInputDigest({
          artifactId: artifact.id,
          expectedCurrentVersionId: command.expectedCurrentVersionId,
          operation: "restore",
          principalId: command.principal.id,
          projectId: project.id,
          value: command.versionId,
        }),
        principalId: command.principal.id,
        projectId: project.id,
        versionId: command.versionId,
      });
    },
  );

  const changeAccess = Effect.fn("ArtifactManagementService.changeAccess")(
    function*(command: ChangeArtifactAccessCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      yield* requireArtifactVisible(command.principal, artifact);
      yield* authorization.requireArtifactManagement(command.principal, artifact);
      // Only the owner or an administrator moves an artifact to or from restricted.
      if (
        (artifact.accessSetting === accessSettings.restricted ||
          command.accessSetting === accessSettings.restricted) &&
        !mayChangeRestriction(command.principal, artifact)
      ) {
        return yield* new AuthorizationDenied({
          message: "Only the owner or an administrator can change who sees this artifact.",
        });
      }
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.changeAccessSetting({
        accessSetting: command.accessSetting,
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        createdAt,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        idempotencyKey,
        inputDigest: managementInputDigest({
          artifactId: artifact.id,
          expectedCurrentVersionId: command.expectedCurrentVersionId,
          operation: "change_access",
          principalId: command.principal.id,
          projectId: project.id,
          value: command.accessSetting,
        }),
        principalId: command.principal.id,
        projectId: project.id,
      });
    },
  );

  const changeTags = Effect.fn("ArtifactManagementService.changeTags")(
    function*(command: ChangeArtifactTagsCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      yield* requireArtifactVisible(command.principal, artifact);
      yield* authorization.requireArtifactManagement(command.principal, artifact);
      yield* requireArtifactChangeable(command.principal, artifact);
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const tags = yield* parseArtifactTags(command.tags);
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.changeTags({
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        createdAt,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        idempotencyKey,
        inputDigest: managementInputDigest({
          artifactId: artifact.id,
          expectedCurrentVersionId: command.expectedCurrentVersionId,
          operation: "change_tags",
          principalId: command.principal.id,
          projectId: project.id,
          value: JSON.stringify(tags),
        }),
        principalId: command.principal.id,
        projectId: project.id,
        tags,
      });
    },
  );

  const deleteArtifact = Effect.fn("ArtifactManagementService.deleteArtifact")(
    function*(command: DeleteArtifactCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      const artifact = yield* requireArtifactForAdministration(
        project.id,
        command.artifactId,
      );
      yield* requireArtifactVisible(command.principal, artifact);
      yield* authorization.requireArtifactManagement(command.principal, artifact);
      yield* requireArtifactChangeable(command.principal, artifact);
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.deleteArtifact({
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        createdAt,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        idempotencyKey,
        inputDigest: managementInputDigest({
          artifactId: artifact.id,
          expectedCurrentVersionId: command.expectedCurrentVersionId,
          operation: "delete",
          principalId: command.principal.id,
          projectId: project.id,
          value: artifact.id,
        }),
        principalId: command.principal.id,
        projectId: project.id,
      });
    },
  );

  // Choosing who sees an artifact is the owner's or an administrator's call,
  // through a person's own session or a key with the management capability.
  const requireSharingAuthority = Effect.fn(
    "ArtifactManagementService.requireSharingAuthority",
  )(function*(principal: Principal, artifact: ArtifactRecord) {
    yield* authorization.requireArtifactManagement(principal, artifact);
    if (mayChangeRestriction(principal, artifact)) return;
    yield* Effect.fail(new AuthorizationDenied({
      message: "Only the owner or an administrator can change who sees this artifact.",
    }));
  });

  const grantAccess = Effect.fn("ArtifactManagementService.grantAccess")(
    function*(command: ChangeArtifactGrantCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      yield* requireArtifactVisible(command.principal, artifact);
      yield* requireSharingAuthority(command.principal, artifact);
      const member = yield* members.findActiveMember(command.memberId);
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      // The owner already sees the artifact; a grant would only clutter the list.
      if (member.id === artifact.ownerPrincipalId) return {changed: false};
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.grantArtifactAccess({
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        createdAt,
        idempotencyKey,
        memberId: member.id,
        principalId: command.principal.id,
        projectId: project.id,
      });
    },
  );

  const revokeAccess = Effect.fn("ArtifactManagementService.revokeAccess")(
    function*(command: ChangeArtifactGrantCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      yield* requireArtifactVisible(command.principal, artifact);
      yield* requireSharingAuthority(command.principal, artifact);
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      // A deactivated member can still be removed, so no membership check here.
      return yield* dependencies.repository.revokeArtifactAccess({
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        createdAt,
        idempotencyKey,
        memberId: command.memberId,
        principalId: command.principal.id,
        projectId: project.id,
      });
    },
  );

  const listSharedMembers = Effect.fn(
    "ArtifactManagementService.listSharedMembers",
  )(function*(command: ReadArtifactCommand) {
    const project = yield* resolveProjectForRead(
      command.principal,
      command.projectId,
    );
    const artifact = yield* requireArtifact(project.id, command.artifactId);
    yield* requireArtifactVisible(command.principal, artifact);
    yield* requireSharingAuthority(command.principal, artifact);
    const [grants, directory] = yield* Effect.all([
      dependencies.repository.listArtifactGrants(project.id, artifact.id),
      members.listMemberDirectory(command.principal),
    ]);
    const activeMembers = new Map(directory.map((entry) => [entry.id, entry]));
    return grants.map((grant): SharedMember => {
      const member = activeMembers.get(grant.principalId);
      return {
        displayName: member?.displayName ?? null,
        email: member?.email ?? null,
        grantedAt: grant.grantedAt,
        grantedByPrincipalId: grant.grantedByPrincipalId,
        principalId: grant.principalId,
      };
    });
  });

  return ArtifactManagementService.of({
    changeAccess,
    changeTags,
    deleteArtifact,
    getArtifact,
    getVersion,
    getVersionDetails,
    grantAccess,
    listArtifactActions,
    listArtifacts,
    listSharedMembers,
    listVersions,
    restoreVersion,
    revokeAccess,
  });
}

interface ManagementInputDigest {
  readonly artifactId: string;
  readonly expectedCurrentVersionId: string;
  readonly operation:
    | "change_access"
    | "change_tags"
    | "delete"
    | "restore";
  readonly principalId: string;
  readonly projectId: string;
  readonly value: string;
}

function managementInputDigest(input: ManagementInputDigest): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
