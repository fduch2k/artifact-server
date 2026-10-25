# 0031: Restricted artifacts shared with named members

**Status:** Proposed
**Date:** October 25, 2026

Builds on [0030: Artifact owner and opt-in restricted access](0030-artifact-owner-and-restricted-access.md),
which left "grants to named members or groups" for a later decision. Would
amend AUTH-031 and SCP-008-F. Nothing changes for an artifact that is not
restricted or that no one shares.

## Decision

The owner of a restricted artifact, or an installation administrator, may
share it with named members of the installation. Each grant names one active
member. A member the artifact is shared with may find, read, open, compare,
and comment on it, and may send its threads to an agent, exactly as the owner
can. Only the owner and administrators may publish to it, restore, change its
tags or access, delete it, clear its threads, read its action history, or
choose who it is shared with.

| Who | Restricted, no grants ("Only me") | Restricted, shared ("Selected people") |
| --- | --- | --- |
| Owner and administrators | everything, as in 0030 | everything, as in 0030 |
| Member it is shared with | not listed; answers as missing | lists, reads, opens, compares, comments, sends threads to an agent |
| Other members | not listed; answers as missing | not listed; answers as missing |
| Service principals | not listed; answers as missing | not listed; answers as missing |

The Review interface shows the two restricted cases as separate choices
between "Only me" and "Signed-in members". The API keeps the three access
settings of 0030; "Selected people" is `restricted` with at least one grant.

## Why

A restricted artifact either stays with its owner or opens to every member.
Teams publish pages that a few named colleagues must see and the rest of the
company must not: business metrics for a product group, a draft for two
reviewers, an incident write-up for the people on call. Without a middle step
the owner has to choose between not sharing and sharing with everyone, which
is the gap that made 0030 necessary in the first place.

## Recorded decisions

### Grants name members, not email addresses

A grant names an active member. Someone who has never signed in cannot be
added until they sign in once; with automatic admission that is their first
visit, otherwise an administrator admits them. Grants by email would need
pending grants, matching at sign-in, and their own rules for changed and
deactivated addresses, for little gain once members can admit themselves.

A deactivated member keeps the grant record but cannot authenticate, so it
grants nothing. Revoking it still works and is the way to tidy the list.

### Shared members read and comment; they do not change the artifact

Viewing and commenting is what sharing is for. Publishing, restoring, tagging,
deleting, and choosing who sees an artifact stay with its owner and
administrators. This holds for a member-bound key with `artifact:manage:any`:
managing any artifact does not reach a restricted artifact that is only shared
with you, including deleting other people's comments on it.

### Grants follow members through their keys

A grant names a member id. A member-bound API key carries that id, so the key
sees what its member sees, as 0030 already does for owners. A service key
never sees a restricted artifact, shared or not.

### Git clone credentials stay with the owner and administrators

Clone credentials come from the Git provider and cannot be revoked early. A
member who is later removed from the list would keep a clone credential until
it expires, so shared members do not receive one.

### Grants are kept when the setting changes

Grants take effect only while the artifact is restricted. Switching to
account-required or a public link leaves them in place, and switching back
restores them, so a round trip does not lose the list. The Review interface
clears them when the owner chooses "Only me", so the interface never restores
a list the owner can no longer see.

### Revoking ends open content at once

Removing a member deletes that member's content sessions and unconsumed
bootstraps for the artifact in the same transaction, as 0030 does for the
switch to restricted. The switch to restricted now keeps the sessions of the
owner and of the members it is shared with.

### Members can see who else is a member

Choosing people needs a directory. Any signed-in person, or a member-bound key,
may list active members' display names and email addresses; service
principals may not. Roles, status, and administration stay with
administrators. The directory is the installation's own membership, which an
internal team already shares.

### Changing grants is recorded as an access change

Granting and revoking each record one `change_access` action against the
current version, attributed like every other change. The Postgres and D1
action ledgers constrain the action kinds, and an access change is what a
grant is; a new kind would need a table rebuild on D1 for no new information.
A repeated grant or revocation changes nothing and records nothing.

### Storage: one table

Each backend gains `artifact_grants`, keyed by artifact and member, with an
index by member for listings. Listings, search, counts, and dispatch filter
shared artifacts inside the query. An artifact record carries its grantees, so
every visibility check stays a pure function of the record.

| Backend | Migration |
| --- | --- |
| SQLite | schema 14 |
| D1 | revision 11 |
| Postgres | `0013_artifact_grants` |

## Requirements

- **AUTH-033:** a restricted artifact can be shared with named active members,
  who can find, read, open, and comment on it until the grant is revoked, and
  cannot change it or reshare it; nobody else can find it or manage its
  grants.

## Not part of this decision

- Grants to groups or to email addresses of people who never signed in.
- An editor role that lets a shared member publish versions.
- Notifying a member that something was shared with them.
- MCP tools for grants; the HTTP API and the Review interface carry them first.

## Rejected alternatives

### Per-project member lists

Rejected for the same reasons as in 0030: it moves the decision from one page
to a whole project and adds a membership surface per project.

### A fourth access setting

`shared` beside `restricted` would duplicate every restricted rule and add a
second migration of the stored setting. A restricted artifact with grants
already says the same thing.
