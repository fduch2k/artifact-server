# 0039: Review's thread views list sent threads explicitly

**Status:** Proposed
**Date:** November 25, 2026

Builds on [0021: Agent dispatch](0021-agent-dispatch.md). It changes the
Review behavior described in the
[dispatch spec](../agent-dispatch-spec.md#9-web-application) and adds the
[Review thread views](../artifact-comments-spec.md#review-thread-views) section
of the comments spec. The comment listing contract (DSP-008, DSP-009) is
unchanged.

## Context

A mailbox agent claimed a bundle, reported it delivered, replied to each
thread, and resolved it, so the dispatch became `addressed`. An addressed
dispatch keeps its marker on threads that stay resolved, and the comment
listing excludes dispatched threads unless asked otherwise
(`dispatched=exclude`). Review read its Open, Resolved, and All tabs and the
artifact list's comment count from that default listing. The threads were
therefore listed only under Sent: Resolved and All did not show them or the
agent's replies, and the artifact list said "1 comment" for a version with
four threads.

The same default made the Open tab misleading. After "Send all open" the Open
view was empty, and when any other thread was resolved it said "All comments
on this version are resolved", although the sent threads were still open and
waiting for an agent.

## Decision

**Review lists every thread and filters it itself.** Review loads a version's
threads with `dispatched=include` and the ids of the threads a dispatch holds
with `dispatched=only`, and derives its views from the two:

- **Open** lists open threads no dispatch holds. Only these are drawn on the
  page and offered to "Send all open", exactly as before.
- **Resolved** lists every resolved thread, including threads an agent
  addressed, with their replies.
- **All** lists every thread on the version. A thread a dispatch holds offers
  no Send control there.
- **Sent** is unchanged: the threads a dispatch holds, with their dispatch
  state.

The comment count Review shows for the selected artifact is the size of All.

**The API default stays.** `comment_list` and `GET …/comments` still exclude
dispatched threads unless asked. Agents and integrations read that default as
"what is still waiting for a person", and DSP-008 and DSP-009 promise it. The
browser WebMCP tools also keep reading the default listing.

## Alternatives rejected

- **Change the listing default to `include`.** It fixes Review in one line but
  every agent that lists comments would start seeing threads it already
  handled, and DSP-009's "threads return to the default listings" would lose
  its meaning.
- **Add a dispatch marker to every thread in the payload.** It would let
  Review use one request instead of two, but it changes the thread contract
  across three storage backends and the MCP tools for a display concern. The
  second listing is small and runs only on load and when a poll sees a change.
- **Show addressed threads only under Sent.** That is the behavior reported as
  a defect: a reader looking for resolved threads and their replies does not
  look under Sent.

## Consequences

- Review makes one more listing request per load and per poll that finds a
  change.
- Dispatch membership can change without a thread changing (a cancel or a
  failure releases threads). Review sees that on its next load or the next poll
  that finds a changed thread, as it did before for threads another reader
  sent.
