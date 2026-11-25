import {expect, test, type Page} from "@playwright/test";

import {
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
  issueApiKey,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";
import {createReplyOverApi, createThreadOverApi} from "./comment-api.js";

const fixtureHtml = "<!doctype html><html lang=\"en\"><head><title>Thread views fixture</title></head>"
  + "<body><main><p id=\"target\">Review target</p></main></body></html>";

async function publishFixture(fixture: BrowserFixture, key: string) {
  return (await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: fixtureHtml,
    idempotencyKey: `${key}-thread-views-publish`,
    mediaType: "text/html; charset=utf-8",
    name: `Thread views ${key}`,
    path: "index.html",
  })).body;
}

async function connectMailboxAgent(
  fixture: BrowserFixture,
  name: string,
): Promise<{readonly agentId: string; readonly client: ApiClient}> {
  const cookies = await signInAdministrator(fixture.server, fixture.installation);
  const token = await issueApiKey(fixture.server, cookies, ["agent:connect"], `${name} key`);
  const client = new ApiClient(fixture.server, token);
  const agent = await client.registerAgent({
    agentSessionId: `session-${name}`,
    capabilities: {beacon: false, evidence: "mailbox"},
    connectionKey: `${name}-connection`,
    displayName: name,
    workingDirectory: `/work/${name}`,
  });
  return {agentId: agent.id, client};
}

async function openComments(
  fixture: BrowserFixture,
  artifactId: string,
  versionId: string,
): Promise<Page> {
  await localLogin(fixture);
  const page = fixture.page;
  await page.goto(
    `${fixture.server.baseUrl}/review?project=prj_default&artifact=${artifactId}&version=${versionId}`,
  );
  await page.getByRole("tab", {name: "Comments"}).click();
  return page;
}

function filter(page: Page, name: string) {
  return page.getByRole("navigation", {name: "Comment filters"})
    .getByRole("button", {name});
}

const cards = (page: Page) => page.locator(".as-comment-card");

test.describe("Review thread views", () => {
  test("CMT-025-B CMT-025-F: Resolved and All keep threads an agent addressed, and the count matches All", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishFixture(fixture, "cmt-025");
      const threads = await Promise.all(["one", "two", "three", "four"].map((word) =>
        createThreadOverApi(fixture, {
          anchor: null,
          artifactId: published.artifact.id,
          body: `Thread ${word}`,
          idempotencyKey: `cmt-025-thread-${word}`,
          path: "index.html",
          versionId: published.version.id,
        })
      ));
      const addressedThreads = threads.slice(0, 3);
      const neverSent = threads[3];
      if (neverSent === undefined) throw new Error("The unsent thread is missing.");

      // The mailbox flow from the report: send, claim, deliver, reply, resolve.
      const agent = await connectMailboxAgent(fixture, "mailbox");
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const sent = await owner.sendDispatch({
        agentId: agent.agentId,
        idempotencyKey: "cmt-025-dispatch-send",
        projectId: "prj_default",
        threadIds: addressedThreads.map((thread) => thread.id),
      });
      expect(sent.status).toBe(201);
      const dispatchId = dispatchCreationSchema.parse(await sent.json()).dispatch.id;
      expect((await agent.client.claim(agent.agentId)).status).toBe(200);
      expect((await agent.client.reportDelivered(dispatchId, agent.agentId)).status).toBe(200);
      await Promise.all(addressedThreads.map(async (thread) => {
        await createReplyOverApi(fixture, {
          artifactId: published.artifact.id,
          body: `Fixed: ${thread.body}`,
          idempotencyKey: `cmt-025-reply-${thread.id}`,
          threadId: thread.id,
        });
        expect((await owner.setThreadState(published, thread.id, "resolved")).status)
          .toBe(200);
      }));
      const dispatch = dispatchEnvelopeSchema.parse(
        await (await owner.getDispatch(dispatchId, "prj_default")).json(),
      ).dispatch;
      expect(dispatch.state).toBe("addressed");

      // The API default stays as DSP-008 and DSP-009 specify for agents.
      expect(await owner.listThreadIds(published)).toEqual([neverSent.id]);

      const page = await openComments(fixture, published.artifact.id, published.version.id);
      await expect(page.locator(".as-artifact-card[aria-current='true']"))
        .toContainText("4 comments");

      await expect(cards(page)).toHaveCount(1);
      await expect(cards(page)).toContainText("Thread four");

      await filter(page, "Resolved").click();
      await expect(cards(page)).toHaveCount(3);
      await Promise.all(addressedThreads.map(async (thread) => {
        const card = cards(page).filter({hasText: thread.body});
        await expect(card).toContainText(`Fixed: ${thread.body}`);
        await expect(card.locator("header [data-state]")).toHaveText("resolved");
      }));

      await filter(page, "All").click();
      await expect(cards(page)).toHaveCount(4);

      await filter(page, "Sent (3)").click();
      await expect(cards(page)).toHaveCount(3);
      await expect(page.getByText("Addressed", {exact: true})).toHaveCount(3);

      // Reopening an addressed thread hands it back to the reviewer (DSP-009-F):
      // it is open, sendable, and drawn once, never twice.
      await filter(page, "Resolved").click();
      const reopened = addressedThreads[0];
      if (reopened === undefined) throw new Error("The reopened thread is missing.");
      await cards(page).filter({hasText: reopened.body})
        .getByRole("button", {name: "Reopen"}).click();
      await expect(cards(page)).toHaveCount(2);
      await filter(page, "Open").click();
      await expect(cards(page)).toHaveCount(2);
      await expect(page.getByRole("button", {name: "Send all open (2) to mailbox"}))
        .toBeVisible();
      await filter(page, "All").click();
      await expect(cards(page)).toHaveCount(4);
      await expect(page.locator(".as-artifact-card[aria-current='true']"))
        .toContainText("4 comments");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-026-B CMT-026-F: an empty Open view points to threads sent to agents instead of calling them resolved", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishFixture(fixture, "cmt-026");
      const threads = await Promise.all(["one", "two", "three", "four"].map((word) =>
        createThreadOverApi(fixture, {
          anchor: null,
          artifactId: published.artifact.id,
          body: `Thread ${word}`,
          idempotencyKey: `cmt-026-thread-${word}`,
          path: "index.html",
          versionId: published.version.id,
        })
      ));
      const resolved = threads[3];
      if (resolved === undefined) throw new Error("The resolved thread is missing.");
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      expect((await owner.setThreadState(published, resolved.id, "resolved")).status)
        .toBe(200);
      await connectMailboxAgent(fixture, "builder");

      const page = await openComments(fixture, published.artifact.id, published.version.id);
      await page.getByRole("button", {name: "Send all open (3) to builder"}).click();
      await expect(page.getByText(/^Queued for builder/u)).toBeVisible();
      await expect(cards(page)).toHaveCount(0);
      const empty = page.locator(".as-comments > .as-inspector-empty");
      await expect(empty).toHaveText("Nothing open. 3 sent to agents — see Sent.");
      await expect(page.getByText("All comments on this version are resolved."))
        .toHaveCount(0);

      // Queued threads stay off the page and out of the next send, yet All lists them.
      const preview = page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      await expect(preview.locator("button[data-plannotator-marker]")).toHaveCount(0);
      await expect(page.getByRole("button", {name: "Send all open (0) to builder"}))
        .toBeDisabled();
      await filter(page, "All").click();
      await expect(cards(page)).toHaveCount(4);
      await Promise.all(threads.slice(0, 3).map((thread) =>
        expect(cards(page).filter({hasText: thread.body}).getByRole("button", {
          name: /^Send/u,
        })).toHaveCount(0)
      ));

      await filter(page, "Open").click();
      await empty.getByRole("button", {name: "see Sent"}).click();
      await expect(filter(page, "Sent (3)")).toHaveAttribute("aria-pressed", "true");
      await expect(cards(page)).toHaveCount(3);

      // With nothing sent and everything resolved, the old wording still holds.
      await filter(page, "Open").click();
      await expect(empty).toContainText("Nothing open. 3 sent to agents");
      const resolutions = await Promise.all(threads.slice(0, 3).map((thread) =>
        owner.setThreadState(published, thread.id, "resolved")
      ));
      expect(resolutions.map((response) => response.status)).toEqual([200, 200, 200]);
      await page.getByRole("button", {name: "Reload"}).click();
      await expect(empty).toHaveText("All comments on this version are resolved.");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

});
