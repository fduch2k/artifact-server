import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  reserveLoopbackPort,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  startStubOidcLogin,
  startStubOidcProvider,
  type RunningStubOidcProvider,
  type StubOidcAuthorization,
} from "../support/stub-oidc-provider.js";

const administratorEmail = "administrator@example.test";
const clientSecret = "browser-failure-pages-test-client-secret";
const weekMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const publisherCapabilities = [
  "artifact:create",
  "artifact:manage:own",
  "artifact:publish:own",
  "artifact:read",
] as const;

/** The request headers a browser sends when a person opens a link. */
const documentNavigation = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
} as const;

/** The identity provider sends the browser back from its own site. */
const providerReturn = {...documentNavigation, "Sec-Fetch-Site": "cross-site"} as const;

const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const issuedKeySchema = z.object({token: z.string()});

/** Every error code a person's page must not show. */
const internalCodes = [
  "ARTIFACT_NOT_FOUND",
  "AUTHENTICATION_REQUIRED",
  "IDENTITY_ADMISSION_DENIED",
  "IDENTITY_PROVIDER_FAILURE",
  "INVALID_INPUT",
  "VERSION_NOT_FOUND",
] as const;

interface Person {
  readonly csrf: string;
  readonly header: string;
}

interface PageAnswer {
  readonly body: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly status: number;
}

describe("a person's browser gets a page for refused admission and links it cannot open", () => {
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer;
  let administrator: Person;
  let publisherKey: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({clientId: "browser-failure-test", clientSecret});
    server = await startPrivateTeamServer();
    administrator = await signIn(administratorEmail, "administrator-subject");
    publisherKey = await personalKey(administrator);
  });

  afterEach(async () => {
    await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-042-B: refused admission, a link that opens nothing, and an unfinished sign-in each answer a browser with a page", async () => {
    // A person outside the admitted domains opens a private link, signs in at
    // the provider, and is refused admission by this installation.
    const site = await publish("Team plan", "account_required");
    const latestPath = `/artifacts/${site.artifact.id}`;
    const signedOut = await navigate(`${server.baseUrl}${latestPath}`);
    expect(signedOut.status).toBe(303);
    const loginUrl = new URL(requiredLocation(signedOut), server.baseUrl);
    const refused = await returnFromProvider(
      await startAs(loginUrl, "visitor@elsewhere.test", "visitor-subject"),
    );
    expect(refused.status).toBe(403);
    expectPersonPage(refused);
    expect(refused.headers.getSetCookie().some((cookie) => cookie.startsWith("artifact_session=")))
      .toBe(false);
    const refusedPage = await refused.text();
    expect(refusedPage).toContain("<title>You do not have access yet</title>");
    expect(refusedPage).toContain("Ask an administrator of this Artifact Server to give you access");
    expectNothingInternal(refusedPage, ["visitor@elsewhere.test", site.artifact.id]);

    // A provider that signs a person in without a verified email is refused the same way.
    const unverified = await startAs(loginUrl, "ben@example.test", "ben-subject");
    provider.claims.emailVerified = false;
    const unverifiedAnswer = await returnFromProvider(unverified);
    expect(unverifiedAnswer.status).toBe(403);
    expect(await unverifiedAnswer.text()).toBe(refusedPage);

    // A signed-in member opens a restricted artifact they cannot see.
    const hidden = await publish("Hidden plan", "restricted");
    const ben = await signIn("ben@example.test", "ben-subject");
    const notFoundPages = await Promise.all([
      `/artifacts/${hidden.artifact.id}`,
      `/open/${hidden.version.contentToken}`,
    ].map(async (requestPath) => {
      const response = await navigate(`${server.baseUrl}${requestPath}`, {Cookie: ben.header});
      return {html: await response.text(), response};
    }));
    for (const {html, response} of notFoundPages) {
      expect(response.status).toBe(404);
      expectPersonPage(response);
      expect(html).toContain("<title>Artifact not available</title>");
      expect(html).toContain("Check that the link is complete");
      expectNothingInternal(html, [hidden.artifact.id, hidden.version.contentToken, "Hidden plan"]);
    }

    // A callback used twice and a provider that fails both leave the person
    // with a way to sign in again.
    const replayed = await startAs(new URL("/auth/login", server.baseUrl), "ben@example.test", "ben-subject");
    expect((await returnFromProvider(replayed)).status).toBe(303);
    const replay = await returnFromProvider(replayed);
    expect(replay.status).toBe(401);
    expectPersonPage(replay);
    const replayPage = await replay.text();
    expect(replayPage).toContain("<title>Sign-in did not finish</title>");
    expect(replayPage).toContain('<a href="/auth/login?returnTo=%2F">Sign in again</a>');
    expectNothingInternal(replayPage, []);

    const failing = await startAs(new URL("/auth/login", server.baseUrl), "ben@example.test", "ben-subject");
    provider.defects.tokenStatus = 500;
    const providerFailure = await returnFromProvider(failing);
    expect(providerFailure.status).toBe(502);
    expectPersonPage(providerFailure);
    expect(await providerFailure.text()).toBe(replayPage);
  });

  test("AUTH-042-F: a restricted artifact's page is identical to a missing one's, and programs keep the JSON error", async () => {
    const hidden = await publish("Hidden plan", "restricted");
    const ben = await signIn("ben@example.test", "ben-subject");
    const missingArtifactId = lookalike(hidden.artifact.id);
    const missingContentToken = lookalike(hidden.version.contentToken);
    expect(missingArtifactId).not.toBe(hidden.artifact.id);

    // Restricted, missing, unknown, and malformed links all answer one page,
    // byte for byte, with the same status and headers apart from the date.
    const answers = await Promise.all([
      `/artifacts/${hidden.artifact.id}`,
      `/artifacts/${missingArtifactId}`,
      `/open/${hidden.version.contentToken}`,
      `/open/${hidden.version.contentToken}?path=index.html`,
      `/open/${missingContentToken}`,
      "/open/not-a-token",
    ].map(async (requestPath) =>
      pageAnswer(await navigate(`${server.baseUrl}${requestPath}`, {Cookie: ben.header}))
    ));
    const [first] = answers;
    if (first === undefined) throw new Error("No answer was read.");
    expect(first.status).toBe(404);
    for (const answer of answers) expect(answer).toEqual(first);

    // Programs, embedded loads, and HEAD keep the JSON error and its status.
    const program = await fetch(`${server.baseUrl}/artifacts/${hidden.artifact.id}`, {
      headers: {Cookie: ben.header},
      redirect: "manual",
    });
    expect(program.status).toBe(404);
    expect(program.headers.get("content-type")).toContain("application/json");
    expect(failureSchema.parse(await program.json()).error.code).toBe("ARTIFACT_NOT_FOUND");
    const embedded = await Promise.all([
      {Accept: "*/*", Cookie: ben.header, "Sec-Fetch-Dest": "image", "Sec-Fetch-Mode": "no-cors"},
      {...documentNavigation, Cookie: ben.header, "Sec-Fetch-Dest": "iframe"},
      {Accept: "application/json", Cookie: ben.header},
    ].map(async (headers) => {
      const response = await fetchVersion(server, `${server.baseUrl}/artifacts/${hidden.artifact.id}`, "GET", headers);
      return {code: failureSchema.parse(await response.json()).error.code, status: response.status};
    }));
    expect(embedded).toEqual(Array.from({length: 3}, () => ({code: "ARTIFACT_NOT_FOUND", status: 404})));
    const head = await fetchVersion(server, `${server.baseUrl}/open/${hidden.version.contentToken}`, "HEAD", {
      ...documentNavigation,
      Cookie: ben.header,
    });
    expect(head.status).toBe(404);
    expect(head.headers.get("content-type")).toContain("application/json");
    const malformedProgram = await fetch(`${server.baseUrl}/open/not-a-token`, {
      headers: {Cookie: ben.header},
      redirect: "manual",
    });
    expect(malformedProgram.status).toBe(422);
    expect(failureSchema.parse(await malformedProgram.json()).error.code).toBe("INVALID_INPUT");

    // A program completing a refused sign-in keeps the 403 JSON error.
    const refused = await startAs(new URL("/auth/login", server.baseUrl), "visitor@elsewhere.test", "visitor-subject");
    const refusedProgram = await fetch(refused.callbackUrl, {
      headers: {Cookie: refused.handshakeCookie},
      redirect: "manual",
    });
    expect(refusedProgram.status).toBe(403);
    expect(failureSchema.parse(await refusedProgram.json()).error.code).toBe("IDENTITY_ADMISSION_DENIED");
    expect(refusedProgram.headers.getSetCookie().some((cookie) => cookie.startsWith("artifact_session=")))
      .toBe(false);

    // The refused person never received a session: the private link still
    // sends a browser to sign in.
    const site = await publish("Team plan", "account_required");
    const stillSignedOut = await navigate(`${server.baseUrl}/artifacts/${site.artifact.id}`, {
      Cookie: refused.handshakeCookie,
    });
    expect(stillSignedOut.status).toBe(303);
    expect(new URL(requiredLocation(stillSignedOut), server.baseUrl).pathname).toBe("/auth/login");
  });

  async function startPrivateTeamServer(): Promise<RunningTestServer> {
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    return startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      externalIdentityAdmissionPolicy: {
        allowedEmailDomains: ["example.test"],
        provider: `oidc:${provider.issuer}`,
      },
      interactiveIdentityProvider: createOidcIdentityProvider({
        applicationOrigin,
        clientId: provider.clientId,
        clientSecret: Redacted.make(clientSecret),
        issuer: provider.issuer,
        scopes: "openid email profile",
      }),
      personalApiKeyPolicy: {maxLifetimeDays: 30},
      port,
    });
  }

  /** Start a sign-in at the stub provider as one person, up to the callback. */
  async function startAs(
    loginUrl: URL,
    email: string,
    subject: string,
  ): Promise<StubOidcAuthorization> {
    provider.claims.email = email;
    provider.claims.subject = subject;
    provider.claims.emailVerified = true;
    provider.defects.tokenStatus = 200;
    return startStubOidcLogin(server.baseUrl, loginUrl.searchParams.get("returnTo"));
  }

  /** The browser follows the provider's redirect back to the callback. */
  function returnFromProvider(started: StubOidcAuthorization): Promise<Response> {
    return fetchVersion(server, started.callbackUrl.toString(), "GET", {
      ...providerReturn,
      Cookie: started.handshakeCookie,
    });
  }

  async function signIn(email: string, subject: string): Promise<Person> {
    const started = await startAs(new URL("/auth/login", server.baseUrl), email, subject);
    const completed = await fetch(started.callbackUrl, {
      headers: {Cookie: started.handshakeCookie},
      redirect: "manual",
    });
    expect(completed.status).toBe(303);
    return applicationCookies(completed);
  }

  async function personalKey(person: Person): Promise<string> {
    const issued = await fetch(`${server.baseUrl}/api/v1/personal-api-keys`, {
      body: JSON.stringify({
        capabilities: publisherCapabilities,
        expiresAt: new Date(Date.now() + weekMilliseconds).toISOString(),
        name: "Publisher",
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: person.header,
        "Idempotency-Key": crypto.randomUUID(),
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": person.csrf,
      },
      method: "POST",
    });
    expect(issued.status).toBe(201);
    return issuedKeySchema.parse(await issued.json()).token;
  }

  async function publish(
    name: string,
    accessSetting: "account_required" | "restricted",
  ): Promise<PublishResponse> {
    const published = await publishNew(server, {...installation, apiToken: publisherKey}, {
      accessSetting,
      content: `<!doctype html><p>${name}</p>`,
      idempotencyKey: `browser-failure-${name}`,
      path: "index.html",
    });
    expect(published.response.status).toBe(201);
    return published.body;
  }

  /** Open a URL the way a person's browser does. */
  function navigate(
    url: string,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    return fetchVersion(server, url, "GET", {
      ...documentNavigation,
      "Sec-Fetch-Site": "none",
      ...headers,
    });
  }
});

function expectPersonPage(response: Response): void {
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
}

function expectNothingInternal(html: string, secrets: readonly string[]): void {
  for (const value of [...internalCodes, ...secrets]) expect(html).not.toContain(value);
}

async function pageAnswer(response: Response): Promise<PageAnswer> {
  return {
    body: await response.text(),
    headers: [...response.headers].filter(([name]) => name !== "date"),
    status: response.status,
  };
}

/** A well-formed identifier that differs from `value` in its last character. */
function lookalike(value: string): string {
  const last = value.at(-1);
  return `${value.slice(0, -1)}${last === "a" ? "b" : "a"}`;
}

function requiredLocation(response: Response): string {
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error(`The ${response.status} response has no Location.`);
  }
  return location;
}

function applicationCookies(response: Response): Person {
  const pairs = response.headers.getSetCookie()
    .filter((value) => value.startsWith("artifact_session=") || value.startsWith("artifact_csrf="))
    .map((value) => value.split(";", 1)[0]);
  const csrfPair = pairs.find((value) => value?.startsWith("artifact_csrf="));
  if (pairs.length !== 2 || csrfPair === undefined) {
    throw new Error("The response lacks application cookies.");
  }
  return {csrf: csrfPair.slice("artifact_csrf=".length), header: pairs.join("; ")};
}
