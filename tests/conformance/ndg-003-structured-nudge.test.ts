/**
 * NDG-003 — the nudge reaches clients that read only `structuredContent`.
 * Claude Code hands its model the serialized structured value of a result
 * that has one and drops every content item, so a nudge carried only as a
 * trailing text item never reached it (ADR 0041). Every nudged tool now
 * advertises an optional `nudge` field in its output schema, and a pending
 * nudge fills it; schema-validating official clients, in both protocol eras,
 * accept the result.
 */

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  ApiClient,
  dispatchCreationSchema,
} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const nudgeHeading = "— artifact server —";
const queuedNudge =
  "1 review bundle is queued for your inbox. " +
  'Call dispatch_inbox {"operation": "claim"} to pick up the oldest.';

const inboxAnswerSchema = z.object({
  agent: z.object({id: z.string().startsWith("agt_")}).loose(),
}).loose();
const threadCreationSchema = z.object({
  thread: z.object({id: z.string()}).loose(),
}).loose();
const advertisedOutputSchema = z.object({
  additionalProperties: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).optional(),
}).loose();
const textItemsSchema = z.array(
  z.object({text: z.string(), type: z.literal("text")}).loose(),
);
const advertisedNudgeFieldSchema = z.object({
  maxLength: z.literal(400),
  type: z.literal("string"),
}).loose();
const nudgedStructureSchema = z.object({nudge: z.string()}).loose();

type Era = "legacy" | "modern";

describe("structured nudges on MCP tool results", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Structured</title>",
      idempotencyKey: "ndg-003-publish-artifact",
      name: "Structured report",
    })).body;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("NDG-003-B: every nudged tool advertises an optional nudge field, and with a bundle queued an unrelated result carries the nudge in structuredContent that schema-validating official clients accept in both protocol eras", async () => {
    expect.hasAssertions();
    await withClient("modern", async (official) => {
      const {tools} = await official.listTools();
      const structured = tools.filter((tool) => tool.outputSchema !== undefined);
      expect(structured.length).toBeGreaterThan(20);
      const advertised = structured.map((tool) => {
        const schema = advertisedOutputSchema.parse(tool.outputSchema);
        return {
          name: tool.name,
          nudge: schema.properties["nudge"] ?? null,
          nudgeRequired: (schema.required ?? []).includes("nudge"),
        };
      });
      // The inbox already says everything, so it never carries a nudge.
      expect(advertised.find((tool) => tool.name === "dispatch_inbox")?.nudge)
        .toBeNull();
      // Every other tool declares the same optional, bounded string.
      const nonconforming = advertised
        .filter((tool) => tool.name !== "dispatch_inbox")
        .filter((tool) =>
          tool.nudgeRequired || !advertisedNudgeFieldSchema.safeParse(tool.nudge).success
        )
        .map((tool) => tool.name);
      expect(nonconforming).toEqual([]);

      // No work pending: no field at all, so quiet results are unchanged.
      const quiet = await official.callTool({arguments: {}, name: "project_list"});
      expect(quiet.isError).not.toBe(true);
      expect(quiet.structuredContent).not.toHaveProperty("nudge");
    });

    await queueOneBundle();

    const eras: readonly Era[] = ["modern", "legacy"];
    await Promise.all(eras.map((era) => withClient(era, async (official) => {
      // listTools first, so the client validates the call against the
      // advertised output schema, as Claude Code and Codex hosts do.
      await official.listTools();
      const nudged = await official.callTool({
        arguments: {artifactId: published.artifact.id, projectId: published.artifact.projectId},
        name: "artifact_version_list",
      });
      expect(nudged.isError).not.toBe(true);
      const structuredNudge = nudgedStructureSchema
        .parse(nudged.structuredContent).nudge;
      expect(structuredNudge).toBe(`${nudgeHeading}\n${queuedNudge}`);
      // The text channel still carries the same block for content-only clients.
      const content = textItemsSchema.parse(nudged.content);
      expect(content).toHaveLength(2);
      expect(content[1]?.text).toBe(structuredNudge);
    })));
  });

  test("NDG-003-F: with a bundle queued, an error result and a dispatch_inbox result carry no nudge field", async () => {
    expect.hasAssertions();
    await queueOneBundle();
    await withClient("modern", async (official) => {
      await official.listTools();
      const failed = await official.callTool({
        arguments: {
          artifactId: published.artifact.id,
          projectId: published.artifact.projectId,
          resolved: true,
          threadId: "th_does_not_exist",
        },
        name: "comment_resolve",
      });
      expect(failed.isError).toBe(true);
      expect(failed.structuredContent ?? {}).not.toHaveProperty("nudge");

      const inbox = await official.callTool({
        arguments: {agentName: "Structured Claude", operation: "list"},
        name: "dispatch_inbox",
      });
      expect(inbox.isError).not.toBe(true);
      expect(inbox.structuredContent).not.toHaveProperty("nudge");
    });
  });

  async function withClient(
    era: Era,
    use: (official: Client) => Promise<void>,
  ): Promise<void> {
    const official = new Client(
      {name: `ndg-003-${era}-client`, version: "1"},
      {versionNegotiation: {mode: era === "legacy" ? "legacy" : {pin: "2026-07-28"}}},
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`${server.baseUrl}/mcp`),
      {authProvider: {token: async () => installation.apiToken}},
    );
    try {
      await official.connect(transport);
      await use(official);
    } finally {
      await official.close();
    }
  }

  async function queueOneBundle(): Promise<void> {
    const projectId = published.artifact.projectId;
    const threadResponse = await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}` +
        `/versions/${published.version.id}/comments?projectId=${projectId}`,
      {
        body: JSON.stringify({body: "Shorten the title.", path: "index.html"}),
        idempotencyKey: "ndg-003-thread-title",
        method: "POST",
      },
    );
    expect(threadResponse.status).toBe(201);
    const threadId = threadCreationSchema.parse(await threadResponse.json()).thread.id;
    let agentId = "";
    await withClient("modern", async (official) => {
      const registered = await official.callTool({
        arguments: {agentName: "Structured Claude", operation: "list"},
        name: "dispatch_inbox",
      });
      agentId = inboxAnswerSchema.parse(registered.structuredContent).agent.id;
    });
    const sent = await client.sendDispatch({
      agentId,
      idempotencyKey: "ndg-003-dispatch-title",
      projectId,
      threadIds: [threadId],
    });
    expect(sent.status).toBe(201);
    dispatchCreationSchema.parse(await sent.json());
  }
});
