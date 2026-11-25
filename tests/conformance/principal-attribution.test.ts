import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {
  ApiClient,
  dispatchCreationSchema,
  issuedKeySchema,
} from "../support/agent-dispatch.js";
import {
  publishNew,
  publishVersion,
  type PublishResponse,
} from "../support/publishing.js";
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
const clientSecret = "principal-attribution-test-client-secret";
const weekMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const personalCapabilities = [
  "agent:connect",
  "agent:dispatch",
  "artifact:create",
  "artifact:manage:own",
  "artifact:publish:own",
  "artifact:read",
  "comment:write",
] as const;

const sessionSchema = z.object({principal: z.object({id: z.string()})});
const authorSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  displayName: z.string(),
  principalId: z.string(),
  principalKind: z.enum(["human", "service"]),
});
const threadSchema = z.object({
  author: authorSchema,
  id: z.string(),
  resolvedBy: authorSchema.nullable(),
});
const threadDetailsSchema = z.object({
  replies: z.array(z.object({author: authorSchema})),
  thread: threadSchema,
});
const attributionSchema = z.object({
  displayName: z.string().optional(),
  email: z.string().nullable().optional(),
  keyName: z.string().nullable().optional(),
  kind: z.enum(["member", "former-member", "service", "local", "unknown"]),
  label: z.string(),
  principalId: z.string(),
}).strict();
const artifactDetailsSchema = z.object({
  current: z.object({publisher: attributionSchema}),
  owner: attributionSchema.nullable(),
});
const versionListSchema = z.object({
  versions: z.array(z.object({
    publisher: attributionSchema,
    version: z.object({number: z.number()}),
  })),
});
const versionSchema = z.object({publisher: attributionSchema});
const artifactPageSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string()}),
    owner: attributionSchema.nullable(),
  })),
});

/** Request bodies sent by these tests: strings and string lists only. */
type RequestBody = Readonly<Record<string, string | readonly string[]>>;

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

/** A person signed in through the browser. */
interface Person {
  readonly cookies: ApplicationCookies;
  readonly id: string;
}

describe("who stands behind comments, sends, owners, and publishers", () => {
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer;
  let administrator: Person;
  let ada: Person;
  let ben: Person;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({clientId: "principal-attribution-test", clientSecret});
    server = await startServer();
    administrator = await signIn(administratorEmail, "administrator-subject", "Ida Admin");
    ada = await signIn("ada@example.test", "ada-subject", "Ada Lovelace");
    ben = await signIn("ben@example.test", "ben-subject", "Ben Okri");
  });

  afterEach(async () => {
    await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("CMT-028-B: threads, replies, resolutions, and sends made through a member's key show the member with the key as qualifier", async () => {
    expect.hasAssertions();
    const laptopToken = await personalKey(ada, "laptop");
    const laptop = new ApiClient(server, laptopToken);
    const draft = await publish(laptopToken, "Ada's draft");

    const thread = await laptop.openThread(draft, "Tighten the summary.", "attribution-thread");
    const reply = await laptop.fetch(
      `/api/v1/artifacts/${draft.artifact.id}/comments/${thread.id}/replies` +
        `?projectId=${draft.artifact.projectId}`,
      {body: JSON.stringify({body: "Done."}), idempotencyKey: crypto.randomUUID(), method: "POST"},
    );
    expect(reply.status).toBe(201);
    expect((await laptop.setThreadState(draft, thread.id, "resolved")).status).toBe(200);

    const details = threadDetailsSchema.parse(await (await laptop.fetch(
      `/api/v1/artifacts/${draft.artifact.id}/comments/${thread.id}` +
        `?projectId=${draft.artifact.projectId}`,
    )).json());
    const viaLaptop = {
      authorizedByPrincipalId: ada.id,
      displayName: "Ada Lovelace · laptop",
      principalId: ada.id,
      principalKind: "human",
    };
    expect(details.thread.author).toEqual(viaLaptop);
    expect(details.thread.resolvedBy).toEqual(viaLaptop);
    expect(details.replies.map((entry) => entry.author)).toEqual([viaLaptop]);

    // The same member writing from Review is signed with their name alone.
    const fromReview = await browser(
      ada,
      "POST",
      `/api/v1/artifacts/${draft.artifact.id}/versions/${draft.version.id}/comments` +
        `?projectId=${draft.artifact.projectId}`,
      {body: "Add a chart.", path: "index.html"},
    );
    expect(fromReview.status).toBe(201);
    expect(z.object({thread: threadSchema}).parse(await fromReview.json()).thread.author)
      .toMatchObject({authorizedByPrincipalId: null, displayName: "Ada Lovelace"});

    // A send through the key names the member and the key, which is what the
    // bundle message reads to the agent.
    const agent = await laptop.registerAgent({
      connectionKey: "ada-laptop",
      displayName: "Ada's agent",
      workingDirectory: "/work/ada",
    });
    const open = await laptop.openThread(draft, "Fix the date.", "attribution-send-thread");
    const sent = await laptop.sendDispatch({
      agentId: agent.id,
      idempotencyKey: crypto.randomUUID(),
      projectId: draft.artifact.projectId,
      threadIds: [open.id],
    });
    expect(sent.status).toBe(201);
    expect(dispatchCreationSchema.parse(await sent.json()).dispatch.sender)
      .toMatchObject({displayName: "Ada Lovelace · laptop", principalId: ada.id});
  });

  test("CMT-028-F: a service key cannot pass as a member by its name, and a former member's key signs nothing", async () => {
    expect.hasAssertions();
    const report = await publish(await personalKey(ada, "laptop"), "Ada's report");
    const imitator = new ApiClient(
      server,
      await serviceKey(["artifact:read", "comment:write"], "Ada Lovelace · laptop"),
    );
    const thread = await imitator.openThread(report, "Looks fine.", "attribution-imitator");
    expect(thread).toMatchObject({id: expect.any(String)});
    const listed = z.object({items: z.array(threadSchema)}).parse(
      await (await imitator.listThreads(report)).json(),
    ).items.find((item) => item.id === thread.id);
    expect(listed?.author).toMatchObject({
      authorizedByPrincipalId: administrator.id,
      principalKind: "service",
    });
    expect(listed?.author.principalId).toMatch(/^service:/u);

    // Deactivating Ben revokes his key, so nothing new carries his name.
    const benToken = await personalKey(ben, "desktop");
    expect((await browser(administrator, "POST", `/api/v1/members/${ben.id}/deactivate`)).status)
      .toBe(200);
    const refused = await new ApiClient(server, benToken).fetch(
      `/api/v1/artifacts/${report.artifact.id}/versions/${report.version.id}/comments` +
        `?projectId=${report.artifact.projectId}`,
      {body: JSON.stringify({body: "Late note."}), idempotencyKey: crypto.randomUUID(), method: "POST"},
    );
    expect(refused.status).toBe(401);
  });

  test("ART-012-B: artifact and version reads name the owner and the publisher of a member-owned artifact", async () => {
    expect.hasAssertions();
    const adaToken = await personalKey(ada, "laptop");
    const draft = await publish(adaToken, "Ada's plan");
    const service = await serviceKey(["artifact:publish:any", "artifact:read"], "CI");
    const second = await publishVersion(server, {...installation, apiToken: service}, {
      artifactId: draft.artifact.id,
      content: "Ada's plan, rebuilt",
      expectedCurrentVersionId: draft.version.id,
      idempotencyKey: "attribution-second-version",
      projectId: draft.artifact.projectId,
    });
    expect(second.response.status).toBe(201);

    const adaMember = {
      displayName: "Ada Lovelace",
      email: "ada@example.test",
      kind: "member",
      label: "Ada Lovelace",
      principalId: ada.id,
    };
    const details = artifactDetailsSchema.parse(await (await browser(
      ben,
      "GET",
      `/api/v1/artifacts/${draft.artifact.id}?projectId=${draft.artifact.projectId}`,
    )).json());
    expect(details.owner).toEqual(adaMember);
    expect(details.current.publisher).toMatchObject({
      keyName: "CI",
      kind: "service",
      label: "Service key · CI",
    });

    const versions = versionListSchema.parse(await (await browser(
      ben,
      "GET",
      `/api/v1/artifacts/${draft.artifact.id}/versions?projectId=${draft.artifact.projectId}`,
    )).json()).versions;
    expect(versions.map((entry) => [entry.version.number, entry.publisher.label]))
      .toEqual(expect.arrayContaining([[1, "Ada Lovelace"], [2, "Service key · CI"]]));
    const first = versionSchema.parse(await (await browser(
      ben,
      "GET",
      `/api/v1/artifacts/${draft.artifact.id}/versions/${draft.version.id}` +
        `?projectId=${draft.artifact.projectId}`,
    )).json());
    expect(first.publisher).toEqual(adaMember);

    const page = artifactPageSchema.parse(await (await browser(
      ben,
      "GET",
      `/api/v1/artifacts?projectId=${draft.artifact.projectId}`,
    )).json());
    expect(page.artifacts.find((item) => item.artifact.id === draft.artifact.id)?.owner)
      .toEqual(adaMember);
  });

  test("ART-012-F: owners that are not active members read as labels, never as raw ids", async () => {
    expect.hasAssertions();
    const serviceOwned = await publish(
      await serviceKey(["artifact:create", "artifact:read"], "Nightly report"),
      "Nightly report",
    );
    const benOwned = await publish(await personalKey(ben, "desktop"), "Ben's notes");
    expect((await browser(administrator, "POST", `/api/v1/members/${ben.id}/deactivate`)).status)
      .toBe(200);

    const owners = await Promise.all([serviceOwned, benOwned].map(async (published) =>
      artifactDetailsSchema.parse(await (await browser(
        ada,
        "GET",
        `/api/v1/artifacts/${published.artifact.id}?projectId=${published.artifact.projectId}`,
      )).json())
    ));
    expect(owners.map((details) => details.owner)).toEqual([
      {
        keyName: "Nightly report",
        kind: "service",
        label: "Service key · Nightly report",
        principalId: serviceOwned.artifact.ownerPrincipalId,
      },
      {kind: "former-member", label: "Former member", principalId: ben.id},
    ]);
    // A former member's name and email are not served once they leave.
    expect(owners[1]?.current.publisher).toEqual(
      {kind: "former-member", label: "Former member", principalId: ben.id},
    );

    // On a single-user installation the local API token owns what it
    // publishes, and reads back as the local token.
    const local = await createTestInstallation();
    const localServer = await startTestServer(local);
    try {
      const published = await publishNew(localServer, local, {
        accessSetting: "account_required",
        content: "Local notes",
        idempotencyKey: "attribution-local-publish",
        name: "Local notes",
      });
      expect(published.response.status).toBe(201);
      const read = await fetch(
        `${localServer.baseUrl}/api/v1/artifacts/${published.body.artifact.id}` +
          `?projectId=${published.body.artifact.projectId}`,
        {headers: {Authorization: `Bearer ${local.apiToken}`}},
      );
      const details = artifactDetailsSchema.parse(await read.json());
      const localToken = {kind: "local", label: "Local API token", principalId: "local-api-token"};
      expect(details.owner).toEqual(localToken);
      expect(details.current.publisher).toEqual(localToken);
    } finally {
      await localServer.stop();
      await removeTestInstallation(local);
    }
  });

  test("AUTH-041-B: people see the email of an owner who is a member", async () => {
    expect.hasAssertions();
    const draft = await publish(await personalKey(ada, "laptop"), "Ada's draft");
    const benKey = new ApiClient(server, await personalKey(ben, "desktop"));
    const viaKey = artifactDetailsSchema.parse(await (await benKey.fetch(
      `/api/v1/artifacts/${draft.artifact.id}?projectId=${draft.artifact.projectId}`,
    )).json());
    expect(viaKey.owner).toMatchObject({displayName: "Ada Lovelace", email: "ada@example.test"});
  });

  test("AUTH-041-F: a service key reads an owner's name but never their email", async () => {
    expect.hasAssertions();
    const draft = await publish(await personalKey(ada, "laptop"), "Ada's draft");
    const service = new ApiClient(server, await serviceKey(["artifact:read"], "Indexer"));
    const details = artifactDetailsSchema.parse(await (await service.fetch(
      `/api/v1/artifacts/${draft.artifact.id}?projectId=${draft.artifact.projectId}`,
    )).json());
    expect(details.owner).toEqual({
      displayName: "Ada Lovelace",
      email: null,
      kind: "member",
      label: "Ada Lovelace",
      principalId: ada.id,
    });
    expect(details.current.publisher).toMatchObject({email: null, kind: "member"});
  });

  async function startServer(): Promise<RunningTestServer> {
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
      personalApiKeyPolicy: {maxLifetimeDays: 30},
      port,
    });
  }

  async function signIn(email: string, subject: string, name: string): Promise<Person> {
    provider.claims.email = email;
    provider.claims.subject = subject;
    provider.claims.name = name;
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

  /** Issue a personal key from the person's browser session and answer with its token. */
  async function personalKey(person: Person, name: string): Promise<string> {
    const response = await browser(person, "POST", "/api/v1/personal-api-keys", {
      capabilities: personalCapabilities,
      expiresAt: new Date(Date.now() + weekMilliseconds).toISOString(),
      name,
    });
    expect(response.status).toBe(201);
    return issuedKeySchema.parse(await response.json()).token;
  }

  /** Issue a key bound to no member from the administrator's session. */
  async function serviceKey(capabilities: readonly string[], name: string): Promise<string> {
    const response = await browser(administrator, "POST", "/api/v1/api-keys", {
      capabilities,
      expiresAt: new Date(Date.now() + weekMilliseconds).toISOString(),
      name,
    });
    expect(response.status).toBe(201);
    return issuedKeySchema.parse(await response.json()).token;
  }

  async function publish(token: string, name: string): Promise<PublishResponse> {
    const published = await publishNew(server, {...installation, apiToken: token}, {
      accessSetting: "account_required",
      content: name,
      idempotencyKey: `attribution-publish-${name}-${crypto.randomUUID()}`,
      name,
    });
    expect(published.response.status).toBe(201);
    return published.body;
  }

  function browser(
    person: Person,
    method: string,
    requestPath: string,
    body?: RequestBody,
  ): Promise<Response> {
    const headers = {
      Cookie: person.cookies.header,
      "Idempotency-Key": crypto.randomUUID(),
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": person.cookies.csrf,
    };
    if (body === undefined) return fetch(`${server.baseUrl}${requestPath}`, {headers, method});
    return fetch(`${server.baseUrl}${requestPath}`, {
      body: JSON.stringify(body),
      headers: {...headers, "Content-Type": "application/json"},
      method,
    });
  }
});

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
