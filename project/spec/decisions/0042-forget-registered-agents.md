# 0042: Owners and administrators forget registered agents

**Status:** Proposed
**Date:** November 25, 2026

Builds on [0021: Agent dispatch](0021-agent-dispatch.md),
[0033: Member keys connect agents](0033-member-keys-connect-agents.md), and
[0036: Mailbox agents queue while away, and agents are offered only where they can read](0036-mailbox-queue-and-agent-reach.md),
which left "removing registered agents" out of its decision. It adds one route
to the [dispatch spec](../agent-dispatch-spec.md#7-http-routes) and one screen
to Review settings.

## Context

`/api/v1/agents` offers register, list, disconnect, claims, and activity, but
no delete. Disconnect is the bridge's own courtesy on shutdown, so it takes a
key holding `agent:connect` and is refused to a person in the browser. An MCP
mailbox agent has no shutdown at all. A one-off registration — a probe, a test
session — therefore stays in every reader's send picker until the seven-day
retention reaper removes it, and its owner cannot remove it sooner.

## Decision

`DELETE /api/v1/agents/{agentId}` forgets one registered agent.

- **Who.** The agent's owner — the person's own session, or any of their keys
  holding `agent:connect`, which already disconnect that agent (0033) — and a
  human administrator, for any agent, including the agents of service keys and
  of former members. A browser session needs no capability; a key without
  `agent:connect` is refused with `403 AUTHORIZATION_DENIED` before any agent is
  looked up.
- **Others learn nothing.** For another member, and for another member's key,
  the agent answers `404 AGENT_NOT_FOUND` with the same message as an agent
  that does not exist. A `403` would confirm that the identifier names a live
  registration of someone else.
- **Work in progress keeps the agent.** While the agent holds a `queued`,
  `claimed`, or `delivered` dispatch the removal is refused with
  `409 DISPATCH_STATE_CONFLICT` and a message naming the way out: cancel the
  send, or wait until it fails or is addressed. The lazy transitions run first,
  in the same transaction (SQLite, Postgres) or batch (D1) as the delete: an
  expired lease is back in `queued`, a stale live agent's queue has failed as
  `agent_unavailable`, and a delivered bundle whose threads are all resolved is
  `addressed`. An administrator gets the same refusal.
- **Gone at once, history kept.** The row is deleted, so the agent leaves every
  listing in the same request. Dispatch records keep their agent id and name
  snapshot, as they do after disconnect and reaping.
- **A returning client is new.** A later `POST /agents` or `dispatch_inbox`
  call from the same client finds no row and inserts one with a new id.
- **Review.** Settings gains an **Agents** page for people signed in through the
  browser. It lists the agents `GET /agents` returns and offers **Remove** on
  the person's own agents, or on every agent for an administrator. A refusal is
  shown in the confirmation dialog with the server's message.

## Requirements

| ID | Requirement |
| --- | --- |
| DSP-017 | An agent's owner, from their session or a key holding `agent:connect`, and an administrator forget an idle agent, which leaves every listing at once and comes back as a new row when the client registers again; another member, their keys, and a missing agent all get the same `AGENT_NOT_FOUND`. |
| DSP-018 | An agent holding a queued, claimed, or delivered dispatch cannot be forgotten, by its owner or an administrator, until the dispatch is canceled, failed, or addressed; the dispatch record outlives the agent. |

## Recorded decisions

### Reuse `DISPATCH_STATE_CONFLICT`

The refusal is a conflict with dispatch state, and clients already handle the
code with its message. A new code would have to be added to the failure union,
the HTTP mapping, MCP, and the web client for no behavior a client could not
already get from the message.

### No MCP tool

The MCP surface is the agent's side of dispatch, and the only agent it has is
the caller's own mailbox: `dispatch_inbox` registers it on every `list` and
`claim`. A `forget` operation there would be undone by the agent's next inbox
call, and a person removing a probe works from Review, where the list of agents
is. MCP has no agent listing to pick another agent from either. If agents later
need to drop their own mailbox registration at the end of a session, that is a
`dispatch_inbox` operation of its own, not a general delete tool.

### Removal is not disconnect

Disconnect stays as it is: the bridge's best-effort shutdown, idempotent, open
only to `agent:connect` keys, and not checked against dispatches, because a
live bridge that goes away with queued work is what the `agent_unavailable`
failure already handles. Forgetting is a decision taken by a person about an
agent that may not be running, so it answers precisely and protects work in
flight.

## Not part of this decision

- Removing an agent from the send-control menu in the comments panel. Settings
  is the one place the whole list is shown with owners.
- Canceling an agent's active dispatches as part of removing it. A person
  cancels the send in Review first; the refusal says so.
- Hiding agents per reader without removing them.
- Removal by keys holding `artifact:manage:any`. Administration of other
  principals' agents stays with people who administer the installation.

## Rejected alternatives

### Open disconnect to people

Disconnect is idempotent and silent by design: a missing row is a success. That
would tell a person "removed" for an agent they cannot see, and it would delete
an agent holding queued work, failing that work at the next read.

### Cancel or fail active dispatches on removal

The sender, not the agent's owner, decides what happens to a send. Failing it
silently from the agent's side would return threads to someone who did not
expect them back, while a refusal leaves the decision with the people involved.

### Answer `403` to other members

It distinguishes "exists, not yours" from "does not exist" and lets any member
probe the registry by identifier. Listings already withhold where another
member's agent runs (0036); removal should not leak more than the listing.
