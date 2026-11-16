import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const faviconFixture =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>\n';

describe("favicon route", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let webAssetsRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    webAssetsRoot = await mkdtemp(path.join(tmpdir(), "artifact-server-favicon-"));
    await writeFile(
      path.join(webAssetsRoot, "review.html"),
      '<!doctype html><link rel="icon" href="/favicon.svg" type="image/svg+xml"><title>Shell</title>',
    );
    await writeFile(path.join(webAssetsRoot, "favicon.svg"), faviconFixture);
    server = await startTestServer(installation, {webAssetsRoot});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(webAssetsRoot, {force: true, recursive: true});
  });

  test("foundation: the icon the Review shell links is served as SVG and revalidated", async () => {
    const shell = await fetch(`${server.baseUrl}/review`);
    expect(await shell.text()).toContain('href="/favicon.svg"');

    const icon = await fetch(`${server.baseUrl}/favicon.svg`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/svg+xml");
    // A fixed name, so a replaced icon must not hide behind an immutable cache.
    expect(icon.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    expect(icon.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await icon.text()).toBe(faviconFixture);

    const etag = icon.headers.get("etag");
    expect(etag).not.toBeNull();
    const revalidated = await fetch(`${server.baseUrl}/favicon.svg`, {
      headers: {"If-None-Match": etag ?? ""},
    });
    expect(revalidated.status).toBe(304);

    const head = await fetch(`${server.baseUrl}/favicon.svg`, {method: "HEAD"});
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("foundation: without a built icon the route answers not found", async () => {
    await rm(path.join(webAssetsRoot, "favicon.svg"));
    await server.stop();
    server = await startTestServer(installation, {webAssetsRoot});
    expect((await fetch(`${server.baseUrl}/favicon.svg`)).status).toBe(404);
  });
});
