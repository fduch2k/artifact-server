import {expect, test, type FrameLocator, type Page} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";
import {listThreadsOverApi} from "./comment-api.js";

const selectionArtifact = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Selection fixture</title>
  </head>
  <body>
    <h1>Selection fixture</h1>
    <p id="first">Alpha bravo charlie delta echo foxtrot golf hotel india juliet.</p>
    <p id="second">Kilo lima mike november oscar papa quebec romeo sierra tango.</p>
  </body>
</html>`;

type ReviewMode = "annotate" | "interact";

interface OpenReview {
  readonly artifactId: string;
  readonly preview: FrameLocator;
  readonly reviewFrame: FrameLocator;
}

test.describe("Review text selection", () => {
  for (const mode of ["annotate", "interact"] as const) {
    test(`CMT-024-B CMT-024-F: a text selection in ${mode} mode offers Copy and Comment and copies what was selected`, async ({browser}) => {
      const fixture = await startBrowserFixture(browser);
      try {
        const review = await openReview(fixture, mode);
        const copy = review.reviewFrame.getByRole("button", {name: "Copy"});
        const comment = review.reviewFrame.getByRole("button", {name: "Comment"});
        const composer = review.reviewFrame.getByPlaceholder("Add a comment...");

        const first = await selectText(fixture.page, review, "#first");
        expect(first).toMatch(/^Alpha bravo charlie/u);
        await expect(copy).toBeVisible();
        await expect(comment).toBeVisible();
        await expect(composer).toHaveCount(0);
        expect(await artifactHasFocus(review)).toBe(true);
        expect(await selectionIn(review)).toBe(first);

        await resetClipboard(fixture.page);
        await fixture.page.keyboard.press("ControlOrMeta+c");
        await expect.poll(() => clipboardText(fixture.page)).toBe(first);

        await resetClipboard(fixture.page);
        await copy.click();
        await expect(review.reviewFrame.getByRole("button", {name: "Copied!"}))
          .toBeVisible();
        await expect.poll(() => clipboardText(fixture.page)).toBe(first);

        await fixture.page.keyboard.press("Escape");
        await expect(comment).toHaveCount(0);
        await expect(composer).toHaveCount(0);

        // Copying one passage and then selecting the next is the common case.
        const second = await selectText(fixture.page, review, "#second");
        expect(second).toMatch(/^Kilo lima mike/u);
        await expect(comment).toBeVisible();
        await expect(composer).toHaveCount(0);
        await resetClipboard(fixture.page);
        await fixture.page.keyboard.press("ControlOrMeta+c");
        await expect.poll(() => clipboardText(fixture.page)).toBe(second);

        expect(await listThreadsOverApi(fixture, review.artifactId)).toHaveLength(0);
      } finally {
        await stopBrowserFixture(fixture);
      }
    });

    test(`CMT-024-B: a text selection in ${mode} mode starts a comment from Comment or the first typed character`, async ({browser}) => {
      const fixture = await startBrowserFixture(browser);
      try {
        const review = await openReview(fixture, mode);
        const composer = review.reviewFrame.getByPlaceholder("Add a comment...");

        const first = await selectText(fixture.page, review, "#first");
        await review.reviewFrame.getByRole("button", {name: "Comment"}).click();
        await expect(composer).toBeVisible();
        await expect(composer).toBeFocused();
        await expect(review.reviewFrame.getByText(quotePrefix(first))).toBeVisible();
        await fixture.page.keyboard.press("Escape");
        await expect(composer).toHaveCount(0);

        const second = await selectText(fixture.page, review, "#second");
        await fixture.page.keyboard.type("N");
        await expect(composer).toBeVisible();
        await expect(composer).toHaveValue("N");
        await fixture.page.keyboard.type("eeds a source.");
        await review.reviewFrame.getByRole("button", {name: "Save"}).click();

        await expect.poll(async () =>
          (await listThreadsOverApi(fixture, review.artifactId)).length
        ).toBe(1);
        const [thread] = await listThreadsOverApi(fixture, review.artifactId);
        expect(thread?.body).toBe("Needs a source.");
        expect(JSON.stringify(thread?.anchor)).toContain(second);
      } finally {
        await stopBrowserFixture(fixture);
      }
    });
  }

  test("CMT-024-B: every control on the selection toolbar stands out from the toolbar in the dark and light themes", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const review = await openReview(fixture, "annotate");
      await selectText(fixture.page, review, "#first");
      await expectToolbarIconsVisible(review);

      await fixture.page.keyboard.press("Escape");
      await fixture.page.getByRole("button", {name: "Use light theme"}).first().click();
      await expect(fixture.page.locator("html")).toHaveAttribute("data-review-theme", "dawn");
      await selectText(fixture.page, review, "#first");
      await expectToolbarIconsVisible(review);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-024-F: a click in Annotate mode still opens the composer on the clicked element", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const review = await openReview(fixture, "annotate");
      await review.preview.locator("#first").click();
      await expect(review.reviewFrame.getByPlaceholder("Add a comment..."))
        .toBeVisible();
      await expect(review.reviewFrame.getByRole("button", {name: "Copy"}))
        .toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

async function openReview(fixture: BrowserFixture, mode: ReviewMode): Promise<OpenReview> {
  await fixture.context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const published = await publishNew(fixture.server, fixture.installation, {
    accessSetting: "account_required",
    content: selectionArtifact,
    idempotencyKey: "review-copy-selection",
    mediaType: "text/html; charset=utf-8",
    name: "Selection fixture",
    path: "index.html",
  });
  await localLogin(fixture);
  await fixture.page.goto(
    `${fixture.server.baseUrl}/review?project=prj_default`
      + `&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
  );
  const reviewFrame = fixture.page.frameLocator(".as-artifact-frame");
  const preview = reviewFrame.frameLocator("iframe");
  await expect(preview.locator("#first")).toBeVisible();
  if (mode === "interact") {
    await fixture.page.getByRole("button", {name: /^Annotate mode:/u}).click();
    await expect(fixture.page.getByRole("button", {name: /^Interact mode:/u}))
      .toHaveAttribute("aria-pressed", "false");
  }
  return {artifactId: published.body.artifact.id, preview, reviewFrame};
}

/** Drag across most of one paragraph, as a reader would, and return the selection. */
async function selectText(page: Page, review: OpenReview, selector: string): Promise<string> {
  const box = await review.preview.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} has no box.`);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, y, {steps: 8});
  await page.mouse.up();
  await expect(review.reviewFrame.getByRole("button", {name: "Copy"})).toBeVisible();
  return selectionIn(review);
}

async function selectionIn(review: OpenReview): Promise<string> {
  return review.preview.locator("body").evaluate(() =>
    window.getSelection()?.toString() ?? ""
  );
}

/** Whether keyboard focus is still inside the artifact sandbox. */
async function artifactHasFocus(review: OpenReview): Promise<boolean> {
  return review.reviewFrame.locator("iframe").evaluate((frame) =>
    frame.ownerDocument.activeElement === frame
  );
}

/**
 * Each toolbar icon is drawn in its button's text color, so that color must
 * reach the WCAG non-text contrast of 3:1 against the toolbar behind it.
 */
async function expectToolbarIconsVisible(review: OpenReview): Promise<void> {
  const contrast = async (): Promise<Record<string, number>> => {
    const painted = await review.reviewFrame.locator(".annotation-toolbar").evaluate((toolbar) => {
      const canvas = document.createElement("canvas").getContext("2d", {willReadFrequently: true});
      if (canvas === null) throw new Error("No 2D canvas.");
      // Colors come back in different notations (oklch, oklab, color-mix), so
      // paint them, each over what sits behind it, and read the pixels back.
      const paint = (...layers: readonly string[]): number[] => {
        canvas.clearRect(0, 0, 1, 1);
        for (const layer of layers) {
          canvas.fillStyle = layer;
          canvas.fillRect(0, 0, 1, 1);
        }
        return Array.from(canvas.getImageData(0, 0, 1, 1).data.slice(0, 3));
      };
      const page = getComputedStyle(document.body).backgroundColor;
      const surface = getComputedStyle(toolbar).backgroundColor;
      return {
        icons: Array.from(toolbar.querySelectorAll("button"), (button) => ({
          label: button.title,
          rgb: paint(page, surface, getComputedStyle(button).color),
        })),
        surface: paint(page, surface),
      };
    });
    const behind = relativeLuminance(painted.surface);
    return Object.fromEntries(painted.icons.map(({label, rgb}) => {
      const icon = relativeLuminance(rgb);
      const ratio = (Math.max(icon, behind) + 0.05) / (Math.min(icon, behind) + 0.05);
      return [label, Math.round(ratio * 100) / 100];
    }));
  };

  await expect.poll(async () => Object.keys(await contrast())).toEqual(["Copy", "Comment", "Cancel"]);
  await expect.poll(async () =>
    Object.entries(await contrast()).filter(([, ratio]) => ratio < 3)
  ).toEqual([]);
}

/** WCAG relative luminance of an sRGB color given as 0-255 channels. */
function relativeLuminance(rgb: readonly number[]): number {
  const [red = 0, green = 0, blue = 0] = rgb.map((channel) => {
    const linear = channel / 255;
    return linear <= 0.040_45 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

async function resetClipboard(page: Page): Promise<void> {
  await page.evaluate(() => navigator.clipboard.writeText(""));
}

async function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** The composer quotes the start of the selection and may truncate the rest. */
function quotePrefix(text: string): string {
  return text.slice(0, 24);
}
