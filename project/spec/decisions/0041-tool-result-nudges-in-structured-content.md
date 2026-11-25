# 0041: Tool-result nudges travel in structuredContent

**Status:** Proposed
**Date:** November 25, 2026

Amends the delivery rule of [Tool-result nudges](../tool-result-nudges-spec.md)
("appended as a trailing text content item only; `structuredContent` is never
touched"). Adds NDG-003 and MCP-021 and rewords NDG-002.

## Context

A mailbox-tier agent learns about queued review bundles only from the nudge
the MCP server attaches to its ordinary tool results. The nudge was one
trailing text content item. A direct `tools/call` showed it; a Claude Code
session never did, so a Claude Code mailbox agent never picked up work by
itself.

Live probes settled the cause. A stand-in MCP server returned five result
shapes, each carrying a distinct marker, and the probes read what each host's
model received from the host's own transcript (Claude Code `--output-format
stream-json` tool results, Codex `exec --json` tool-call items):

| Result shape | Claude Code 2.1.332 | Codex 0.169.0 |
| --- | --- | --- |
| `structuredContent` plus a trailing text item (the shape before this change) | JSON of `structuredContent` only; the text item is dropped | everything |
| Text items only, no `structuredContent` | every text item | everything |
| A declared field inside `structuredContent` | the field | the field |
| A key in the result `_meta` | nothing | nothing |
| Nudge appended inside the first text item, `structuredContent` present | JSON of `structuredContent` only | everything |

Claude Code hands its model `JSON.stringify(structuredContent)` whenever a
result has structured content and discards every content item. Codex hands
its model the whole result, content and structured content alike. Neither
shows `_meta`. Every tool on this server declares an output schema, and both the SDK on our side and schema-validating clients
check `structuredContent` against it; the schemas are strict objects, so an
undeclared field fails validation.

## Decision

A nudge travels in two places on a successful result of a nudged tool:

- an optional `nudge` string field of `structuredContent`, declared once at
  the registration seam: every nudged tool's output schema is extended with
  `nudge: string (≤ 400 characters), optional`, and a tool that already
  declares a field of that name fails at registration;
- the trailing text content item, unchanged, for clients that show only
  content.

`dispatch_inbox`, the one nudge-free tool, keeps its schema without the field.
Error results never carry either. Every other structured field and every
existing content item stays byte-identical with and without a pending nudge.
A quiet result has no `nudge` key at all.

`scripts/qualify-mcp-host-nudge.ts` reruns the live check: a real server with
one queued bundle, one ordinary `artifact_version_list` call from each
installed host, and a verdict read from the host's transcript.

## Rejected alternatives

- **`_meta`.** Neither Claude Code nor Codex passes result `_meta` to its
  model; the nudge would stay invisible in both.
- **Nudges only on tools without structured output.** Every tool declares an
  output schema, so the nudge would reach nobody; removing
  output schemas would break typed consumers and the advertised contract.
- **Folding the nudge into the first text item.** Claude Code drops that item
  too when `structuredContent` is present, and the item would stop being the
  plain JSON or summary clients parse.
- **Only the structured field, no text item.** Codex would see the nudge once
  instead of twice, but a client that renders only content would lose it,
  which is the failure this change fixes. A duplicate of at most 400
  characters, only while work is pending, is the cheaper cost.

## Consequences

- Every nudged tool's advertised output schema gains one optional property.
  Clients that validate against the advertised schema accept nudged results;
  official SDK clients in both protocol eras are covered by NDG-003-B.
- A consumer that compares a whole `structuredContent` value across calls
  sees it change while work is pending. The rest of the value is unchanged.
- The live host check needs signed-in host CLIs and their model providers, so
  it stays outside `pnpm verify:iteration`; MCP-021 records it as a manual
  qualification.
