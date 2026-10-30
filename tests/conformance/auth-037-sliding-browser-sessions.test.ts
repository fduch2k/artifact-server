import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {digestIdentitySecret} from "../../src/application/installation-access.js";
import {membershipRoles} from "../../src/core/identity.js";
import {parseSlidingSessionPolicy} from "../../src/identity/sliding-session-policy.js";
import {SqliteIdentityRepository} from "../../src/storage/sqlite-identity-repository.js";
import {MutableClock} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  issueLocalBrowserLogin,
  type RunningTestServer,
  type TestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";

const hour = 60 * 60 * 1_000;
const day = 24 * hour;
const expiresAtRowSchema = z.object({expiresAt: z.string()});

interface BrowserSession {
  readonly csrf: string;
  readonly header: string;
  readonly token: string;
}

/** A cookie the response re-issued: its value and Expires instant. */
interface ReissuedCookie {
  readonly expires: number | null;
  readonly value: string;
}

interface SessionCheck {
  readonly cacheControl: string | null;
  readonly csrf: ReissuedCookie | null;
  readonly session: ReissuedCookie | null;
  readonly status: number;
}

describe("sliding browser sessions", () => {
  let installation: TestInstallation;
  let clock: MutableClock;
  let server: RunningTestServer | undefined;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock("2026-10-30T08:00:00.000Z");
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    await removeTestInstallation(installation);
  });

  const start = async (idleLifetimeDays?: number): Promise<RunningTestServer> => {
    server = await startTestServer(
      installation,
      idleLifetimeDays === undefined
        ? {clock}
        : {clock, slidingSessionPolicy: {idleLifetimeDays}},
    );
    return server;
  };

  const storedExpiry = (session: BrowserSession): string => {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    try {
      return expiresAtRowSchema.parse(database.prepare(`
        SELECT expires_at AS expiresAt FROM application_sessions WHERE token_digest = ?
      `).get(digestIdentitySecret(session.token))).expiresAt;
    } finally {
      database.close();
    }
  };

  const updateSessions = (statement: string, value: string): void => {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    try {
      database.prepare(statement).run(value);
    } finally {
      database.close();
    }
  };

  test("AUTH-037-B: use keeps a sliding session alive past its first expiry and the cookies follow", async () => {
    const running = await start(7);
    const signedInAt = clock.now().getTime();
    const login = await signIn(running, installation);
    expect(login.sessionExpires).toBe(signedInAt + 7 * day);
    const session = login.session;

    // Within the hourly renewal step nothing is rewritten or re-issued.
    clock.advance(30 * 60 * 1_000);
    const early = await checkSession(running, session);
    expect(early).toMatchObject({csrf: null, session: null, status: 200});
    expect(storedExpiry(session)).toBe(new Date(signedInAt + 7 * day).toISOString());

    // A later use pushes expiry one idle window past that use, in storage and in
    // both cookies, which keep the browser's existing values.
    clock.advance(6 * day);
    const renewedAt = clock.now().getTime();
    const renewed = await checkSession(running, session);
    expect(renewed).toEqual({
      cacheControl: "private, no-store",
      csrf: {expires: renewedAt + 7 * day, value: session.csrf},
      session: {expires: renewedAt + 7 * day, value: session.token},
      status: 200,
    });
    expect(storedExpiry(session)).toBe(new Date(renewedAt + 7 * day).toISOString());

    // The same cookie values outlive the original expiry, and the CSRF pair still authorizes a mutation.
    clock.advance(2 * day);
    expect(clock.now().getTime()).toBeGreaterThan(signedInAt + 7 * day);
    expect((await checkSession(running, session)).status).toBe(200);
    // Past the cache bound and the renewal step, so logout itself renews on the way in.
    clock.advance(2 * hour);
    const logout = await fetch(`${running.baseUrl}/api/v1/session/logout`, {
      headers: browserMutationHeaders(running.baseUrl, session),
      method: "POST",
    });
    expect(logout.status).toBe(204);
    // Its cleared cookies are the last word over the renewal.
    expect(logout.headers.getSetCookie()
      .filter((cookie) => cookie.startsWith("artifact_session="))
      .map((cookie) => cookie.split(";", 1)[0])).toEqual(["artifact_session="]);
    expect((await checkSession(running, session)).status).toBe(401);
  });

  test("AUTH-037-F: idle, revoked, and deactivated sessions are not renewed, and fixed sessions stay fixed", async () => {
    const running = await start(7);

    // A session unused for one idle window expires.
    const idle = (await signIn(running, installation)).session;
    clock.advance(7 * day + 1_000);
    expect((await checkSession(running, idle)).status).toBe(401);

    // A session revoked in shared storage by another replica is refused, not renewed.
    const revoked = (await signIn(running, installation)).session;
    const revokedExpiry = storedExpiry(revoked);
    updateSessions(
      "UPDATE application_sessions SET revoked_at = ? WHERE revoked_at IS NULL",
      clock.now().toISOString(),
    );
    clock.advance(2 * hour);
    expect(await checkSession(running, revoked)).toMatchObject({
      session: null,
      status: 401,
    });
    expect(storedExpiry(revoked)).toBe(revokedExpiry);

    // A deactivated member's live session is refused, not renewed.
    const deactivated = (await signIn(running, installation)).session;
    const deactivatedExpiry = storedExpiry(deactivated);
    updateSessions("UPDATE installation_members SET status = ?", "inactive");
    clock.advance(2 * hour);
    expect(await checkSession(running, deactivated)).toMatchObject({
      session: null,
      status: 401,
    });
    expect(storedExpiry(deactivated)).toBe(deactivatedExpiry);
    updateSessions("UPDATE installation_members SET status = ?", "active");

    // Without the policy a session keeps its fixed twelve hours however it is used.
    await running.stop();
    const fixed = await start();
    const signedInAt = clock.now().getTime();
    const login = await signIn(fixed, installation);
    expect(login.sessionExpires).toBe(signedInAt + 12 * hour);
    clock.advance(11 * hour);
    expect(await checkSession(fixed, login.session)).toMatchObject({
      session: null,
      status: 200,
    });
    clock.advance(hour + 1_000);
    expect((await checkSession(fixed, login.session)).status).toBe(401);
  });

  test("AUTH-037: storage renews only a live session and never moves its expiry earlier", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "artifact-sliding-sessions-"));
    const repository = new SqliteIdentityRepository(path.join(directory, "identity.db"));
    try {
      await repository.admitMember({
        createdAt: "2026-10-30T00:00:00.000Z",
        displayName: "Member",
        email: "member@example.test",
        id: "member-one",
        installationId: "installation-one",
        role: membershipRoles.member,
      });
      await Promise.all(["session-live", "session-revoked", "session-expired"].map(
        (id) => repository.createApplicationSession({
          createdAt: "2026-10-30T00:00:00.000Z",
          csrfDigest: `${id}-csrf`,
          expiresAt: "2026-11-06T00:00:00.000Z",
          id,
          installationId: "installation-one",
          memberId: "member-one",
          tokenDigest: `${id}-token`,
        }),
      ));
      await repository.revokeApplicationSession(
        "installation-one",
        "session-revoked-token",
        "2026-10-30T01:00:00.000Z",
      );
      const renew = (id: string, expiresAt: string, requestTime: string) =>
        repository.renewApplicationSession("installation-one", id, expiresAt, requestTime);
      const expiryOf = async (id: string, requestTime: string) =>
        (await repository.findApplicationSession(
          "installation-one",
          `${id}-token`,
          requestTime,
        ))?.expiresAt ?? null;

      expect(await renew("session-live", "2026-11-08T00:00:00.000Z", "2026-11-01T00:00:00.000Z"))
        .toBe(true);
      // A slower replica asking for an earlier expiry changes nothing.
      expect(await renew("session-live", "2026-11-07T00:00:00.000Z", "2026-11-01T00:00:00.000Z"))
        .toBe(false);
      expect(await expiryOf("session-live", "2026-11-01T00:00:00.000Z"))
        .toBe("2026-11-08T00:00:00.000Z");
      // Another installation cannot reach the session.
      expect(await repository.renewApplicationSession(
        "installation-two",
        "session-live",
        "2026-11-09T00:00:00.000Z",
        "2026-11-01T00:00:00.000Z",
      )).toBe(false);
      expect(await renew("session-revoked", "2026-11-08T00:00:00.000Z", "2026-11-01T00:00:00.000Z"))
        .toBe(false);
      // An expired session is not brought back.
      expect(await renew("session-expired", "2026-11-14T00:00:00.000Z", "2026-11-07T00:00:00.000Z"))
        .toBe(false);
      expect(await expiryOf("session-expired", "2026-11-05T00:00:00.000Z"))
        .toBe("2026-11-06T00:00:00.000Z");
    } finally {
      repository.close();
      await rm(directory, {force: true, recursive: true});
    }
  });

  test("AUTH-037: the idle window accepts whole days from 1 to 365 and stays off when unset", () => {
    expect(parseSlidingSessionPolicy(undefined)).toBeNull();
    expect(parseSlidingSessionPolicy("")).toBeNull();
    expect(parseSlidingSessionPolicy(" 7 ")).toEqual({idleLifetimeDays: 7});
    expect(parseSlidingSessionPolicy("1")).toEqual({idleLifetimeDays: 1});
    expect(parseSlidingSessionPolicy("365")).toEqual({idleLifetimeDays: 365});
    for (const idleDays of ["0", "-1", "1.5", "7d", "366", "007", "true"]) {
      expect(() => parseSlidingSessionPolicy(idleDays))
        .toThrow("ARTIFACT_SERVER_SESSION_IDLE_DAYS must be a whole number of days from 1 to 365.");
    }
  });
});

async function signIn(
  server: RunningTestServer,
  installation: TestInstallation,
): Promise<{readonly session: BrowserSession; readonly sessionExpires: number}> {
  const token = await issueLocalBrowserLogin(server, installation);
  const login = await fetch(`${server.baseUrl}/auth/local?token=${token}`, {
    redirect: "manual",
  });
  expect(login.status).toBe(303);
  const cookies = login.headers.getSetCookie();
  const session = cookiePair(cookies, "artifact_session");
  const csrf = cookiePair(cookies, "artifact_csrf");
  const sessionExpires = cookieExpires(cookies, "artifact_session");
  if (session === null || csrf === null || sessionExpires === null) {
    throw new Error("The login response did not issue both application cookies.");
  }
  return {
    session: {
      csrf,
      header: `artifact_session=${session}; artifact_csrf=${csrf}`,
      token: session,
    },
    sessionExpires,
  };
}

async function checkSession(
  server: RunningTestServer,
  session: BrowserSession,
): Promise<SessionCheck> {
  const response = await fetch(`${server.baseUrl}/api/v1/session`, {
    headers: {Cookie: session.header},
  });
  await response.body?.cancel();
  const cookies = response.headers.getSetCookie();
  return {
    cacheControl: response.headers.get("cache-control"),
    csrf: reissuedCookie(cookies, "artifact_csrf"),
    session: reissuedCookie(cookies, "artifact_session"),
    status: response.status,
  };
}

function reissuedCookie(cookies: readonly string[], name: string): ReissuedCookie | null {
  const value = cookiePair(cookies, name);
  return value === null ? null : {expires: cookieExpires(cookies, name), value};
}

function cookiePair(cookies: readonly string[], name: string): string | null {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  const pair = cookie?.split(";", 1)[0];
  return pair === undefined ? null : pair.slice(name.length + 1);
}

function cookieExpires(cookies: readonly string[], name: string): number | null {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  const expires = cookie === undefined ? undefined : /;\s*Expires=([^;]+)/iu.exec(cookie)?.[1];
  return expires === undefined ? null : Date.parse(expires);
}

function browserMutationHeaders(origin: string, session: BrowserSession): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: session.header,
    Origin: origin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": session.csrf,
  });
}
