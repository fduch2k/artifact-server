import {expect, test, type Frame, type FrameLocator, type Page} from "@playwright/test";

import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
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
 * A minimal stand-in for a `slidev build` deck (ADR 0045): a root-relative
 * module entry, a history router that normalises the URL at startup and
 * pushes a path per slide, unguarded `localStorage` at startup, a worker
 * started from a URL and one from a blob, and several pages. Each of these
 * broke the deck in the former opaque-origin `srcdoc` Review.
 */
const deckEntry = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Synthetic deck</title>
    <script type="module" src="/assets/deck.js"></script>
  </head>
  <body><main id="app"></main></body>
</html>`;

const deckRuntime = `const visits = Number(localStorage.getItem("deck-visits") ?? "0") + 1;
localStorage.setItem("deck-visits", String(visits));
const slides = [
  {path: "/", title: "Title slide"},
  {path: "/2", title: "Second slide"},
  {path: "/3", title: "Closing slide"},
];
const state = {blob: "blob worker pending", worker: "worker pending"};
function current() {
  return slides.find((slide) => slide.path === location.pathname) ?? slides[0];
}
function render() {
  const slide = current();
  const index = slides.indexOf(slide);
  const app = document.getElementById("app");
  app.replaceChildren();
  const heading = document.createElement("h1");
  heading.id = "slide-title";
  heading.textContent = slide.title;
  const body = document.createElement("p");
  body.id = "slide-body";
  body.textContent = "Body of " + slide.title;
  const status = document.createElement("p");
  status.id = "deck-status";
  status.textContent = "visits " + visits + "; " + state.worker + "; " + state.blob;
  const next = document.createElement("button");
  next.id = "next-slide";
  next.textContent = "Next slide";
  next.addEventListener("click", () => {
    const target = slides[Math.min(index + 1, slides.length - 1)];
    history.pushState({index: index + 1}, "", target.path);
    render();
  });
  app.append(heading, body, status, next);
}
// Routers rewrite the URL to their canonical form before the first render.
history.replaceState({index: 0}, "", location.pathname);
window.addEventListener("popstate", render);
const worker = new Worker("/assets/worker.js");
worker.addEventListener("message", (event) => {
  state.worker = event.data;
  render();
});
const blobWorker = new Worker(URL.createObjectURL(
  new Blob(["postMessage('blob worker ready')"], {type: "text/javascript"}),
));
blobWorker.addEventListener("message", (event) => {
  state.blob = event.data;
  render();
});
render();
`;

const deckWorker = `postMessage("worker ready");`;

function file(path: string, content: string, mediaType: string): TestSiteFile {
  return {bytes: new TextEncoder().encode(content), mediaType, path};
}

const deckFiles: readonly TestSiteFile[] = [
  file("index.html", deckEntry, "text/html; charset=utf-8"),
  file("assets/deck.js", deckRuntime, "text/javascript; charset=utf-8"),
  file("assets/worker.js", deckWorker, "text/javascript; charset=utf-8"),
];

interface PublishedSite {
  readonly artifactId: string;
  readonly reviewUrl: string;
  readonly versionId: string;
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
    {accessSetting: "account_required", kind: "new_artifact", name: "Synthetic deck"},
  );
  expect(committed.response.status).toBe(201);
  const artifactId = committed.body.artifact.id;
  const versionId = committed.body.version.id;
  return {
    artifactId,
    reviewUrl: `${fixture.server.baseUrl}/review?project=prj_default&artifact=${artifactId}&version=${versionId}`,
    versionId,
  };
}

function reviewFrame(page: Page): FrameLocator {
  return page.frameLocator(".as-artifact-frame");
}

function artifactFrame(page: Page): FrameLocator {
  return reviewFrame(page).frameLocator("iframe");
}

/** The artifact document's own frame, found by its preview lease host. */
async function artifactDocument(page: Page): Promise<Frame> {
  let found: Frame | undefined;
  await expect.poll(() => {
    found = page.frames().find((frame) => new URL(frame.url()).hostname.startsWith("review-"));
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

test.describe("Review runs a version live on its preview origin", () => {
  test("CNT-012-B: a routed deck with storage and workers renders, navigates, reloads, and keeps comments on their pages", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const deck = await publishDeck(fixture, deckFiles, "cnt-012-live-deck");
      await localLogin(fixture);
      await fixture.page.goto(deck.reviewUrl);

      const sandbox = reviewFrame(fixture.page).locator("iframe");
      await expect(sandbox).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
      const artifact = artifactFrame(fixture.page);
      await expect(artifact.locator("#slide-title")).toHaveText("Title slide");
      await expect(artifact.locator("#deck-status"))
        .toHaveText("visits 1; worker ready; blob worker ready");
      const artifactPage = await artifactDocument(fixture.page);
      expect(new URL(artifactPage.url()).pathname).toBe("/");

      await commentOn(fixture.page, "#slide-body", "Tighten the title slide.");

      // Annotate mode keeps clicks for pinning comments; the reviewer pages
      // through the deck in Interact mode.
      await setAnnotateMode(fixture.page, false);
      await artifact.locator("#next-slide").click();
      await expect(artifact.locator("#slide-title")).toHaveText("Second slide");
      await setAnnotateMode(fixture.page, true);
      await expect.poll(() => new URL(artifactPage.url()).pathname).toBe("/2");
      // The title slide's marker belongs to its page and is not painted here.
      await expect(artifact.locator("[data-plannotator-marker]")).toHaveCount(0);

      await commentOn(fixture.page, "#slide-body", "Second slide needs a chart.");

      // A reload inside the frame keeps the page (SPA routing serves the entry
      // for /2), the bridge, and the storage on the lease origin.
      await artifactPage.evaluate(() => {
        window.setTimeout(() => location.reload(), 0);
      });
      await expect(artifact.locator("#slide-title")).toHaveText("Second slide");
      await expect(artifact.locator("#deck-status"))
        .toHaveText("visits 2; worker ready; blob worker ready");
      await expect(artifact.locator("[data-plannotator-marker]")).toHaveCount(1);

      const threads = await listThreadsOverApi(fixture, deck.artifactId);
      const pageOf = (body: string): unknown => {
        const anchor = threads.find((thread) => thread.body === body)?.anchor;
        return typeof anchor === "object" && anchor !== null
          ? Reflect.get(anchor, "pageUrl")
          : undefined;
      };
      expect(threads).toHaveLength(2);
      expect(pageOf("Tighten the title slide.")).toBe("/");
      expect(pageOf("Second slide needs a chart.")).toBe("/2");

      // Show in page on the first slide's comment opens its page.
      const firstComment = fixture.page.getByRole("article").filter({
        hasText: "Tighten the title slide.",
      });
      await firstComment.getByRole("button", {name: /Show in page/u}).click();
      await expect(artifact.locator("#slide-title")).toHaveText("Title slide");
      await expect(artifact.locator("[data-plannotator-marker]")).toHaveCount(1);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CNT-012-F CMT-014-F: hostile artifact code on the preview origin cannot reach the application, comment, forge the bridge, or navigate the top window", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Hostile probe</title><p id=\"probe-target\">Probe target</p>",
        idempotencyKey: "cnt-012-hostile-artifact",
        name: "Hostile probe",
      });
      const artifactId = published.body.artifact.id;
      const versionId = published.body.version.id;
      await localLogin(fixture);
      const reviewUrl = `${fixture.server.baseUrl}/review?project=prj_default&artifact=${artifactId}&version=${versionId}`;
      await fixture.page.goto(reviewUrl);
      await expect(artifactFrame(fixture.page).locator("#probe-target")).toBeVisible();
      await expect(reviewFrame(fixture.page).locator("iframe"))
        .toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
      const artifactPage = await artifactDocument(fixture.page);
      const applicationOrigin = new URL(fixture.server.baseUrl).origin;

      // Everything below runs as the artifact's own JavaScript, in its realm.
      const probes = await artifactPage.evaluate(async ({applicationOrigin: appOrigin, artifactId: artifact, versionId: version}) => {
        const outcome = (run: () => unknown): string => {
          try {
            run();
            return "reached";
          } catch {
            return "blocked";
          }
        };
        const reach = async (url: string, init: RequestInit): Promise<string> => {
          try {
            const response = await fetch(url, {...init, credentials: "include"});
            return `read:${response.status}`;
          } catch {
            return "blocked";
          }
        };
        const config: unknown = Reflect.get(window, "__plannotatorLiveConfig");
        const editorOrigins = typeof config === "object" && config !== null
          ? (Reflect.get(config, "editorOrigins") as string[])
          : [];
        const session = await Promise.all(
          [appOrigin, ...editorOrigins].map((origin) => reach(`${origin}/api/v1/session`, {})),
        );
        const comment = await reach(
          `${appOrigin}/api/v1/artifacts/${artifact}/versions/${version}/comments?projectId=prj_default`,
          {
            body: JSON.stringify({anchor: null, body: "Posted by the artifact itself"}),
            headers: {"Content-Type": "application/json"},
            method: "POST",
          },
        );
        await fetch(`${appOrigin}/api/v1/artifacts/${artifact}/versions/${version}/comments?projectId=prj_default`, {
          body: JSON.stringify({anchor: null, body: "Posted blind by the artifact"}),
          credentials: "include",
          method: "POST",
          mode: "no-cors",
        }).catch(() => undefined);
        return {
          comment,
          cookieNames: document.cookie.split(";").map((part) => part.trim().split("=")[0]).filter(Boolean),
          opener: window.open("about:blank") === null ? "blocked" : "reached",
          parent: outcome(() => window.parent.document.title),
          session,
          storage: outcome(() => localStorage.setItem("probe", "own origin storage")),
          top: outcome(() => window.top?.document.title),
          topNavigation: outcome(() => {
            if (window.top !== null) window.top.location.href = `${appOrigin}/navigated-by-artifact`;
          }),
        };
      }, {applicationOrigin, artifactId, versionId});

      expect(probes.parent).toBe("blocked");
      expect(probes.top).toBe("blocked");
      expect(probes.topNavigation).toBe("blocked");
      expect(probes.opener).toBe("blocked");
      expect(probes.session.every((answer) => answer === "blocked")).toBe(true);
      expect(probes.comment).toBe("blocked");
      expect(probes.cookieNames).toEqual([]);
      // Its own origin's storage is what it newly gains (ADR 0045).
      expect(probes.storage).toBe("reached");
      expect(fixture.page.url()).toBe(reviewUrl);

      // Bridge and review-frame messages forged without the live token, with
      // a wrong one, or aimed at the shell's own protocol do nothing.
      await artifactPage.evaluate(() => {
        const rect = {bottom: 40, height: 20, left: 10, right: 110, top: 20, width: 100, x: 10, y: 20};
        const selection = {pinpoint: true, rect, text: "Forged selection", type: "plannotator-bridge-selection"};
        const submit = {anchor: null, body: "Forged submit", originalText: "", type: "as-review-submit", v: 1};
        for (const target of [window.parent, window.top]) {
          if (target === null) continue;
          target.postMessage(selection, "*");
          target.postMessage({...selection, token: "not-the-live-token"}, "*");
          target.postMessage(submit, "*");
        }
      });
      await fixture.page.waitForTimeout(500);
      await expect(reviewFrame(fixture.page).getByPlaceholder("Add a comment...")).toHaveCount(0);

      // With the live token, which its own realm can read, the artifact can
      // at most open the composer; posting still needs the reviewer.
      await artifactPage.evaluate(() => {
        const config: unknown = Reflect.get(window, "__plannotatorLiveConfig");
        const token = typeof config === "object" && config !== null ? Reflect.get(config, "token") : "";
        const rect = {bottom: 40, height: 20, left: 10, right: 110, top: 20, width: 100, x: 10, y: 20};
        for (const origin of [window.location.origin.replace(/^http:\/\/[^.]+\./u, "http://"), "http://127.0.0.1:" + window.location.port]) {
          window.parent.postMessage({pinpoint: true, rect, text: "Token selection", token, type: "plannotator-bridge-selection"}, origin);
        }
      });
      // The same message shape with the token does reach the viewer, so the
      // refusals above were the token check, not a malformed message.
      await expect(reviewFrame(fixture.page).getByPlaceholder("Add a comment...")).toBeVisible();
      await fixture.page.waitForTimeout(500);
      expect(await listThreadsOverApi(fixture, artifactId)).toHaveLength(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CNT-012-F: the review frame refuses to load an artifact source on the application origin or off its live origin", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Source probe</title><p id=\"probe-target\">Source probe</p>",
        idempotencyKey: "cnt-012-source-refusal",
        name: "Source probe",
      });
      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
      );
      await expect(artifactFrame(fixture.page).locator("#probe-target")).toBeVisible();
      const applicationOrigin = new URL(fixture.server.baseUrl).origin;
      const refused = reviewFrame(fixture.page).getByText("Review could not open this version's preview.");
      for (const source of [
        {liveOrigin: applicationOrigin, src: `${applicationOrigin}/review`},
        {liveOrigin: "http://review-a.localhost:1", src: `${applicationOrigin}/review`},
        {liveOrigin: "null", src: "javascript:alert(1)"},
      ]) {
        await fixture.page.evaluate((message) => {
          const frame = window.document.querySelector<HTMLIFrameElement>(".as-artifact-frame");
          frame?.contentWindow?.postMessage(
            {...message, liveToken: "token", type: "as-review-source", v: 1},
            window.location.origin,
          );
        }, source);
        await expect(refused).toBeVisible();
        await expect(reviewFrame(fixture.page).locator("iframe")).toHaveCount(0);
      }
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
