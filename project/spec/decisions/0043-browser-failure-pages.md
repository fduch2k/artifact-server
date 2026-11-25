# 0043: A person's browser gets a page when sign-in is refused or a link opens nothing

**Status:** Proposed
**Date:** November 25, 2026

Builds on [0035: Private links send a browser through sign-in](0035-private-links-sign-in.md),
which tells a person's browser from a program and sends a signed-out browser
through sign-in, and on
[0030: Artifact owner and restricted access](0030-artifact-owner-and-restricted-access.md),
which answers a restricted artifact as not found to people who may not read it.

## Context

ADR 0035 listed two failures on the private-link routes as out of scope. A
person's browser still met the API's raw JSON error in both:

- the identity provider signed the person in, and `/auth/callback` answered
  `403 IDENTITY_ADMISSION_DENIED` because this installation did not admit them;
- a signed-in member opened `/artifacts/{id}` or `/open/{token}` for a
  restricted artifact they cannot see, and got `404 ARTIFACT_NOT_FOUND`.

The callback route had a third case of the same kind: a callback used twice,
expired, or failing at the provider answered a browser with JSON as well.

## Decision

A `GET` document navigation, as ADR 0035 defines it (accepts HTML and, when it
sends fetch metadata, reports a `document` destination and `navigate` mode),
that fails on one of these routes gets a short HTML page instead of JSON.
Every other request, including programs, embedded resources, frames, and
`HEAD`, keeps the JSON error and status code unchanged.

| Route | Failure | Page | Status |
| --- | --- | --- | --- |
| `/auth/callback` | the installation refuses admission | "You do not have access yet": ask an administrator for access, then open the link again | 403 |
| `/auth/callback` | the attempt was replayed, expired, came from another browser, or the callback is malformed; the provider failed | "Sign-in did not finish": open the link again, or sign in again | 401, 422, or 502 as the JSON answer |
| `/artifacts/{id}`, `/open/{token}` | missing or restricted artifact, unknown version, malformed token | "Artifact not available": check the link, or ask whoever shared it or an administrator for access | 404 |

- **Indistinguishable not found.** A missing artifact, a restricted artifact
  the viewer may not read, an unknown version, and a malformed token answer a
  browser with the same status, body bytes, and headers. The page names no
  artifact, version, token, title, error code, or request detail, so nothing
  in it differs between those causes. A malformed token answers 404 to a
  browser, not the 422 a program receives, because a person cannot act on the
  difference and it would separate one cause from the others.
- **No session on refusal.** A refused sign-in sets no application session, as
  before. The page does not try to resume the link.
- **Private pages.** Every page is `Cache-Control: private, no-store`,
  `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, with a
  closed Content-Security-Policy and no script. A provider failure is still
  logged as an adapter failure.

The choice lives in the HTTP adapter: application services keep failing with
the same typed failures, and the adapter picks a page only for the routes a
person's browser reaches by following a link.

## Requirements

| ID | Requirement |
| --- | --- |
| AUTH-042 | A person's browser whose sign-in this installation refuses, whose sign-in did not finish, or whose private link names nothing the viewer can see gets a short non-cacheable HTML page saying what happened and what to do; programs, embedded resources, and `HEAD` requests keep the JSON error and status, and a restricted artifact's page is indistinguishable from a missing one's. |

## Consequences

- A person refused admission learns to ask an administrator instead of seeing
  `IDENTITY_ADMISSION_DENIED`. The page does not name the administrator or the
  admitted email domains.
- A program asking `/open/{token}` still tells a restricted version
  (`ARTIFACT_NOT_FOUND`) from an unknown one (`VERSION_NOT_FOUND`) in the JSON
  code. That predates this decision and is not changed by it.

## Not part of this decision

- A page for failures on other routes, such as `/auth/login` when interactive
  login is unavailable, or the version host itself.
- Telling a signed-out person anything about a missing artifact before
  sign-in; a missing artifact still answers not found there, as in ADR 0035.

## Rejected alternatives

### Choosing a page in the global error handler

The global handler sees every route, including the version hosts and `/api`.
Deciding by path there would risk turning an API or content error into a page.
Naming the routes and the failures each one turns into a page keeps the change
narrow and keeps every other answer as it was.

### Separate pages for a restricted and a missing artifact

Telling a signed-in member "you do not have access to this artifact" would
confirm that a restricted artifact exists, which ADR 0030 forbids.

### Redirecting a refused person back to sign-in

The provider would sign them in again and the installation would refuse them
again: a loop with no explanation.
