import {AxeBuilder} from "@axe-core/playwright";
import {expect, test} from "@playwright/test";
import {z} from "zod";

import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const sessionSchema = z.object({
  principal: z.object({
    authorizedByPrincipalId: z.string().nullable(),
    capabilities: z.array(z.string()),
    id: z.string(),
  }),
});

test.describe("Personal API keys in settings", () => {
  test("AUTH-034-B: a signed-in person issues a key that acts as them, copies it once, and revokes it", async ({browser}) => {
    const fixture = await startBrowserFixture(browser, {
      personalApiKeyPolicy: {maxLifetimeDays: 45},
    });
    try {
      await localLogin(fixture);
      const signedIn = sessionSchema.parse(await fixture.page.evaluate(async () =>
        (await fetch("/api/v1/session", {credentials: "same-origin"})).json()
      ));
      await fixture.page.goto(`${fixture.server.baseUrl}/review/settings/mcp`);
      await fixture.page.getByRole("link", {name: "Personal API keys"}).first().click();
      await expect(fixture.page).toHaveURL(/\/review\/settings\/personal-api-keys$/u);
      await expect(fixture.page.getByRole("heading", {exact: true, name: "Personal API keys"})).toBeVisible();
      await expect(fixture.page.getByText("No personal API keys")).toBeVisible();

      await fixture.page.getByRole("button", {name: "Issue personal key"}).click();
      const dialog = fixture.page.getByRole("dialog", {name: "Issue personal key"});
      await expect(dialog).toContainText("expires within 45 days");
      // Every capability of the ceiling starts selected; nothing reaches others' work.
      await expect(dialog.getByRole("checkbox")).toHaveCount(7);
      await expect(dialog.getByText("Manage artifacts", {exact: true})).toHaveCount(0);
      await expect(dialog.getByRole("button", {name: "Issue personal key"})).toBeDisabled();
      await dialog.getByLabel("Name").fill("Laptop agent");
      // The submit button fades in once enabled; judge contrast after it settles.
      await dialog.evaluate((element) => Promise.all(
        element.getAnimations({subtree: true}).map((animation) => animation.finished),
      ));
      const issueAccessibility = await new AxeBuilder({page: fixture.page})
        .exclude("[data-base-ui-focus-guard]")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(issueAccessibility.violations).toEqual([]);
      await dialog.getByRole("button", {name: "Issue personal key"}).click();

      const secret = fixture.page.getByRole("dialog", {name: "Copy API key now"});
      const token = (await secret.locator("code").textContent())?.trim() ?? "";
      expect(token).toMatch(/^as_key_/u);
      await secret.getByRole("button", {name: "I stored it"}).click();
      await expect(secret).toHaveCount(0);

      const asKey = await fetch(`${fixture.server.baseUrl}/api/v1/session`, {
        headers: {Authorization: `Bearer ${token}`},
      });
      expect(asKey.status).toBe(200);
      expect(sessionSchema.parse(await asKey.json()).principal).toMatchObject({
        authorizedByPrincipalId: signedIn.principal.id,
        id: signedIn.principal.id,
      });

      const listed = fixture.page.getByRole("article").filter({hasText: "Laptop agent"});
      await expect(listed).toContainText("Active");
      await expect(listed).toContainText("artifact:manage:own");
      await listed.getByRole("button", {name: "Revoke"}).click();
      await fixture.page.getByRole("dialog", {name: "Revoke API key"})
        .getByRole("button", {name: "Revoke API key"}).click();
      await expect(listed).toContainText("Revoked");
      expect((await fetch(`${fixture.server.baseUrl}/api/v1/session`, {
        headers: {Authorization: `Bearer ${token}`},
      })).status).toBe(401);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("AUTH-034-F: without the operator's opt-in, settings explain that keys come from an administrator", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await localLogin(fixture);
      await fixture.page.goto(`${fixture.server.baseUrl}/review/settings/personal-api-keys`);
      await expect(fixture.page.getByText("Self-service keys are off")).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: "Issue personal key"})).toHaveCount(0);
      await fixture.page.goto(`${fixture.server.baseUrl}/review/settings/mcp`);
      await expect(fixture.page.getByText("ask an administrator for a scoped API key")).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
