/**
 * Live MCP host qualification for tool-result nudges (MCP-021, ADR 0041).
 *
 * Starts a real Artifact Server on a temporary data directory, queues one
 * review bundle for the API key's mailbox agent, then asks each installed
 * host CLI (Claude Code, Codex) to make one ordinary tool call over /mcp.
 * The verdict comes from the host's own transcript of the tool result its
 * model received, not from what the model says about it.
 *
 * It needs the host CLIs on PATH, signed in, and network access to their
 * model providers, so it is deliberately not part of pnpm verify:iteration.
 *
 *   pnpm exec tsx scripts/qualify-mcp-host-nudge.ts <evidence.json>
 */

import {execFile, spawn} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {z} from "zod";

import {ApiClient, dispatchCreationSchema} from "../tests/support/agent-dispatch.js";
import {publishNew} from "../tests/support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../tests/support/runtime-harness.js";

const executeFile = promisify(execFile);
const nudgeHeading = "— artifact server —";
const hostTimeoutMilliseconds = 300_000;
const agentName = "Qualified host";

const threadCreationSchema = z.object({thread: z.object({id: z.string()}).loose()}).loose();
const inboxAnswerSchema = z.object({
  agent: z.object({id: z.string().startsWith("agt_")}).loose(),
}).loose();
const claudeLineSchema = z.object({
  message: z.object({content: z.unknown()}).loose().optional(),
  result: z.string().optional(),
  type: z.string(),
}).loose();
const claudeToolResultSchema = z.object({
  content: z.unknown(),
  type: z.literal("tool_result"),
}).loose();
const codexLineSchema = z.object({
  item: z.object({
    result: z.unknown().optional(),
    text: z.string().optional(),
    tool: z.string().optional(),
    type: z.string(),
  }).loose().optional(),
  type: z.string(),
}).loose();

interface HostOutcome {
  /** Whether the model's final answer repeated the queued-work instruction. */
  readonly answerRepeatsNudge: boolean;
  readonly host: string;
  readonly nudgeSeenByModel: boolean;
  readonly toolResultSeenByModel: string;
  readonly version: string;
}

await main();

async function main(): Promise<void> {
  const evidencePath = process.argv[2];
  if (evidencePath === undefined) {
    throw new Error("Usage: tsx scripts/qualify-mcp-host-nudge.ts <evidence.json>");
  }
  const installation = await createTestInstallation();
  const server = await startTestServer(installation);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "artifact-server-host-nudge-"));
  try {
    const {artifactId, projectId} = await queueOneBundle(server, installation);
    const prompt =
      `Call the artifact server tool artifact_version_list with artifactId ${artifactId} ` +
      `and projectId ${projectId}, then tell me how many versions the artifact has. ` +
      "Do not call any other tool. After the count, repeat any instruction the tool result gave you, word for word, or say there was none.";
    const outcomes = [
      await runClaudeCode(server.baseUrl, installation.apiToken, prompt, workspace),
      await runCodex(server.baseUrl, installation.apiToken, prompt, workspace),
    ];
    const evidence = {
      outcomes,
      passed: outcomes.every((outcome) => outcome.nudgeSeenByModel),
      recordedAt: new Date().toISOString(),
      requirement: "MCP-021",
    };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    for (const outcome of outcomes) {
      process.stdout.write(`${outcome.host} ${outcome.version}: nudge seen by model = ${String(outcome.nudgeSeenByModel)}\n`);
    }
    if (!evidence.passed) process.exitCode = 1;
  } finally {
    await rm(workspace, {force: true, recursive: true});
    await server.stop();
    await removeTestInstallation(installation);
  }
}

async function queueOneBundle(
  server: RunningTestServer,
  installation: TestInstallation,
): Promise<{readonly artifactId: string; readonly projectId: string}> {
  const {apiToken} = installation;
  const {baseUrl} = server;
  const published = (await publishNew(server, installation, {
    accessSetting: "account_required",
    content: "<!doctype html><title>Host nudge</title>",
    idempotencyKey: "mcp-021-publish-artifact",
    name: "Host nudge report",
  })).body;
  const projectId = published.artifact.projectId;
  const client = new ApiClient(server, apiToken);
  const thread = await client.fetch(
    `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}` +
      `/comments?projectId=${projectId}`,
    {
      body: JSON.stringify({body: "Shorten the title.", path: "index.html"}),
      idempotencyKey: "mcp-021-thread-title",
      method: "POST",
    },
  );
  if (thread.status !== 201) throw new Error(`Thread creation returned ${thread.status}.`);
  const threadId = threadCreationSchema.parse(await thread.json()).thread.id;
  const registrar = new Client(
    {name: "mcp-021-registrar", version: "1"},
    {versionNegotiation: {mode: "legacy"}},
  );
  await registrar.connect(new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    {authProvider: {token: async () => apiToken}},
  ));
  const registration = await registrar.callTool({
    arguments: {agentName, operation: "list"},
    name: "dispatch_inbox",
  });
  await registrar.close();
  const agentId = inboxAnswerSchema.parse(registration.structuredContent).agent.id;
  const sent = await client.sendDispatch({
    agentId,
    idempotencyKey: "mcp-021-dispatch-title",
    projectId,
    threadIds: [threadId],
  });
  if (sent.status !== 201) throw new Error(`Dispatch creation returned ${sent.status}.`);
  dispatchCreationSchema.parse(await sent.json());
  return {artifactId: published.artifact.id, projectId};
}

async function runClaudeCode(
  baseUrl: string,
  apiToken: string,
  prompt: string,
  workspace: string,
): Promise<HostOutcome> {
  const configPath = path.join(workspace, "claude-mcp.json");
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      artifact: {
        headers: {Authorization: `Bearer ${apiToken}`},
        type: "http",
        url: `${baseUrl}/mcp`,
      },
    },
  }));
  const version = (await executeFile("claude", ["--version"])).stdout.trim();
  const stdout = await runHost("claude", [
    "-p",
    "--strict-mcp-config",
    "--mcp-config", configPath,
    "--allowedTools", "mcp__artifact__artifact_version_list",
    "--output-format", "stream-json",
    "--verbose",
    "--",
    prompt,
  ], {cwd: workspace, env: process.env});
  const seen: string[] = [];
  let answer = "";
  for (const line of stdout.split("\n").filter((text) => text.trim() !== "")) {
    const event = claudeLineSchema.parse(JSON.parse(line));
    if (event.type === "result" && event.result !== undefined) answer = event.result;
    const blocks = event.message?.content;
    if (event.type !== "user" || !Array.isArray(blocks)) continue;
    for (const block of blocks) {
      const toolResult = claudeToolResultSchema.safeParse(block);
      if (toolResult.success) seen.push(JSON.stringify(toolResult.data.content));
    }
  }
  const toolResultSeenByModel = seen.find((text) => text.includes("versions")) ?? seen.join("\n");
  return {
    answerRepeatsNudge: answer.includes("dispatch_inbox"),
    host: "claude-code",
    nudgeSeenByModel: toolResultSeenByModel.includes(nudgeHeading),
    toolResultSeenByModel,
    version,
  };
}

async function runCodex(
  baseUrl: string,
  apiToken: string,
  prompt: string,
  workspace: string,
): Promise<HostOutcome> {
  const version = (await executeFile("codex", ["--version"])).stdout.trim();
  const stdout = await runHost("codex", [
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--sandbox", "read-only",
    "-c", `mcp_servers.artifact.url="${baseUrl}/mcp"`,
    "-c", 'mcp_servers.artifact.bearer_token_env_var="ARTIFACT_SERVER_QUALIFICATION_TOKEN"',
    "-c", 'mcp_servers.artifact.default_tools_approval_mode="approve"',
    prompt,
  ], {
    cwd: workspace,
    env: {...process.env, ARTIFACT_SERVER_QUALIFICATION_TOKEN: apiToken},
  });
  let toolResultSeenByModel = "";
  let answer = "";
  for (const line of stdout.split("\n").filter((text) => text.trim().startsWith("{"))) {
    const event = codexLineSchema.parse(JSON.parse(line));
    if (event.type !== "item.completed" || event.item === undefined) continue;
    if (event.item.type === "mcp_tool_call" && event.item.tool === "artifact_version_list") {
      toolResultSeenByModel = JSON.stringify(event.item.result);
    }
    if (event.item.type === "agent_message" && event.item.text !== undefined) answer = event.item.text;
  }
  return {
    answerRepeatsNudge: answer.includes("dispatch_inbox"),
    host: "codex",
    nudgeSeenByModel: toolResultSeenByModel.includes(nudgeHeading),
    toolResultSeenByModel,
    version,
  };
}

/**
 * Run one host CLI with stdin closed (both hosts otherwise wait for piped
 * input) and return its stdout, failing on a non-zero exit or the timeout.
 */
function runHost(
  command: string,
  args: readonly string[],
  options: {readonly cwd: string; readonly env: NodeJS.ProcessEnv},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: hostTimeoutMilliseconds,
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(output).toString("utf8"));
      else reject(new Error(`${command} exited with ${String(code)}: ${Buffer.concat(errors).toString("utf8").slice(-2_000)}`));
    });
  });
}
