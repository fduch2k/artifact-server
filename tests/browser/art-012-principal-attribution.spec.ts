import {expect, test, type Page} from "@playwright/test";
import {z} from "zod";

import {publishNew, type PublishResponse} from "../support/publishing.js";
import type {RunningTestServer, TestInstallation} from "../support/runtime-harness.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const admittedSchema = z.object({member: z.object({id: z.string()})});
const issuedKeySchema = z.object({token: z.string()});
const weekMilliseconds = 7 * 24 * 60 * 60 * 1_000;

test.describe("Review shows who owns an artifact and who published a version", () => {
  test("ART-012-B: Details names the member who owns and published an artifact, the label for a service key, and the member behind a key's comment", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const ben = (await sessionPost(fixture.page, "/api/v1/members", {
        displayName: "Ben Okafor",
        email: "ben@example.test",
        role: "member",
      }, admittedSchema)).member.id;
      const benToken = await issueKey(fixture.page, "laptop", ben);
      const serviceToken = await issueKey(fixture.page, "Nightly report", null);

      const benDraft = await publish(fixture.server, fixture.installation, benToken, "Ben's draft");
      const nightly = await publish(fixture.server, fixture.installation, serviceToken, "Nightly");
      const comment = await fetch(
        `${fixture.server.baseUrl}/api/v1/artifacts/${benDraft.artifact.id}` +
          `/versions/${benDraft.version.id}/comments?projectId=${benDraft.artifact.projectId}`,
        {
          body: JSON.stringify({body: "Check the totals."}),
          headers: {
            Authorization: `Bearer ${benToken}`,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          method: "POST",
        },
      );
      expect(comment.status).toBe(201);

      // A member-owned artifact: the owner and publisher by name, email on hover.
      await openReview(fixture.page, fixture.server, benDraft);
      await fixture.page.getByRole("tab", {name: "Details"}).click();
      const ownerRow = fixture.page.locator(".as-inspector-row").filter({hasText: "owner"});
      await expect(ownerRow.locator("dd")).toHaveText("Ben Okafor");
      await expect(ownerRow.locator("dd")).toHaveAttribute("title", "ben@example.test");
      const publisherRow = fixture.page.locator(".as-inspector-row")
        .filter({hasText: "published by"});
      await expect(publisherRow.locator("dd")).toHaveText("Ben Okafor");
      await expect(publisherRow.locator("dd")).toHaveAttribute("title", "ben@example.test");

      // The comment Ben's key wrote names Ben, with the key as a qualifier.
      await fixture.page.getByRole("tab", {name: /Comments/u}).click();
      const conversation = fixture.page.getByRole("article").filter({hasText: "Check the totals."});
      await expect(conversation.getByText("Ben Okafor · laptop", {exact: true})).toBeVisible();

      // A service-key-owned artifact reads as a label, never as a raw id.
      await openReview(fixture.page, fixture.server, nightly);
      await fixture.page.getByRole("tab", {name: "Details"}).click();
      const serviceOwner = fixture.page.locator(".as-inspector-row").filter({hasText: "owner"});
      await expect(serviceOwner.locator("dd")).toHaveText("Service key · Nightly report");
      await expect(fixture.page.locator(".as-inspector-row")
        .filter({hasText: "published by"}).locator("dd"))
        .toHaveText("Service key · Nightly report");
      await expect(fixture.page.locator(".as-inspector-stack")).not.toContainText("service:");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ART-012-F: Details says \"you\" for the viewer's own artifact and labels the local API token", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      const own = await publish(
        fixture.server,
        fixture.installation,
        await issueKey(fixture.page, "desk", await sessionPrincipalId(fixture.page)),
        "My notes",
      );
      const local = await publish(
        fixture.server,
        fixture.installation,
        fixture.installation.apiToken,
        "Local notes",
      );

      await openReview(fixture.page, fixture.server, own);
      await fixture.page.getByRole("tab", {name: "Details"}).click();
      await expect(fixture.page.locator(".as-inspector-row").filter({hasText: "owner"})
        .locator("dd")).toHaveText("you");

      await openReview(fixture.page, fixture.server, local);
      await fixture.page.getByRole("tab", {name: "Details"}).click();
      await expect(fixture.page.locator(".as-inspector-row").filter({hasText: "owner"})
        .locator("dd")).toHaveText("Local API token");
      await expect(fixture.page.locator(".as-inspector-stack")).not.toContainText("local-api-token");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

async function openReview(
  page: Page,
  server: RunningTestServer,
  published: PublishResponse,
): Promise<void> {
  await page.goto(`${server.baseUrl}/review?${new URLSearchParams({
    artifact: published.artifact.id,
    project: published.artifact.projectId,
    version: published.version.id,
  })}`);
}

async function publish(
  server: RunningTestServer,
  installation: TestInstallation,
  token: string,
  name: string,
): Promise<PublishResponse> {
  const published = await publishNew(server, {...installation, apiToken: token}, {
    accessSetting: "account_required",
    content: `<!doctype html><html lang="en"><title>${name}</title><main><h1>${name}</h1></main></html>`,
    idempotencyKey: `attribution-browser-${crypto.randomUUID()}`,
    name,
  });
  expect(published.response.status).toBe(201);
  return published.body;
}

/** Issue a key from the signed-in administrator's session, bound to a member or to none. */
async function issueKey(page: Page, name: string, memberId: string | null): Promise<string> {
  const capabilities = ["artifact:create", "artifact:read", "comment:write"];
  const expiresAt = new Date(Date.now() + weekMilliseconds).toISOString();
  const body = memberId === null
    ? {capabilities, expiresAt, name}
    : {capabilities, expiresAt, memberId, name};
  return (await sessionPost(page, "/api/v1/api-keys", body, issuedKeySchema)).token;
}

async function sessionPrincipalId(page: Page): Promise<string> {
  return z.object({principal: z.object({id: z.string()})}).parse(await page.evaluate(
    async () => (await fetch("/api/v1/session", {credentials: "same-origin"})).json(),
  )).principal.id;
}

/** Request bodies sent by these tests: strings and string lists only. */
type RequestBody = Readonly<Record<string, string | readonly string[]>>;

/** POST from the signed-in page with its CSRF token, and parse the answer. */
async function sessionPost<Answer>(
  page: Page,
  requestPath: string,
  body: RequestBody,
  schema: z.ZodType<Answer>,
): Promise<Answer> {
  return schema.parse(await page.evaluate(async ({body: payload, requestPath: target}) => {
    const csrf = document.cookie.split(";")
      .map((cookie) => cookie.trim().split("="))
      .find(([name]) => name === "artifact_csrf" || name === "__Host-artifact_csrf")
      ?.slice(1).join("=") ?? "";
    const response = await fetch(target, {
      body: JSON.stringify(payload),
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-CSRF-Token": decodeURIComponent(csrf),
      },
      method: "POST",
    });
    return response.json();
  }, {body, requestPath}));
}
