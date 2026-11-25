/**
 * The nudge composer's own contract: one block in the spec's priority
 * order, sanitized through the shared bundle sanitization on its single
 * exit, and bounded — proven with the same hostile characters the render
 * sanitization tests use, so the conformance suite's "no untrusted text"
 * assertion has a check behind it that can actually fail.
 */

import {describe, expect, test} from "vitest";
import {z} from "zod";

import {
  appendToolResultNudge,
  composeToolResultNudge,
  maximumNudgeCharacters,
  nudgeHeading,
  withNudgeField,
} from "../../src/mcp/tool-result-nudges.js";

// ASCII-escaped codepoints only, so the hostile set is visible in review.
const hostilePattern =
  /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\uFEFF]/u;
const hostileDispatchId =
  "dsp_\u202Eevil\u202C\u200B01\u2066x\u2069\uFEFF";

describe("tool-result nudge composition", () => {
  test("picks exactly one kind in priority order and nothing when nothing applies", () => {
    expect.hasAssertions();
    expect(composeToolResultNudge({
      activeBundle: {dispatchId: "dsp_active"},
      queuedBundles: 2,
      settledBundle: {dispatchId: "dsp_settled", threadCount: 3},
    })).toContain("2 review bundles are queued");
    expect(composeToolResultNudge({
      activeBundle: {dispatchId: "dsp_active"},
      queuedBundles: 0,
      settledBundle: {dispatchId: "dsp_settled", threadCount: 3},
    })).toContain("Your claimed bundle dsp_active is not fully resolved");
    const settled = composeToolResultNudge({
      activeBundle: null,
      queuedBundles: 0,
      settledBundle: {dispatchId: "dsp_settled", threadCount: 1},
    });
    expect(settled).toContain("All 1 thread in bundle dsp_settled are resolved");
    expect(settled?.startsWith(nudgeHeading)).toBe(true);
    expect(composeToolResultNudge({
      activeBundle: null,
      queuedBundles: 0,
      settledBundle: null,
    })).toBeNull();
  });

  test("strips bidirectional and invisible characters from anything a nudge quotes", () => {
    expect.hasAssertions();
    for (const nudge of [
      composeToolResultNudge({
        activeBundle: {dispatchId: hostileDispatchId},
        queuedBundles: 0,
        settledBundle: null,
      }),
      composeToolResultNudge({
        activeBundle: null,
        queuedBundles: 0,
        settledBundle: {dispatchId: hostileDispatchId, threadCount: 2},
      }),
    ]) {
      expect(nudge).not.toBeNull();
      expect(nudge).not.toMatch(hostilePattern);
      // The visible characters of the id survive; only the directives go.
      expect(nudge).toContain("dsp_evil01x");
    }
  });

  test("bounds one block and attaches it as the nudge field and one trailing text item", () => {
    expect.hasAssertions();
    const nudge = composeToolResultNudge({
      activeBundle: {dispatchId: "x".repeat(2_000)},
      queuedBundles: 0,
      settledBundle: null,
    });
    expect(nudge).not.toBeNull();
    expect((nudge ?? "").length).toBe(maximumNudgeCharacters);

    const original = {
      content: [{text: "{\"ok\":true}", type: "text" as const}],
      structuredContent: {ok: true},
    };
    const appended = appendToolResultNudge(original, nudge ?? "");
    // The structured value gains only the nudge field; the original is not
    // mutated, so a cached result stays nudge-free.
    expect(appended.structuredContent).toEqual({nudge, ok: true});
    expect(original.structuredContent).toEqual({ok: true});
    expect(appended.content).toHaveLength(2);
    expect(appended.content[0]).toBe(original.content[0]);
    expect(appended.content[1]).toEqual({text: nudge, type: "text"});
  });

  test("adds an optional bounded nudge field to a strict output schema and refuses a tool that already owns the name", () => {
    expect.hasAssertions();
    const extended = withNudgeField("project_list", z.object({ok: z.boolean()}).strict());
    expect(extended.safeParse({ok: true}).success).toBe(true);
    expect(extended.safeParse({nudge: "x", ok: true}).success).toBe(true);
    // Still strict: only the nudge field was added.
    expect(extended.safeParse({ok: true, other: 1}).success).toBe(false);
    expect(extended.safeParse({
      nudge: "x".repeat(maximumNudgeCharacters + 1),
      ok: true,
    }).success).toBe(false);
    expect(() => withNudgeField("clashing_tool", z.object({nudge: z.number()})))
      .toThrow('Tool clashing_tool declares the reserved output field "nudge".');
  });
});
