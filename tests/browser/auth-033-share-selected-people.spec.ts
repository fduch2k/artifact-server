import {AxeBuilder} from "@axe-core/playwright";
import {expect, test} from "@playwright/test";
import {z} from "zod";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const artifactSchema = z.object({
  artifact: z.object({
    accessSetting: z.enum(["account_required", "public_link", "restricted"]),
    grantedPrincipalIds: z.array(z.string()),
  }),
});
const admittedSchema = z.object({member: z.object({id: z.string()})});

test.describe("Review sharing with selected people", () => {
  test("AUTH-033-B: Review shares a restricted artifact with chosen members and takes it back to only the owner", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><title>Metrics</title><main><h1>Metrics</h1></main></html>",
        idempotencyKey: "frontend-share-selected-people",
        name: "Quarter metrics",
      });
      const artifactId = published.body.artifact.id;
      const projectId = published.body.artifact.projectId;
      await localLogin(fixture);

      // The local owner admits two colleagues; only people who have a member
      // record can be chosen.
      const admit = async (displayName: string, email: string): Promise<string> => {
        const body = await fixture.page.evaluate(async (member) => {
          const csrf = document.cookie.split(";")
            .map((cookie) => cookie.trim().split("="))
            .find(([name]) => name === "artifact_csrf" || name === "__Host-artifact_csrf")
            ?.slice(1).join("=") ?? "";
          const response = await fetch("/api/v1/members", {
            body: JSON.stringify(member),
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": decodeURIComponent(csrf),
            },
            method: "POST",
          });
          return response.json();
        }, {displayName, email});
        return admittedSchema.parse(body).member.id;
      };
      const ben = await admit("Ben Okafor", "ben@example.test");
      await admit("Carla Diaz", "carla@example.test");

      // The installation's API token is a service principal, which never sees
      // a restricted artifact, so the owner's own session reads it back.
      const readArtifact = async () => artifactSchema.parse(await fixture.page.evaluate(
        async (artifactPath) => (await fetch(artifactPath, {credentials: "same-origin"})).json(),
        `/api/v1/artifacts/${artifactId}?projectId=${projectId}`,
      )).artifact;

      await fixture.page.goto(`${fixture.server.baseUrl}/review?${new URLSearchParams({
        artifact: artifactId,
        project: projectId,
        version: published.body.version.id,
      })}`);
      const headerShare = fixture.page.locator(".as-preview-header__actions")
        .getByRole("button", {exact: true, name: "Share"});
      await headerShare.click();
      const share = fixture.page.locator(".as-share-popover[data-open]");
      await share.getByRole("button", {name: "Manage access"}).click();
      await share.getByRole("radio", {name: /Selected people/u}).check();

      // Nobody chosen yet: saving would mean "Only me", so it waits for a person.
      await expect(share.getByText("Add at least one person.", {exact: true})).toBeVisible();
      await expect(share.getByRole("button", {name: "Save"})).toBeDisabled();
      const search = share.getByRole("searchbox", {name: "Add people by name or email"});
      await search.fill("nobody-matches");
      await expect(share.getByText("No signed-in member matches.", {exact: true})).toBeVisible();
      await search.fill("ben");
      await share.getByRole("list", {name: "Matching members"})
        .getByRole("button", {name: /Ben Okafor/u}).click();
      await expect(share.getByRole("list", {name: "People who can open this artifact"}))
        .toContainText("ben@example.test");
      const pickerAccessibility = await new AxeBuilder({page: fixture.page})
        .exclude(".as-artifact-frame")
        .exclude("[data-base-ui-focus-guard]")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(pickerAccessibility.violations).toEqual([]);
      await share.getByRole("button", {name: "Save"}).click();

      await expect(share.getByText(
        "Only you, 1 person you chose, and installation administrators can review this artifact.",
        {exact: true},
      )).toBeVisible();
      expect(await readArtifact()).toEqual({
        accessSetting: "restricted",
        grantedPrincipalIds: [ben],
      });

      // Reopening shows the stored choice; "Only me" removes everyone chosen.
      await share.getByRole("button", {name: "Manage access"}).click();
      await expect(share.getByRole("radio", {name: /Selected people/u})).toBeChecked();
      await expect(share.getByRole("list", {name: "People who can open this artifact"}))
        .toContainText("Ben Okafor");
      await share.getByRole("radio", {name: /Only me/u}).check();
      await share.getByRole("button", {name: "Save"}).click();
      await expect(share.getByText(
        "Only you and installation administrators can review this artifact.",
        {exact: true},
      )).toBeVisible();
      expect(await readArtifact()).toEqual({
        accessSetting: "restricted",
        grantedPrincipalIds: [],
      });
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
