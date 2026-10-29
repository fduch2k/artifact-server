import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import type {PersonalApiKeyPolicy} from "../../src/core/installation-identity.js";
import {createOidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
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
const clientSecret = "personal-api-key-test-client-secret";
const dayMilliseconds = 24 * 60 * 60 * 1_000;
const personalCapabilities = [
  "agent:connect",
  "artifact:create",
  "artifact:manage:own",
  "artifact:publish:own",
  "artifact:read",
  "comment:write",
  "content-session:issue",
] as const;

const principalSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  capabilities: z.array(z.string()),
  id: z.string(),
  kind: z.enum(["human", "service"]),
  membershipRole: z.enum(["administrator", "member"]),
});
const sessionSchema = z.object({
  capabilities: z.object({
    personalApiKeys: z.object({maxLifetimeDays: z.number()}).nullable(),
  }),
  principal: principalSchema,
});
const apiKeySchema = z.object({
  authorizedByPrincipalId: z.string(),
  capabilities: z.array(z.string()),
  id: z.string(),
  principalId: z.string(),
  principalKind: z.enum(["human", "service"]),
  revokedAt: z.string().nullable(),
});
const issuedKeySchema = z.object({
  apiKey: apiKeySchema,
  token: z.string().startsWith("as_key_"),
});
const keyListSchema = z.object({apiKeys: z.array(apiKeySchema)});
const artifactSchema = z.object({
  currentVersionId: z.string(),
  id: z.string(),
  ownerPrincipalId: z.string().nullable(),
  projectId: z.string(),
  tags: z.array(z.string()),
});
const artifactEnvelopeSchema = z.object({artifact: artifactSchema});
const errorSchema = z.object({error: z.object({code: z.string()})});

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

/** A person signed in through the browser. */
interface Person {
  readonly cookies: ApplicationCookies;
  readonly email: string;
  readonly id: string;
}

/** One issued key and the member it acts as. */
interface Key {
  readonly keyId: string;
  readonly memberId: string;
  readonly token: string;
}

/** Request bodies sent by these tests: strings and string lists only. */
type RequestBody = Readonly<Record<string, string | readonly string[]>>;

function artifactPath(artifactId: string, suffix = ""): string {
  return `/api/v1/artifacts/${artifactId}${suffix}`;
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * dayMilliseconds).toISOString();
}

describe("personal API keys and owner-scoped capabilities", () => {
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer;
  let administrator: Person;
  let ada: Person;
  let ben: Person;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({clientId: "personal-api-key-test", clientSecret});
    server = await startServer({maxLifetimeDays: 30});
    administrator = await signIn(administratorEmail, "administrator-subject");
    ada = await signIn("ada@example.test", "ada-subject");
    ben = await signIn("ben@example.test", "ben-subject");
  });

  afterEach(async () => {
    await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-034-B: a signed-in member issues a key that acts as them, sees every key in their name, and revokes it", async () => {
    expect.hasAssertions();
    expect((await session(ada)).capabilities.personalApiKeys)
      .toEqual({maxLifetimeDays: 30});

    const issued = await issuePersonal(ada, {
      capabilities: personalCapabilities,
      expiresAt: daysFromNow(30),
      name: "Ada's laptop agent",
    });
    expect(issued.status).toBe(201);
    const key = issuedKeySchema.parse(await issued.json());
    expect(key.apiKey).toMatchObject({
      authorizedByPrincipalId: ada.id,
      capabilities: [...personalCapabilities],
      principalId: ada.id,
      principalKind: "human",
      revokedAt: null,
    });

    // The key authenticates as Ada, never as her browser session.
    const asKey = await bearer(key.token, "GET", "/api/v1/session");
    expect(asKey.status).toBe(200);
    expect(sessionSchema.parse(await asKey.json()).principal).toMatchObject({
      authorizedByPrincipalId: ada.id,
      id: ada.id,
      kind: "human",
      membershipRole: "member",
    });

    // A key an administrator bound to Ada is hers to see and revoke too.
    const bound = await adminIssue({
      capabilities: ["artifact:read"],
      expiresAt: daysFromNow(90),
      memberId: ada.id,
      name: "Ada's CI key",
    });
    expect(bound.status).toBe(201);
    const boundKey = issuedKeySchema.parse(await bound.json());

    expect((await personalKeys(ada)).map(({id}) => id).toSorted())
      .toEqual([key.apiKey.id, boundKey.apiKey.id].toSorted());
    expect(await personalKeys(ben)).toEqual([]);
    const all = await browser(administrator, "GET", "/api/v1/api-keys");
    expect(keyListSchema.parse(await all.json()).apiKeys.map(({id}) => id))
      .toEqual(expect.arrayContaining([key.apiKey.id, boundKey.apiKey.id]));

    const revocations = await Promise.all([key, boundKey].map((issuedKey) =>
      browser(ada, "POST", `/api/v1/personal-api-keys/${issuedKey.apiKey.id}/revoke`)
    ));
    expect(revocations.map(({status}) => status)).toEqual([200, 200]);
    const afterRevocation = await Promise.all([key, boundKey].map((issuedKey) =>
      bearer(issuedKey.token, "GET", "/api/v1/session")
    ));
    expect(afterRevocation.map(({status}) => status)).toEqual([401, 401]);
    expect((await personalKeys(ada)).every(({revokedAt}) => revokedAt !== null)).toBe(true);
  });

  test("AUTH-034-F: a member cannot exceed the ceiling or lifetime, mint keys from a key, reach a colleague's key, or keep a key after leaving", async () => {
    expect.hasAssertions();
    const tooWide = await Promise.all([
      ["artifact:read", "artifact:manage:any"],
      ["artifact:publish:any"],
      ["project:manage"],
    ].map(async (capabilities) => {
      const refused = await issuePersonal(ada, {
        capabilities,
        expiresAt: daysFromNow(7),
        name: "Too wide",
      });
      return [refused.status, errorSchema.parse(await refused.json()).error.code];
    }));
    expect(tooWide).toEqual(Array.from({length: 3}, () => [403, "AUTHORIZATION_DENIED"]));
    const wrongLifetime = await Promise.all([daysFromNow(31), daysFromNow(-1)].map(
      (expiresAt) => issuePersonal(ada, {
        capabilities: ["artifact:read"],
        expiresAt,
        name: "Wrong lifetime",
      }),
    ));
    expect(wrongLifetime.map(({status}) => status)).toEqual([409, 409]);
    // A personal key always acts as its issuer; naming a colleague is malformed.
    const forBen = await issuePersonal(ada, {
      capabilities: ["artifact:read"],
      expiresAt: daysFromNow(7),
      memberId: ben.id,
      name: "Ben's key",
    });
    expect(forBen.status).toBe(422);
    expect(await personalKeys(ada)).toEqual([]);
    expect(await personalKeys(ben)).toEqual([]);

    const key = await personalKey(ada, "Ada's agent");
    const fromKey = await Promise.all(([
      ["GET", "/api/v1/personal-api-keys"],
      ["POST", "/api/v1/personal-api-keys"],
      ["GET", "/api/v1/api-keys"],
      ["POST", "/api/v1/api-keys"],
    ] as const).map(([method, requestPath]) =>
      bearer(key.token, method, requestPath, {
        capabilities: ["artifact:read"],
        expiresAt: daysFromNow(7),
        name: "Successor",
      })
    ));
    expect(fromKey.map(({status}) => status)).toEqual([403, 403, 403, 403]);

    // Another member's key reads like a missing one and stays usable.
    expect((await browser(
      ben,
      "POST",
      `/api/v1/personal-api-keys/${key.keyId}/revoke`,
    )).status).toBe(404);
    expect((await bearer(key.token, "GET", "/api/v1/session")).status).toBe(200);

    // A service principal owns nothing, so an owner-scoped capability is refused.
    const inert = await adminIssue({
      capabilities: ["artifact:publish:own"],
      expiresAt: daysFromNow(7),
      name: "Inert bot",
    });
    expect(inert.status).toBe(409);

    const deactivated = await browser(
      administrator,
      "POST",
      `/api/v1/members/${ada.id}/deactivate`,
    );
    expect(deactivated.status).toBe(200);
    expect((await bearer(key.token, "GET", "/api/v1/session")).status).toBe(401);

    // Without the operator's opt-in, issuance stays with administrators.
    await server.stop();
    server = await startServer(null);
    expect((await session(ben)).capabilities.personalApiKeys).toBeNull();
    const disabled = await issuePersonal(ben, {
      capabilities: ["artifact:read"],
      expiresAt: daysFromNow(7),
      name: "Ben's agent",
    });
    expect(disabled.status).toBe(403);
    expect(await personalKeys(ben)).toEqual([]);
  });

  test("AUTH-035-B: an owner-scoped key publishes, tags, shares, and deletes its member's own artifact", async () => {
    expect.hasAssertions();
    const key = await personalKey(ada, "Ada's agent");
    const artifact = await publishAs(key, "Ada's metrics");
    expect(artifact.ownerPrincipalId).toBe(ada.id);

    const second = await publishVersion(server, as(key), {
      artifactId: artifact.id,
      content: "Ada's metrics, revised",
      expectedCurrentVersionId: artifact.currentVersionId,
      idempotencyKey: "auth-035-ada-version",
      projectId: artifact.projectId,
    });
    expect(second.response.status).toBe(201);
    const current = second.body.version.id;
    expect((await mutate(key, "PATCH", artifactPath(artifact.id, "/tags"), {
      expectedCurrentVersionId: current,
      tags: ["weekly"],
    })).status).toBe(200);
    expect((await mutate(key, "PATCH", artifactPath(artifact.id, "/access"), {
      accessSetting: "public_link",
      expectedCurrentVersionId: current,
    })).status).toBe(200);
    expect((await mutate(key, "POST", artifactPath(artifact.id, "/restore"), {
      expectedCurrentVersionId: current,
      versionId: artifact.currentVersionId,
    })).status).toBe(200);
    const restored = await readArtifact(key, artifact.id);
    expect((await mutate(key, "DELETE", artifactPath(artifact.id), {
      expectedCurrentVersionId: restored.currentVersionId,
    })).status).toBe(200);
  });

  test("AUTH-035-F: an owner-scoped key cannot publish to, change, or delete a colleague's artifact", async () => {
    expect.hasAssertions();
    const bensKey = await personalKey(ben, "Ben's agent");
    const bens = await publishAs(bensKey, "Ben's report");
    const adasKey = await personalKey(ada, "Ada's agent");
    const bound = await adminIssue({
      capabilities: ["artifact:create", "artifact:manage:own", "artifact:publish:own", "artifact:read"],
      expiresAt: daysFromNow(90),
      memberId: ada.id,
      name: "Ada's administrator-issued key",
    });
    expect(bound.status).toBe(201);
    const adasBoundKey = keyOf(issuedKeySchema.parse(await bound.json()));

    await Promise.all([adasKey, adasBoundKey].map(async (key) => {
      // Reading a colleague's shared work stays open; changing it does not.
      expect((await readArtifact(key, bens.id)).ownerPrincipalId).toBe(ben.id);
      await expect(publishVersion(server, as(key), {
        artifactId: bens.id,
        content: "Ada's edit",
        expectedCurrentVersionId: bens.currentVersionId,
        idempotencyKey: `auth-035-${key.keyId}-version`,
        projectId: bens.projectId,
      })).rejects.toThrow("HTTP 403");
      const changes = await Promise.all(([
        ["PATCH", "/tags", {tags: ["edited-by-ada"]}],
        ["PATCH", "/access", {accessSetting: "public_link"}],
        ["POST", "/restore", {versionId: bens.currentVersionId}],
        ["DELETE", "", {}],
      ] as const).map(([method, suffix, body]) =>
        mutate(key, method, artifactPath(bens.id, suffix), {
          ...body,
          expectedCurrentVersionId: bens.currentVersionId,
        })
      ));
      expect(changes.map(({status}) => status)).toEqual([403, 403, 403, 403]);
    }));
    expect(await readArtifact(bensKey, bens.id)).toMatchObject({
      currentVersionId: bens.currentVersionId,
      tags: [],
    });

    // Without the owner-scoped capability, a key cannot change even its own artifact.
    const readOnly = await personalKey(ada, "Ada's creator", ["artifact:create", "artifact:read"]);
    const adas = await publishAs(readOnly, "Ada's notes");
    await expect(publishVersion(server, as(readOnly), {
      artifactId: adas.id,
      content: "Ada's notes, revised",
      expectedCurrentVersionId: adas.currentVersionId,
      idempotencyKey: "auth-035-read-only-version",
      projectId: adas.projectId,
    })).rejects.toThrow("HTTP 403");
    expect((await mutate(readOnly, "PATCH", artifactPath(adas.id, "/tags"), {
      expectedCurrentVersionId: adas.currentVersionId,
      tags: ["mine"],
    })).status).toBe(403);
  });

  async function startServer(
    policy: PersonalApiKeyPolicy | null,
  ): Promise<RunningTestServer> {
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    const options = {
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
      port,
    };
    return startTestServer(
      installation,
      policy === null ? options : {...options, personalApiKeyPolicy: policy},
    );
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
    return {cookies, email, id: sessionSchema.parse(await response.json()).principal.id};
  }

  async function session(person: Person): Promise<z.infer<typeof sessionSchema>> {
    const response = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: person.cookies.header},
    });
    expect(response.status).toBe(200);
    return sessionSchema.parse(await response.json());
  }

  function issuePersonal(person: Person, body: RequestBody): Promise<Response> {
    return browser(person, "POST", "/api/v1/personal-api-keys", body);
  }

  async function personalKey(
    person: Person,
    name: string,
    capabilities: readonly string[] = personalCapabilities,
  ): Promise<Key> {
    const response = await issuePersonal(person, {
      capabilities,
      expiresAt: daysFromNow(7),
      name,
    });
    expect(response.status).toBe(201);
    return keyOf(issuedKeySchema.parse(await response.json()));
  }

  async function personalKeys(
    person: Person,
  ): Promise<z.infer<typeof apiKeySchema>[]> {
    const response = await browser(person, "GET", "/api/v1/personal-api-keys");
    expect(response.status).toBe(200);
    return keyListSchema.parse(await response.json()).apiKeys;
  }

  function adminIssue(body: RequestBody): Promise<Response> {
    return browser(administrator, "POST", "/api/v1/api-keys", body);
  }

  async function publishAs(
    key: Key,
    name: string,
  ): Promise<z.infer<typeof artifactSchema>> {
    const published = await publishNew(server, as(key), {
      accessSetting: "account_required",
      content: name,
      idempotencyKey: `publish-${key.keyId}-${name}`,
      name,
    });
    expect(published.response.status).toBe(201);
    return artifactSchema.parse(published.body.artifact);
  }

  async function readArtifact(
    key: Key,
    artifactId: string,
  ): Promise<z.infer<typeof artifactSchema>> {
    const response = await bearer(key.token, "GET", artifactPath(artifactId));
    expect(response.status).toBe(200);
    return artifactEnvelopeSchema.parse(await response.json()).artifact;
  }

  function as(key: Key): TestInstallation {
    return {...installation, apiToken: key.token};
  }

  function mutate(
    key: Key,
    method: string,
    requestPath: string,
    body: RequestBody,
  ): Promise<Response> {
    return fetch(`${server.baseUrl}${requestPath}`, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${key.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      method,
    });
  }

  function bearer(
    token: string,
    method: string,
    requestPath: string,
    body?: RequestBody,
  ): Promise<Response> {
    const init: RequestInit = {
      headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      method,
    };
    return fetch(
      `${server.baseUrl}${requestPath}`,
      body === undefined || method === "GET" ? init : {...init, body: JSON.stringify(body)},
    );
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

function keyOf(issued: z.infer<typeof issuedKeySchema>): Key {
  return {keyId: issued.apiKey.id, memberId: issued.apiKey.principalId, token: issued.token};
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
