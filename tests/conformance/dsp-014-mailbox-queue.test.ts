import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  agentListSchema,
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
  MutableClock,
  type RegisteredAgent,
} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const minuteMilliseconds = 60 * 1_000;
const unavailableStalenessMilliseconds = 15 * minuteMilliseconds;
const retentionMilliseconds = 7 * 24 * 60 * minuteMilliseconds;

describe("a mailbox agent is a queue", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer;
  let owner: ApiClient;
  let published: PublishResponse;

  beforeEach(async () => {
    clock = new MutableClock();
    installation = await createTestInstallation();
    server = await startTestServer(installation, {clock});
    owner = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Queue</title>",
      idempotencyKey: "mailbox-queue-publish",
      name: "Queue report",
    })).body;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-014-B: a send to a mailbox agent that has not checked in for long stays queued until its next check claims it", async () => {
    expect.hasAssertions();
    const mailbox = await registerMailbox("inbox");
    const thread = await owner.openThread(published, "Tighten the summary.", "mailbox-queue-thread");

    // Well past the live window and the live agents' 15-minute backstop.
    clock.advance(unavailableStalenessMilliseconds + minuteMilliseconds);
    expect(await presence(mailbox)).toMatchObject({
      activity: "disconnected",
      capabilities: {evidence: "mailbox"},
      connected: false,
    });
    const sent = await owner.sendDispatch({
      agentId: mailbox.id,
      idempotencyKey: "mailbox-queue-send",
      projectId: published.artifact.projectId,
      threadIds: [thread.id],
    });
    expect(sent.status).toBe(201);
    const dispatch = dispatchCreationSchema.parse(await sent.json()).dispatch;
    expect(dispatch.state).toBe("queued");

    // Hours later the send still waits, and its thread is still away.
    clock.advance(6 * 60 * minuteMilliseconds);
    expect(await readDispatch(dispatch.id)).toMatchObject({
      failedAt: null,
      failureReason: null,
      state: "queued",
    });
    expect(await owner.listThreadIds(published)).not.toContain(thread.id);

    // The agent's next inbox check takes it and reconnects the agent.
    const mailboxAgent = new ApiClient(server, installation.apiToken);
    const claimed = await mailboxAgent.claim(mailbox.id);
    expect(claimed.status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await claimed.json()).dispatch.id).toBe(dispatch.id);
    expect((await mailboxAgent.reportDelivered(dispatch.id, mailbox.id)).status).toBe(200);
    expect(await readDispatch(dispatch.id)).toMatchObject({state: "delivered"});
    expect(await presence(mailbox)).toMatchObject({connected: true});
  });

  test("DSP-014-F: a live agent's stale queue still fails agent_unavailable, and a mailbox whose registration is reaped fails too", async () => {
    expect.hasAssertions();
    const live = await owner.registerAgent({
      connectionKey: "live-pi",
      displayName: "live",
      workingDirectory: "/work/live",
    });
    const mailbox = await registerMailbox("inbox");
    const liveThread = await owner.openThread(published, "For the live agent.", "mailbox-queue-live-thread");
    const mailboxThread = await owner.openThread(published, "For the mailbox.", "mailbox-queue-mailbox-thread");
    const toLive = await send(live, liveThread.id, "mailbox-queue-live-send");
    const toMailbox = await send(mailbox, mailboxThread.id, "mailbox-queue-mailbox-send");

    clock.advance(unavailableStalenessMilliseconds + minuteMilliseconds);
    expect(await readDispatch(toLive)).toMatchObject({
      failureReason: "agent_unavailable",
      state: "failed",
    });
    expect(await readDispatch(toMailbox)).toMatchObject({state: "queued"});
    const afterLiveFailure = await owner.listThreadIds(published);
    expect(afterLiveFailure).toContain(liveThread.id);
    expect(afterLiveFailure).not.toContain(mailboxThread.id);

    // The retention reaper removes a mailbox that never checks in again;
    // its queue then fails like any vanished agent's and the thread returns.
    clock.advance(retentionMilliseconds);
    const listed = agentListSchema.parse(await (await owner.listAgents()).json());
    expect(listed.items.map(({id}) => id)).not.toContain(mailbox.id);
    expect(await readDispatch(toMailbox)).toMatchObject({
      failureReason: "agent_unavailable",
      state: "failed",
    });
    expect(await owner.listThreadIds(published)).toContain(mailboxThread.id);
  });

  function registerMailbox(displayName: string): Promise<RegisteredAgent> {
    return owner.registerAgent({
      capabilities: {beacon: false, evidence: "mailbox"},
      connectionKey: `mailbox-${displayName}`,
      displayName,
      kind: "mcp-mailbox",
      workingDirectory: "(mcp mailbox)",
    });
  }

  async function presence(agent: RegisteredAgent) {
    const listed = agentListSchema.parse(await (await owner.listAgents()).json());
    return listed.items.find(({id}) => id === agent.id);
  }

  async function send(
    agent: RegisteredAgent,
    threadId: string,
    idempotencyKey: string,
  ): Promise<string> {
    const sent = await owner.sendDispatch({
      agentId: agent.id,
      idempotencyKey,
      projectId: published.artifact.projectId,
      threadIds: [threadId],
    });
    expect(sent.status).toBe(201);
    return dispatchCreationSchema.parse(await sent.json()).dispatch.id;
  }

  async function readDispatch(dispatchId: string) {
    const response = await owner.getDispatch(dispatchId, published.artifact.projectId);
    expect(response.status).toBe(200);
    return dispatchEnvelopeSchema.parse(await response.json()).dispatch;
  }
});
