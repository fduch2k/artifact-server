import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {
  agentListSchema,
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
  failureSchema,
  type RegisteredAgent,
} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  startStubOidcLogin,
  startStubOidcProvider,
  type RunningStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const administratorEmail = "administrator@example.test";
const clientSecret = "agent-removal-test-client-secret";
const dayMilliseconds = 24 * 60 * 60 * 1_000;
const agentKeyCapabilities = [
  "agent:connect",
  "artifact:create",
  "artifact:manage:own",
  "artifact:publish:own",
  "artifact:read",
  "comment:write",
] as const;

const sessionSchema = z.object({principal: z.object({id: z.string()})});
const issuedKeySchema = z.object({token: z.string().startsWith("as_key_")});

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

/** A person signed in through the browser, with one personal key for agents. */
interface Person {
  readonly cookies: ApplicationCookies;
  readonly id: string;
  readonly key: ApiClient;
}

/** Request bodies sent by these tests: strings and string lists only. */
type RequestBody = Readonly<Record<string, string | readonly string[]>>;

describe("registered agents can be forgotten by their owner or an administrator", () => {
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer;
  let administrator: Person;
  let ada: Person;
  let ben: Person;
  let notes: PublishResponse;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({
      clientId: "agent-removal-test",
      clientSecret,
    });
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    server = await startTestServer(installation, {
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
    administrator = await signIn(administratorEmail, "administrator-subject");
    ada = await signIn("ada@example.test", "ada-subject");
    ben = await signIn("ben@example.test", "ben-subject");
    const published = await publishNew(
      server,
      {...installation, apiToken: await personalKeyToken(ada, agentKeyCapabilities)},
      {
        accessSetting: "account_required",
        content: "<!doctype html><title>Team notes</title>",
        idempotencyKey: "agent-removal-notes",
        name: "Team notes",
      },
    );
    if (published.response.status !== 201) {
      throw new Error(`Publishing the team notes answered ${published.response.status}.`);
    }
    notes = published.body;
  });

  afterEach(async () => {
    await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-017-B: an owner forgets an idle agent from their session or key, an administrator forgets anyone's, and the same client registers again as a new row", async () => {
    expect.hasAssertions();
    const probe = await register(ada, "probe");
    const laptop = await register(ada, "laptop");
    const bens = await register(ben, "desk");
    expect(await listedIds(ben)).toEqual([probe.id, laptop.id, bens.id]);

    // The owner removes the probe from Review, and it leaves every listing at once.
    expect((await browser(ada, "DELETE", agentPath(probe.id))).status).toBe(204);
    expect(await listedIds(ada)).toEqual([laptop.id, bens.id]);
    expect(await listedIds(ben)).toEqual([laptop.id, bens.id]);
    expect(await listedIds(ada, notes)).toEqual([laptop.id, bens.id]);

    // The owner's key that connects agents may forget them too.
    expect((await ada.key.fetch(agentPath(laptop.id), {method: "DELETE"})).status)
      .toBe(204);
    // An administrator forgets another member's agent.
    expect((await browser(administrator, "DELETE", agentPath(bens.id))).status).toBe(204);
    expect(await listedIds(ben)).toEqual([]);

    // The same client connecting again is a new registration, not the old row.
    const again = await register(ada, "probe");
    expect(again.connectionKey).toBe(probe.connectionKey);
    expect(again.id).not.toBe(probe.id);
    expect(await listedIds(ben)).toEqual([again.id]);
  });

  test("DSP-017-F: another member, their key, and a key without agent:connect cannot forget an agent, and a foreign agent answers exactly like a missing one", async () => {
    expect.hasAssertions();
    const adas = await register(ada, "laptop");

    const missing = await refusal(browser(ben, "DELETE", agentPath("agt_missing")));
    expect(missing).toEqual([404, "AGENT_NOT_FOUND", "The registered agent does not exist."]);
    expect(await refusal(browser(ben, "DELETE", agentPath(adas.id)))).toEqual(missing);
    expect(await refusal(ben.key.fetch(agentPath(adas.id), {method: "DELETE"})))
      .toEqual(missing);

    // A key that connects no agents is refused before any agent is looked up.
    const readOnly = new ApiClient(server, await personalKeyToken(ada, ["artifact:read"]));
    expect((await refusal(readOnly.fetch(agentPath(adas.id), {method: "DELETE"})))
      .slice(0, 2)).toEqual([403, "AUTHORIZATION_DENIED"]);
    expect((await refusal(readOnly.fetch(agentPath("agt_missing"), {method: "DELETE"})))
      .slice(0, 2)).toEqual([403, "AUTHORIZATION_DENIED"]);

    // Nothing was removed, and a removed agent cannot be removed twice.
    expect(await listedIds(ben)).toEqual([adas.id]);
    expect((await browser(ada, "DELETE", agentPath(adas.id))).status).toBe(204);
    expect(await refusal(browser(ada, "DELETE", agentPath(adas.id)))).toEqual(missing);
  });

  test("DSP-018-B: once its dispatch is canceled, failed, or addressed, the agent can be forgotten and the dispatch record stays", async () => {
    expect.hasAssertions();
    const canceling = await register(ada, "canceling");
    const failing = await register(ada, "failing");
    const addressing = await register(ada, "addressing");

    const canceled = await send(canceling, "Cancel me.");
    expect((await browser(ada, "POST", `/api/v1/agent-dispatches/${canceled}/cancel?projectId=${notes.artifact.projectId}`)).status)
      .toBe(200);

    const failed = await send(failing, "Fail me.");
    expect((await ada.key.claim(failing.id)).status).toBe(200);
    expect((await ada.key.reportFailed(failed, failing.id, "Workspace gone.")).status)
      .toBe(200);

    // Resolving every thread of a delivered bundle addresses it; the removal
    // sees that without anyone reading the dispatch in between.
    const addressed = await send(addressing, "Address me.");
    expect((await ada.key.claim(addressing.id)).status).toBe(200);
    expect((await ada.key.reportDelivered(addressed, addressing.id)).status).toBe(200);
    const thread = await threadOf(addressed);
    expect((await ada.key.setThreadState(notes, thread, "resolved")).status).toBe(200);

    const removals = await Promise.all([canceling, failing, addressing].map((agent) =>
      browser(ada, "DELETE", agentPath(agent.id))
    ));
    expect(removals.map(({status}) => status)).toEqual([204, 204, 204]);
    expect(await listedIds(ada)).toEqual([]);
    expect(await dispatchStates([canceled, failed, addressed]))
      .toEqual(["canceled", "failed", "addressed"]);
  });

  test("DSP-018-F: a queued, claimed, or delivered dispatch keeps its agent, for the owner and an administrator alike", async () => {
    expect.hasAssertions();
    const busy = await register(ada, "busy");
    const dispatch = await send(busy, "Work on this.");
    const blocked = async (expected: string): Promise<void> => {
      const refusals = await Promise.all([ada, administrator].map((person) =>
        refusal(browser(person, "DELETE", agentPath(busy.id)))
      ));
      for (const [status, code, message] of refusals) {
        expect([status, code]).toEqual([409, "DISPATCH_STATE_CONFLICT"]);
        expect(message).toContain("still holds a queued, claimed, or delivered dispatch");
      }
      expect(await dispatchStates([dispatch])).toEqual([expected]);
      expect(await listedIds(ada)).toEqual([busy.id]);
    };

    await blocked("queued");
    expect((await ada.key.claim(busy.id)).status).toBe(200);
    await blocked("claimed");
    expect((await ada.key.reportDelivered(dispatch, busy.id)).status).toBe(200);
    await blocked("delivered");
    // The thread it carries is still away from the open list.
    expect(await ada.key.listThreadIds(notes)).not.toContain(await threadOf(dispatch));
  });

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
    const id = sessionSchema.parse(await response.json()).principal.id;
    const signedIn = {cookies, id};
    return {
      ...signedIn,
      key: new ApiClient(server, await personalKeyToken(signedIn, agentKeyCapabilities)),
    };
  }

  async function personalKeyToken(
    person: Pick<Person, "cookies">,
    capabilities: readonly string[],
  ): Promise<string> {
    const response = await browser(person, "POST", "/api/v1/personal-api-keys", {
      capabilities,
      expiresAt: new Date(Date.now() + 7 * dayMilliseconds).toISOString(),
      name: `Key ${crypto.randomUUID()}`,
    });
    expect(response.status).toBe(201);
    return issuedKeySchema.parse(await response.json()).token;
  }

  async function listedIds(
    person: Person,
    published?: PublishResponse,
  ): Promise<readonly string[]> {
    const query = published === undefined
      ? ""
      : `?artifactId=${published.artifact.id}&projectId=${published.artifact.projectId}`;
    const response = await browser(person, "GET", `/api/v1/agents${query}`);
    expect(response.status).toBe(200);
    return agentListSchema.parse(await response.json()).items.map(({id}) => id);
  }

  /** Ada sends one fresh thread on the team notes to an agent; returns the dispatch id. */
  async function send(agent: RegisteredAgent, body: string): Promise<string> {
    const thread = await ada.key.openThread(notes, body, `agent-removal-${body}`);
    const response = await browser(
      ada,
      "POST",
      `/api/v1/agent-dispatches?projectId=${notes.artifact.projectId}`,
      {agentId: agent.id, threadIds: [thread.id]},
    );
    expect(response.status).toBe(201);
    return dispatchCreationSchema.parse(await response.json()).dispatch.id;
  }

  async function readDispatch(dispatchId: string) {
    const response = await ada.key.getDispatch(dispatchId, notes.artifact.projectId);
    expect(response.status).toBe(200);
    return dispatchEnvelopeSchema.parse(await response.json()).dispatch;
  }

  async function dispatchStates(dispatchIds: readonly string[]): Promise<readonly string[]> {
    const dispatches = await Promise.all(dispatchIds.map(readDispatch));
    return dispatches.map(({state}) => state);
  }

  async function threadOf(dispatchId: string): Promise<string> {
    const [threadId] = (await readDispatch(dispatchId)).threadIds;
    if (threadId === undefined) throw new Error("The dispatch carries no thread.");
    return threadId;
  }

  function browser(
    person: Pick<Person, "cookies">,
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

/** One person's agent, registered through their personal key. */
function register(person: Person, machine: string): Promise<RegisteredAgent> {
  return person.key.registerAgent({
    connectionKey: `${person.id}-${machine}`,
    displayName: `${machine} agent`,
    workingDirectory: `/work/${machine}`,
  });
}

function agentPath(agentId: string): string {
  return `/api/v1/agents/${agentId}`;
}

/** Status, error code, and message of one refused response. */
async function refusal(
  pending: Promise<Response>,
): Promise<readonly [number, string, string]> {
  const response = await pending;
  const {error} = failureSchema.parse(await response.json());
  return [response.status, error.code, error.message];
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
