# 0034: Sliding browser sessions

**Status:** Proposed
**Date:** October 30, 2026

Builds on [0004: Installation identity and login](0004-installation-identity-and-login.md),
which defines the browser session as an opaque, server-side credential.
Nothing changes for an installation that does not opt in: its sessions keep a
fixed lifetime of 12 hours from sign-in.

## Context

A browser session ends 12 hours after sign-in however much it is used. In a
private team that signs in through the company identity provider, people
review artifacts every day and meet the sign-in page every morning, and a
review link opened from chat lands on it whenever the last sign-in was the day
before. The fixed lifetime is not what bounds a departed person's access in
such a team: deactivating their member ends every session at once, and the
identity provider stops new sign-ins.

## Decision

An operator may make browser sessions sliding. With
`ARTIFACT_SERVER_SESSION_IDLE_DAYS` set to a whole number of days from 1 to
365:

- a new session expires that many days after sign-in;
- a use of a live session pushes its expiry to that many days after the use,
  so a session ends only after a full idle window without use;
- the stored expiry is rewritten at most once an hour per session, and only
  forward: a slower replica never shortens it, and a revoked or expired
  session, or one whose member is inactive, is refused rather than renewed;
- the response that renews a session re-issues the session and CSRF cookies
  with their existing values and the new expiry and is not cacheable; a route
  that writes the session cookie itself, such as logout, keeps the last word.

Without the setting a session keeps the fixed 12-hour lifetime and is never
renewed. A session issued under one setting keeps its stored expiry when the
setting changes and slides from its next use if sliding is on. Invalid values
fail startup.

## Requirements

| ID | Requirement |
| --- | --- |
| AUTH-037 | With a configured idle window, use renews a live browser session one idle window past the use, at most hourly and only forward, and the browser cookies follow; an idle, revoked, or deactivated member's session is not renewed, and without the setting sessions keep their fixed lifetime. |

## Consequences

- A session that keeps being used has no absolute end. Leaving the identity
  provider alone no longer bounds it; deactivating the member does.
- A renewal costs one conditional storage write per session per hour. A
  cached session check never renews, so the authentication cache keeps its
  bound of 0004.

## Not part of this decision

- An absolute maximum session age on top of the idle window.
- Ending sessions when the identity provider disables an account.
- Showing members their sessions or letting them end the ones on other devices.

## Rejected alternatives

### A longer fixed lifetime

A fixed seven days still signs everybody out once a week, mid-work, and keeps an
unused session alive just as long as an active one.

### Renewing on every request

Every API call would become a storage write, and replicas would race to rewrite
the same row. The hourly step makes the idle window an hour less exact in
exchange.
