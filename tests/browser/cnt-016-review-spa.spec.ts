import {expect, test, type Frame, type FrameLocator, type Page} from "@playwright/test";

import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  type TestSiteFile,
} from "../support/publishing.js";
import {listThreadsOverApi} from "./comment-api.js";
import {
  browserStorage,
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";

/*
 * CNT-016 (ADR 0046): Review renders single-page apps that touch the History
 * API and storage while they start, through @plannotator/ui's sandbox shim in
 * the unchanged opaque-origin srcdoc frame.
 *
 * The decks are synthetic and follow vue-router's history shapes, which is
 * what an exported slide deck uses: the hash router pushes a bare `#/2`; the
 * history router keeps its route in memory and pushes an absolute path.
 */

const entry = (script: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Synthetic deck</title>
    <script type="module" src="/assets/${script}"></script>
  </head>
  <body><main id="app"></main><output id="deck-errors"></output></body>
</html>`;

const slidesAndRender = `
window.addEventListener("error", (event) => {
  document.getElementById("deck-errors").append(String(event.message) + "; ");
});
const slides = ["Title slide", "Second slide", "Closing slide"];
const visits = Number(localStorage.getItem("deck-visits") ?? "0") + 1;
localStorage.setItem("deck-visits", String(visits));
sessionStorage.setItem("deck-session", "kept for this load");
function render(index) {
  const app = document.getElementById("app");
  app.replaceChildren();
  const heading = document.createElement("h1");
  heading.id = "slide-title";
  heading.textContent = slides[index];
  const status = document.createElement("p");
  status.id = "deck-status";
  status.textContent = "visits " + visits + "; session " + sessionStorage.getItem("deck-session");
  const next = document.createElement("button");
  next.id = "next-slide";
  next.textContent = "Next slide";
  next.addEventListener("click", () => go(Math.min(index + 1, slides.length - 1)));
  app.append(heading, status, next);
}
`;

/** `routerMode: hash`: the route lives in the fragment. */
const hashRuntime = `${slidesAndRender}
function fromHash() {
  const match = /^#\\/(\\d+)$/.exec(location.hash);
  return match ? Math.max(0, Math.min(slides.length - 1, Number(match[1]) - 1)) : 0;
}
function go(index) {
  history.pushState({index}, "", "#/" + (index + 1));
  render(index);
}
history.replaceState({index: fromHash()}, "", "#/" + (fromHash() + 1));
window.addEventListener("popstate", () => render(fromHash()));
render(fromHash());
`;

/** A history router: the route is kept in memory and an absolute path pushed. */
const historyRuntime = `${slidesAndRender}
let current = 0;
function go(index) {
  current = index;
  history.pushState({index}, "", index === 0 ? "/" : "/" + (index + 1));
  render(current);
}
history.replaceState({index: 0}, "", "/");
window.addEventListener("popstate", (event) => render(event.state?.index ?? 0));
render(current);
`;

/** Everything a hostile page might try from its sandbox, reported, not thrown. */
const hostileRuntime = `
const report = {};
function attempt(name, action) {
  try {
    report[name] = "ok: " + String(action());
  } catch (error) {
    report[name] = "threw " + (error && error.name);
  }
}
attempt("localStorage", () => { localStorage.setItem("hostile-key", "x"); return localStorage.getItem("hostile-key"); });
attempt("sessionStorage", () => { sessionStorage.setItem("hostile-key", "x"); return sessionStorage.getItem("hostile-key"); });
attempt("cookie", () => document.cookie);
attempt("pushPath", () => { history.pushState(null, "", "/escape"); return location.href; });
attempt("pushForeign", () => { history.pushState(null, "", "https://example.com/escape"); return location.href; });
attempt("parentLocation", () => window.parent.location.href);
attempt("topLocation", () => window.top.location.href);
attempt("alert", () => { alert("hostile"); return "returned"; });
attempt("open", () => window.open("https://example.com/") === null ? "blocked" : "opened");
window.__report = report;
document.getElementById("app").textContent = "hostile page ran";
`;

/** Workers from a URL and from a blob, each in isolation. */
const workerRuntime = `
const results = {url: "pending", blob: "pending"};
function show() {
  document.getElementById("app").textContent = "url: " + results.url + "; blob: " + results.blob;
}
function start(kind, make) {
  try {
    const worker = make();
    worker.addEventListener("message", (event) => { results[kind] = String(event.data); show(); });
    worker.addEventListener("error", (event) => {
      results[kind] = "error event";
      event.preventDefault();
      show();
    });
  } catch (error) {
    results[kind] = "threw " + error.name;
  }
}
start("url", () => new Worker("/assets/worker.js"));
start("blob", () => new Worker(URL.createObjectURL(
  new Blob(["postMessage('ready')"], {type: "text/javascript"}),
)));
show();
`;

function file(path: string, content: string, mediaType: string): TestSiteFile {
  return {bytes: new TextEncoder().encode(content), mediaType, path};
}

const js = "text/javascript; charset=utf-8";
const html = "text/html; charset=utf-8";

const deckOf = (name: string, runtime: string): readonly TestSiteFile[] => [
  file("index.html", entry(`${name}.js`), html),
  file(`assets/${name}.js`, runtime, js),
];

interface PublishedSite {
  readonly artifactId: string;
  readonly reviewUrl: string;
}

async function publishSpa(
  fixture: BrowserFixture,
  files: readonly TestSiteFile[],
  idempotencyKey: string,
): Promise<PublishedSite> {
  const planned = await createStagedUpload(
    fixture.server,
    fixture.installation,
    "index.html",
    files,
    undefined,
    "spa",
  );
  const uploads = await uploadEveryStagedFile(fixture.installation, planned.body, files);
  expect(uploads.every((response) => response.status === 200)).toBe(true);
  const committed = await commitStagedUpload(
    fixture.installation,
    planned.body,
    idempotencyKey,
    {accessSetting: "account_required", kind: "new_artifact", name: idempotencyKey},
  );
  expect(committed.response.status).toBe(201);
  const artifactId = committed.body.artifact.id;
  return {
    artifactId,
    reviewUrl: `${fixture.server.baseUrl}/review?project=prj_default&artifact=${artifactId}&version=${committed.body.version.id}`,
  };
}

const reviewFrame = (page: Page): FrameLocator => page.frameLocator(".as-artifact-frame");
const artifactFrame = (page: Page): FrameLocator => reviewFrame(page).frameLocator("iframe");

async function artifactDocument(page: Page): Promise<Frame> {
  let found: Frame | undefined;
  await expect.poll(() => {
    found = page.frames().find((frame) => frame.url().startsWith("about:srcdoc"));
    return found !== undefined;
  }).toBe(true);
  if (found === undefined) throw new Error("The artifact frame did not open.");
  return found;
}

async function reloadArtifactDocument(page: Page): Promise<void> {
  const doc = await artifactDocument(page);
  await doc.evaluate(() => {
    window.setTimeout(() => location.reload(), 0);
  });
}

async function setAnnotateMode(page: Page, active: boolean): Promise<void> {
  const toggle = page.getByRole("button", {name: /^(Annotate|Interact) mode:/u});
  if ((await toggle.getAttribute("aria-pressed")) !== String(active)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", String(active));
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Script errors the deck caught while it ran. */
async function deckErrors(page: Page): Promise<string> {
  return (await artifactFrame(page).locator("#deck-errors").textContent()) ?? "";
}

test.describe("Review renders single-page apps in the srcdoc sandbox", () => {
  test("CNT-016-B: a hash-routed deck that uses storage at startup renders, pages, keeps its slide across a frame reload, and takes a comment", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const errors = collectPageErrors(fixture.page);
      const deck = await publishSpa(fixture, deckOf("hash", hashRuntime), "browser-cnt-016-hash-deck");
      await localLogin(fixture);
      await fixture.page.goto(deck.reviewUrl);
      const preview = artifactFrame(fixture.page);
      await expect(preview.locator("#slide-title")).toHaveText("Title slide");
      await expect(preview.locator("#deck-status")).toHaveText("visits 1; session kept for this load");
      expect((await artifactDocument(fixture.page)).url()).toBe("about:srcdoc#/1");
      const reviewUrl = fixture.page.url();

      await setAnnotateMode(fixture.page, false);
      await preview.locator("#next-slide").click();
      await expect(preview.locator("#slide-title")).toHaveText("Second slide");
      await expect.poll(async () => (await artifactDocument(fixture.page)).url())
        .toBe("about:srcdoc#/2");

      // The route survives a reload of the frame; storage lives one load.
      await reloadArtifactDocument(fixture.page);
      await expect(preview.locator("#slide-title")).toHaveText("Second slide");
      await expect(preview.locator("#deck-status")).toHaveText("visits 1; session kept for this load");

      await setAnnotateMode(fixture.page, true);
      await preview.locator("#slide-title").click();
      const composer = reviewFrame(fixture.page).getByPlaceholder("Add a comment...");
      await expect(composer).toBeVisible();
      await composer.fill("Comment on the second slide.");
      await reviewFrame(fixture.page).getByRole("button", {name: "Save"}).click();
      await expect(fixture.page.getByRole("article").filter({hasText: "Comment on the second slide."}))
        .toBeVisible();
      const threads = await listThreadsOverApi(fixture, deck.artifactId);
      expect(threads.map((thread) => thread.body)).toEqual(["Comment on the second slide."]);

      expect(await deckErrors(fixture.page)).toBe("");
      expect(errors).toEqual([]);
      expect(fixture.page.url()).toBe(reviewUrl);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CNT-016-B: a history-routed deck renders and pages in memory, and starts over after a frame reload", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const errors = collectPageErrors(fixture.page);
      const navigations: string[] = [];
      fixture.page.on("request", (request) => {
        if (request.isNavigationRequest()) navigations.push(request.url());
      });
      const deck = await publishSpa(fixture, deckOf("history", historyRuntime), "browser-cnt-016-history-deck");
      await localLogin(fixture);
      await fixture.page.goto(deck.reviewUrl);
      const preview = artifactFrame(fixture.page);
      await expect(preview.locator("#slide-title")).toHaveText("Title slide");
      const reviewUrl = fixture.page.url();
      navigations.length = 0;

      await setAnnotateMode(fixture.page, false);
      await preview.locator("#next-slide").click();
      await expect(preview.locator("#slide-title")).toHaveText("Second slide");
      await preview.locator("#next-slide").click();
      await expect(preview.locator("#slide-title")).toHaveText("Closing slide");
      // The frame keeps its own address: the pushed path never names another.
      expect((await artifactDocument(fixture.page)).url()).toBe("about:srcdoc");
      expect(await deckErrors(fixture.page)).toBe("");

      // No served address to come back to: the deck starts over.
      await reloadArtifactDocument(fixture.page);
      await expect(preview.locator("#slide-title")).toHaveText("Title slide");
      await expect(preview.locator("#deck-status")).toHaveText("visits 1; session kept for this load");
      expect(await deckErrors(fixture.page)).toBe("");

      expect(errors).toEqual([]);
      expect(navigations).toEqual([]);
      expect(fixture.page.url()).toBe(reviewUrl);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CNT-016-F: storage and history the shim allows stay inside the scripts-only sandbox", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const dialogs: string[] = [];
      const popups: string[] = [];
      fixture.page.on("dialog", (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      fixture.context.on("page", (page) => popups.push(page.url()));
      const site = await publishSpa(fixture, deckOf("hostile", hostileRuntime), "browser-cnt-016-hostile");
      await localLogin(fixture);
      const applicationStorage = await browserStorage(fixture.page);
      await fixture.page.goto(site.reviewUrl);
      const preview = artifactFrame(fixture.page);
      await expect(preview.locator("#app")).toHaveText("hostile page ran");
      await expect(reviewFrame(fixture.page).locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
      const reviewUrl = fixture.page.url();

      const report = await (await artifactDocument(fixture.page)).evaluate("window.__report");
      expect(report).toEqual({
        alert: "ok: returned",
        cookie: "threw SecurityError",
        localStorage: "ok: x",
        open: "ok: blocked",
        parentLocation: "threw SecurityError",
        pushForeign: "ok: about:srcdoc",
        pushPath: "ok: about:srcdoc",
        sessionStorage: "ok: x",
        topLocation: "threw SecurityError",
      });
      expect(dialogs).toEqual([]);
      expect(popups).toEqual([]);
      expect(fixture.page.url()).toBe(reviewUrl);

      // What the page stored never reached the application or the review frame.
      expect(await browserStorage(fixture.page)).toEqual(applicationStorage);
      const reviewFrameDocument = fixture.page.frames().find((frame) =>
        new URL(frame.url(), "http://invalid").pathname === "/review-frame"
      );
      expect(reviewFrameDocument).toBeDefined();
      expect(await reviewFrameDocument?.evaluate(() => ({
        local: localStorage.getItem("hostile-key"),
        session: sessionStorage.getItem("hostile-key"),
      }))).toEqual({local: null, session: null});
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CNT-016-F: workers from a URL and from a blob do not start, and the page keeps running", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const site = await publishSpa(fixture, [
        ...deckOf("workers", workerRuntime),
        file("assets/worker.js", "postMessage('ready');", js),
      ], "browser-cnt-016-workers");
      await localLogin(fixture);
      await fixture.page.goto(site.reviewUrl);
      const app = artifactFrame(fixture.page).locator("#app");
      await expect(app).toContainText("url: threw SecurityError");
      await expect.poll(() => app.textContent(), {timeout: 5_000}).not.toContain("blob: pending");
      await expect(app).not.toContainText("ready");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
