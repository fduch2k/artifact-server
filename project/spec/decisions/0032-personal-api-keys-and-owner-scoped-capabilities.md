# 0032: Personal API keys and owner-scoped capabilities

**Status:** Proposed
**Date:** October 27, 2026

Builds on [0030: Artifact owner and opt-in restricted access](0030-artifact-owner-and-restricted-access.md),
which records who owns each artifact. Takes up "self-service personal API-key
issuance by non-administrator members", which the
[local-owner and private-team access spec](../local-owner-and-private-team-access-spec.md)
deferred, and revisits the owned-capability pair that 0030 rejected. Nothing
changes for an installation that does not opt in and for keys that do not use
the new capabilities.

## Decision

Two capabilities reach only the artifacts the key's own member owns:

| Capability | Allows, on artifacts the key's member owns |
| --- | --- |
| `artifact:publish:own` | publishing new versions, capturing and relinking linked sources |
| `artifact:manage:own` | restoring, changing tags or access, choosing who a restricted artifact is shared with, deleting, reading the action history |

A service principal owns nothing, so these capabilities are refused on a
service key. `artifact:publish:any` and `artifact:manage:any` keep their
meaning, and a person's own browser session keeps every right it has today.

An operator may let members issue their own keys. With
`ARTIFACT_SERVER_PERSONAL_API_KEYS=true`, a signed-in member can issue, list,
and revoke keys that act as themselves from **Settings → Personal API keys**.
A personal key:

- acts as the member who issued it, so it counts as the owner of what that
  member owns and sees what that member sees;
- holds at most `artifact:create`, `artifact:read`, `artifact:publish:own`,
  `artifact:manage:own`, `comment:write`, and `content-session:issue`;
- expires within `ARTIFACT_SERVER_PERSONAL_API_KEY_MAX_DAYS` days, 30 unless
  the operator sets another whole number from 1 to 99999;
- is issued only from the member's browser session, never from another key;
- is revoked with every other key of the member when the member is
  deactivated.

A member's list shows every key that acts as them, including keys an
administrator bound to them, and the member may revoke any of them. Another
member's key reads exactly like a missing one. Administrators still see and
manage every key; a personal key is marked "Personal" there.

## Why

The first private-team installations hand each person's agent an
administrator-issued key bound to that person. An agent that should update its
owner's pages needs `artifact:publish:any`, and one that should tag or delete
them needs `artifact:manage:any`. Those reach every colleague's artifact that
is not restricted. Pilot users reported exactly that: a key for their own work
lets an agent overwrite or delete someone else's.

Issuing every such key also waits on an administrator, and the keys tend to
get long lifetimes so nobody has to ask twice. Letting members issue their own
short-lived, owner-scoped keys removes both problems without widening what
anyone can do.

## Recorded decisions

### Owner scope narrows keys, not people

A person's browser session still manages any artifact that is not restricted,
as 0030 left it. The owner scope applies only where a key names it. Keys are
what agents hold, and an agent acting for one person should not reach work it
was never asked to touch.

### Why the owned pair returns

0030 rejected restoring the removed `artifact:manage:owned` and
`artifact:publish:owned` because that ownership gated mutation without ever
narrowing reading, and so did not answer the problem 0030 was solving. This
decision answers a different problem: how far a key reaches when it changes
things. Reading stays with `artifact:read` and with 0030's visibility rules,
and the new names end in `:own` beside the existing `:any`.

### Only a session mints a personal key

Issuing, listing, and revoking personal keys require the member's own browser
session. A leaked key cannot issue its own successor and outlive revocation,
and cannot list the member's other keys. Deactivating the member revokes
everything.

### The ceiling is fixed; the lifetime is the operator's

The ceiling is the set of capabilities a person uses on their own work. It
leaves out `agent:connect`, which is reserved for service principals, and
`project:manage`, which stays with administrators. The longest lifetime is a
deployment setting rather than a constant, because installations differ in how
quickly they offboard people; the default of 30 days bounds how long a key of
someone who left but was not deactivated keeps working.

### No new storage

Personal keys are managed API keys. The issuer of a personal key is the member
it acts as, which is how the settings screens tell it apart. Capabilities are
already stored as a list, so no backend needs a migration.

## Requirements

| ID | Requirement |
| --- | --- |
| AUTH-034 | A signed-in member of an installation that opts in issues, lists, and revokes keys that act as themselves, within a fixed capability ceiling and the operator's longest lifetime; keys cannot mint keys, and deactivation revokes them. |
| AUTH-035 | `artifact:publish:own` and `artifact:manage:own` change only artifacts the key's member owns, on every mutation path, and are refused on service keys. |

## Not part of this decision

- A personal key that connects an agent to the dispatch mailbox. Agents are
  service principals keyed by principal id; giving a member's own keys that
  role needs its own decision.
- Rotating a personal key. A member issues a new key and revokes the old one.
- A limit on how many personal keys a member holds.
- Helm values for the two settings; compact Compose, external-storage Compose,
  and the Cloudflare worker read them from the environment.

## Rejected alternatives

### Let a member choose any capability their session has

Simpler, and a person's session can already manage any unrestricted artifact.
It would make every personal key as wide as the keys the pilot complained
about.

### A short fixed lifetime

Seven or thirty days fixed in code. Operators who offboard through their
identity provider within hours do not need it, and those who rely on
deactivation want a bound they choose.
