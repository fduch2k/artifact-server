# 0036: Mailbox agents queue while away, and agents are offered only where they can read

**Status:** Proposed
**Date:** November 10, 2026

Builds on [0021: Agent dispatch](0021-agent-dispatch.md),
[0031: Restricted artifacts shared with members](0031-restricted-artifacts-shared-with-members.md),
and [0033: Member keys connect agents](0033-member-keys-connect-agents.md). It
changes the send control of the [send-all spec](../send-all-spec.md), the
honesty rules of the [presence spec](../agent-presence-and-bridge-spec.md#34-honesty-rules),
and the agent listing and send rules of the
[dispatch spec](../agent-dispatch-spec.md#5-access).

## Context

Two things went wrong once several members connected their own agents.

**A mailbox agent looked gone 90 seconds after its last check.** An MCP mailbox
agent (`evidence: "mailbox"`) has no heartbeat: it refreshes `lastSeenAt` only
when it calls `dispatch_inbox`. Review applied the live agents' presence rule to
it, so a minute and a half after a check the panel said "0 connected · 2
offline" and the control said "‹name› disconnected — pick another". The server
agreed in its own way: a queued dispatch whose agent had not polled for 15
minutes failed as `agent_unavailable`, so a send to a mailbox that checks in
twice a day came back before the agent ever saw it. The send-all spec already
promised the opposite — "Queued for ‹name› — it picks this up when it next
checks in."

**The picker offered every agent in the installation.** `GET /agents` listed
all registered agents to anyone who could read artifacts, with each agent's
working directory, and a send checked only what the sender could read. A
thread of a restricted artifact could be queued for an agent whose owner could
not read it; the mailbox then failed it at claim time ("Thread … is not
readable"), and the sender learned that late. Another member's working
directory was also on every reader's screen.

## Decision

**A mailbox is a queue.** A send to a mailbox-tier agent is accepted however
long ago it last checked in, and it waits as `queued` until the agent's next
check claims it. A stale heartbeat never fails a mailbox agent's queued
dispatch as `agent_unavailable`. The backstop is the registration itself: an
agent row unseen for the retention window (seven days) is reaped, and its
queued dispatches then fail as `agent_unavailable` and release their threads,
as for any vanished agent. Live tiers (`native`, `channel`) keep the 90-second
connected window, the disabled control for a disconnected remembered default,
and the 15-minute failure.

Review treats a mailbox agent that has not checked in recently as a
destination, not as offline: it stays selectable and remembered, its presence
reads "Mailbox — last checked … delivered on its next check", and the panel
counts it apart from connected and offline agents.

**An agent is offered only where it can read.** An agent acts for the
principal that registered it, and it always connects through an API key, so it
never has an administrator's reach:

- an agent of an active member reads what that member owns or was given;
- an agent of a service key or of the local token reads no restricted
  artifact;
- an agent of a former member reads nothing — its keys are revoked.

`GET /agents?artifactId=…` lists only the agents that can read that artifact,
and Review asks for exactly that list. A reader who cannot see the artifact
gets the artifact's not-found. Without `artifactId` the listing keeps every
agent that can still claim work. A former member's agent is listed nowhere,
and a send to it fails as `AGENT_NOT_FOUND`.

A send is refused as a whole with `INVALID_DISPATCH` when the target agent
cannot read the artifact of any thread in the bundle, in the same transaction
that would otherwise mark the threads, so a refusal leaves no marker.

Where another member's agent runs stays with that member: for an agent of a
member other than the reader, the listing returns `workingDirectory`,
`connectionKey`, and `agentSessionId` as `null`. Every listed agent carries
`ownerDisplayName`, the member it acts for (`null` for a service key's agent),
so Review can tell two members' agents of the same name apart. Agents of
service keys and the local token are installation tooling and keep their
working directory.

## Requirements

| ID | Requirement |
| --- | --- |
| DSP-014 | A mailbox-tier agent is a queue: a send to it is accepted and stays queued whatever its last check, until it claims or its registration is reaped; live agents keep the 15-minute `agent_unavailable` failure; Review keeps a waiting mailbox selectable and says it is delivered on the next check. |
| DSP-015 | The agent listing for an artifact holds only agents whose owner can read it, a send is refused whole when the target agent cannot read a thread's artifact, a former member's agent is offered nowhere, and another member's agent keeps its location private. |

## Not part of this decision

- Removing registered agents (fork backlog item 4).
- Sending from a personal key (fork backlog item 1).
- Re-checking an already queued dispatch when a grant is revoked after the
  send. The claim still reads each thread as the agent, as before.
- A presence signal for mailbox agents beyond the time of their last check.

## Rejected alternatives

### Widen the connected window for mailbox agents

Any window is a guess about how often a person asks their agent to check its
inbox, and the 15-minute failure would still need its own exception. The tier
already says what the agent is; the rules follow the tier.

### Filter the picker in the browser only

The browser does not know who can read a restricted artifact, and a client
that skipped the filter could still queue work an agent cannot read. The
server answers the question once, for the listing and for the send.

### Hide other members' agents entirely

A reviewer sending to the author's agent is the loop this fork is built for.
The agent stays visible where its owner can read the artifact; only where it
runs stays private.
