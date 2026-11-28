import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  uploadEveryStagedFile,
  type TestSiteFile,
} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

/*
 * The web build copies the pinned viewer's bridge into review-bridge.json.
 * These tests serve a synthetic one from a temporary web root, so they prove
 * where and how the preview host inserts it without depending on a build.
 */
const syntheticBridge = {
  bootstrap: "/* synthetic live bootstrap */",
  bridge: "/* synthetic annotation bridge */",
  css: "[data-synthetic-annotation]{outline:1px solid red}",
};

const leaseSchema = z.object({
  baseUrl: z.url(),
  bridgeToken: z.string().regex(/^[a-f0-9]{64}$/u),
  expiresAt: z.string(),
  versionId: z.string(),
});

const renewedSchema = z.object({expiresAt: z.string(), versionId: z.string()});

const errorSchema = z.object({error: z.object({code: z.string(), message: z.string()})});

const liveConfigSchema = z.object({
  css: z.string(),
  editorOrigins: z.array(z.string()),
  frameDepth: z.literal(2),
  hostTheme: z.boolean(),
  token: z.string(),
});

const bootstrapSchema = z.object({bootstrapUrl: z.url()});

const entryHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<title>Routed deck</title>
<script type="module" src="/assets/app.js"></script>
</head>
<body><main id="app"></main></body>
</html>`;

const appScript = "document.getElementById('app').textContent = 'deck';";
const bridgeMarker = "__plannotatorLiveConfig";

function file(filePath: string, content: string, mediaType: string): TestSiteFile {
  return {bytes: new TextEncoder().encode(content), mediaType, path: filePath};
}

const siteFiles: readonly TestSiteFile[] = [
  file("index.html", entryHtml, "text/html; charset=utf-8"),
  file(
    "notes/page.html",
    '<!doctype html><meta name="plannotator-theme" content="host"><title>Notes</title><p>Notes</p>',
    "text/html; charset=utf-8",
  ),
  file("assets/app.js", appScript, "text/javascript; charset=utf-8"),
];

/** Pull the live configuration the preview host put in front of the bridge. */
function liveConfigOf(html: string): z.infer<typeof liveConfigSchema> {
  const match = /window\.__plannotatorLiveConfig=(\{.*?\});\n/su.exec(html);
  if (match?.[1] === undefined) throw new Error("No live configuration was injected.");
  return liveConfigSchema.parse(JSON.parse(match[1]));
}

describe("Review preview host", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let webRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    webRoot = await mkdtemp(path.join(tmpdir(), "artifact-server-review-bridge-"));
    await writeFile(path.join(webRoot, "review-bridge.json"), JSON.stringify(syntheticBridge));
    server = await startTestServer(installation, {webAssetsRoot: webRoot});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(webRoot, {force: true, recursive: true});
  });

  async function publishSite(
    accessSetting: "account_required" | "public_link",
    idempotencyKey: string,
  ): Promise<{readonly artifactId: string; readonly projectId: string; readonly versionId: string; readonly versionUrl: string}> {
    const planned = await createStagedUpload(
      server,
      installation,
      "index.html",
      siteFiles,
      undefined,
      "spa",
    );
    const uploads = await uploadEveryStagedFile(installation, planned.body, siteFiles);
    expect(uploads.every((response) => response.status === 200)).toBe(true);
    const committed = await commitStagedUpload(installation, planned.body, idempotencyKey, {
      accessSetting,
      kind: "new_artifact",
      name: "Routed deck",
    });
    expect(committed.response.status).toBe(201);
    return {
      artifactId: committed.body.artifact.id,
      projectId: committed.body.artifact.projectId,
      versionId: committed.body.version.id,
      versionUrl: committed.body.links.version,
    };
  }

  function leaseEndpoint(site: {readonly artifactId: string; readonly projectId: string; readonly versionId: string}): string {
    return `${server.baseUrl}/api/v1/artifacts/${site.artifactId}/versions/${site.versionId}/preview-leases?projectId=${site.projectId}`;
  }

  async function issueLease(site: {readonly artifactId: string; readonly projectId: string; readonly versionId: string}): Promise<z.infer<typeof leaseSchema>> {
    const issued = await fetch(leaseEndpoint(site), {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
      method: "POST",
    });
    expect(issued.status).toBe(201);
    return leaseSchema.parse(await issued.json());
  }

  test("CNT-013-B: the preview host serves each inline HTML document of the version with the live bridge, and nothing else changes", async () => {
    const site = await publishSite("account_required", "cnt-013-preview-bridge");
    const lease = await issueLease(site);

    const entry = await fetchVersion(server, lease.baseUrl);
    expect(entry.status).toBe(200);
    const html = await entry.text();
    expect(entry.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(entry.headers.get("cache-control")).toBe("private, no-store");
    expect(entry.headers.get("etag")).toBeNull();
    expect(entry.headers.get("access-control-allow-origin")).toBeNull();
    expect(entry.headers.get("set-cookie")).toBeNull();
    expect(entry.headers.get("content-length")).toBe(String(new TextEncoder().encode(html).byteLength));

    const config = liveConfigOf(html);
    expect(config.token).toBe(lease.bridgeToken);
    expect(config.hostTheme).toBe(false);
    expect(config.css).toBe(syntheticBridge.css);
    expect(config.editorOrigins).toContain(new URL(server.baseUrl).origin);
    expect(config.editorOrigins.every((origin) => new URL(origin).port === String(server.port)))
      .toBe(true);
    expect(html).toContain(syntheticBridge.bootstrap);
    expect(html).toContain(syntheticBridge.bridge);
    // Inserted before </head>: the document's own charset stays first, and
    // its own module script and body are untouched.
    expect(html.indexOf("<meta charset=\"utf-8\">")).toBeLessThan(html.indexOf(bridgeMarker));
    expect(html.indexOf(bridgeMarker)).toBeLessThan(html.indexOf("</head>"));
    expect(html).toContain('<script type="module" src="/assets/app.js"></script>');
    expect(html).toContain('<body><main id="app"></main></body>');
    // An authored CSP meta would block the inline bridge; the viewer's srcdoc
    // builder removed it, and so does the preview host.
    expect(html).not.toMatch(/http-equiv="Content-Security-Policy"/iu);

    // Another HTML file and a frame reload on a deep SPA path carry it too.
    const nested = await fetchVersion(server, new URL("notes/page.html", lease.baseUrl).toString());
    const nestedConfig = liveConfigOf(await nested.text());
    expect(nestedConfig.token).toBe(lease.bridgeToken);
    // The viewer's host-theme opt-in is read from the served document.
    expect(nestedConfig.hostTheme).toBe(true);
    const deepReload = await fetchVersion(server, new URL("/3", lease.baseUrl).toString(), "GET", {
      Accept: "text/html",
      "Sec-Fetch-Dest": "iframe",
      "Sec-Fetch-Mode": "navigate",
    });
    expect(deepReload.status).toBe(200);
    const deepHtml = await deepReload.text();
    expect(deepHtml).toContain("<title>Routed deck</title>");
    expect(liveConfigOf(deepHtml).token).toBe(lease.bridgeToken);

    // Scripts, styles, and data are served byte for byte as stored.
    const script = await fetchVersion(server, new URL("/assets/app.js", lease.baseUrl).toString());
    expect(await script.text()).toBe(appScript);
    expect(script.headers.get("etag")).not.toBeNull();

    const head = await fetchVersion(server, lease.baseUrl, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    // A second lease is a different origin with a different bridge token.
    const second = await issueLease(site);
    expect(second.bridgeToken).not.toBe(lease.bridgeToken);
    expect(new URL(second.baseUrl).origin).not.toBe(new URL(lease.baseUrl).origin);
  });

  test("CNT-013-F: exact-version, current, and public-link hosts never carry the bridge, and a forged lease is refused before any document is built", async () => {
    const publicSite = await publishSite("public_link", "cnt-013-public-site");
    const publicCurrent = await fetchVersion(server, publicSite.versionUrl);
    expect(publicCurrent.status).toBe(200);
    expect(await publicCurrent.text()).toBe(entryHtml);
    const publicPage = await fetchVersion(server, new URL("notes/page.html", publicSite.versionUrl).toString());
    expect(await publicPage.text()).not.toContain(bridgeMarker);

    const privateSite = await publishSite("account_required", "cnt-013-private-site");
    const issued = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${privateSite.artifactId}/content-sessions`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"},
    );
    expect(issued.status).toBe(201);
    const {bootstrapUrl} = bootstrapSchema.parse(await issued.json());
    const exchange = await fetchVersion(server, bootstrapUrl);
    expect(exchange.status).toBe(200);
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeDefined();
    const exact = await fetchVersion(server, privateSite.versionUrl, "GET", {Cookie: cookie ?? ""});
    expect(exact.status).toBe(200);
    expect(await exact.text()).toBe(entryHtml);
    expect(exact.headers.get("etag")).not.toBeNull();

    const lease = await issueLease(privateSite);
    const forged = new URL(lease.baseUrl);
    forged.hostname = `review-${"0".repeat(56)}.localhost`;
    const refused = await fetchVersion(server, forged.toString());
    expect(refused.status).toBe(401);
    expect(await refused.text()).not.toContain(bridgeMarker);
  });

  test("CNT-014-B: Review renews its own lease while the view is open, without changing its origin", async () => {
    const site = await publishSite("account_required", "cnt-014-lease-renewal");
    const lease = await issueLease(site);
    const renewed = await fetch(`${leaseEndpoint(site).replace("/preview-leases?", "/preview-leases/renewals?")}`, {
      body: JSON.stringify({baseUrl: lease.baseUrl}),
      headers: {
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(renewed.status).toBe(200);
    const body = renewedSchema.parse(await renewed.json());
    expect(body.versionId).toBe(site.versionId);
    expect(Date.parse(body.expiresAt)).toBeGreaterThanOrEqual(Date.parse(lease.expiresAt));
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    const stillServed = await fetchVersion(server, lease.baseUrl);
    expect(stillServed.status).toBe(200);
  });

  test("preview lease renewal over HTTP refuses anonymous, foreign-route, forged, non-lease, and malformed requests", async () => {
    const site = await publishSite("account_required", "cnt-014-renewal-hostile");
    const other = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Other</title>",
      idempotencyKey: "cnt-014-other-artifact",
      name: "Other artifact",
    });
    const lease = await issueLease(site);
    const renewalUrl = (artifactId: string, versionId: string): string =>
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}/preview-leases/renewals?projectId=${site.projectId}`;
    const renew = (url: string, baseUrl: string, authorized = true): Promise<Response> =>
      fetch(url, {
        body: JSON.stringify({baseUrl}),
        headers: {
          ...(authorized ? {Authorization: `Bearer ${installation.apiToken}`} : {}),
          "Content-Type": "application/json",
        },
        method: "POST",
      });

    expect((await renew(renewalUrl(site.artifactId, site.versionId), lease.baseUrl, false)).status)
      .toBe(401);

    const expectExpired = async (response: Response): Promise<void> => {
      expect(response.status).toBe(410);
      expect(errorSchema.parse(await response.json()).error.code).toBe("PREVIEW_LEASE_EXPIRED");
    };
    // Another artifact's route cannot extend this lease.
    await expectExpired(await renew(
      renewalUrl(other.body.artifact.id, other.body.version.id),
      lease.baseUrl,
    ));
    // A forged lease, a non-lease content host, and a foreign host are refused.
    const forged = new URL(lease.baseUrl);
    forged.hostname = `review-${"0".repeat(56)}.localhost`;
    await expectExpired(await renew(renewalUrl(site.artifactId, site.versionId), forged.toString()));
    await expectExpired(await renew(renewalUrl(site.artifactId, site.versionId), site.versionUrl));
    await expectExpired(await renew(
      renewalUrl(site.artifactId, site.versionId),
      "https://review-attacker.example.test/",
    ));
    const malformed = await fetch(renewalUrl(site.artifactId, site.versionId), {
      body: JSON.stringify({baseUrl: lease.baseUrl, extra: true}),
      headers: {Authorization: `Bearer ${installation.apiToken}`, "Content-Type": "application/json"},
      method: "POST",
    });
    expect(malformed.status).toBe(422);
  });
});
