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

const svgFixture =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>\n';
// Byte-exact stand-ins: the route must pass binary icons through untouched.
const icoFixture = new Uint8Array([0, 0, 1, 0, 1, 0, 32, 32, 0, 0, 1, 0, 32, 0, 7, 0]);
const pngFixture = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const icons = [
  {body: new TextEncoder().encode(svgFixture), file: "favicon.svg", type: "image/svg+xml"},
  {body: icoFixture, file: "favicon.ico", type: "image/x-icon"},
  {body: pngFixture, file: "apple-touch-icon.png", type: "image/png"},
] as const;

describe("favicon routes", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let webAssetsRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    webAssetsRoot = await mkdtemp(path.join(tmpdir(), "artifact-server-favicon-"));
    await writeFile(
      path.join(webAssetsRoot, "review.html"),
      [
        "<!doctype html>",
        '<link rel="icon" href="/favicon.ico" sizes="32x32" />',
        '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
        '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
        "<title>Shell</title>",
      ].join(""),
    );
    await Promise.all(icons.map((icon) =>
      writeFile(path.join(webAssetsRoot, icon.file), icon.body)));
    server = await startTestServer(installation, {webAssetsRoot});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
    await rm(webAssetsRoot, {force: true, recursive: true});
  });

  test("foundation: every icon the Review shell links is served with its type and revalidated", async () => {
    expect.assertions(icons.length * 10);
    const shell = await (await fetch(`${server.baseUrl}/review`)).text();
    await Promise.all(icons.map(async (icon) => {
      expect(shell).toContain(`href="/${icon.file}"`);

      const response = await fetch(`${server.baseUrl}/${icon.file}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(icon.type);
      // A fixed name, so a replaced icon must not hide behind an immutable cache.
      expect(response.headers.get("cache-control")).toBe("no-cache, must-revalidate");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(icon.body);

      const etag = response.headers.get("etag");
      expect(etag).not.toBeNull();
      const revalidated = await fetch(`${server.baseUrl}/${icon.file}`, {
        headers: {"If-None-Match": etag ?? ""},
      });
      expect(revalidated.status).toBe(304);

      const head = await fetch(`${server.baseUrl}/${icon.file}`, {method: "HEAD"});
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    }));
  });

  test("foundation: an icon missing from the build answers not found", async () => {
    await rm(path.join(webAssetsRoot, "favicon.ico"));
    await server.stop();
    server = await startTestServer(installation, {webAssetsRoot});
    expect((await fetch(`${server.baseUrl}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`${server.baseUrl}/favicon.svg`)).status).toBe(200);
  });
});
