# 0038: Owner-scoped management for people

**Status:** Proposed
**Date:** November 16, 2026

Builds on [0030: Artifact owner and opt-in restricted access](0030-artifact-owner-and-restricted-access.md),
which records who owns each artifact, and on
[0032: Personal API keys and owner-scoped capabilities](0032-personal-api-keys-and-owner-scoped-capabilities.md),
which narrowed keys to their member's own artifacts and left people as they
were. Would amend AUTH-008 for installations that opt in. Nothing changes for an
installation that does not.

## Context

AUTH-008-B requires that every admitted member "can read, publish, restore,
change visibility, tag, and delete project artifacts", and
`requireArtifactManagement` and `requireVersionPublication` let a person's own
session through without looking at the owner. 0032 decided that "owner scope
narrows keys, not people": a member's agent can no longer touch a colleague's
work, but the member can, from the browser.

Three facts make that the riskiest gap a private team has left:

- Signed-in members is the default access, so the rule covers nearly every
  artifact; only "Only me" and "Selected people" escape it.
- A deleted artifact cannot be brought back. There is no undelete route; only
  a restore of the whole installation returns it.
- A switch to a public link exposes the page outside the installation, and
  copies downloaded meanwhile cannot be recalled.

The pilot that led to 0032 asked for exactly this protection: "a key for their
own work lets an agent overwrite or delete someone else's". People in the
browser are the remaining way to do it.

## Decision

An operator may make management owner-scoped for people too. With
`ARTIFACT_SERVER_OWNER_SCOPED_MANAGEMENT=true`, a person's own session (the
browser, or MCP signed in as the person) manages and publishes to only the
artifacts that person owns. Administrators keep managing every artifact.

| Who, on an artifact that is not restricted | Setting off (AUTH-008) | Setting on |
| --- | --- | --- |
| Owner | everything | everything |
| Administrator | everything | everything |
| Other member, own session | everything | reads, opens, compares, comments, resolves, sends threads to agents |
| Member-bound key | its capabilities (0032) | unchanged |
| Service key | its capabilities | unchanged |

"Everything" is every action behind `requireArtifactManagement` and
`requireVersionPublication`, plus bulk clearing of threads:

- publishing a new version, capturing and relinking a linked source;
- restoring a version;
- changing tags;
- changing access, including a public link and the members a restricted
  artifact is shared with;
- deleting the artifact;
- reading its action history;
- clearing its threads in bulk.

Restricted artifacts already follow this rule (0030, 0031) and do not change.

The value must be exactly `true` or `false`; anything else fails startup.
Unset means `false`, so AUTH-008 stays as upstream defines it.

## Recorded decisions

### An operator setting, not a fork-wide change

Every earlier fork decision that changes who may do what is opt-in: personal
keys, sliding sessions, automatic admission. An installation that runs the fork
for other features keeps upstream's rule, and the conformance tests of AUTH-008
keep proving it with the setting off.

### The whole management set, not only the destructive part

Keys are owner-scoped for every management action (0032). Splitting the set
for people (delete, access and restore only) would leave two different rules
for the same member depending on whether they act through a key or the
browser, and tags and publishing would remain a way to change a colleague's
page. The owner chose the full set.

### Artifacts without a human owner belong to administrators

An artifact published by a service key, the local token, or a member who has
left has no human owner who can manage it. With the setting on, only
administrators manage it. A member who needs such a page changed asks an
administrator; there is no ownership transfer yet.

### What stays open to every member

Reading, listing, opening content, comparing versions, downloading,
commenting, replying, resolving and reopening threads, and sending threads to
agents stay as they are. Review is where a colleague's page is discussed; the
owner acts on what they decide.

### Review hides what the person cannot do

`GET /api/v1/session` reports `capabilities.ownerScopedManagement`. With it on,
Review shows the management controls (Manage access, Edit tags, Delete
artifact, Make current, capture) only on artifacts the person owns, or to an
administrator. The server refuses the same actions with `403
AUTHORIZATION_DENIED` whatever the interface shows.

## Requirements

| ID | Requirement |
| --- | --- |
| AUTH-040 | With owner-scoped management on, a person's own session publishes to, restores, tags, changes access of, deletes, reads the history of, and bulk-clears the threads of only artifacts that person owns; administrators manage every artifact; other members keep reading, commenting and sending threads to agents; with the setting off AUTH-008 is unchanged. |

## What it would amend

- **AUTH-008:** "every admitted human member can manage artifacts" gains a
  second exception: an installation with owner-scoped management, where only
  the owner and administrators manage.
- **Product specification** `#sharing`: the management column for members
  under the setting.

## Not part of this decision

- Ownership transfer, and what happens to the artifacts of a member who leaves
  beyond administrators managing them.
- Canceling dispatches: a person may still cancel any dispatch in the project.
- Undeleting an artifact.
- Project management, which keeps its own rule.

## Rejected alternatives

### Always on in the fork

Simpler code, but it rewrites AUTH-008 for everyone who builds the fork and
widens the gap with upstream for a rule some teams want.

### Only delete, access, and restore

Keeps tagging and publishing open to colleagues. See "The whole management
set" above.

### A per-artifact "protected" flag

The author would have to remember to set it, and the default access would stay
open. "Only me" and "Selected people" already give per-artifact protection;
the gap is the default.
