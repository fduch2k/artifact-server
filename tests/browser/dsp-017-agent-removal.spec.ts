import {expect, test} from "@playwright/test";

import {
  ApiClient,
  issueApiKey,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";

const fixtureHtml = "<!doctype html><html lang=\"en\"><head><title>Removal fixture</title></head>"
  + "<body><main><p>Removal target</p></main></body></html>";

test.describe("Review agent removal", () => {
  test("DSP-017-B: an administrator removes an idle agent from Settings, and an agent holding a send stays with the reason shown", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const administrator = await signInAdministrator(fixture.server, fixture.installation);
      const token = await issueApiKey(
        fixture.server,
        administrator,
        ["agent:connect", "agent:dispatch", "artifact:read"],
        "agent key",
      );
      const client = new ApiClient(fixture.server, token);
      await client.registerAgent({
        connectionKey: "removal-probe",
        displayName: "probe",
        workingDirectory: "/work/probe",
      });
      const busy = await client.registerAgent({
        connectionKey: "removal-busy",
        displayName: "busy",
        workingDirectory: "/work/busy",
      });
      const published = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: fixtureHtml,
        idempotencyKey: "removal-browser-publish",
        mediaType: "text/html; charset=utf-8",
        name: "Removal page",
        path: "index.html",
      })).body;
      const thread = await createThreadOverApi(fixture, {
        artifactId: published.artifact.id,
        body: "Keep the busy agent busy.",
        idempotencyKey: "removal-browser-thread",
        path: "index.html",
        versionId: published.version.id,
      });
      const sent = await client.sendDispatch({
        agentId: busy.id,
        idempotencyKey: "removal-browser-send",
        projectId: published.artifact.projectId,
        threadIds: [thread.id],
      });
      expect(sent.status).toBe(201);

      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(`${fixture.server.baseUrl}/review/settings/agents`);
      const list = page.getByRole("list", {name: "Registered agents"});
      await expect(list.getByRole("listitem")).toHaveCount(2, {timeout: 20_000});

      await page.getByRole("button", {name: "Remove probe"}).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("probe leaves every send picker now.")).toBeVisible();
      await dialog.getByRole("button", {name: "Remove agent"}).click();
      await expect(dialog).toHaveCount(0);
      await expect(list.getByRole("listitem")).toHaveCount(1);
      await expect(list.getByRole("listitem", {name: "busy"})).toBeVisible();

      await page.getByRole("button", {name: "Remove busy"}).click();
      await dialog.getByRole("button", {name: "Remove agent"}).click();
      await expect(dialog.getByRole("alert"))
        .toContainText("busy still holds a queued, claimed, or delivered dispatch");
      await page.keyboard.press("Escape");
      await expect(list.getByRole("listitem", {name: "busy"})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
