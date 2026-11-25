import {expect, test, type Locator} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {
  type BrowserFixture,
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const personalKeyLead = "Issue a personal API key in Settings → Personal API keys";
const oauthLead = "The client should open browser sign-in when it connects.";

/** Publish one artifact, open it in Review, and open its Share dialog. */
async function openShare(fixture: BrowserFixture, idempotencyKey: string): Promise<Locator> {
  const published = await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: "<!doctype html><html lang=\"en\"><title>Plan</title><main><h1>Plan</h1></main></html>",
    idempotencyKey,
    name: "Rollout plan",
  });
  await fixture.page.goto(`${fixture.server.baseUrl}/review?${new URLSearchParams({
    artifact: published.body.artifact.id,
    project: published.body.artifact.projectId,
    version: published.body.version.id,
  })}`);
  await fixture.page.locator(".as-preview-header__actions")
    .getByRole("button", {exact: true, name: "Share"}).click();
  return fixture.page.locator(".as-share-popover[data-open]");
}

async function copiedReviewPrompt(
  fixture: BrowserFixture,
  share: Locator,
): Promise<string> {
  await share.getByRole("button", {name: "Copy review prompt"}).click();
  await expect(share.getByRole("button", {name: "Prompt copied"})).toBeVisible();
  return fixture.page.evaluate(() => navigator.clipboard.readText());
}

test.describe("Agent setup texts follow the installation's credentials and skill", () => {
  test("MCP-022-B: with personal keys enabled, Settings → MCP and the review prompt lead with a personal API key", async ({browser, browserName}) => {
    const fixture = await startBrowserFixture(browser, {
      personalApiKeyPolicy: {maxLifetimeDays: 30},
    });
    const canInspectClipboard = browserName === "chromium";
    try {
      if (canInspectClipboard) {
        await fixture.context.grantPermissions(
          ["clipboard-read", "clipboard-write"],
          {origin: fixture.server.baseUrl},
        );
      }
      await localLogin(fixture);

      await fixture.page.goto(`${fixture.server.baseUrl}/review/settings/mcp`);
      const remote = fixture.page.locator("section").filter({
        has: fixture.page.getByRole("heading", {name: "Connect with the server address"}),
      });
      await expect(remote).toContainText(personalKeyLead);
      await expect(remote).toContainText("Browser sign-in is an alternative");
      await expect(remote).not.toContainText(oauthLead);
      await expect(remote).not.toContainText("ask an administrator");
      await expect(remote.getByRole("link", {name: "Personal API keys"})).toBeVisible();

      const share = await openShare(fixture, "mcp-022-personal-keys");
      if (canInspectClipboard) {
        const prompt = await copiedReviewPrompt(fixture, share);
        const remoteLine = prompt.split("\n").find((line) => line.startsWith("- Remote or team setup:"));
        expect(remoteLine).toContain("issue a personal API key in Settings → Personal API keys");
        expect(remoteLine).toContain(`${fixture.server.baseUrl}/review/settings/personal-api-keys`);
        expect(remoteLine).toContain(`${fixture.server.baseUrl}/mcp`);
        // Browser sign-in follows the key as the alternative, never leads.
        expect(remoteLine?.indexOf("personal API key")).toBeLessThan(
          remoteLine?.indexOf("Browser sign-in") ?? -1,
        );
        expect(prompt).toContain("with an admitted session or personal API key");
        expect(prompt).not.toContain("administrator-issued");
      }

      await share.getByRole("button", {name: "Connect MCP"}).click();
      const setup = share.locator(".as-share-agent-setup");
      await expect(setup.locator("section").filter({hasText: "Team or remote server"}))
        .toContainText(personalKeyLead);
      await expect(setup.locator("section").filter({hasText: "Without MCP"}))
        .toContainText("Use a personal API key from Settings → Personal API keys");
      await expect(setup).not.toContainText("administrator");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("MCP-022-F: without personal keys, the texts keep browser sign-in and administrator-issued keys and never offer a personal key", async ({browser, browserName}) => {
    const fixture = await startBrowserFixture(browser);
    const canInspectClipboard = browserName === "chromium";
    try {
      if (canInspectClipboard) {
        await fixture.context.grantPermissions(
          ["clipboard-read", "clipboard-write"],
          {origin: fixture.server.baseUrl},
        );
      }
      await localLogin(fixture);

      await fixture.page.goto(`${fixture.server.baseUrl}/review/settings/mcp`);
      const remote = fixture.page.locator("section").filter({
        has: fixture.page.getByRole("heading", {name: "Connect with the server address"}),
      });
      await expect(remote).toContainText(oauthLead);
      await expect(remote).toContainText("ask an administrator for a scoped API key");
      await expect(remote).not.toContainText("personal API key");

      const share = await openShare(fixture, "mcp-022-administrator-keys");
      if (canInspectClipboard) {
        const prompt = await copiedReviewPrompt(fixture, share);
        expect(prompt).toContain("complete browser sign-in, or use an administrator-issued scoped key");
        expect(prompt).not.toContain("personal API key");
        expect(prompt).not.toContain("/review/settings/personal-api-keys");
      }

      await share.getByRole("button", {name: "Connect MCP"}).click();
      const setup = share.locator(".as-share-agent-setup");
      await expect(setup).toContainText("administrator-issued scoped key");
      await expect(setup).toContainText("Use a scoped API key from an administrator");
      await expect(setup).not.toContainText("personal API key");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("SKL-007-B: Settings → MCP offers the installation's own agent skill, and the upstream skill by default", async ({browser, browserName}) => {
    const named = await startBrowserFixture(browser, {agentSkillSource: "example/agent-skill"});
    try {
      if (browserName === "chromium") {
        await named.context.grantPermissions(
          ["clipboard-read", "clipboard-write"],
          {origin: named.server.baseUrl},
        );
      }
      await localLogin(named);
      await named.page.goto(`${named.server.baseUrl}/review/settings/mcp`);
      const skill = named.page.locator("section").filter({
        has: named.page.getByRole("heading", {name: "Give agents the Artifact Server skill"}),
      });
      await expect(skill.locator("code")).toHaveText("npx skills add example/agent-skill");
      await expect(skill).not.toContainText("plannotator/artifact-server");
      if (browserName === "chromium") {
        await skill.getByRole("button", {name: "Copy skill installation command"}).click();
        expect(await named.page.evaluate(() => navigator.clipboard.readText()))
          .toBe("npx skills add example/agent-skill");
      }
    } finally {
      await stopBrowserFixture(named);
    }

    const upstream = await startBrowserFixture(browser);
    try {
      await localLogin(upstream);
      await upstream.page.goto(`${upstream.server.baseUrl}/review/settings/mcp`);
      await expect(upstream.page.locator("section").filter({
        has: upstream.page.getByRole("heading", {name: "Give agents the Artifact Server skill"}),
      }).locator("code")).toHaveText("npx skills add plannotator/artifact-server");
    } finally {
      await stopBrowserFixture(upstream);
    }
  });
});
