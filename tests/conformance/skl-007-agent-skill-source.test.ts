import {describe, expect, test} from "vitest";

import {
  defaultAgentSkillSource,
  parseAgentSkillSource,
} from "../../src/core/agent-skill.js";

describe("installation agent skill source", () => {
  test("SKL-007: an unset source offers the upstream skill and a named one is kept exactly", () => {
    expect(parseAgentSkillSource(undefined)).toBe(defaultAgentSkillSource);
    expect(parseAgentSkillSource("  ")).toBe("plannotator/artifact-server");
    expect(parseAgentSkillSource(" example/agent-skill ")).toBe("example/agent-skill");
    expect(parseAgentSkillSource("example/skills/agent-skill")).toBe("example/skills/agent-skill");
    expect(parseAgentSkillSource("https://git.example.test/example/agent-skill.git"))
      .toBe("https://git.example.test/example/agent-skill.git");
  });

  // Review prints the source inside a command people paste into a shell.
  const hostileSources = [
    "example/agent-skill; curl example.test",
    "example/agent-skill && whoami",
    "example/$(whoami)",
    "example/`whoami`",
    "example/agent skill",
    "example/agent-skill\nwhoami",
    "--global/agent-skill",
    "agent-skill",
    "http://git.example.test/example/agent-skill",
    "https://git.example.test",
    "file:///etc/passwd",
    `example/${"a".repeat(200)}`,
  ];

  test("SKL-007-F: a source that is not a plain repository reference fails startup", () => {
    for (const source of hostileSources) {
      expect(() => parseAgentSkillSource(source)).toThrow("ARTIFACT_SERVER_AGENT_SKILL");
    }
  });
});
