import {expect, test} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const hostileArtifact = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Sandbox probe</title></head>
  <body>
    <p id="probe-parent">parent:pending</p>
    <p id="probe-cookie">cookie:pending</p>
    <p id="probe-fetch">fetch:pending</p>
    <p id="probe-application">application:pending</p>
    <script>
      (function () {
        var report = function (id, value) {
          document.getElementById(id).textContent = value;
        };
        try {
          var title = window.parent.document.title;
          report("probe-parent", "parent:reached:" + title);
        } catch (error) {
          report("probe-parent", "parent:blocked");
        }
        report("probe-cookie", "cookie:[" + document.cookie + "]");
        // A relative request stays on the version's own lease origin.
        fetch("/api/v1/session", {credentials: "include"}).then(
          function (response) { report("probe-fetch", "fetch:lease-origin:" + response.status); },
          function () { report("probe-fetch", "fetch:blocked"); }
        );
        // The application origin, as the page can guess it from its own host.
        var application = location.protocol + "//127.0.0.1:" + location.port;
        fetch(application + "/api/v1/session", {credentials: "include"}).then(
          function (response) { report("probe-application", "application:reached:" + response.status); },
          function () { report("probe-application", "application:blocked"); }
        );
      })();
    </script>
  </body>
</html>`;

test.describe("Review sandbox isolation", () => {
  test("CMT-014-B CMT-014-F: hostile artifact HTML runs sandboxed on its credential-free preview origin", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: hostileArtifact,
        idempotencyKey: "review-sandbox-isolation",
        mediaType: "text/html; charset=utf-8",
        name: "Sandbox probe",
        path: "index.html",
      });
      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
      );

      const reviewFrame = fixture.page.frameLocator(".as-artifact-frame");
      const sandboxElement = reviewFrame.locator("iframe");
      // ADR 0045: same-origin with its own lease host, never the application;
      // still no forms, popups, modals, downloads, or top navigation.
      await expect(sandboxElement).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
      const source = await sandboxElement.getAttribute("src");
      expect(new URL(source ?? "").hostname).toMatch(/^review-[a-f0-9]+\.localhost$/u);
      expect(new URL(source ?? "").origin).not.toBe(new URL(fixture.server.baseUrl).origin);

      const artifactFrame = reviewFrame.frameLocator("iframe");
      await expect(artifactFrame.locator("#probe-parent")).toHaveText("parent:blocked");
      await expect(artifactFrame.locator("#probe-cookie")).toHaveText("cookie:[]");
      await expect(artifactFrame.locator("#probe-fetch")).toHaveText("fetch:lease-origin:404");
      await expect(artifactFrame.locator("#probe-application")).toHaveText("application:blocked");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
