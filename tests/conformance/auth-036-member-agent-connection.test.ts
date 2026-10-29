import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
  failureSchema,
  issuedKeySchema,
  type RegisteredAgent,
} from "../support/agent-dispatch.js";
import {publishNew, publishVersion, type PublishResponse} from "../support/publishing.js";
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
const clientSecret = "member-agent-connection-test-client-secret";
const weekMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const personalCeiling = [
  "agent:connect",
  "artifact:create",
  "artifact:manage:own",
  "artifact:publish:own",
  "artifact:read",
  "comment:write",
  "content-session:issue",
] as const;

const sessionSchema = z.object({principal: z.object({id: z.string()})});

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

describe("member keys connect agents", () => {
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer;
  let administrator: Person;
  let ada: Person;
  let ben: Person;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({clientId: "member-agent-test", clientSecret});
    server = await startServer();
    administrator = await signIn(administratorEmail, "administrator-subject");
    ada = await signIn("ada@example.test", "ada-subject");
    ben = await signIn("ben@example.test", "ben-subject");
  });

  afterEach(async () => {
    await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-036-B: a member's personal key runs that member's agent on their own restricted artifact", async () => {
    expect.hasAssertions();
    const agentKey = await personalKey(ada, "Ada's agent", personalCeiling);
    const adaAgent = new ApiClient(server, agentKey);
    const draft = await publishRestricted(agentKey, "Ada's draft");
    const agent = await adaAgent.registerAgent({
      connectionKey: "ada-laptop",
      displayName: "Ada's agent",
      workingDirectory: "/work/ada",
    });

    // Ada reviews in the browser and sends the thread to her own agent.
    const thread = await adaAgent.openThread(draft, "Tighten the summary.", "member-agent-ada-thread");
    const sent = await browser(ada, "POST", `/api/v1/agent-dispatches?projectId=${draft.artifact.projectId}`, {
      agentId: agent.id,
      threadIds: [thread.id],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json()).dispatch.id;

    const claimed = await adaAgent.claim(agent.id);
    expect(claimed.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await claimed.json()).dispatch.id).toBe(dispatchId);
    expect((await beacon(adaAgent, agent)).status).toBe(204);
    // The agent fixes the artifact it was sent, which only its member may see.
    const fixed = await publishVersion(server, {...installation, apiToken: agentKey}, {
      artifactId: draft.artifact.id,
      content: "Ada's draft, tightened",
      expectedCurrentVersionId: draft.version.id,
      idempotencyKey: "member-agent-ada-fix",
    });
    expect(fixed.response.status).toBe(201);
    expect((await adaAgent.reportDelivered(dispatchId, agent.id)).status).toBe(200);

    // Any of Ada's keys reaches Ada's agent; it is hers, not one key's.
    const second = new ApiClient(server, await personalKey(ada, "Ada's second laptop", ["agent:connect"]));
    expect((await second.claim(agent.id)).status).toBe(204);
    expect((await beacon(second, agent)).status).toBe(204);

    // A key an administrator binds to a member connects that member's agent too.
    const bound = await browser(administrator, "POST", "/api/v1/api-keys", {
      capabilities: ["agent:connect"],
      expiresAt: new Date(Date.now() + weekMilliseconds).toISOString(),
      memberId: ben.id,
      name: "Ben's CI agent",
    });
    expect(bound.status).toBe(201);
    const bensAgent = await new ApiClient(server, issuedKeySchema.parse(await bound.json()).token)
      .registerAgent({connectionKey: "ben-ci", displayName: "Ben's CI agent", workingDirectory: "/ci"});
    expect(bensAgent.id).not.toBe(agent.id);
  });

  test("AUTH-036-F: keys without the capability, other members' keys, and browser sessions cannot act as an agent, and leaving stops it", async () => {
    expect.hasAssertions();
    const agentKey = await personalKey(ada, "Ada's agent", personalCeiling);
    const adaAgent = new ApiClient(server, agentKey);
    const agent = await adaAgent.registerAgent({
      connectionKey: "ada-laptop",
      displayName: "Ada's agent",
      workingDirectory: "/work/ada",
    });

    // Without agent:connect, even Ada's own key is not an agent.
    const readOnly = new ApiClient(server, await personalKey(ada, "Ada's reader", ["artifact:read"]));
    expect(await codes([
      readOnly.fetch("/api/v1/agents", {body: registration("ada-reader"), method: "POST"}),
      readOnly.claim(agent.id),
      beacon(readOnly, agent),
    ])).toEqual(Array.from({length: 3}, () => [403, "AUTHORIZATION_DENIED"]));

    // Ben's key reaches nothing of Ada's agent.
    const bens = new ApiClient(server, await personalKey(ben, "Ben's agent", ["agent:connect"]));
    expect(await codes([
      bens.claim(agent.id),
      beacon(bens, agent),
      bens.fetch(`/api/v1/agents/${agent.id}/disconnect`, {method: "POST"}),
    ])).toEqual([
      [403, "AUTHORIZATION_DENIED"],
      [404, "AGENT_NOT_FOUND"],
      [403, "AUTHORIZATION_DENIED"],
    ]);
    // Ben's agent with Ada's connection key is a separate agent, not Ada's.
    const lookalike = await bens.registerAgent({
      connectionKey: "ada-laptop",
      displayName: "Lookalike",
      workingDirectory: "/work/ben",
    });
    expect(lookalike.id).not.toBe(agent.id);

    // A person's browser session is not an agent.
    const fromBrowser = await browser(ada, "POST", "/api/v1/agents", registrationBody("ada-browser"));
    expect(fromBrowser.status).toBe(403);

    // Deactivating Ada revokes her keys, and her agent stops claiming.
    expect((await browser(administrator, "POST", `/api/v1/members/${ada.id}/deactivate`)).status)
      .toBe(200);
    expect((await adaAgent.claim(agent.id)).status).toBe(401);
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

  /** Issue a personal key from the person's browser session and answer with its token. */
  async function personalKey(
    person: Person,
    name: string,
    capabilities: readonly string[],
  ): Promise<string> {
    const response = await browser(person, "POST", "/api/v1/personal-api-keys", {
      capabilities,
      expiresAt: new Date(Date.now() + weekMilliseconds).toISOString(),
      name,
    });
    expect(response.status).toBe(201);
    return issuedKeySchema.parse(await response.json()).token;
  }

  async function publishRestricted(token: string, name: string): Promise<PublishResponse> {
    const published = await publishNew(server, {...installation, apiToken: token}, {
      accessSetting: "restricted",
      content: name,
      idempotencyKey: `member-agent-publish-${name}`,
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

/** An agent registration body for a principal that must be refused. */
function registrationBody(connectionKey: string) {
  return {
    connectionKey,
    displayName: "impostor",
    kind: "pi",
    workingDirectory: "/work/impostor",
  } satisfies RequestBody;
}

function registration(connectionKey: string): string {
  return JSON.stringify(registrationBody(connectionKey));
}

function beacon(client: ApiClient, agent: RegisteredAgent): Promise<Response> {
  return client.fetch(`/api/v1/agents/${agent.id}/activity`, {
    body: JSON.stringify({state: "replying"}),
    method: "POST",
  });
}

/** Status and error code of each refused response, in order. */
async function codes(
  pending: readonly Promise<Response>[],
): Promise<readonly (readonly [number, string])[]> {
  return Promise.all(pending.map(async (request) => {
    const response = await request;
    return [response.status, failureSchema.parse(await response.json()).error.code] as const;
  }));
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
