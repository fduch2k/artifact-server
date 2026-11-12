# 0037: Keys send dispatches with agent:dispatch

**Status:** Proposed
**Date:** November 12, 2026

Builds on [0032: Personal API keys and owner-scoped capabilities](0032-personal-api-keys-and-owner-scoped-capabilities.md)
and [0033: Member keys connect agents](0033-member-keys-connect-agents.md), which
left "a capability to send dispatches from a personal key" out of its decision.
It changes the send and cancel rules of the
[dispatch spec](../agent-dispatch-spec.md#5-access) and the personal-key ceiling
of 0032.

## Context

A member who sends threads to an agent from Review cannot do the same from a
script or an agent: their personal key gets `403 AUTHORIZATION_DENIED` on
`POST /api/v1/agent-dispatches`, even for the member's own artifact, thread, and
agent. Sending and canceling took a person's browser session or a key holding
`artifact:manage:any`, which a personal key can never hold and which also lets a
key change every artifact.

Opening the send through a capability keys already hold was considered and
refused (see Rejected alternatives): a send is not a comment and not a
connection. It hands work to an agent, and the rendered message tells the agent
not to wait for confirmation. A key that may write comments, or that only
receives work, should not also be able to give work to other members' agents.

## Decision

A new capability, `agent:dispatch`, lets an API key send and cancel dispatches.

- **Who may hold it.** It joins the personal-key ceiling of 0032, and an
  administrator may give it to a key bound to a member or to a service key. In
  the personal-key issue dialog it starts unselected, unlike the rest of the
  ceiling: sending work to agents is chosen on purpose.
- **Reach.** A key sends with its principal's reach, as a person sends from
  Review. A key bound to a member reaches the threads of artifacts the member
  can read, including restricted artifacts shared with them; a thread of a
  restricted artifact the member cannot see counts as missing. A service key
  reaches no restricted artifact. The target rules of 0036 apply unchanged: the
  agent's owner must be able to read every thread's artifact.
- **Cancel.** A key holding `agent:dispatch` cancels only dispatches its
  principal sent. For a member key that is everything the member sent, from
  Review or from any of their keys. People in Review and keys holding
  `artifact:manage:any` keep canceling any dispatch in the project.
- **Nothing else.** The capability lets a key resolve projects, as every other
  write capability does, and grants nothing beyond sending and canceling. Bulk
  clearing an artifact's threads, which shared the old send rule, keeps it: a
  person, or `artifact:manage:any`. `artifact:manage:any` keeps sending and
  canceling as before.

Existing keys do not change. A key gains the capability only when it is issued
with it, so a member who wants it issues a new personal key.

## Requirements

| ID | Requirement |
| --- | --- |
| AUTH-039 | A key holding `agent:dispatch` sends dispatches with its principal's reach and cancels only the dispatches its principal sent; without the capability a key cannot send or cancel, and the capability does not reach bulk comment clearing. |

## Not part of this decision

- An MCP tool for sending. The capability opens the HTTP route; agents keep
  receiving through `dispatch_inbox`.
- Limiting a key's sends to its member's own agents. A key reaches the agents a
  person may pick in Review.
- A per-capability default in the administrator's issue dialog, which starts
  with nothing selected.

## Rejected alternatives

### Open the send to keys holding `comment:write`

Every key that writes comments would gain the send at deploy time, including
service keys issued to bots that only post comments, and no key could write
comments without also handing work to every reachable agent.

### Open the send to keys holding `agent:connect`

`agent:connect` is the receiving side: a key holding only it sees just what was
sent to its agent. Opening the send there would let every connected agent give
work to other members' agents, and would let a key with no comment rights move
threads out of every listing. It would also widen every agent key at deploy
time.
