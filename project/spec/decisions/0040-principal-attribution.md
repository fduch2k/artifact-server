# 0040: Who stands behind a comment, an owner, and a publisher

**Status:** Proposed
**Date:** November 25, 2026

Builds on [0030: Artifact owner and opt-in restricted access](0030-artifact-owner-and-restricted-access.md),
which records `ownerPrincipalId` on every artifact and `publisherPrincipalId`
on every version, on [0032: Personal API keys and owner-scoped capabilities](0032-personal-api-keys-and-owner-scoped-capabilities.md),
whose keys act as their member, and on
[0036: Mailbox queue and agent reach](0036-mailbox-queue-and-agent-reach.md),
which already names an agent's owner with `ownerDisplayName`.

## Context

Two places hid who stands behind an action.

- A principal authenticated by a member-bound API key carried the key's name
  as its display name. Threads, replies, resolutions, and sends written
  through the key were signed `laptop`, not by the member, and the bundle
  message an agent receives read "laptop sent 1 annotation(s)".
- Review's Details listed an artifact's name, access, and ids, and a version's
  number, entry, and ids, but never the owner or the publisher. With
  owner-scoped management (0038) the owner is the person to ask for a change.

## Decision

### One display model for principals

Every place that names a principal follows one model:

| Principal | Shown as |
| --- | --- |
| A member, from their own session | the member's name |
| A member, through a key bound to them | `Member · key name` |
| An unbound service key | `Service key · key name` |
| The local API token | `Local API token` |
| A former member | `Former member` |
| An id that matches none of the above | `Unknown principal` |

### Comments and sends capture the member and the key when written

A member-bound key now authenticates with the display name
`<member name> · <key name>`. A principal's display name is captured with every
write it makes and never re-read later (`src/core/identity.ts`), so threads,
replies, resolutions, and dispatch senders written through a key carry both
names, and the bundle message reads "Jane Doe · laptop sent 3 annotation(s)".
Nothing changes in storage, in the comment API's shape, or in the bundle
template: every client, MCP tool, and script sees the new name.

A service key cannot borrow a member's standing by its name: its author keeps
`principalKind: service` and its `service:` principal id whatever it is
called. A deactivated member's keys are revoked, so no new record carries
their name.

### Owners and publishers are resolved when read

Owner and publisher ids are resolved by the server on read, through
`InstallationAccessService.attributePrincipals`:

- `GET /api/v1/artifacts/:id` returns `owner` beside `artifact` and
  `current.publisher`;
- `GET /api/v1/artifacts` returns `owner` on each listed artifact;
- `GET /api/v1/artifacts/:id/versions` and
  `GET /api/v1/artifacts/:id/versions/:versionId` return `publisher`;
- the MCP tools `artifact_get` and `artifact_version_list` return
  `ownerDisplayName` and `publisherDisplayName` labels.

Each attribution is `{kind, label, principalId}`, plus `displayName` and
`email` for an active member and `keyName` for a service key. `owner` is
`null` for an artifact from before owners were recorded. Write responses
(publish, restore, capture) carry no attribution: the caller is the
publisher.

A member's email reaches only readers who are people, the same rule as
`GET /api/v1/member-directory`; a service key reads the name with `email:
null`. A former member's name and email are not served at all.

Review's Details shows **owner** for the artifact and **published by** for the
version: the label, the member's email on hover (the raw id behind any other
label), and "you" for the viewer's own.

## Recorded decisions

### Why comments capture and owners resolve

Comments already store a display name captured at write time, and the
identity model says that name is never re-read. Fixing the key principal's
name fixes every surface that reads it, including the bundle message an agent
receives, with no storage change. Owners and publishers store only an id, so
there is nothing captured to show; they are resolved like an agent's owner in
0036.

### Earlier comments keep the name they were written with

Threads, replies, resolutions, and sends written through a key before this
change keep the key's name. They are not rewritten in storage and not
re-resolved on read: the identity model forbids re-reading a captured name,
and a read-time rewrite would make the same record read differently from
different code paths. The author's `principalId` and
`authorizedByPrincipalId` still say which member and which issuer stood
behind them.

### Server attribution over an interface-only lookup

Review could have resolved ids through `GET /api/v1/member-directory`. That
directory is refused to service keys, lists only active members, and knows
nothing of service keys or the local token, so MCP tools and scripts would
still see raw ids, and the browser would have to reimplement the labels. The
server answers once, for every client.

## Requirements

| ID | Requirement |
| --- | --- |
| AUTH-041 | Owner and publisher attribution reveals a member's email only to readers who are people; a service key reads names without emails. |
| CMT-028 | Threads, replies, resolutions, and sends written through a member-bound key show the member with the key as a qualifier; a service key keeps its own kind whatever it is called. |
| ART-012 | Artifact and version reads name the owner and the publisher, with labels for service keys, the local token, and former members, and Review's Details shows them. |

## Not part of this decision

- Re-signing comments written through a key before this change.
- Showing the owner on catalog cards and a "mine" filter. The listing
  already returns `owner`, so both are interface work.
- Attributing the action history (`GET …/actions`), which still reports ids.

## Rejected alternatives

### Resolve every comment author on read

Would rename old key-written comments too, but every comment read path (HTTP,
MCP, Review, WebMCP, the bundle renderer) would need the member directory,
renamed members would change past records, and it contradicts the captured
display-name rule.

### Store the key name in a new comment column

Would let clients style the member and the key separately, at the cost of a
migration on SQLite, Postgres, and D1 for a value the combined display name
already carries.

### Answer only `ownerDisplayName` strings

A bare string cannot carry the email for hover or tell a client which label
it is looking at. MCP tools, which only print, take the label string.
