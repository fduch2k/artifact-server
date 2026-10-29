# 0033: Member keys connect agents

**Status:** Proposed
**Date:** October 29, 2026

Builds on [0032: Personal API keys and owner-scoped capabilities](0032-personal-api-keys-and-owner-scoped-capabilities.md),
which left "a personal key that connects an agent to the dispatch mailbox" out
of its decision, and changes the principal that
[DSP-002](../agent-dispatch-spec.md#10-conformance-and-testing) requires for the
agent side of dispatch. Nothing changes for service keys, the local token, or
direct human sessions.

## Context

A reviewer comments on an artifact and sends the threads to the author's agent,
which fixes the artifact and answers. Until now the agent side of that loop —
registering, claiming, reporting, the activity beacon, and disconnecting — took
a service key holding `agent:connect`, and only an administrator issues service
keys. The pilot's authors therefore needed an administrator for the one key
their agent most needs, and a service key carries no member: it cannot see a
restricted artifact, so it cannot work on the author's own "Only me" artifacts,
and what it publishes is attributed to the key rather than the author.

## Decision

Any API key holding `agent:connect` connects agents: a service key, as before,
and now a key bound to a member, whether an administrator issued it or the
member issued it as a personal key. A person's browser session is still not an
agent and is refused.

Agents already belong to the principal that registered them. For a member key
that principal is the member, so the agent is that member's: any of the
member's keys holding `agent:connect` may claim, report on, beacon, and
disconnect it, and no other member's key can. Deactivating the member revokes
the keys, and the agent stops claiming. What the agent may do with the
artifacts it is sent is still decided by the key's other capabilities: a
personal key publishes only to its member's artifacts.

`agent:connect` joins the personal-key ceiling of 0032 and starts selected in
the issue dialog, like the other capabilities there. Sending and canceling a
dispatch keep their rules: a person's session, or a key with
`artifact:manage:any`.

## Requirements

| ID | Requirement |
| --- | --- |
| AUTH-036 | A key bound to a member and holding `agent:connect`, including a personal key, registers, claims, reports on, beacons, and disconnects agents that belong to that member; keys without the capability, other members' keys, and browser sessions cannot. |

## Not part of this decision

- Separating agents of one member by key. All of a member's keys reach all of
  that member's agents, as a person's keys reach all of their artifacts.
- A capability to send dispatches from a personal key.
- Showing in the agent list which member an agent belongs to.

## Rejected alternatives

### Keep agents on service keys and let members issue those

A self-issued service key would still carry no member, could not see the
author's restricted artifacts, and would attribute the agent's replies and
versions to a key instead of a person.
