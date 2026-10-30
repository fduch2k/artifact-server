import {createServer, type Server} from "node:http";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";

import {z} from "zod";
import {exportJWK, generateKeyPair, SignJWT, type JWK} from "jose";
import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const apiToken = "cloudflare-oidc-test-api-token-00000001";
const origin = "https://artifacts.example.test";
const contentDomain = "content.example.test";
const clientId = "artifact-server-cloudflare";

const assignedAddressSchema = z.object({
  port: z.number().int().positive(),
});
const personalSessionSchema = z.object({
  capabilities: z.object({personalApiKeys: z.unknown()}),
});
const notReadySchema = z.object({
  error: z.string(),
  message: z.string(),
}).loose();

let issuerOrigin: string;
let issuer: Server;
let signingKey: CryptoKey;
const issuedTokens = new Map<string, string>();

beforeAll(async () => {
  const signing = await generateKeyPair("ES256");
  signingKey = signing.privateKey;
  issuer = await startDiscoveryStub({
    ...await exportJWK(signing.publicKey),
    alg: "ES256",
    kid: "worker-oidc-test",
    use: "sig",
  });
  const address = assignedAddressSchema.parse(issuer.address());
  issuerOrigin =
    `http://127.0.0.1:${address.port}/cdn-cgi/access/sso/oidc/${clientId}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    issuer.close((cause) => cause === undefined ? resolve() : reject(cause));
  });
});

describe("Cloudflare Worker browser-login provider", () => {
  it("AUTH-029: configured OIDC policy admits a new Worker member and rejects an unlisted domain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-server-oidc-admission-"));
    const worker = await startWorker(directory, {
      ARTIFACT_SERVER_OIDC_AUTO_ADMIT: "true",
      ARTIFACT_SERVER_OIDC_ALLOWED_EMAIL_DOMAINS: " EXAMPLE.TEST ",
      ARTIFACT_SERVER_OIDC_CLIENT_ID: clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: `${issuerOrigin}/`,
    });
    try {
      expect((await completeWorkerLogin(
        worker, "administrator@example.test", "administrator",
      )).status).toBe(303);
      const admitted = await completeWorkerLogin(
        worker, "new-member@example.test", "new-member",
      );
      expect(admitted.status).toBe(303);
      const sessionCookie = admitted.headers.getSetCookie()
        .find((cookie) => cookie.startsWith("__Host-artifact_session="))
        ?.split(";")[0];
      if (sessionCookie === undefined) throw new Error("Missing admitted session.");
      const session = await worker.fetch(`${origin}/api/v1/session`, {
        headers: {Cookie: sessionCookie},
      });
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({
        principal: {kind: "human", membershipRole: "member"},
      });
      expect((await completeWorkerLogin(
        worker, "unlisted@attacker.test", "unlisted",
      )).status).toBe(403);
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);

  it("AUTH-034: the Worker advertises the operator's personal key policy to a signed-in member", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-server-personal-keys-"));
    const worker = await startWorker(directory, {
      ARTIFACT_SERVER_OIDC_AUTO_ADMIT: "true",
      ARTIFACT_SERVER_OIDC_CLIENT_ID: clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: `${issuerOrigin}/`,
      ARTIFACT_SERVER_PERSONAL_API_KEYS: "true",
      ARTIFACT_SERVER_PERSONAL_API_KEY_MAX_DAYS: "60",
    });
    try {
      expect((await completeWorkerLogin(
        worker, "administrator@example.test", "administrator",
      )).status).toBe(303);
      const admitted = await completeWorkerLogin(worker, "member@example.test", "member");
      expect(admitted.status).toBe(303);
      const cookie = admitted.headers.getSetCookie()
        .map((entry) => entry.split(";")[0] ?? "").join("; ");
      const session = await worker.fetch(`${origin}/api/v1/session`, {
        headers: {Cookie: cookie},
      });
      expect(session.status).toBe(200);
      expect(personalSessionSchema.parse(await session.json()).capabilities.personalApiKeys)
        .toEqual({maxLifetimeDays: 60});
      const keys = await worker.fetch(`${origin}/api/v1/personal-api-keys`, {
        headers: {Cookie: cookie},
      });
      expect(keys.status).toBe(200);
      expect(await keys.json()).toEqual({apiKeys: []});
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);

  it.each([
    {ARTIFACT_SERVER_PERSONAL_API_KEYS: "yes"},
    {ARTIFACT_SERVER_PERSONAL_API_KEYS: "true", ARTIFACT_SERVER_PERSONAL_API_KEY_MAX_DAYS: "0"},
  ])("AUTH-034: refuses invalid personal key configuration %j", async (settings) => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-server-personal-key-policy-"));
    const worker = await startWorker(directory, {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: issuerOrigin,
      ...settings,
    });
    try {
      const ready = await worker.fetch(`${origin}/ready`);
      expect(ready.status).toBe(503);
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);

  it("AUTH-037: the Worker slides a D1 browser session forward on use", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-server-sliding-sessions-"));
    const settings = {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: `${issuerOrigin}/`,
      ARTIFACT_SERVER_SESSION_IDLE_DAYS: "3",
    };
    const idleWindow = 3 * 24 * 60 * 60 * 1_000;
    let worker: Unstable_DevWorker | null = await startWorker(directory, settings);
    try {
      const signedInAt = Date.now();
      const login = await completeWorkerLogin(worker, "administrator@example.test", "administrator");
      expect(login.status).toBe(303);
      const cookies = login.headers.getSetCookie();
      expectNear(cookieExpires(cookies, "__Host-artifact_session"), signedInAt + idleWindow);
      const cookie = cookies.map((entry) => entry.split(";")[0] ?? "").join("; ");

      // Age the stored session as if its last renewal were days ago, then use it.
      await worker.stop();
      worker = null;
      const agedExpiry = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
      await withD1Database(directory, (database) => {
        database.prepare("UPDATE application_sessions SET expires_at = ?").run(agedExpiry);
      });
      worker = await startWorker(directory, settings);
      const usedAt = Date.now();
      const used = await worker.fetch(`${origin}/api/v1/session`, {headers: {Cookie: cookie}});
      expect(used.status).toBe(200);
      const renewed = used.headers.getSetCookie();
      expectNear(cookieExpires(renewed, "__Host-artifact_session"), usedAt + idleWindow);
      expectNear(cookieExpires(renewed, "__Host-artifact_csrf"), usedAt + idleWindow);
      await worker.stop();
      worker = null;
      await withD1Database(directory, (database) => {
        const stored = z.object({expiresAt: z.string()}).parse(database.prepare(
          "SELECT expires_at AS expiresAt FROM application_sessions",
        ).get()).expiresAt;
        expectNear(Date.parse(stored), usedAt + idleWindow);
      });
    } finally {
      await worker?.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);

  it("AUTH-037: refuses a malformed session idle window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-server-session-idle-policy-"));
    const worker = await startWorker(directory, {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: issuerOrigin,
      ARTIFACT_SERVER_SESSION_IDLE_DAYS: "0",
    });
    try {
      const ready = await worker.fetch(`${origin}/ready`);
      expect(ready.status).toBe(503);
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);

  it("starts generic OIDC login from a path-based issuer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-server-oidc-"));
    const worker = await startWorker(directory, {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: issuerOrigin,
    });
    try {
      const started = await worker.fetch(`${origin}/auth/login`, {
        redirect: "manual",
      });
      expect(started.status).toBe(302);
      const location = new URL(started.headers.get("location") ?? "");
      expect(location.origin).toBe(new URL(issuerOrigin).origin);
      expect(location.pathname).toBe(
        `/cdn-cgi/access/sso/oidc/${clientId}/authorize`,
      );
      expect(location.searchParams.get("client_id")).toBe(clientId);
      expect(location.searchParams.get("redirect_uri"))
        .toBe(`${origin}/auth/callback`);
      expect(location.searchParams.get("response_type")).toBe("code");
      expect(location.searchParams.get("scope")).toBe("openid email profile");
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("code_challenge")).toBeTruthy();
      expect(location.searchParams.get("state")).toBeTruthy();
      expect(location.searchParams.get("nonce")).toBeTruthy();
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);

  it("refuses to start with both WorkOS and OIDC configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-server-oidc-both-"));
    const worker = await startWorker(directory, {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: issuerOrigin,
      ARTIFACT_SERVER_WORKOS_API_KEY: "sk_workos_test",
      ARTIFACT_SERVER_WORKOS_CLIENT_ID: "client_workos_test",
      ARTIFACT_SERVER_WORKOS_ISSUER: "https://workos.example.test",
    });
    try {
      const ready = await worker.fetch(`${origin}/ready`);
      expect(ready.status).toBe(503);
      expect(notReadySchema.parse(await ready.json()).error)
        .toBe("artifact_server_not_ready");
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);

  it("refuses to start with a partial OIDC configuration", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "artifact-server-oidc-partial-"),
    );
    const worker = await startWorker(directory, {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: clientId,
    });
    try {
      const ready = await worker.fetch(`${origin}/ready`);
      expect(ready.status).toBe(503);
      expect(notReadySchema.parse(await ready.json()).error)
        .toBe("artifact_server_not_ready");
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);

  it.each([
    {ARTIFACT_SERVER_OIDC_AUTO_ADMIT: "yes"},
    {ARTIFACT_SERVER_OIDC_ALLOWED_EMAIL_DOMAINS: "*.example.test"},
  ])("AUTH-029: refuses invalid OIDC admission configuration %j", async (settings) => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-server-oidc-policy-"));
    const worker = await startWorker(directory, {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: issuerOrigin,
      ...settings,
    });
    try {
      const ready = await worker.fetch(`${origin}/ready`);
      expect(ready.status).toBe(503);
      expect(notReadySchema.parse(await ready.json()).error)
        .toBe("artifact_server_not_ready");
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);

  it("AUTH-029: policy settings alone require an OIDC provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-server-oidc-policy-alone-"));
    const worker = await startWorker(directory, {
      ARTIFACT_SERVER_OIDC_AUTO_ADMIT: "false",
    });
    try {
      const ready = await worker.fetch(`${origin}/ready`);
      expect(ready.status).toBe(503);
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);

  it("fails private-team runtime initialization when no provider is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "artifact-server-oidc-none-"));
    const worker = await startWorker(directory, {});
    try {
      const started = await worker.fetch(`${origin}/auth/login`, {
        redirect: "manual",
      });
      expect(started.status).toBe(503);
      expect(notReadySchema.parse(await started.json()).error)
        .toBe("artifact_server_not_ready");
    } finally {
      await worker.stop();
      await rm(directory, {force: true, recursive: true});
    }
  }, 120_000);
});

async function completeWorkerLogin(
  worker: Unstable_DevWorker,
  email: string,
  subject: string,
): Promise<Awaited<ReturnType<Unstable_DevWorker["fetch"]>>> {
  const login = await worker.fetch(`${origin}/auth/login`, {redirect: "manual"});
  expect(login.status).toBe(302);
  const authorization = new URL(login.headers.get("location") ?? "");
  const nonce = authorization.searchParams.get("nonce");
  const state = authorization.searchParams.get("state");
  if (nonce === null || state === null) throw new Error("Missing OIDC handshake.");
  const token = await new SignJWT({email, email_verified: true, nonce})
    .setProtectedHeader({alg: "ES256", kid: "worker-oidc-test"})
    .setIssuer(issuerOrigin)
    .setAudience(clientId)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
  issuedTokens.set(nonce, token);
  const callback = new URL("/auth/callback", origin);
  callback.searchParams.set("code", nonce);
  callback.searchParams.set("state", state);
  const cookie = login.headers.getSetCookie()
    .map((entry) => entry.split(";")[0]).join("; ");
  return worker.fetch(callback.toString(), {
    headers: {Cookie: cookie},
    redirect: "manual",
  });
}

function startDiscoveryStub(publicJwk: JWK): Promise<Server> {
  const server = createServer((request, response) => {
    const issuerPath = `/cdn-cgi/access/sso/oidc/${clientId}`;
    if (request.url === `${issuerPath}/jwks`) {
      response.writeHead(200, {"content-type": "application/json"});
      response.end(JSON.stringify({keys: [publicJwk]}));
      return;
    }
    if (request.url === `${issuerPath}/token` && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += new TextDecoder().decode(chunk);
      });
      request.on("end", () => {
        const code = new URLSearchParams(body).get("code") ?? "";
        const token = issuedTokens.get(code);
        issuedTokens.delete(code);
        response.writeHead(token === undefined ? 400 : 200, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify(token === undefined
          ? {error: "invalid_grant"} : {id_token: token}));
      });
      return;
    }
    if (request.url !== `${issuerPath}/.well-known/openid-configuration`) {
      response.writeHead(404).end();
      return;
    }
    const host = request.headers.host ?? "127.0.0.1";
    const requestIssuer = `http://${host}${issuerPath}`;
    const document = {
      authorization_endpoint: `${requestIssuer}/authorize`,
      issuer: requestIssuer,
      jwks_uri: `${requestIssuer}/jwks`,
      token_endpoint: `${requestIssuer}/token`,
    };
    response.writeHead(200, {"content-type": "application/json"});
    response.end(JSON.stringify(document));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function cookieExpires(cookies: readonly string[], name: string): number {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  const expires = cookie === undefined ? undefined : /;\s*Expires=([^;]+)/iu.exec(cookie)?.[1];
  if (expires === undefined) throw new Error(`The response did not set ${name} with an expiry.`);
  return Date.parse(expires);
}

/** Cookie expiry has one-second precision and the Worker reads its own clock. */
function expectNear(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(5_000);
}

/** Open the Worker's persisted D1 file while the Worker is stopped. */
async function withD1Database(
  persistenceDirectory: string,
  use: (database: DatabaseSync) => void,
): Promise<void> {
  const files = (await readdir(persistenceDirectory, {recursive: true}))
    .filter((file) => file.endsWith(".sqlite"))
    .map((file) => join(persistenceDirectory, file));
  for (const file of files) {
    const database = new DatabaseSync(file);
    try {
      const sessions = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'application_sessions'",
      ).get();
      if (sessions !== undefined) {
        use(database);
        return;
      }
    } finally {
      database.close();
    }
  }
  throw new Error("The persisted D1 database was not found.");
}

function startWorker(
  persistenceDirectory: string,
  loginVariables: Record<string, string>,
): Promise<Unstable_DevWorker> {
  return unstable_dev("src/worker.ts", {
    bundle: true,
    config: "wrangler.test.jsonc",
    compatibilityDate: "2026-08-15",
    compatibilityFlags: ["nodejs_compat"],
    experimental: {
      d1Databases: [{
        binding: "ARTIFACT_SERVER_D1_DATABASE",
        database_id: "artifact-server-test-d1",
        database_name: "artifact-server-test-d1",
      }],
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      testScheduled: true,
      watch: false,
    },
    inspect: false,
    local: true,
    logLevel: "error",
    persist: true,
    persistTo: persistenceDirectory,
    r2: [{
      binding: "ARTIFACT_SERVER_R2_BUCKET",
      bucket_name: "artifact-server-test-r2",
    }],
    vars: {
      ARTIFACT_SERVER_API_TOKEN: apiToken,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-oidc-test",
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
      ...loginVariables,
    },
  });
}
