import {expect, test, type Browser, type Page} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";

/** Dark text and no scheme or background of its own: a plain tab paints it on white. */
const unthemedArtifact = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Unthemed artifact</title>
    <style>body { color: #1f2328; margin: 32px; }</style>
  </head>
  <body><h1>Unthemed artifact</h1><p>Dark text that expects a light page.</p></body>
</html>`;

/** Declares both schemes and leaves the canvas to the browser. */
const schemeAwareArtifact = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="light dark">
    <title>Scheme-aware artifact</title>
  </head>
  <body><h1>Scheme-aware artifact</h1></body>
</html>`;

/** Opts into the viewer's host theme and paints with the tokens it receives. */
const hostThemedArtifact = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="plannotator-theme" content="host">
    <title>Host-themed artifact</title>
    <style>
      body { background: var(--background, Canvas); color: var(--foreground, CanvasText); }
    </style>
  </head>
  <body><h1>Host-themed artifact</h1></body>
</html>`;

type Canvas = "dark" | "light";
type ReviewTheme = "dawn" | "moon";

test.describe("Review artifact canvas", () => {
  for (const system of ["light", "dark"] as const) {
    test(`CMT-023-B CMT-023-F: an artifact with no color scheme stays on a light canvas through Review theme switches on a ${system} system`, async ({browser}) => {
      await expectCanvasAcrossThemes(browser, system, unthemedArtifact, () => "light");
    });

    test(`CMT-023-B CMT-023-F: an artifact that declares both schemes follows the ${system} system through Review theme switches`, async ({browser}) => {
      await expectCanvasAcrossThemes(browser, system, schemeAwareArtifact, () => system);
    });
  }

  test("CMT-023-B: an artifact that opts into the host theme follows the Review theme", async ({browser}) => {
    await expectCanvasAcrossThemes(
      browser,
      "light",
      hostThemedArtifact,
      (theme) => theme === "moon" ? "dark" : "light",
    );
  });
});

async function expectCanvasAcrossThemes(
  browser: Browser,
  system: Canvas,
  content: string,
  expected: (theme: ReviewTheme) => Canvas,
): Promise<void> {
  const fixture = await startBrowserFixture(browser);
  try {
    await fixture.page.emulateMedia({colorScheme: system});
    await openReview(fixture, content);
    await expectReviewTheme(fixture.page, "moon");
    await expectCanvas(fixture.page, expected("moon"));
    // Dark, light, and dark again: a canvas must also survive switching back.
    await switchTheme(fixture.page, "dawn");
    await expectCanvas(fixture.page, expected("dawn"));
    await switchTheme(fixture.page, "moon");
    await expectCanvas(fixture.page, expected("moon"));
  } finally {
    await stopBrowserFixture(fixture);
  }
}

async function openReview(fixture: BrowserFixture, content: string): Promise<void> {
  const published = await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content,
    idempotencyKey: "review-artifact-canvas",
    mediaType: "text/html; charset=utf-8",
    name: "Canvas fixture",
    path: "index.html",
  });
  await localLogin(fixture);
  await fixture.page.goto(
    `${fixture.server.baseUrl}/review?project=prj_default`
      + `&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
  );
  const artifact = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
  await expect(artifact.locator("h1")).toBeVisible();
}

async function expectReviewTheme(page: Page, theme: ReviewTheme): Promise<void> {
  const root = page.locator("html");
  await (theme === "dawn"
    ? expect(root).toHaveAttribute("data-review-theme", "dawn")
    : expect(root).not.toHaveAttribute("data-review-theme", "dawn"));
}

async function switchTheme(page: Page, theme: ReviewTheme): Promise<void> {
  const name = theme === "dawn" ? "Use light theme" : "Use dark theme";
  await page.getByRole("button", {name}).first().click();
  await expectReviewTheme(page, theme);
}

async function expectCanvas(page: Page, expected: Canvas): Promise<void> {
  await (expected === "light"
    ? expect.poll(() => artifactCanvasLuminance(page)).toBeGreaterThan(0.8)
    : expect.poll(() => artifactCanvasLuminance(page)).toBeLessThan(0.05));
}

/**
 * Relative luminance (0 black … 1 white) of an empty corner of the artifact
 * viewport. The sandbox is cross-origin and its canvas color is not a style
 * anyone can read, so only the painted pixels show what a reader sees.
 */
async function artifactCanvasLuminance(page: Page): Promise<number> {
  const sandbox = page.frameLocator(".as-artifact-frame").locator("iframe");
  const box = await sandbox.boundingBox();
  if (box === null) throw new Error("The artifact sandbox has no box.");
  const png = await page.screenshot({
    clip: {height: 4, width: 4, x: box.x + box.width - 24, y: box.y + box.height - 24},
  });
  const decoder = await page.context().newPage();
  try {
    const [red = 0, green = 0, blue = 0] = await decoder.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], {type: "image/png"}));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("No 2D canvas.");
      context.drawImage(bitmap, 0, 0);
      return Array.from(context.getImageData(1, 1, 1, 1).data.slice(0, 3));
    }, png.toString("base64"));
    return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
  } finally {
    await decoder.close();
  }
}

/** One sRGB channel (0 … 255) in linear light, as relative luminance weighs it. */
function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
