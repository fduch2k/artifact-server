import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {
  commitStagedUpload,
  createStagedUpload,
  publishNew,
  publishVersion,
  uploadEveryStagedFile,
  type PublishResponse,
  type TestSiteFile,
} from "../support/publishing.js";
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
} from "../support/stub-oidc-provider.js";

const administratorEmail = "administrator@example.test";
const clientSecret = "private-link-sign-in-test-client-secret";
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

const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const issuedKeySchema = z.object({token: z.string()});

interface Person {
  readonly csrf: string;
  readonly header: string;
}

describe("private artifact links send a browser through sign-in and back", () => {
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer;
  let administrator: Person;
  let publisherKey: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({clientId: "private-link-test", clientSecret});
    server = await startPrivateTeamServer();
    administrator = await signIn(administratorEmail, "administrator-subject");
    publisherKey = await personalKey(administrator);
  });

  afterEach(async () => {
    await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-038-B: a signed-out browser signs in and lands on the private latest or exact-version link it opened", async () => {
    const site = await publishSite("Private plan", "account_required");
    const latestPath = `/artifacts/${site.artifact.id}`;

    // The latest link sends a signed-out person to the provider and asks to come back.
    const signedOut = await navigate(server, `${server.baseUrl}${latestPath}`);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("cache-control")).toBe("private, no-store");
    const loginUrl = new URL(requiredLocation(signedOut), server.baseUrl);
    expect(loginUrl.origin).toBe(server.baseUrl);
    expect(loginUrl.pathname).toBe("/auth/login");
    expect(loginUrl.searchParams.get("returnTo")).toBe(latestPath);

    // Signing in returns the browser to the link it opened.
    const signedIn = await completeSignIn(loginUrl, administratorEmail, "administrator-subject");
    expect(signedIn.returnedTo).toBe(latestPath);

    // Now the same link opens the current version through a one-time bootstrap.
    const latest = await openSignedIn(signedIn.person, latestPath);
    expect(latest.host).toBe(new URL(site.links.version).host);
    expect(latest.pathname).toBe("/");
    expect(await readThroughBootstrap(latest)).toContain("Private plan home");

    // An exact-version file opened from elsewhere goes to the application
    // origin, through sign-in, and back to the same file.
    const rawFile = new URL("notes/plan.html", site.links.version).toString();
    const fromChat = await fetchVersion(server, rawFile, "GET", {
      ...documentNavigation,
      "Sec-Fetch-Site": "cross-site",
    });
    expect(fromChat.status).toBe(303);
    expect(fromChat.headers.get("cache-control")).toBe("private, no-store");
    const openUrl = new URL(requiredLocation(fromChat));
    expect(openUrl.origin).toBe(server.baseUrl);
    expect(openUrl.pathname).toBe(`/open/${site.version.contentToken}`);
    expect(openUrl.searchParams.get("path")).toBe("notes/plan.html");
    const openPath = `${openUrl.pathname}${openUrl.search}`;

    const openSignedOut = await navigate(server, openUrl.toString());
    expect(openSignedOut.status).toBe(303);
    const openLogin = new URL(requiredLocation(openSignedOut), server.baseUrl);
    expect(openLogin.pathname).toBe("/auth/login");
    expect(openLogin.searchParams.get("returnTo")).toBe(openPath);
    const versionSignIn = await completeSignIn(openLogin, administratorEmail, "administrator-subject");
    expect(versionSignIn.returnedTo).toBe(openPath);
    const exactFile = await openSignedIn(versionSignIn.person, openPath);
    expect(exactFile.host).toBe(new URL(site.links.version).host);
    expect(exactFile.pathname).toBe("/notes/plan.html");
    expect(await readThroughBootstrap(exactFile)).toContain("Private plan notes");

    // After a new version the latest link moves, and the old exact address stays exact.
    const next = await publishVersion(server, publisher(), {
      artifactId: site.artifact.id,
      content: "<!doctype html><p>Private plan, second version</p>",
      expectedCurrentVersionId: site.version.id,
      idempotencyKey: "private-link-second-version",
      path: "index.html",
    });
    expect(next.response.status).toBe(201);
    const moved = await openSignedIn(signedIn.person, latestPath);
    expect(moved.host).toBe(new URL(next.body.links.version).host);
    expect(await readThroughBootstrap(moved)).toContain("second version");
    const pinned = await openSignedIn(signedIn.person, `/open/${site.version.contentToken}`);
    expect(pinned.host).toBe(new URL(site.links.version).host);
    expect(await readThroughBootstrap(pinned)).toContain("Private plan home");

    // A public latest link still opens without sign-in.
    const open = await publishNew(server, publisher(), {
      accessSetting: "public_link",
      content: "<!doctype html><p>Open to anyone</p>",
      idempotencyKey: "private-link-public-artifact",
      path: "index.html",
    });
    const publicLink = await navigate(server, open.body.links.artifact);
    expect(publicLink.status).toBe(302);
    expect(requiredLocation(publicLink)).toBe(open.body.links.version);

    // A local owner has no sign-in step: the management application creates
    // the session and resumes the link.
    const localInstallation = await createTestInstallation();
    const localServer = await startTestServer(localInstallation);
    try {
      const published = await publishNew(localServer, localInstallation, {
        accessSetting: "account_required",
        content: "<!doctype html><p>Local private page</p>",
        idempotencyKey: "private-link-local-owner",
        path: "index.html",
      });
      const localLatestPath = `/artifacts/${published.body.artifact.id}`;
      const localSignedOut = await navigate(localServer, `${localServer.baseUrl}${localLatestPath}`);
      expect(localSignedOut.status).toBe(303);
      const continueUrl = new URL(requiredLocation(localSignedOut), localServer.baseUrl);
      expect(continueUrl.pathname).toBe("/review/continue");
      expect(continueUrl.searchParams.get("returnTo")).toBe(localLatestPath);
      const application = await navigate(localServer, continueUrl.toString());
      expect(application.status).toBe(200);
      expect(application.headers.get("content-type")).toContain("text/html");
    } finally {
      await localServer.stop();
      await removeTestInstallation(localInstallation);
    }
  });

  test("AUTH-038-F: programs, embedded loads, refused cookies, and people without access never get a sign-in loop or private bytes", async () => {
    const site = await publishSite("Guarded plan", "account_required");
    const latestPath = `/artifacts/${site.artifact.id}`;

    // Programs and embedded resources keep the plain 401 instead of a redirect.
    const program = await fetch(`${server.baseUrl}${latestPath}`, {redirect: "manual"});
    expect(program.status).toBe(401);
    expect(failureSchema.parse(await program.json()).error.code).toBe("CONTENT_NOT_PUBLIC");
    const embedded = await Promise.all([
      {},
      {Accept: "*/*", "Sec-Fetch-Dest": "image", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "cross-site"},
      {...documentNavigation, "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "cross-site"},
    ].map(async (headers) => {
      const response = await fetchVersion(server, site.links.version, "GET", headers);
      return {
        code: failureSchema.parse(await response.json()).error.code,
        location: response.headers.get("location"),
        status: response.status,
      };
    }));
    expect(embedded).toEqual(Array.from({length: 3}, () => ({
      code: "CONTENT_NOT_PUBLIC",
      location: null,
      status: 401,
    })));
    const head = await fetchVersion(server, site.links.version, "HEAD", {
      ...documentNavigation,
      "Sec-Fetch-Site": "cross-site",
    });
    expect(head.status).toBe(401);
    expect(head.headers.get("location")).toBeNull();

    // A navigation from the version host itself means the content cookie did
    // not stick after the exchange; a browser without fetch metadata could be
    // in the same state. Both get a sign-in page, never another redirect.
    const signInPages = await Promise.all([
      {...documentNavigation, "Sec-Fetch-Site": "same-origin"},
      {Accept: documentNavigation.Accept},
    ].map(async (headers) => {
      const page = await fetchVersion(
        server,
        new URL("notes/plan.html", site.links.version).toString(),
        "GET",
        headers,
      );
      return {html: await page.text(), page};
    }));
    for (const {html, page} of signInPages) {
      expect(page.status).toBe(401);
      expect(page.headers.get("location")).toBeNull();
      expect(page.headers.get("cache-control")).toBe("private, no-store");
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(html).toContain(
        `href="${server.baseUrl}/open/${site.version.contentToken}?path=notes%2Fplan.html"`,
      );
      expect(html).not.toContain("Guarded plan notes");
    }

    // An expired or forged application session is a signed-out visit, not an error.
    const forged = await navigate(server, `${server.baseUrl}${latestPath}`, {
      Cookie: `artifact_session=${"x".repeat(43)}`,
    });
    expect(forged.status).toBe(303);
    expect(new URL(requiredLocation(forged), server.baseUrl).pathname).toBe("/auth/login");

    // A member who may not read a restricted artifact gets the same not-found
    // answer as for a missing artifact, and no bootstrap.
    const hidden = await publishSite("Hidden plan", "restricted");
    const ben = await signIn("ben@example.test", "ben-subject");
    const refused = await Promise.all([
      `/artifacts/${hidden.artifact.id}`,
      `/open/${hidden.version.contentToken}`,
    ].map(async (requestPath) => {
      const response = await navigate(server, `${server.baseUrl}${requestPath}`, {
        Cookie: ben.header,
      });
      return {
        code: failureSchema.parse(await response.json()).error.code,
        location: response.headers.get("location"),
        status: response.status,
      };
    }));
    expect(refused).toEqual(Array.from({length: 2}, () => ({
      code: "ARTIFACT_NOT_FOUND",
      location: null,
      status: 404,
    })));

    // Version hosts that do not exist or are malformed issue nothing.
    const unknown = await navigate(server, `${server.baseUrl}/open/${"a".repeat(32)}`, {
      Cookie: administrator.header,
    });
    expect(unknown.status).toBe(404);
    expect(failureSchema.parse(await unknown.json()).error.code).toBe("VERSION_NOT_FOUND");
    const malformed = await navigate(server, `${server.baseUrl}/open/not-a-token`, {
      Cookie: administrator.header,
    });
    expect(malformed.status).toBe(422);
    expect(malformed.headers.get("location")).toBeNull();
  });

  async function startPrivateTeamServer(): Promise<RunningTestServer> {
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    return startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      externalIdentityAdmissionPolicy: {
        allowedEmailDomains: [],
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

  async function signIn(email: string, subject: string): Promise<Person> {
    return (await completeSignIn(new URL("/auth/login", server.baseUrl), email, subject)).person;
  }

  /** Follow one `/auth/login` URL through the stub provider back to the application. */
  async function completeSignIn(
    loginUrl: URL,
    email: string,
    subject: string,
  ): Promise<{readonly person: Person; readonly returnedTo: string}> {
    provider.claims.email = email;
    provider.claims.subject = subject;
    provider.claims.emailVerified = true;
    const started = await startStubOidcLogin(
      server.baseUrl,
      loginUrl.searchParams.get("returnTo"),
    );
    const completed = await fetch(started.callbackUrl, {
      headers: {Cookie: started.handshakeCookie},
      redirect: "manual",
    });
    expect(completed.status).toBe(303);
    return {person: applicationCookies(completed), returnedTo: requiredLocation(completed)};
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

  function publisher(): TestInstallation {
    return {...installation, apiToken: publisherKey};
  }

  async function publishSite(
    name: string,
    accessSetting: "account_required" | "restricted",
  ): Promise<PublishResponse> {
    const files: readonly TestSiteFile[] = [
      {
        bytes: new TextEncoder().encode(`<!doctype html><p>${name} home</p>`),
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
      },
      {
        bytes: new TextEncoder().encode(`<!doctype html><p>${name} notes</p>`),
        mediaType: "text/html; charset=utf-8",
        path: "notes/plan.html",
      },
    ];
    const planned = await createStagedUpload(server, publisher(), "index.html", files);
    const uploads = await uploadEveryStagedFile(publisher(), planned.body, files);
    expect(uploads.every((response) => response.status === 200)).toBe(true);
    const committed = await commitStagedUpload(
      publisher(),
      planned.body,
      `private-link-${name}`,
      {accessSetting, kind: "new_artifact", name},
    );
    expect(committed.response.status).toBe(201);
    return committed.body;
  }

  /** Open an application path as a signed-in browser and answer the bootstrap URL it sends. */
  async function openSignedIn(person: Person, requestPath: string): Promise<URL> {
    const response = await navigate(server, `${server.baseUrl}${requestPath}`, {
      Cookie: person.header,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const bootstrap = new URL(requiredLocation(response));
    expect(bootstrap.searchParams.get("__artifact_bootstrap")).not.toBeNull();
    return bootstrap;
  }

  /** Exchange a bootstrap on its version host and read the file it returns to. */
  async function readThroughBootstrap(bootstrap: URL): Promise<string> {
    const exchange = await fetchVersion(server, bootstrap.toString(), "GET", {
      ...documentNavigation,
      "Sec-Fetch-Site": "cross-site",
    });
    expect(exchange.status).toBe(200);
    expect(await exchange.text()).toContain(`content="0;url=${bootstrap.pathname}"`);
    const cookie = exchange.headers.getSetCookie()[0]?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("The exchange set no content cookie.");
    const destination = new URL(bootstrap.pathname, bootstrap.origin).toString();
    const content = await fetchVersion(server, destination, "GET", {
      ...documentNavigation,
      Cookie: cookie,
      "Sec-Fetch-Site": "same-origin",
    });
    expect(content.status).toBe(200);
    return content.text();
  }
});

/**
 * Open a URL the way a person's browser does. Node's fetch always reports
 * `Sec-Fetch-Mode: cors`, so navigations go out as raw HTTP requests.
 */
function navigate(
  target: RunningTestServer,
  url: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetchVersion(target, url, "GET", {...documentNavigation, ...headers});
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
