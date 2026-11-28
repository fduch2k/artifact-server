import {mkdir, writeFile} from "node:fs/promises";

import {expect, test, type Frame, type FrameLocator, type Page} from "@playwright/test";

import {
  commitStagedUpload,
  createStagedUpload,
  uploadEveryStagedFile,
  type TestSiteFile,
} from "../support/publishing.js";
import {listThreadsOverApi} from "./comment-api.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";

/*
 * Spike (Refs #18): what @plannotator/ui 0.67's srcdoc sandbox shim does for
 * routed single-page apps in today's opaque-origin Review, without live mode.
 * Each test records what it observes into test-results/spike-pn067 so the
 * report can quote the run; assertions pin only what the run established.
 *
 * The routers follow vue-router's history shapes, which is what a Slidev
 * build uses: the hash router pushes a bare `#/2`; the history router keeps
 * its current route in memory and pushes an absolute path.
 */

const entry = (script: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Synthetic deck</title>
    <script type="module" src="/assets/${script}"></script>
  </head>
  <body><main id="app"></main></body>
</html>`;

const slidesAndRender = `
const slides = ["Title slide", "Second slide", "Closing slide"];
const visits = Number(localStorage.getItem("deck-visits") ?? "0") + 1;
localStorage.setItem("deck-visits", String(visits));
function render(index) {
  const app = document.getElementById("app");
  app.replaceChildren();
  const heading = document.createElement("h1");
  heading.id = "slide-title";
  heading.textContent = slides[index];
  const body = document.createElement("p");
  body.id = "slide-body";
  body.textContent = "Body of " + slides[index];
  const status = document.createElement("p");
  status.id = "deck-status";
  status.textContent = "visits " + visits;
  const next = document.createElement("button");
  next.id = "next-slide";
  next.textContent = "Next slide";
  next.addEventListener("click", () => go(Math.min(index + 1, slides.length - 1)));
  app.append(heading, body, status, next);
  window.__deck = {index, href: location.href, errors: window.__deckErrors ?? []};
}
window.__deckErrors = [];
window.addEventListener("error", (event) => window.__deckErrors.push(String(event.message)));
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

/** Default Slidev: a history router, route kept in memory, URL pushed. */
const historyRuntime = `${slidesAndRender}
let current = 0;
function fromPath() {
  const match = /^\\/(\\d+)$/.exec(location.pathname);
  return match ? Math.max(0, Math.min(slides.length - 1, Number(match[1]) - 1)) : 0;
}
function go(index) {
  current = index;
  try {
    history.pushState({index}, "", index === 0 ? "/" : "/" + (index + 1));
  } catch (error) {
    window.__deckErrors.push("pushState: " + error.name);
    location.assign(index === 0 ? "/" : "/" + (index + 1));
    return;
  }
  render(current);
}
current = fromPath();
try {
  history.replaceState({index: current}, "", current === 0 ? "/" : "/" + (current + 1));
} catch (error) {
  window.__deckErrors.push("replaceState: " + error.name);
}
window.addEventListener("popstate", (event) => render(event.state?.index ?? fromPath()));
render(current);
`;

/** Workers from a URL and from a blob, each in isolation. */
const workerRuntime = `
const results = {url: "pending", blob: "pending"};
function show() {
  document.getElementById("app").textContent = "url: " + results.url + "; blob: " + results.blob;
  window.__workers = results;
}
function start(kind, make) {
  try {
    const worker = make();
    worker.addEventListener("message", (event) => { results[kind] = String(event.data); show(); });
    worker.addEventListener("error", (event) => {
      results[kind] = "error event" + (event.message ? ": " + event.message : "");
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

const hashDeck: readonly TestSiteFile[] = [
  file("index.html", entry("hash.js"), html),
  file("assets/hash.js", hashRuntime, js),
];
const historyDeck: readonly TestSiteFile[] = [
  file("index.html", entry("history.js"), html),
  file("assets/history.js", historyRuntime, js),
];
const workerDeck: readonly TestSiteFile[] = [
  file("index.html", entry("workers.js"), html),
  file("assets/workers.js", workerRuntime, js),
  file("assets/worker.js", "postMessage('ready');", js),
];

interface PublishedSite {
  readonly artifactId: string;
  readonly reviewUrl: string;
}

async function publishDeck(
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

async function setAnnotateMode(page: Page, active: boolean): Promise<void> {
  const toggle = page.getByRole("button", {name: /^(Annotate|Interact) mode:/u});
  if ((await toggle.getAttribute("aria-pressed")) !== String(active)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", String(active));
}

async function commentOn(page: Page, selector: string, body: string): Promise<void> {
  await artifactFrame(page).locator(selector).click();
  const composer = reviewFrame(page).getByPlaceholder("Add a comment...");
  await expect(composer).toBeVisible();
  await composer.fill(body);
  await reviewFrame(page).getByRole("button", {name: "Save"}).click();
  await expect(page.getByRole("article").filter({hasText: body})).toBeVisible();
}

async function textOr(frame: FrameLocator, selector: string): Promise<string> {
  const locator = frame.locator(selector);
  return (await locator.count()) > 0 ? ((await locator.first().textContent()) ?? "") : "<absent>";
}

interface DeckState {
  readonly deck: string;
  readonly frameUrl: string;
  readonly markers: number;
  readonly status: string;
  readonly title: string;
}

type Observation = DeckState | number | string | readonly string[];

async function deckState(page: Page): Promise<DeckState> {
  const doc = await artifactDocument(page);
  return {
    frameUrl: doc.url(),
    deck: String(await doc.evaluate("JSON.stringify(window.__deck ?? null)").catch(() => "evaluate failed")),
    title: await textOr(artifactFrame(page), "#slide-title"),
    status: await textOr(artifactFrame(page), "#deck-status"),
    markers: await artifactFrame(page).locator("[data-plannotator-marker]").count(),
  };
}

async function record(name: string, observations: Record<string, Observation>): Promise<void> {
  await mkdir("test-results/spike-pn067", {recursive: true});
  await writeFile(`test-results/spike-pn067/${name}.json`, `${JSON.stringify(observations, null, 2)}\n`);
}

function watchConsole(page: Page, sink: string[]): void {
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") sink.push(message.text());
  });
  page.on("pageerror", (error) => sink.push(`pageerror: ${error.message}`));
}

test.describe("Spike pn067: srcdoc + sandbox shim (0.67)", () => {
  test("hash router with localStorage at startup", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    const consoleLog: string[] = [];
    const observations: Record<string, Observation> = {};
    try {
      watchConsole(fixture.page, consoleLog);
      const deck = await publishDeck(fixture, hashDeck, "spike-hash-router-deck");
      await localLogin(fixture);
      await fixture.page.goto(deck.reviewUrl);
      await expect(artifactFrame(fixture.page).locator("#slide-title")).toHaveText("Title slide");
      observations["start"] = await deckState(fixture.page);

      await commentOn(fixture.page, "#slide-body", "Comment on slide one.");
      await setAnnotateMode(fixture.page, false);
      await artifactFrame(fixture.page).locator("#next-slide").click();
      await expect(artifactFrame(fixture.page).locator("#slide-title")).toHaveText("Second slide");
      await setAnnotateMode(fixture.page, true);
      observations["afterNext"] = await deckState(fixture.page);

      // The slide-one marker sits on the same #slide-body here (no page
      // identity in srcdoc), so the second comment goes on the heading.
      await commentOn(fixture.page, "#slide-title", "Comment on slide two.");
      observations["afterSecondComment"] = await deckState(fixture.page);

      const doc = await artifactDocument(fixture.page);
      await doc.evaluate(() => { window.setTimeout(() => location.reload(), 0); });
      await fixture.page.waitForTimeout(1500);
      observations["afterFrameReload"] = await deckState(fixture.page);

      await fixture.page.reload();
      await expect(artifactFrame(fixture.page).locator("#slide-title")).toBeVisible();
      await fixture.page.waitForTimeout(1000);
      observations["afterReviewReload"] = await deckState(fixture.page);

      const threads = await listThreadsOverApi(fixture, deck.artifactId);
      observations["threads"] = threads.map((thread) => `${thread.body} -> ${JSON.stringify(thread.anchor)}`);
    } finally {
      observations["console"] = consoleLog;
      await record("hash-router", observations);
      await stopBrowserFixture(fixture);
    }
  });

  test("history router (Slidev default)", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    const consoleLog: string[] = [];
    const observations: Record<string, Observation> = {};
    try {
      watchConsole(fixture.page, consoleLog);
      const deck = await publishDeck(fixture, historyDeck, "spike-history-deck");
      await localLogin(fixture);
      await fixture.page.goto(deck.reviewUrl);
      await expect(artifactFrame(fixture.page).locator("#slide-title")).toHaveText("Title slide");
      observations["start"] = await deckState(fixture.page);

      await setAnnotateMode(fixture.page, false);
      await artifactFrame(fixture.page).locator("#next-slide").click();
      await fixture.page.waitForTimeout(1000);
      observations["afterNext"] = await deckState(fixture.page);
      await artifactFrame(fixture.page).locator("#next-slide").click().catch(() => {});
      await fixture.page.waitForTimeout(1000);
      observations["afterSecondNext"] = await deckState(fixture.page);

      const doc = await artifactDocument(fixture.page);
      await doc.evaluate(() => { window.setTimeout(() => location.reload(), 0); });
      await fixture.page.waitForTimeout(1500);
      observations["afterFrameReload"] = await deckState(fixture.page);
      observations["threads"] = (await listThreadsOverApi(fixture, deck.artifactId)).length;
    } finally {
      observations["console"] = consoleLog;
      await record("history-router", observations);
      await stopBrowserFixture(fixture);
    }
  });

  test("workers from a URL and from a blob", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    const consoleLog: string[] = [];
    const observations: Record<string, Observation> = {};
    try {
      watchConsole(fixture.page, consoleLog);
      const deck = await publishDeck(fixture, workerDeck, "spike-worker-deck");
      await localLogin(fixture);
      await fixture.page.goto(deck.reviewUrl);
      await expect(artifactFrame(fixture.page).locator("#app")).toContainText("url:");
      await fixture.page.waitForTimeout(2000);
      observations["app"] = await textOr(artifactFrame(fixture.page), "#app");
    } finally {
      observations["console"] = consoleLog;
      await record("workers", observations);
      await stopBrowserFixture(fixture);
    }
  });
});
