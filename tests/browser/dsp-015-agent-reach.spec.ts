import {expect, test} from "@playwright/test";

import {
  ApiClient,
  issueApiKey,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";

const fixtureHtml = "<!doctype html><html lang=\"en\"><head><title>Reach fixture</title></head>"
  + "<body><main><p id=\"target\">Review target</p></main></body></html>";

test.describe("Review agent reach", () => {
  test("DSP-015-B: Review offers only the agents whose owner can read the artifact under review", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const shared = await publishWithThread(fixture, "Shared page");
      const restricted = await publishWithThread(fixture, "Owner-only page");
      const administrator = await signInAdministrator(fixture.server, fixture.installation);
      // A service key's agent never reads a restricted artifact.
      const token = await issueApiKey(fixture.server, administrator, ["agent:connect"], "bot key");
      await new ApiClient(fixture.server, token).registerAgent({
        connectionKey: "reach-bot",
        displayName: "bot",
        workingDirectory: "/work/bot",
      });
      const restriction = await fetch(
        `${fixture.server.baseUrl}/api/v1/artifacts/${restricted.artifact.id}/access`,
        {
          body: JSON.stringify({
            accessSetting: "restricted",
            expectedCurrentVersionId: restricted.version.id,
          }),
          headers: {
            "Content-Type": "application/json",
            Cookie: administrator.header,
            "Idempotency-Key": crypto.randomUUID(),
            Origin: fixture.server.baseUrl,
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "X-CSRF-Token": administrator.csrf,
          },
          method: "PATCH",
        },
      );
      expect(restriction.status).toBe(200);

      await localLogin(fixture);
      const page = fixture.page;
      await openComments(fixture, shared);
      await expect(page.getByRole("button", {name: "Send all open (1) to bot"}))
        .toBeEnabled({timeout: 20_000});

      await openComments(fixture, restricted);
      await expect(page.getByText("No agent connected — connect one to send."))
        .toBeVisible({timeout: 20_000});
      await expect(page.getByText("No agents connected")).toBeVisible();
      await expect(page.getByRole("button", {name: "Send all open (1) to bot"}))
        .toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

async function publishWithThread(
  fixture: BrowserFixture,
  name: string,
): Promise<PublishResponse> {
  const published = (await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: fixtureHtml,
    idempotencyKey: `reach-browser-${name}`,
    mediaType: "text/html; charset=utf-8",
    name,
    path: "index.html",
  })).body;
  await createThreadOverApi(fixture, {
    artifactId: published.artifact.id,
    body: `Comment on ${name}`,
    idempotencyKey: `reach-browser-thread-${name}`,
    path: "index.html",
    versionId: published.version.id,
  });
  return published;
}

async function openComments(
  fixture: BrowserFixture,
  published: PublishResponse,
): Promise<void> {
  await fixture.page.goto(
    `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.artifact.id}&version=${published.version.id}`,
  );
  await fixture.page.getByRole("tab", {name: "Comments"}).click();
}
