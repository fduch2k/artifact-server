# 0035: Private links send a browser through sign-in

**Status:** Proposed
**Date:** November 5, 2026

Builds on [0002: Shared identity and private content](0002-shared-identity-and-private-content.md),
which keeps the application login off version hosts and opens private content
through a one-time bootstrap and a version-scoped content cookie, and on
[0004: Installation identity and login](0004-installation-identity-and-login.md),
which defines browser sign-in with a same-origin `returnTo`.

## Context

The Share screen hands out two links besides Review: the moving latest link
`/artifacts/{id}` and the exact-version address `https://{token}.{content domain}/`.
Only a public current version opened through them. For an account-required or
restricted artifact both answered a person's browser with the raw JSON
`CONTENT_NOT_PUBLIC` error:

- a signed-out person saw no way to sign in;
- a signed-in member got the same error from the latest link, because that
  route never read the application session, although the product
  specification says the stable link checks that the viewer belongs to the
  installation;
- a signed-in member opening an exact-version address from chat got it too: the
  version host cannot see the application session, and its content cookie is
  `SameSite=Strict`, so it is not sent on a navigation from another site even
  while it is still valid.

## Decision

A person's browser that opens a private link without the session it needs is
sent through sign-in and back to the link, and a signed-in reader is given that
version's one-time bootstrap. "A person's browser" means a `GET` document
navigation: it accepts HTML and, when it sends fetch metadata, reports a
`document` destination and `navigate` mode.

- **Latest link.** A public current version still redirects straight to its
  version host. Otherwise a signed-in reader is redirected to a bootstrap for
  the current version. A signed-out browser goes to sign-in with the link as
  `returnTo`: the configured provider for a private team, or
  `/review/continue` for a local owner, where the management application
  creates the local session and then resumes the link. An expired, revoked, or
  forged session counts as signed out.
- **Exact-version address.** A browser that arrives from anywhere other than the
  version host itself goes to `/open/{token}?path={file}` on the application
  origin. That route treats a signed-out browser like the latest link does. For
  a signed-in reader it issues a bootstrap for exactly that version and returns
  the browser to the same file.
- **No loops.** The bootstrap exchange page reloads the version itself, so a
  navigation that comes from the same version host without a content cookie
  means the browser did not keep the cookie. It gets a sign-in page with a link
  to `/open/...`, not another redirect. A browser without fetch metadata gets
  the same page, because it cannot be told apart from that case.
- **Unchanged answers.** Programs, embedded resources, frames, and `HEAD`
  requests still get `401 CONTENT_NOT_PUBLIC`. A reader without access to a
  restricted artifact gets the same not-found answer as for a missing one, and
  no bootstrap. Every redirect and sign-in page is `private, no-store`.

The project is read from storage, because the links name none. The bootstrap is
then issued by the ordinary path, which checks project access, visibility, and
the content-session capability as before.

## Requirements

| ID | Requirement |
| --- | --- |
| AUTH-038 | A person's browser that opens a private latest link or exact-version address without a session is sent through this installation's sign-in and back to that link, and a signed-in reader receives that version's one-time content bootstrap; programs, embedded resources, a browser whose content cookie did not stick, and people without access get no redirect loop, bootstrap, or private bytes. |

## Consequences

- Opening a private link costs one bootstrap row each time the browser lacks a
  content session. That is no more than opening it from Review.
- An application session reaching `/artifacts/{id}` or `/open/{token}` renews a
  sliding session as an `/api` request does.
- A query string on an exact-version address is not carried through sign-in.
  The path is.

## Not part of this decision

- An HTML page for other failures a person can meet on these routes, such as a
  provider refusing admission or a restricted artifact answering not found.
- Longer content sessions, or renewing them while a person reads a version.

## Rejected alternatives

### Sending the version host's browser to the latest link

It would reveal the artifact ID to anyone holding an exact-version address and
open a different version once a new one is published.

### Redirecting every navigation without a content cookie

The exchange page reloads the version, so a browser that refuses the content
cookie would bounce between the two origins forever, issuing a bootstrap each
time.
