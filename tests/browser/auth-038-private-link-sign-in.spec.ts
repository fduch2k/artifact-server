import {expect, test} from "@playwright/test";

import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  type PublishResponse,
  type TestSiteFile,
} from "../support/publishing.js";
import {
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";

test.describe("Private artifact links in a fresh browser", () => {
  test("AUTH-038-B: a browser with no session opens a private latest link and an exact-version file", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const site = await publishPrivateSite(fixture);

      // The moving latest link: the management application creates the local
      // owner's session, then the server opens the current version.
      await fixture.page.goto(site.links.artifact);
      await expect(fixture.page.getByText("Private site home")).toBeVisible();
      expect(new URL(fixture.page.url()).host).toBe(new URL(site.links.version).host);
      expect(new URL(fixture.page.url()).searchParams.has("__artifact_bootstrap")).toBe(false);

      // An exact-version file opened in another fresh browser returns to that file.
      const other = await browser.newContext();
      try {
        const page = await other.newPage();
        const rawFile = new URL("notes/plan.html", site.links.version).toString();
        await page.goto(rawFile);
        await expect(page.getByText("Private site notes")).toBeVisible();
        expect(page.url()).toBe(rawFile);
      } finally {
        await other.close();
      }
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("AUTH-038-F: resuming a link never leaves the application origin or returns to itself", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const origin = fixture.server.baseUrl;
      const reviewHome = new RegExp(`^${origin}/review(?:\\?|$)`, "u");
      await Promise.all([
        "//example.test/stolen",
        "https://example.test/stolen",
        "/\\example.test/stolen",
        "/review/continue?returnTo=/review/continue",
      ].map(async (returnTo) => {
        const page = await fixture.context.newPage();
        await page.goto(
          `${origin}/review/continue?${new URLSearchParams({returnTo}).toString()}`,
        );
        await expect(page).toHaveURL(reviewHome);
        await page.close();
      }));
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

async function publishPrivateSite(fixture: BrowserFixture): Promise<PublishResponse> {
  const files: readonly TestSiteFile[] = [
    {
      bytes: new TextEncoder().encode("<!doctype html><title>Private site</title><p>Private site home</p>"),
      mediaType: "text/html; charset=utf-8",
      path: "index.html",
    },
    {
      bytes: new TextEncoder().encode("<!doctype html><title>Notes</title><p>Private site notes</p>"),
      mediaType: "text/html; charset=utf-8",
      path: "notes/plan.html",
    },
  ];
  const planned = await createStagedUpload(fixture.server, fixture.installation, "index.html", files);
  const uploads = await uploadEveryStagedFile(fixture.installation, planned.body, files);
  expect(uploads.every((response) => response.status === 200)).toBe(true);
  const committed = await commitStagedUpload(
    fixture.installation,
    planned.body,
    "browser-private-link-sign-in",
    {accessSetting: "account_required", kind: "new_artifact", name: "Private site"},
  );
  expect(committed.response.status).toBe(201);
  return committed.body;
}
