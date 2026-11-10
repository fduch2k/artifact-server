import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  agentListSchema,
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
  failureSchema,
  type RegisteredAgent,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const memberCapabilities = [
  "agent:connect",
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "comment:write",
] as const;

const memberSchema = z.object({member: z.object({id: z.string()})});
const issuedKeySchema = z.object({
  apiKey: z.object({principalId: z.string()}),
  token: z.string().startsWith("as_key_"),
});

/** Request bodies sent by these tests: strings and string lists only. */
type RequestBody = Readonly<Record<string, string | readonly string[]>>;

/** The administrator's request to issue one API key, bound to a member or not. */
interface IssueKeyRequest {
  readonly capabilities: readonly string[];
  readonly expiresAt: string;
  readonly memberId?: string;
  readonly name: string;
}

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

/** One caller with its key, its principal, and the agent it connected. */
interface Participant {
  readonly agent: RegisteredAgent;
  readonly client: ApiClient;
  readonly id: string;
  readonly token: string;
}

describe("agents are offered only to the artifacts their owners can read", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let administrator: ApplicationCookies;
  let ada: Participant;
  let ben: Participant;
  let carl: Participant;
  let bot: Participant;
  let metrics: PublishResponse;
  let notes: PublishResponse;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    administrator = await signInAdministrator(server, installation);
    ada = await participant("Ada", "ada@example.test");
    ben = await participant("Ben", "ben@example.test");
    carl = await participant("Carl", "carl@example.test");
    bot = await participant("Release bot", null);
    metrics = await publish(ada, "Ada's metrics", "restricted");
    notes = await publish(ada, "Team notes", "account_required");
    const shared = await adminRequest(
      "PUT",
      `/api/v1/artifacts/${metrics.artifact.id}/grants/${ben.id}`,
    );
    if (shared.status !== 200) {
      throw new Error(`Sharing the metrics with Ben answered ${shared.status}.`);
    }
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-015-B: the listing for an artifact holds the agents of everyone who can read it, keeps another member's location private, and their agent receives the send", async () => {
    expect.hasAssertions();
    const forMetrics = await listedFor(ada, metrics);
    expect(forMetrics.map(({id}) => id)).toEqual([ada.agent.id, ben.agent.id]);
    expect(forMetrics[0]).toMatchObject({
      connectionKey: ada.agent.connectionKey,
      ownerDisplayName: "Ada",
      workingDirectory: "/work/Ada",
    });
    expect(forMetrics[1]).toMatchObject({
      agentSessionId: null,
      connectionKey: null,
      ownerDisplayName: "Ben",
      workingDirectory: null,
    });

    // Everyone with an account reads the team notes, the bot's agent too,
    // and a service key's agent stays described as installation tooling.
    const forNotes = await listedFor(ada, notes);
    expect(forNotes.map(({id}) => id))
      .toEqual([ada.agent.id, ben.agent.id, carl.agent.id, bot.agent.id]);
    expect(forNotes[3]).toMatchObject({
      ownerDisplayName: null,
      workingDirectory: "/work/Release bot",
    });
    // Without an artifact the listing keeps every live agent, locations kept private.
    const unscoped = agentListSchema.parse(await (await ada.client.listAgents()).json()).items;
    expect(unscoped.map(({id}) => id)).toEqual(forNotes.map(({id}) => id));
    expect(unscoped[1]?.workingDirectory).toBeNull();

    // Ada sends a thread on her restricted metrics to Ben's agent, and it works it.
    const thread = await ada.client.openThread(metrics, "Recheck the totals.", "reach-metrics-thread");
    const sent = await ada.client.sendDispatch({
      agentId: ben.agent.id,
      idempotencyKey: "reach-send-to-ben",
      projectId: metrics.artifact.projectId,
      threadIds: [thread.id],
    });
    expect(sent.status).toBe(201);
    const dispatch = dispatchCreationSchema.parse(await sent.json()).dispatch;
    const claimed = await ben.client.claim(ben.agent.id);
    expect(claimed.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await claimed.json()).dispatch.id).toBe(dispatch.id);
    const read = await ben.client.fetch(
      `/api/v1/artifacts/${metrics.artifact.id}/comments/${thread.id}?projectId=${metrics.artifact.projectId}`,
    );
    expect(read.status).toBe(200);
  });

  test("DSP-015-F: a send is refused whole when the agent's owner cannot read a thread, readers without access learn nothing, and a former member's agent disappears", async () => {
    expect.hasAssertions();
    const restricted = await ada.client.openThread(metrics, "Only Ada and Ben see this.", "reach-restricted-thread");
    const open = await ada.client.openThread(notes, "Everyone sees this.", "reach-open-thread");

    // Carl cannot read the metrics, nor can a service key's agent.
    expect(await refusal(send(carl.agent, [restricted.id], "reach-send-to-carl")))
      .toEqual([422, "INVALID_DISPATCH"]);
    expect(await refusal(send(bot.agent, [restricted.id], "reach-send-to-bot")))
      .toEqual([422, "INVALID_DISPATCH"]);
    // One unreadable thread refuses the whole bundle, leaving no marker behind.
    expect(await refusal(send(bot.agent, [open.id, restricted.id], "reach-mixed-to-bot")))
      .toEqual([422, "INVALID_DISPATCH"]);
    expect(await ada.client.listThreadIds(notes)).toContain(open.id);
    expect(await ada.client.listThreadIds(metrics)).toContain(restricted.id);
    expect((await send(ada.agent, [restricted.id], "reach-send-to-own-agent")).status).toBe(201);

    // Asking for the agents of an artifact one cannot see discloses nothing.
    expect(await refusal(listFor(carl, metrics))).toEqual([404, "ARTIFACT_NOT_FOUND"]);
    expect(await refusal(listFor(bot, metrics))).toEqual([404, "ARTIFACT_NOT_FOUND"]);

    // Ben leaves: his agent can no longer claim, so nobody is offered it.
    expect((await adminRequest("POST", `/api/v1/members/${ben.id}/deactivate`)).status)
      .toBe(200);
    expect((await listedFor(ada, notes)).map(({id}) => id)).not.toContain(ben.agent.id);
    const unscoped = agentListSchema.parse(await (await ada.client.listAgents()).json()).items;
    expect(unscoped.map(({id}) => id)).not.toContain(ben.agent.id);
    expect(await refusal(send(ben.agent, [open.id], "reach-to-former-member")))
      .toEqual([404, "AGENT_NOT_FOUND"]);
  });

  async function participant(displayName: string, email: string | null): Promise<Participant> {
    let memberId: string | null = null;
    if (email !== null) {
      const admitted = await adminRequest("POST", "/api/v1/members", {displayName, email});
      expect(admitted.status).toBe(201);
      memberId = memberSchema.parse(await admitted.json()).member.id;
    }
    const serviceKey: IssueKeyRequest = {
      capabilities: [...memberCapabilities],
      expiresAt: "2099-01-01T00:00:00.000Z",
      name: `${displayName}'s key`,
    };
    const issued = await adminRequest(
      "POST",
      "/api/v1/api-keys",
      memberId === null ? serviceKey : {...serviceKey, memberId},
    );
    expect(issued.status).toBe(201);
    const key = issuedKeySchema.parse(await issued.json());
    const client = new ApiClient(server, key.token);
    const agent = await client.registerAgent({
      connectionKey: `${displayName}-laptop`,
      displayName: `${displayName}'s agent`,
      workingDirectory: `/work/${displayName}`,
    });
    return {agent, client, id: key.apiKey.principalId, token: key.token};
  }

  async function publish(
    owner: Participant,
    name: string,
    accessSetting: "account_required" | "restricted",
  ): Promise<PublishResponse> {
    const published = await publishNew(server, {...installation, apiToken: owner.token}, {
      accessSetting,
      content: `<!doctype html><title>${name}</title>`,
      idempotencyKey: `reach-publish-${name}`,
      name,
    });
    expect(published.response.status).toBe(201);
    return published.body;
  }

  async function listedFor(reader: Participant, published: PublishResponse) {
    const response = await listFor(reader, published);
    expect(response.status).toBe(200);
    return agentListSchema.parse(await response.json()).items;
  }

  function send(
    agent: RegisteredAgent,
    threadIds: readonly string[],
    idempotencyKey: string,
  ): Promise<Response> {
    return ada.client.sendDispatch({
      agentId: agent.id,
      idempotencyKey,
      projectId: notes.artifact.projectId,
      threadIds,
    });
  }

  function adminRequest(
    method: string,
    requestPath: string,
    body?: IssueKeyRequest | RequestBody,
  ): Promise<Response> {
    const init: RequestInit = {
      headers: {
        "Content-Type": "application/json",
        Cookie: administrator.header,
        "Idempotency-Key": crypto.randomUUID(),
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": administrator.csrf,
      },
      method,
    };
    return fetch(
      `${server.baseUrl}${requestPath}`,
      body === undefined ? init : {...init, body: JSON.stringify(body)},
    );
  }
});

/** One reader's agent listing for one artifact. */
function listFor(reader: Participant, published: PublishResponse): Promise<Response> {
  return reader.client.fetch(
    `/api/v1/agents?artifactId=${published.artifact.id}&projectId=${published.artifact.projectId}`,
  );
}

/** Status and error code of one refused response. */
async function refusal(pending: Promise<Response>): Promise<readonly [number, string]> {
  const response = await pending;
  return [response.status, failureSchema.parse(await response.json()).error.code];
}
