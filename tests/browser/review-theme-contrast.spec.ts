import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Page} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

test.describe("Review theme contrast", () => {
  test("CMT-015-B CMT-015-F: filled and destructive buttons keep their own text color in the dark and light themes", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><head><title>Contrast fixture</title></head>"
          + "<body><h1>Contrast fixture</h1></body></html>",
        idempotencyKey: "review-theme-contrast-fixture",
        mediaType: "text/html; charset=utf-8",
        name: "Contrast fixture",
        path: "index.html",
      });
      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default`
          + `&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
      );
      await page.getByRole("tab", {name: "Comments"}).click();
      // An empty composer disables its button, and contrast checks skip disabled controls.
      await page.getByLabel("Add a comment").fill("Readable in both themes.");
      const post = page.getByRole("button", {exact: true, name: "Post comment"});
      await expect(post).toBeEnabled();

      await expectReadableButtons(page);
      await page.getByRole("button", {name: "Use light theme"}).first().click();
      await expect(page.locator("html")).toHaveAttribute("data-review-theme", "dawn");
      await expect(post).toBeEnabled();
      await expectReadableButtons(page);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

/**
 * A filled button paints its own text color; the page text color must not leak
 * into it, or the label disappears in one of the themes.
 */
async function expectReadableButtons(page: Page): Promise<void> {
  const post = page.getByRole("button", {exact: true, name: "Post comment"});
  // Colors come back in different notations (oklch, oklab), so compare painted pixels.
  await expect.poll(() => post.evaluate((node) => {
    const canvas = document.createElement("canvas").getContext("2d", {willReadFrequently: true});
    if (canvas === null) throw new Error("No 2D canvas.");
    const paint = (color: string): string => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      return Array.from(canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)).join(",");
    };
    const probe = document.createElement("span");
    probe.className = "text-primary-foreground";
    document.body.append(probe);
    const foreground = paint(getComputedStyle(probe).color);
    probe.remove();
    const label = paint(getComputedStyle(node).color);
    return label === foreground && label !== paint(getComputedStyle(document.body).color);
  })).toBe(true);

  const contrast = await new AxeBuilder({page})
    .include("[data-slot='button']")
    .withRules(["color-contrast"])
    .analyze();
  expect(contrast.violations).toEqual([]);
}
