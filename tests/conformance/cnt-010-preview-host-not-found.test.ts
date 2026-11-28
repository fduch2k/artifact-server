import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const previewLeaseResponseSchema = z.object({
  baseUrl: z.url(),
  expiresAt: z.string(),
  versionId: z.string(),
});

describe("preview host answers for missing files", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("CNT-010-B CNT-010-F: a missing file on the preview host is a readable cross-origin 404, and nothing else about the host changes", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Listing probe</title>",
      idempotencyKey: "cnt-010-preview-not-found",
      name: "Listing probe",
    });
    const issued = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/versions/${published.body.version.id}/preview-leases?projectId=${published.body.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}, method: "POST"},
    );
    expect(issued.status).toBe(201);
    const lease = previewLeaseResponseSchema.parse(await issued.json());

    const missingPaths = ["_files.json", "project/deck.json", "%2e%2e/etc/passwd"];
    const answers = await Promise.all(missingPaths.map(async (missingPath) => {
      const missing = await fetchVersion(
        server,
        new URL(missingPath, lease.baseUrl).toString(),
        "GET",
        {Origin: "null"},
      );
      return {body: await missing.json(), headers: missing.headers, status: missing.status};
    }));
    for (const missing of answers) {
      expect(missing.status).toBe(404);
      expect(missing.headers.get("access-control-allow-origin")).toBe("*");
      expect(missing.headers.get("access-control-allow-credentials")).toBeNull();
      expect(missing.headers.get("cache-control")).toBe("private, no-store");
      expect(missing.headers.get("set-cookie")).toBeNull();
      expect(missing.body).toEqual({
        error: {code: "VERSION_NOT_FOUND", message: "The version file does not exist."},
      });
    }

    // A forged lease is still refused before any file lookup, and a missing
    // file on the version's own exact-version host keeps its same-origin
    // answer: only the preview host, which Review reads cross-origin, changes.
    const forged = new URL(lease.baseUrl);
    forged.hostname = `review-${"x".repeat(40)}.localhost`;
    const forgedMissing = await fetchVersion(server, new URL("_files.json", forged).toString());
    expect(forgedMissing.status).toBe(401);
    const exactHost = await fetchVersion(
      server,
      new URL("_files.json", published.body.links.version).toString(),
    );
    expect(exactHost.status).toBe(404);
    expect(exactHost.headers.get("access-control-allow-origin")).toBeNull();
  });
});
