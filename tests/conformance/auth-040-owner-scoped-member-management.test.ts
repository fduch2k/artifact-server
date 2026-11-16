import {Effect, ManagedRuntime, Redacted, Result} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {AuthorizationService} from "../../src/application/authorization.js";
import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import type {AuthorizationDenied} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../../src/core/identity.js";
import {createOidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {parseOwnerScopedManagement} from "../../src/identity/owner-scoped-management-policy.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  startStubOidcLogin,
  startStubOidcProvider,
  type RunningStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const administratorEmail = "administrator@example.test";
const clientSecret = "owner-scoped-management-test-client-secret";
const dayMilliseconds = 24 * 60 * 60 * 1_000;
const personalCapabilities = [
  "artifact:create",
  "artifact:manage:own",
  "artifact:publish:own",
  "artifact:read",
  "comment:write",
] as const;

const sessionSchema = z.object({
  capabilities: z.object({ownerScopedManagement: z.boolean()}),
  principal: z.object({id: z.string()}),
});
const artifactSchema = z.object({
  accessSetting: z.string(),
  currentVersionId: z.string(),
  id: z.string(),
  ownerPrincipalId: z.string().nullable(),
  projectId: z.string(),
  tags: z.array(z.string()),
});
const artifactEnvelopeSchema = z.object({artifact: artifactSchema});
const issuedKeySchema = z.object({token: z.string().startsWith("as_key_")});
const threadEnvelopeSchema = z.object({thread: z.object({id: z.string()})});
const errorSchema = z.object({error: z.object({code: z.string()})});

type Artifact = z.infer<typeof artifactSchema>;

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

/** A person signed in through the browser. */
interface Person {
  readonly cookies: ApplicationCookies;
  readonly id: string;
}

/** Request bodies sent by these tests: strings and string lists only. */
type RequestBody = Readonly<Record<string, string | readonly string[]>>;

function artifactPath(artifactId: string, suffix = ""): string {
  return `/api/v1/artifacts/${artifactId}${suffix}`;
}

const policyOwner = human("member-owner", membershipRoles.member);
const policyColleague = human("member-colleague", membershipRoles.member);
const policyAdministrator = human("member-administrator", membershipRoles.administrator);
const policyOwnersKey: Principal = {
  ...policyOwner,
  authorizedByPrincipalId: policyOwner.id,
  capabilities: [principalCapabilities.publishOwnArtifact],
};
const policyManageAnyService = service([principalCapabilities.manageAnyArtifact]);
const ownedByPolicyOwner = {ownerPrincipalId: policyOwner.id};
const ownedByNoMember = {ownerPrincipalId: null};

describe("owner-scoped management for people over HTTP", () => {
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer;
  let administrator: Person;
  let ada: Person;
  let ben: Person;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({
      clientId: "owner-scoped-management-test",
      clientSecret,
    });
    server = await startServer(true);
    administrator = await signIn(administratorEmail, "administrator-subject");
    ada = await signIn("ada@example.test", "ada-subject");
    ben = await signIn("ben@example.test", "ben-subject");
  });

  afterEach(async () => {
    await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-040-B: the owner and administrators manage; colleagues read, comment, and resolve", async () => {
    expect.hasAssertions();
    expect((await session(ben)).capabilities.ownerScopedManagement).toBe(true);
    const adasKey = await personalKey(ada, "Ada's agent");
    const adas = await publishAs(adasKey, "Ada's metrics");
    expect(adas.ownerPrincipalId).toBe(ada.id);
    const second = await publishVersion(server, {...installation, apiToken: adasKey}, {
      artifactId: adas.id,
      content: "Ada's metrics, revised",
      expectedCurrentVersionId: adas.currentVersionId,
      idempotencyKey: "auth-040-ada-version",
      projectId: adas.projectId,
    });
    expect(second.response.status).toBe(201);
    const current = second.body.version.id;

    // A colleague reads, comments on, and resolves threads of the artifact.
    expect((await readArtifact(ben, adas.id)).ownerPrincipalId).toBe(ada.id);
    const thread = await browser(ben, "POST", artifactPath(adas.id, `/versions/${current}/comments`), {
      body: "Ben's question",
    });
    expect(thread.status).toBe(201);
    const threadId = threadEnvelopeSchema.parse(await thread.json()).thread.id;
    expect((await browser(ben, "PATCH", artifactPath(adas.id, `/comments/${threadId}`), {
      state: "resolved",
    })).status).toBe(200);

    // The owner's own session manages every part of it.
    expect((await browser(ada, "PATCH", artifactPath(adas.id, "/tags"), {
      expectedCurrentVersionId: current,
      tags: ["weekly"],
    })).status).toBe(200);
    expect((await browser(ada, "PATCH", artifactPath(adas.id, "/access"), {
      accessSetting: "public_link",
      expectedCurrentVersionId: current,
    })).status).toBe(200);
    expect((await browser(ada, "GET", artifactPath(adas.id, "/actions"))).status).toBe(200);
    expect((await browser(
      ada,
      "POST",
      `/api/v1/projects/${adas.projectId}/artifacts/${adas.id}/comments/clear`,
      {state: "resolved"},
    )).status).toBe(200);
    expect((await browser(ada, "POST", artifactPath(adas.id, "/restore"), {
      expectedCurrentVersionId: current,
      versionId: adas.currentVersionId,
    })).status).toBe(200);
    const restored = await readArtifact(ada, adas.id);
    expect((await browser(ada, "DELETE", artifactPath(adas.id), {
      expectedCurrentVersionId: restored.currentVersionId,
    })).status).toBe(200);

    // An administrator manages a colleague's artifact.
    const bens = await publishAs(await personalKey(ben, "Ben's agent"), "Ben's report");
    expect((await browser(administrator, "PATCH", artifactPath(bens.id, "/tags"), {
      expectedCurrentVersionId: bens.currentVersionId,
      tags: ["reviewed"],
    })).status).toBe(200);
    expect((await browser(administrator, "DELETE", artifactPath(bens.id), {
      expectedCurrentVersionId: bens.currentVersionId,
    })).status).toBe(200);

    // Publishing from a session and clearing threads, at the policy; keys keep their capabilities.
    await withPolicy(true, async (expectAllowed) => {
      await expectAllowed((policy) => policy.requireVersionPublication(policyOwner, ownedByPolicyOwner));
      await expectAllowed((policy) => policy.requireVersionPublication(policyAdministrator, ownedByPolicyOwner));
      await expectAllowed((policy) => policy.requireVersionPublication(policyAdministrator, ownedByNoMember));
      await expectAllowed((policy) => policy.requireVersionPublication(policyOwnersKey, ownedByPolicyOwner));
      await expectAllowed((policy) => policy.requireCommentClearOnArtifact(policyOwner, ownedByPolicyOwner));
      await expectAllowed((policy) => policy.requireCommentClearOnArtifact(policyAdministrator, ownedByPolicyOwner));
      await expectAllowed((policy) => policy.requireCommentClearOnArtifact(policyManageAnyService, ownedByPolicyOwner));
    });
  });

  test("AUTH-040-F: a colleague's own session cannot manage or clear another member's artifact", async () => {
    expect.hasAssertions();
    const adas = await publishAs(await personalKey(ada, "Ada's agent"), "Ada's plan");

    const attempts = await Promise.all(([
      ["PATCH", "/tags", {tags: ["edited-by-ben"]}],
      ["PATCH", "/access", {accessSetting: "public_link"}],
      ["POST", "/restore", {versionId: adas.currentVersionId}],
      ["DELETE", "", {}],
    ] as const).map(([method, suffix, body]) =>
      browser(ben, method, artifactPath(adas.id, suffix), {
        ...body,
        expectedCurrentVersionId: adas.currentVersionId,
      })
    ));
    expect(attempts.map(({status}) => status)).toEqual([403, 403, 403, 403]);
    expect(errorSchema.parse(await attempts[0]?.json()).error.code)
      .toBe("AUTHORIZATION_DENIED");
    expect((await browser(ben, "GET", artifactPath(adas.id, "/actions"))).status).toBe(403);
    expect((await browser(
      ben,
      "POST",
      `/api/v1/projects/${adas.projectId}/artifacts/${adas.id}/comments/clear`,
      {state: "all"},
    )).status).toBe(403);
    expect(await readArtifact(ada, adas.id)).toMatchObject({
      accessSetting: "account_required",
      currentVersionId: adas.currentVersionId,
      tags: [],
    });

    // An artifact no member owns belongs to administrators.
    const automated = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "Nightly report",
      idempotencyKey: "auth-040-service-owned",
      name: "Nightly report",
    });
    expect(automated.response.status).toBe(201);
    const nightly = artifactSchema.parse(automated.body.artifact);
    expect(nightly.ownerPrincipalId).not.toBe(ada.id);
    expect((await browser(ada, "PATCH", artifactPath(nightly.id, "/tags"), {
      expectedCurrentVersionId: nightly.currentVersionId,
      tags: ["mine"],
    })).status).toBe(403);
    expect((await browser(administrator, "PATCH", artifactPath(nightly.id, "/tags"), {
      expectedCurrentVersionId: nightly.currentVersionId,
      tags: ["nightly"],
    })).status).toBe(200);

    // Without the operator's setting, AUTH-008 is unchanged.
    await server.stop();
    server = await startServer(false);
    expect((await session(ben)).capabilities.ownerScopedManagement).toBe(false);
    expect((await browser(ben, "PATCH", artifactPath(adas.id, "/tags"), {
      expectedCurrentVersionId: adas.currentVersionId,
      tags: ["edited-by-ben"],
    })).status).toBe(200);

    // Publishing from a session and clearing threads, at the policy.
    await withPolicy(true, async (_expectAllowed, expectDenied) => {
      await expectDenied((policy) => policy.requireVersionPublication(policyColleague, ownedByPolicyOwner));
      await expectDenied((policy) => policy.requireVersionPublication(policyOwner, ownedByNoMember));
      await expectDenied((policy) => policy.requireArtifactManagement(policyColleague, ownedByPolicyOwner));
      await expectDenied((policy) => policy.requireCommentClearOnArtifact(policyColleague, ownedByPolicyOwner));
    });
    await withPolicy(false, async (expectAllowed) => {
      await expectAllowed((policy) => policy.requireVersionPublication(policyColleague, ownedByPolicyOwner));
      await expectAllowed((policy) => policy.requireCommentClearOnArtifact(policyColleague, ownedByPolicyOwner));
    });

    // The operator setting accepts only true or false.
    expect(parseOwnerScopedManagement(undefined)).toBe(false);
    expect(parseOwnerScopedManagement(" ")).toBe(false);
    expect(parseOwnerScopedManagement("false")).toBe(false);
    expect(parseOwnerScopedManagement("true")).toBe(true);
    for (const invalid of ["yes", "1", "TRUE", "on"]) {
      expect(() => parseOwnerScopedManagement(invalid))
        .toThrow("ARTIFACT_SERVER_OWNER_SCOPED_MANAGEMENT must be exactly true or false.");
    }
  });

  async function startServer(ownerScopedManagement: boolean): Promise<RunningTestServer> {
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    return startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      externalIdentityAdmissionPolicy: {
        allowedEmailDomains: [],
        provider: `oidc:${provider.issuer}`,
      },
      interactiveIdentityProvider: createOidcIdentityProvider({
        applicationOrigin,
        clientId: provider.clientId,
        clientSecret: Redacted.make(clientSecret),
        issuer: provider.issuer,
        scopes: "openid email profile",
      }),
      ownerScopedManagement,
      personalApiKeyPolicy: {maxLifetimeDays: 30},
      port,
    });
  }

  async function signIn(email: string, subject: string): Promise<Person> {
    provider.claims.email = email;
    provider.claims.subject = subject;
    provider.claims.emailVerified = true;
    const started = await startStubOidcLogin(server.baseUrl);
    const completed = await fetch(started.callbackUrl, {
      headers: {Cookie: started.handshakeCookie},
      redirect: "manual",
    });
    expect(completed.status).toBe(303);
    const cookies = applicationCookies(completed);
    const response = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    });
    return {cookies, id: sessionSchema.parse(await response.json()).principal.id};
  }

  async function session(person: Person): Promise<z.infer<typeof sessionSchema>> {
    const response = await browser(person, "GET", "/api/v1/session");
    expect(response.status).toBe(200);
    return sessionSchema.parse(await response.json());
  }

  async function personalKey(person: Person, name: string): Promise<string> {
    const response = await browser(person, "POST", "/api/v1/personal-api-keys", {
      capabilities: personalCapabilities,
      expiresAt: new Date(Date.now() + 7 * dayMilliseconds).toISOString(),
      name,
    });
    expect(response.status).toBe(201);
    return issuedKeySchema.parse(await response.json()).token;
  }

  async function publishAs(token: string, name: string): Promise<Artifact> {
    const published = await publishNew(server, {...installation, apiToken: token}, {
      accessSetting: "account_required",
      content: name,
      idempotencyKey: `auth-040-${name}`,
      name,
    });
    expect(published.response.status).toBe(201);
    return artifactSchema.parse(published.body.artifact);
  }

  async function readArtifact(person: Person, artifactId: string): Promise<Artifact> {
    const response = await browser(person, "GET", artifactPath(artifactId));
    expect(response.status).toBe(200);
    return artifactEnvelopeSchema.parse(await response.json()).artifact;
  }

  function browser(
    person: Person,
    method: string,
    requestPath: string,
    body?: RequestBody,
  ): Promise<Response> {
    const init: RequestInit = {
      headers: {
        "Content-Type": "application/json",
        Cookie: person.cookies.header,
        "Idempotency-Key": crypto.randomUUID(),
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": person.cookies.csrf,
      },
      method,
    };
    return fetch(
      `${server.baseUrl}${requestPath}`,
      body === undefined ? init : {...init, body: JSON.stringify(body)},
    );
  }
});

type PolicyOperation = (
  authorization: AuthorizationService["Service"],
) => Effect.Effect<void, AuthorizationDenied>;

async function withPolicy(
  ownerScopedManagement: boolean,
  check: (
    expectAllowed: (operation: PolicyOperation) => Promise<void>,
    expectDenied: (operation: PolicyOperation) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const runtime = ManagedRuntime.make(
    AuthorizationService.layer({installationId: "installation-a", ownerScopedManagement}),
  );
  try {
    await check(
      async (operation) => {
        const result = await runtime.runPromise(Effect.result(AuthorizationService.use(operation)));
        expect(Result.isSuccess(result)).toBe(true);
      },
      async (operation) => {
        const result = await runtime.runPromise(Effect.result(AuthorizationService.use(operation)));
        expect(Result.match(result, {
          onFailure: (failure) => failure._tag,
          onSuccess: () => "UnexpectedSuccess",
        })).toBe("AuthorizationDenied");
      },
    );
  } finally {
    await runtime.dispose();
  }
}

function human(id: string, membershipRole: Principal["membershipRole"]): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Policy human",
    id,
    installationId: "installation-a",
    kind: principalKinds.human,
    membershipRole,
  };
}

function service(capabilities: Principal["capabilities"]): Principal {
  return {
    authorizedByPrincipalId: null,
    capabilities,
    displayName: "Policy service",
    id: "service-bot",
    installationId: "installation-a",
    kind: principalKinds.service,
    membershipRole: membershipRoles.member,
  };
}

function applicationCookies(response: Response): ApplicationCookies {
  const pairs = response.headers.getSetCookie()
    .filter((value) => value.startsWith("artifact_session=") || value.startsWith("artifact_csrf="))
    .map((value) => value.split(";", 1)[0]);
  const csrfPair = pairs.find((value) => value?.startsWith("artifact_csrf="));
  if (pairs.length !== 2 || csrfPair === undefined) {
    throw new Error("The response lacks application cookies.");
  }
  return {header: pairs.join("; "), csrf: csrfPair.slice("artifact_csrf=".length)};
}
