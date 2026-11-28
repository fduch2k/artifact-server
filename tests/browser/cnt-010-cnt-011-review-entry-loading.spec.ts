import {createHash} from "node:crypto";
import {createServer, type ServerResponse} from "node:http";

import {expect, test, type FrameLocator, type Locator, type Page} from "@playwright/test";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  type TestSiteFile,
} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";

/*
 * A minimal stand-in for an exported slide-deck viewer: a skeleton, a runtime
 * script pinned by an integrity hash, and a bootstrap that asks for a file
 * listing next to the entry page. A missing listing (404) ends in the viewer's
 * own empty state; a network failure keeps the skeleton forever, which is what
 * Review used to show.
 */
const viewerRuntime = `document.addEventListener("DOMContentLoaded", function () {
  var status = document.getElementById("viewer-status");
  status.textContent = "Runtime started";
  fetch("_files.json").then(function (response) {
    return response.ok ? response.json() : {files: {}};
  }).then(function (listing) {
    var slides = Object.keys(listing.files).filter(function (path) {
      return path.indexOf("project/slides/") === 0;
    });
    status.textContent = slides.length > 0
      ? "Showing " + slides.length + " slides"
      : "No slides to show in this view";
  }, function () {
    status.textContent = "Loading viewer";
  });
});
`;

const runtimeIntegrity = sriHash(viewerRuntime);

const viewerEntry = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Quarterly deck</title>
    <script src="runtime/app.js" integrity="${runtimeIntegrity}"></script>
  </head>
  <body>
    <p id="viewer-status">Loading viewer</p>
  </body>
</html>`;

const slideFiles: readonly TestSiteFile[] = [
  file("project/deck.json", "{\"title\":\"Quarterly deck\"}", "application/json"),
  file("project/slides/one.html", "<!doctype html><p>Slide one</p>", "text/html; charset=utf-8"),
  file("project/slides/two.html", "<!doctype html><p>Slide two</p>", "text/html; charset=utf-8"),
];

const assignedAddressSchema = z.object({port: z.number().int().positive()});

function sriHash(content: string): string {
  return `sha256-${createHash("sha256").update(content).digest("base64")}`;
}

function file(path: string, content: string, mediaType: string): TestSiteFile {
  return {bytes: new TextEncoder().encode(content), mediaType, path};
}

async function publishSite(
  fixture: BrowserFixture,
  files: readonly TestSiteFile[],
  idempotencyKey: string,
  name: string,
): Promise<string> {
  const planned = await createStagedUpload(
    fixture.server,
    fixture.installation,
    "index.html",
    files,
  );
  const uploads = await uploadEveryStagedFile(fixture.installation, planned.body, files);
  expect(uploads.every((response) => response.status === 200)).toBe(true);
  const committed = await commitStagedUpload(
    fixture.installation,
    planned.body,
    idempotencyKey,
    {accessSetting: "account_required", kind: "new_artifact", name},
  );
  expect(committed.response.status).toBe(201);
  return `${fixture.server.baseUrl}/review?project=prj_default&artifact=${committed.body.artifact.id}&version=${committed.body.version.id}`;
}

function artifactFrame(page: Page): FrameLocator {
  return page.frameLocator(".as-artifact-frame").frameLocator("iframe");
}

async function openRawArtifact(fixture: BrowserFixture, scope: Locator | Page): Promise<Page> {
  const [rawPage] = await Promise.all([
    fixture.context.waitForEvent("page"),
    scope.getByRole("button", {name: "Open raw artifact"}).first().click(),
  ]);
  return rawPage;
}

/** An image host that accepts requests and answers only when told to. */
async function startHangingImageHost(): Promise<{
  readonly release: () => void;
  readonly stop: () => Promise<void>;
  readonly url: string;
}> {
  const pending: ServerResponse[] = [];
  const server = createServer((_request, response) => {
    pending.push(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const {port} = assignedAddressSchema.parse(server.address());
  return {
    release: () => {
      for (const response of pending.splice(0)) {
        response.writeHead(204).end();
      }
    },
    stop: async () => {
      for (const response of pending.splice(0)) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    url: `http://127.0.0.1:${port}/pixel.png`,
  };
}

function stalledEntry(imageUrl: string, forge: boolean): string {
  const forgery = forge
    ? `<script>
        setInterval(function () {
          var forged = {type: "as-review-entry-loaded", v: 1};
          parent.postMessage(forged, "*");
          try { parent.parent.postMessage(forged, "*"); } catch (error) {}
        }, 200);
      </script>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Slow page</title></head>
  <body>
    <p id="slow-status">Waiting for the cover image</p>
    <img alt="" src="${imageUrl}">
    ${forgery}
  </body>
</html>`;
}

const stalledNotice = "This page has not finished loading";
const stalledBound = 25_000;

test.describe("Review entry loading", () => {
  test("CNT-010-B: an exported viewer that probes for a missing listing reaches the same state in Review as opened directly, and renders with its own listing", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const withoutListing = await publishSite(fixture, [
        file("index.html", viewerEntry, "text/html; charset=utf-8"),
        file("runtime/app.js", viewerRuntime, "text/javascript"),
        ...slideFiles,
      ], "browser-cnt-010-viewer-without-listing", "Deck without listing");
      const listing = JSON.stringify({
        files: Object.fromEntries(slideFiles.map((slide) => [
          slide.path,
          {sha256: createHash("sha256").update(slide.bytes).digest("hex"), size: slide.bytes.byteLength},
        ])),
        ver: "synthetic",
      });
      const withListing = await publishSite(fixture, [
        file("index.html", viewerEntry, "text/html; charset=utf-8"),
        file("runtime/app.js", viewerRuntime, "text/javascript"),
        file("_files.json", listing, "application/json"),
        ...slideFiles,
      ], "browser-cnt-010-viewer-with-listing", "Deck with listing");
      await localLogin(fixture);

      await fixture.page.goto(withoutListing);
      // The integrity-pinned runtime ran, and the missing listing read as a
      // 404 rather than a network failure that leaves the skeleton up.
      await expect(artifactFrame(fixture.page).locator("#viewer-status"))
        .toHaveText("No slides to show in this view");
      const rawPage = await openRawArtifact(fixture, fixture.page);
      await expect(rawPage.locator("#viewer-status")).toHaveText("No slides to show in this view");
      await rawPage.close();

      await fixture.page.goto(withListing);
      await expect(artifactFrame(fixture.page).locator("#viewer-status")).toHaveText("Showing 2 slides");
      await expect(fixture.page.getByRole("alert").filter({hasText: stalledNotice})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CNT-010-F: Review keeps a wrong integrity hash blocked and leaves foreign integrity resources as authored", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const probeEntry = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Integrity probe</title>
    <script>window.__ran = [];</script>
    <script id="tampered" src="runtime/app.js" integrity="${sriHash("something else")}"
      onerror="window.__ran.push('tampered:blocked')"></script>
    <script id="foreign" src="http://127.0.0.1:9/library.js" integrity="${runtimeIntegrity}"
      onerror="window.__ran.push('foreign:blocked')"></script>
  </head>
  <body>
    <p id="report">pending</p>
    <script>
      window.addEventListener("load", function () {
        var foreign = document.getElementById("foreign");
        var tampered = document.getElementById("tampered");
        document.getElementById("report").textContent = [
          "tampered-cors:" + tampered.getAttribute("crossorigin"),
          "foreign-cors:" + foreign.hasAttribute("crossorigin"),
        ].concat(window.__ran).join(" ");
      });
    </script>
  </body>
</html>`;
      const review = await publishSite(fixture, [
        file("index.html", probeEntry, "text/html; charset=utf-8"),
        file("runtime/app.js", "window.__ran.push('tampered:ran');", "text/javascript"),
      ], "browser-cnt-010-integrity-probe", "Integrity probe");
      await localLogin(fixture);
      await fixture.page.goto(review);

      // The version runs on its own lease origin (ADR 0045): its scripts are
      // same-origin and checked as authored, with no crossorigin rewrite.
      const report = artifactFrame(fixture.page).locator("#report");
      await expect(report).toContainText("tampered:blocked");
      await expect(report).toContainText("foreign:blocked");
      await expect(report).toContainText("tampered-cors:null");
      await expect(report).toContainText("foreign-cors:false");
      await expect(report).not.toContainText("tampered:ran");

      const sandbox = fixture.page.frameLocator(".as-artifact-frame").locator("iframe");
      await expect(sandbox).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
      const policy = await fixture.page.evaluate(async () => {
        const response = await fetch("/review-frame");
        return response.headers.get("content-security-policy");
      });
      // The review frame may frame content hosts only; its other directives
      // are unchanged and no longer govern the artifact document.
      expect(policy).toBe([
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline' http://*.localhost:* https://*.localhost",
        "style-src 'self' 'unsafe-inline' http://*.localhost:* https://*.localhost",
        "img-src 'self' * data: blob:",
        "font-src * data:",
        "media-src * data: blob:",
        "connect-src http://*.localhost:* https://*.localhost",
        "frame-src http://*.localhost:* https://*.localhost",
        "frame-ancestors 'self'",
      ].join("; "));
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CNT-011-B: an entry page that never finishes loading gets a bounded notice with the raw artifact, and the notice clears when the page finishes", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    const imageHost = await startHangingImageHost();
    try {
      const review = await publishSite(fixture, [
        file("index.html", stalledEntry(imageHost.url, false), "text/html; charset=utf-8"),
      ], "browser-cnt-011-stalled-entry", "Slow page");
      await localLogin(fixture);
      await fixture.page.goto(review);
      await expect(artifactFrame(fixture.page).locator("#slow-status")).toBeVisible();

      const notice = fixture.page.getByRole("alert").filter({hasText: stalledNotice});
      await expect(notice).toBeVisible({timeout: stalledBound});
      await expect(notice).toContainText("index.html");
      // The page stays on screen under the notice.
      await expect(artifactFrame(fixture.page).locator("#slow-status")).toBeVisible();

      const rawPage = await openRawArtifact(fixture, notice);
      await expect(rawPage.locator("#slow-status")).toHaveText("Waiting for the cover image");
      await rawPage.close();

      await notice.getByRole("button", {name: "Keep waiting"}).click();
      await expect(notice).toHaveCount(0);

      // A second visit: the page finishes after the notice appeared.
      await fixture.page.reload();
      await expect(notice).toBeVisible({timeout: stalledBound});
      imageHost.release();
      await expect(notice).toHaveCount(0);
    } finally {
      await imageHost.stop();
      await stopBrowserFixture(fixture);
    }
  });

  test("CNT-011-F: a page that loads gets no notice, and a stalled page cannot forge its own load to hide the notice", async ({browser}) => {
    test.setTimeout(120_000);
    const fixture = await startBrowserFixture(browser);
    const imageHost = await startHangingImageHost();
    try {
      const loaded = await publishSite(fixture, [
        file("index.html", "<!doctype html><title>Quick page</title><p id=\"quick\">Ready</p>", "text/html; charset=utf-8"),
      ], "browser-cnt-011-loaded-entry", "Quick page");
      const forging = await publishSite(fixture, [
        file("index.html", stalledEntry(imageHost.url, true), "text/html; charset=utf-8"),
      ], "browser-cnt-011-forging-entry", "Forging page");
      await localLogin(fixture);

      await fixture.page.goto(loaded);
      await expect(artifactFrame(fixture.page).locator("#quick")).toHaveText("Ready");
      await fixture.page.waitForTimeout(stalledBound);
      await expect(fixture.page.getByRole("alert").filter({hasText: stalledNotice})).toHaveCount(0);

      await fixture.page.goto(forging);
      await expect(artifactFrame(fixture.page).locator("#slow-status")).toBeVisible();
      await expect(fixture.page.getByRole("alert").filter({hasText: stalledNotice}))
        .toBeVisible({timeout: stalledBound});
    } finally {
      await imageHost.stop();
      await stopBrowserFixture(fixture);
    }
  });
});
