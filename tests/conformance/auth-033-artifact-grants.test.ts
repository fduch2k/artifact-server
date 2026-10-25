import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const allCapabilities = [
  "agent:connect",
  "artifact:create",
  "artifact:manage:any",
  "artifact:publish:any",
  "artifact:read",
  "comment:write",
  "content-session:issue",
] as const;

const artifactSchema = z.object({
  accessSetting: z.enum(["account_required", "public_link", "restricted"]),
  currentVersionId: z.string(),
  grantedPrincipalIds: z.array(z.string()),
  id: z.string(),
  name: z.string(),
  ownerPrincipalId: z.string().nullable(),
  projectId: z.string(),
});
const artifactEnvelopeSchema = z.object({artifact: artifactSchema});
const artifactPageSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({name: z.string()})})),
});
const grantChangeSchema = z.object({changed: z.boolean()}).strict();
const sharedMembersSchema = z.object({
  grants: z.array(z.object({
    displayName: z.string().nullable(),
    email: z.string().nullable(),
    grantedAt: z.string(),
    grantedByPrincipalId: z.string(),
    principalId: z.string(),
  }).strict()),
});
const directorySchema = z.object({
  members: z.array(z.object({
    displayName: z.string(),
    email: z.string(),
    id: z.string(),
  }).strict()),
});
const memberSchema = z.object({member: z.object({id: z.string()})});
const issuedKeySchema = z.object({
  apiKey: z.object({principalId: z.string()}),
  token: z.string().startsWith("as_key_"),
});
const threadSchema = z.object({thread: z.object({id: z.string()})});
const agentSchema = z.object({agent: z.object({id: z.string()})});
const errorSchema = z.object({error: z.object({code: z.string()})});

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

/** A caller that authenticates with an API key. */
interface Actor {
  readonly id: string;
  readonly token: string;
}

/** The local-owner administrator, signed in through a browser session. */
interface BrowserActor {
  readonly cookies: ApplicationCookies;
  readonly id: string;
}

type Caller = Actor | BrowserActor;

/** A member admitted by the administrator, with the member-bound key it acts through. */
interface Member extends Actor {
  readonly email: string;
}

/** The administrator's request to issue one API key. */
interface IssueKeyRequest {
  readonly capabilities: readonly string[];
  readonly expiresAt: string;
  readonly memberId?: string;
  readonly name: string;
}

/** Request bodies sent by these tests: strings and string lists only. */
type RequestBody = Readonly<Record<string, string | readonly string[]>>;

function artifactPath(artifactId: string, suffix = ""): string {
  return `/api/v1/artifacts/${artifactId}${suffix}`;
}

describe("restricted artifacts shared with named members", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let administrator: ApplicationCookies;
  let ada: Member;
  let ben: Member;
  let carl: Member;
  let service: Actor;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    administrator = await signInAdministrator(server, installation);
    ada = await memberWithKey("Ada", "ada@example.test");
    ben = await memberWithKey("Ben", "ben@example.test");
    carl = await memberWithKey("Carl", "carl@example.test");
    service = await issueKey(undefined, "Release bot");
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-033-B: a member the owner shares a restricted artifact with finds, reads, opens, and comments on it until the grant is revoked", async () => {
    expect.hasAssertions();
    const metrics = await publishAs(ada, "Ada's metrics", "restricted");

    // Everyone signed in can see who could be added; the owner adds Ben once.
    const directory = directorySchema.parse(
      await (await request(ada, "GET", "/api/v1/member-directory")).json(),
    );
    expect(directory.members.map(({email}) => email))
      .toEqual(expect.arrayContaining([ada.email, ben.email, carl.email]));
    expect(await grant(ada, metrics.id, ben.id)).toEqual({changed: true});
    expect(await grant(ada, metrics.id, ben.id)).toEqual({changed: false});
    expect((await readArtifact(ada, metrics.id)).grantedPrincipalIds).toEqual([ben.id]);
    const shared = sharedMembersSchema.parse(await (await request(
      ada,
      "GET",
      artifactPath(metrics.id, "/grants"),
    )).json()).grants;
    expect(shared.map(({displayName, email, grantedByPrincipalId, principalId}) => ({
      displayName,
      email,
      grantedByPrincipalId,
      principalId,
    }))).toEqual([{
      displayName: "Ben",
      email: ben.email,
      grantedByPrincipalId: ada.id,
      principalId: ben.id,
    }]);

    // Ben reads and comments through his own key, as he would in the browser.
    expect(await listedNames(ben)).toContain("Ada's metrics");
    expect(await listedNames(ben, "metrics")).toContain("Ada's metrics");
    expect((await readArtifact(ben, metrics.id)).accessSetting).toBe("restricted");
    expect((await request(ben, "GET", artifactPath(metrics.id, "/versions"))).status)
      .toBe(200);
    expect((await request(ben, "POST", artifactPath(metrics.id, "/content-sessions")))
      .status).toBe(201);
    const thread = await commentOn(ben, metrics.id, metrics.currentVersionId);
    expect((await request(ben, "GET", artifactPath(metrics.id, "/comments"))).status)
      .toBe(200);
    // Agents register as service principals; Ben sends his thread to one.
    const agent = await registerAgent(service);
    expect((await dispatch(ben, agent, [thread])).status).toBe(201);

    // Carl, who was not added, still cannot find it.
    expect(await listedNames(carl)).not.toContain("Ada's metrics");

    // Grants survive a round trip through signed-in members.
    expect((await mutate(ada, "PATCH", artifactPath(metrics.id, "/access"), {
      accessSetting: "account_required",
      expectedCurrentVersionId: metrics.currentVersionId,
    })).status).toBe(200);
    expect(await listedNames(carl)).toContain("Ada's metrics");
    expect((await mutate(ada, "PATCH", artifactPath(metrics.id, "/access"), {
      accessSetting: "restricted",
      expectedCurrentVersionId: metrics.currentVersionId,
    })).status).toBe(200);
    expect(await listedNames(ben)).toContain("Ada's metrics");
    expect(await listedNames(carl)).not.toContain("Ada's metrics");
    expect(openContentAccess(metrics.id, ben.id)).toBeGreaterThan(0);

    // Revoking ends Ben's access at once, including content he already opened.
    expect(await revoke(ada, metrics.id, ben.id)).toEqual({changed: true});
    expect(await revoke(ada, metrics.id, ben.id)).toEqual({changed: false});
    expect(openContentAccess(metrics.id, ben.id)).toBe(0);
    expect(await listedNames(ben)).not.toContain("Ada's metrics");
    expect((await request(ben, "GET", artifactPath(metrics.id))).status).toBe(404);

    // An administrator chooses who sees anyone's restricted artifact.
    expect(await grant(administratorActor(), metrics.id, carl.id))
      .toEqual({changed: true});
    expect(await listedNames(carl)).toContain("Ada's metrics");
  });

  test("AUTH-033-F: a shared member cannot change or reshare the artifact, and nobody else can find it or manage its grants", async () => {
    expect.hasAssertions();
    const metrics = await publishAs(ada, "Ada's metrics", "restricted");
    const adaThread = await commentOn(ada, metrics.id, metrics.currentVersionId);
    expect(await grant(ada, metrics.id, ben.id)).toEqual({changed: true});

    // Ben's key carries artifact:manage:any; it still does not reach a
    // restricted artifact that is only shared with him.
    const changes = await Promise.all([
      mutate(ben, "PATCH", artifactPath(metrics.id, "/access"), {
        accessSetting: "account_required",
        expectedCurrentVersionId: metrics.currentVersionId,
      }),
      mutate(ben, "PATCH", artifactPath(metrics.id, "/tags"), {
        expectedCurrentVersionId: metrics.currentVersionId,
        tags: ["ben"],
      }),
      mutate(ben, "POST", artifactPath(metrics.id, "/restore"), {
        expectedCurrentVersionId: metrics.currentVersionId,
        versionId: metrics.currentVersionId,
      }),
      mutate(ben, "DELETE", artifactPath(metrics.id), {
        expectedCurrentVersionId: metrics.currentVersionId,
      }),
      request(ben, "GET", artifactPath(metrics.id, "/actions")),
      request(ben, "GET", artifactPath(metrics.id, "/grants")),
      request(ben, "PUT", artifactPath(metrics.id, `/grants/${carl.id}`), {idempotent: true}),
      request(ben, "DELETE", artifactPath(metrics.id, `/grants/${ben.id}`), {idempotent: true}),
      request(ben, "DELETE", artifactPath(metrics.id, `/comments/${adaThread}`)),
      mutate(
        ben,
        "POST",
        `/api/v1/projects/${metrics.projectId}/artifacts/${metrics.id}/comments/clear`,
        {state: "all"},
      ),
    ]);
    expect(changes.map((change) => change.status)).toEqual(changes.map(() => 403));
    const codes = await Promise.all(changes.map(async (change) =>
      errorSchema.parse(await change.json()).error.code
    ));
    expect(codes).toEqual(changes.map(() => "AUTHORIZATION_DENIED"));
    await expect(publishVersion(server, as(ben), {
      artifactId: metrics.id,
      content: "Ben's edit",
      expectedCurrentVersionId: metrics.currentVersionId,
      idempotencyKey: "auth-033-ben-version",
      projectId: metrics.projectId,
    })).rejects.toThrow("HTTP 403");
    expect((await readArtifact(ada, metrics.id)).grantedPrincipalIds).toEqual([ben.id]);
    expect(await listedNames(carl)).not.toContain("Ada's metrics");

    // Carl and a service key with every capability see no artifact at all.
    const missing = await request(carl, "GET", artifactPath("art_00000000-0000-4000-8000-000000000000"));
    const missingBody = errorSchema.parse(await missing.json());
    await Promise.all([carl, service].map(async (outsider) => {
      expect(await listedNames(outsider)).not.toContain("Ada's metrics");
      const attempts = await Promise.all([
        request(outsider, "GET", artifactPath(metrics.id)),
        request(outsider, "GET", artifactPath(metrics.id, "/grants")),
        request(outsider, "PUT", artifactPath(metrics.id, `/grants/${outsider.id}`), {
          idempotent: true,
        }),
        request(outsider, "DELETE", artifactPath(metrics.id, `/grants/${ben.id}`), {
          idempotent: true,
        }),
      ]);
      expect(attempts.map((attempt) => attempt.status))
        .toEqual(attempts.map(() => missing.status));
      const bodies = await Promise.all(attempts.map(async (attempt) =>
        errorSchema.parse(await attempt.json())
      ));
      expect(bodies).toEqual(attempts.map(() => missingBody));
    }));
    expect((await request(service, "GET", "/api/v1/member-directory")).status).toBe(403);
    expect((await readArtifact(ada, metrics.id)).grantedPrincipalIds).toEqual([ben.id]);

    // Only active members can be added; the owner is never listed as a grant.
    const unknown = await request(
      ada,
      "PUT",
      artifactPath(metrics.id, "/grants/member_00000000-0000-4000-8000-000000000000"),
      {idempotent: true},
    );
    expect(unknown.status).toBe(404);
    expect(errorSchema.parse(await unknown.json()).error.code).toBe("IDENTITY_NOT_FOUND");
    const notAMember = await request(
      ada,
      "PUT",
      artifactPath(metrics.id, `/grants/${service.id}`),
      {idempotent: true},
    );
    expect(notAMember.status).toBe(404);
    expect(await grant(ada, metrics.id, ada.id)).toEqual({changed: false});
    expect((await fetch(`${server.baseUrl}/api/v1/members/${carl.id}/deactivate`, {
      headers: browserMutationHeaders(),
      method: "POST",
    })).status).toBe(200);
    const deactivated = await request(
      ada,
      "PUT",
      artifactPath(metrics.id, `/grants/${carl.id}`),
      {idempotent: true},
    );
    expect(deactivated.status).toBe(404);
    expect((await readArtifact(ada, metrics.id)).grantedPrincipalIds).toEqual([ben.id]);

    // A key that already recorded one change cannot carry a different one.
    const notes = await publishAs(ada, "Ada's notes", "restricted");
    const reusedKey = crypto.randomUUID();
    const granted = await request(ada, "PUT", artifactPath(notes.id, `/grants/${ben.id}`), {
      idempotencyKey: reusedKey,
    });
    expect(grantChangeSchema.parse(await granted.json())).toEqual({changed: true});
    const reused = await request(ada, "DELETE", artifactPath(notes.id, `/grants/${ben.id}`), {
      idempotencyKey: reusedKey,
    });
    expect(reused.status).toBe(409);
    expect(errorSchema.parse(await reused.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await readArtifact(ada, notes.id)).grantedPrincipalIds).toEqual([ben.id]);
    const retried = await request(ada, "PUT", artifactPath(notes.id, `/grants/${ben.id}`), {
      idempotencyKey: reusedKey,
    });
    expect(grantChangeSchema.parse(await retried.json())).toEqual({changed: false});
  });

  function administratorActor(): BrowserActor {
    return {cookies: administrator, id: "administrator"};
  }

  function as(actor: Actor): TestInstallation {
    return {...installation, apiToken: actor.token};
  }

  async function memberWithKey(displayName: string, email: string): Promise<Member> {
    const admitted = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName, email}),
      headers: browserMutationHeaders(),
      method: "POST",
    });
    expect(admitted.status).toBe(201);
    const memberId = memberSchema.parse(await admitted.json()).member.id;
    return {...await issueKey(memberId, `${displayName}'s key`), email};
  }

  async function issueKey(memberId: string | undefined, name: string): Promise<Actor> {
    const keyRequest: IssueKeyRequest = {
      capabilities: [...allCapabilities],
      expiresAt: "2099-01-01T00:00:00.000Z",
      name,
    };
    const body: IssueKeyRequest = memberId === undefined
      ? keyRequest
      : {...keyRequest, memberId};
    const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify(body),
      headers: browserMutationHeaders(),
      method: "POST",
    });
    expect(response.status).toBe(201);
    const issued = issuedKeySchema.parse(await response.json());
    return {id: issued.apiKey.principalId, token: issued.token};
  }

  async function publishAs(
    actor: Actor,
    name: string,
    accessSetting: "account_required" | "restricted",
  ): Promise<z.infer<typeof artifactSchema>> {
    const published = await publishNew(server, as(actor), {
      accessSetting,
      content: name,
      idempotencyKey: `publish-${name}-${actor.id}`,
      name,
    });
    expect(published.response.status).toBe(201);
    return artifactSchema.parse(published.body.artifact);
  }

  async function readArtifact(actor: Caller, artifactId: string) {
    const response = await request(actor, "GET", artifactPath(artifactId));
    expect(response.status).toBe(200);
    return artifactEnvelopeSchema.parse(await response.json()).artifact;
  }

  async function grant(
    actor: Caller,
    artifactId: string,
    memberId: string,
  ): Promise<z.infer<typeof grantChangeSchema>> {
    const response = await request(
      actor,
      "PUT",
      artifactPath(artifactId, `/grants/${memberId}`),
      {idempotent: true},
    );
    expect(response.status).toBe(200);
    return grantChangeSchema.parse(await response.json());
  }

  async function revoke(
    actor: Caller,
    artifactId: string,
    memberId: string,
  ): Promise<z.infer<typeof grantChangeSchema>> {
    const response = await request(
      actor,
      "DELETE",
      artifactPath(artifactId, `/grants/${memberId}`),
      {idempotent: true},
    );
    expect(response.status).toBe(200);
    return grantChangeSchema.parse(await response.json());
  }

  async function listedNames(actor: Caller, search?: string): Promise<string[]> {
    const query = search === undefined ? "" : `?search=${encodeURIComponent(search)}`;
    const response = await request(actor, "GET", `/api/v1/artifacts${query}`);
    expect(response.status).toBe(200);
    return artifactPageSchema.parse(await response.json()).artifacts
      .map(({artifact}) => artifact.name);
  }

  async function commentOn(
    actor: Actor,
    artifactId: string,
    versionId: string,
  ): Promise<string> {
    const response = await mutate(
      actor,
      "POST",
      artifactPath(artifactId, `/versions/${versionId}/comments`),
      {body: "Please check this."},
    );
    expect(response.status).toBe(201);
    return threadSchema.parse(await response.json()).thread.id;
  }

  async function registerAgent(actor: Actor): Promise<string> {
    const response = await fetch(`${server.baseUrl}/api/v1/agents`, {
      body: JSON.stringify({
        displayName: "Test agent",
        kind: "pi",
        workingDirectory: "/tmp/agent",
      }),
      headers: headersFor(actor, {json: true}),
      method: "POST",
    });
    expect(response.status).toBeLessThan(300);
    return agentSchema.parse(await response.json()).agent.id;
  }

  function dispatch(
    actor: Actor,
    agentId: string,
    threadIds: readonly string[],
  ): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/agent-dispatches`, {
      body: JSON.stringify({agentId, threadIds}),
      headers: headersFor(actor, {idempotent: true, json: true}),
      method: "POST",
    });
  }

  function request(
    actor: Caller,
    method: string,
    requestPath: string,
    options: {readonly idempotencyKey?: string; readonly idempotent?: boolean} = {},
  ): Promise<Response> {
    return fetch(`${server.baseUrl}${requestPath}`, {
      headers: headersFor(actor, options),
      method,
    });
  }

  function mutate(
    actor: Caller,
    method: string,
    requestPath: string,
    body: RequestBody,
  ): Promise<Response> {
    return fetch(`${server.baseUrl}${requestPath}`, {
      body: JSON.stringify(body),
      headers: headersFor(actor, {idempotent: true, json: true}),
      method,
    });
  }

  function headersFor(
    actor: Caller,
    options: {
      readonly idempotencyKey?: string;
      readonly idempotent?: boolean;
      readonly json?: boolean;
    } = {},
  ): Headers {
    const headers = "cookies" in actor
      ? new Headers({
        Cookie: actor.cookies.header,
        Origin: server.baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": actor.cookies.csrf,
      })
      : new Headers({Authorization: `Bearer ${actor.token}`});
    if (options.json === true) headers.set("Content-Type", "application/json");
    if (options.idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", options.idempotencyKey);
    } else if (options.idempotent === true) {
      headers.set("Idempotency-Key", crypto.randomUUID());
    }
    return headers;
  }

  function browserMutationHeaders(): Headers {
    return new Headers({
      "Content-Type": "application/json",
      Cookie: administrator.header,
      Origin: server.baseUrl,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": administrator.csrf,
    });
  }

  function openContentAccess(artifactId: string, principalId: string): number {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    try {
      const count = z.object({total: z.number()});
      return ["content_sessions", "content_bootstraps"].reduce(
        (total, table) => total + count.parse(database.prepare(
          `SELECT COUNT(*) AS total FROM ${table}
           WHERE artifact_id = ? AND principal_id = ?`,
        ).get(artifactId, principalId)).total,
        0,
      );
    } finally {
      database.close();
    }
  }
});
