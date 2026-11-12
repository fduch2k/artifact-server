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
import {publishNew, type PublishResponse} from "../support/publishing.js";
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
const clientSecret = "key-dispatch-test-client-secret";
const weekMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const withoutDispatch = [
  "agent:connect",
  "artifact:create",
  "artifact:manage:own",
  "artifact:publish:own",
  "artifact:read",
  "comment:write",
  "content-session:issue",
] as const;
const withDispatch = [...withoutDispatch, "agent:dispatch"] as const;

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

describe("keys send threads to agents", () => {
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer;
  let administrator: Person;
  let ada: Person;
  let ben: Person;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({clientId: "key-dispatch-test", clientSecret});
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

  test("AUTH-039-B: a key holding agent:dispatch sends with its member's reach and cancels its member's sends; a service key sends what it can read", async () => {
    expect.hasAssertions();
    const adaToken = await personalKey(ada, "Ada's script", withDispatch);
    const adaKey = new ApiClient(server, adaToken);
    const agent = await adaKey.registerAgent({
      connectionKey: "ada-laptop",
      displayName: "Ada's agent",
      workingDirectory: "/work/ada",
    });

    // Ada's own restricted draft: the key sends as Ada.
    const draft = await publish(adaToken, "restricted", "Ada's draft");
    const own = await adaKey.openThread(draft, "Tighten the summary.", "key-dispatch-own-thread");
    const sentOwn = await send(adaKey, draft, agent, own.id);
    expect(sentOwn.status).toBe(201);
    const ownDispatch = dispatchCreationSchema.parse(await sentOwn.json()).dispatch;
    expect(ownDispatch.sender).toMatchObject({principalId: ada.id, principalKind: "human"});

    // Ben's restricted notes, shared with Ada: the key reaches them too.
    const benToken = await personalKey(ben, "Ben's script", withoutDispatch);
    const benKey = new ApiClient(server, benToken);
    const notes = await publish(benToken, "restricted", "Ben's notes");
    expect((await browser(ben, "PUT", `/api/v1/artifacts/${notes.artifact.id}/grants/${ada.id}`)).status)
      .toBe(200);
    const shared = await benKey.openThread(notes, "Ada, check the totals.", "key-dispatch-shared-thread");
    expect((await send(adaKey, notes, agent, shared.id)).status).toBe(201);

    // The key cancels what it sent, and what Ada sent from the browser.
    expect((await adaKey.cancelDispatch(ownDispatch.id, draft.artifact.projectId)).status).toBe(200);
    expect(await state(adaKey, ownDispatch.id, draft)).toBe("canceled");
    const fromBrowserThread = await adaKey.openThread(draft, "Add a chart.", "key-dispatch-browser-thread");
    const fromBrowser = await browser(ada, "POST", `/api/v1/agent-dispatches?projectId=${draft.artifact.projectId}`, {
      agentId: agent.id,
      threadIds: [fromBrowserThread.id],
    });
    expect(fromBrowser.status).toBe(201);
    const browserDispatch = dispatchCreationSchema.parse(await fromBrowser.json()).dispatch;
    expect((await adaKey.cancelDispatch(browserDispatch.id, draft.artifact.projectId)).status).toBe(200);
    expect(await state(adaKey, browserDispatch.id, draft)).toBe("canceled");

    // An administrator may give the capability to a service key, which sends
    // a thread it can read as itself.
    const service = new ApiClient(server, await serviceKey(["agent:dispatch"], "Review bot"));
    const report = await publish(adaToken, "account_required", "Ada's report");
    const open = await adaKey.openThread(report, "Fix the date.", "key-dispatch-service-thread");
    const sentByService = await send(service, report, agent, open.id);
    expect(sentByService.status).toBe(201);
    const serviceDispatch = dispatchCreationSchema.parse(await sentByService.json()).dispatch;
    expect(serviceDispatch.sender).toMatchObject({displayName: "Review bot", principalKind: "service"});
    expect((await service.cancelDispatch(serviceDispatch.id, report.artifact.projectId)).status).toBe(200);
  });

  test("AUTH-039-F: without agent:dispatch a key cannot send or cancel, and with it a key reaches no unreadable thread, no other sender's dispatch, and no bulk clear", async () => {
    expect.hasAssertions();
    const adaKey = new ApiClient(server, await personalKey(ada, "Ada's script", withDispatch));
    const plainToken = await personalKey(ada, "Ada's agent key", withoutDispatch);
    const adaPlain = new ApiClient(server, plainToken);
    const agent = await adaPlain.registerAgent({
      connectionKey: "ada-laptop",
      displayName: "Ada's agent",
      workingDirectory: "/work/ada",
    });
    const draft = await publish(plainToken, "restricted", "Ada's draft");
    const thread = await adaPlain.openThread(draft, "Tighten the summary.", "key-dispatch-plain-thread");

    // A personal key issued without the capability is refused both ways.
    const fromBrowser = await browser(ada, "POST", `/api/v1/agent-dispatches?projectId=${draft.artifact.projectId}`, {
      agentId: agent.id,
      threadIds: [thread.id],
    });
    expect(fromBrowser.status).toBe(201);
    const adaDispatch = dispatchCreationSchema.parse(await fromBrowser.json()).dispatch;
    const second = await adaPlain.openThread(draft, "Add a chart.", "key-dispatch-plain-second");
    expect(await codes([
      send(adaPlain, draft, agent, second.id),
      adaPlain.cancelDispatch(adaDispatch.id, draft.artifact.projectId),
    ])).toEqual([[403, "AUTHORIZATION_DENIED"], [403, "AUTHORIZATION_DENIED"]]);
    expect(await state(adaPlain, adaDispatch.id, draft)).toBe("queued");

    // Ben's restricted notes are not shared with Ada: the thread is missing to her key.
    const benToken = await personalKey(ben, "Ben's agent key", withoutDispatch);
    const benKey = new ApiClient(server, benToken);
    const notes = await publish(benToken, "restricted", "Ben's notes");
    const hidden = await benKey.openThread(notes, "Private remark.", "key-dispatch-hidden-thread");
    const refused = await send(adaKey, notes, agent, hidden.id);
    expect(refused.status).toBe(422);
    expect(failureSchema.parse(await refused.json()).error).toMatchObject({
      code: "INVALID_DISPATCH",
      message: "The bundle references a comment thread that does not exist in this project.",
    });

    // Ada's key cannot cancel what Ben sent to his own agent.
    const benAgent = await benKey.registerAgent({
      connectionKey: "ben-laptop",
      displayName: "Ben's agent",
      workingDirectory: "/work/ben",
    });
    const benDispatch = dispatchCreationSchema.parse(await (await browser(
      ben,
      "POST",
      `/api/v1/agent-dispatches?projectId=${notes.artifact.projectId}`,
      {agentId: benAgent.id, threadIds: [hidden.id]},
    )).json()).dispatch;
    expect(await codes([adaKey.cancelDispatch(benDispatch.id, notes.artifact.projectId)]))
      .toEqual([[403, "AUTHORIZATION_DENIED"]]);
    expect(await state(benKey, benDispatch.id, notes)).toBe("queued");

    // The capability does not clear an artifact's threads in bulk.
    expect(await codes([adaKey.fetch(
      `/api/v1/projects/${draft.artifact.projectId}/artifacts/${draft.artifact.id}/comments/clear`,
      {body: JSON.stringify({state: "all"}), idempotencyKey: crypto.randomUUID(), method: "POST"},
    )])).toEqual([[403, "AUTHORIZATION_DENIED"]]);

    // A service key with the capability still reads no restricted artifact.
    const service = new ApiClient(server, await serviceKey(["agent:dispatch"], "Review bot"));
    const third = await adaPlain.openThread(draft, "Shorten the title.", "key-dispatch-service-hidden");
    const serviceRefused = await send(service, draft, agent, third.id);
    expect(serviceRefused.status).toBe(422);
    expect(failureSchema.parse(await serviceRefused.json()).error.code).toBe("INVALID_DISPATCH");
    expect(await adaPlain.listThreadIds(draft)).toEqual(expect.arrayContaining([second.id, third.id]));
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

  async function publish(
    token: string,
    accessSetting: "account_required" | "restricted",
    name: string,
  ): Promise<PublishResponse> {
    const published = await publishNew(server, {...installation, apiToken: token}, {
      accessSetting,
      content: name,
      idempotencyKey: `key-dispatch-publish-${name}`,
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

function send(
  client: ApiClient,
  published: PublishResponse,
  agent: RegisteredAgent,
  threadId: string,
): Promise<Response> {
  return client.sendDispatch({
    agentId: agent.id,
    idempotencyKey: crypto.randomUUID(),
    projectId: published.artifact.projectId,
    threadIds: [threadId],
  });
}

async function state(
  client: ApiClient,
  dispatchId: string,
  published: PublishResponse,
): Promise<string> {
  const response = await client.getDispatch(dispatchId, published.artifact.projectId);
  expect(response.status).toBe(200);
  return dispatchEnvelopeSchema.parse(await response.json()).dispatch.state;
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
