/** The upstream skill offered when an installation does not name its own. */
export const defaultAgentSkillSource = "plannotator/artifact-server";

const maximumAgentSkillSourceLength = 200;

/**
 * A skills-CLI source Review can print inside a copyable shell command:
 * `owner/repository[/path…]` or an `https://` repository address. The
 * character set leaves no room for shell syntax, and the first character
 * cannot turn the source into a command-line flag.
 */
const shorthandSource = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)+$/u;
const httpsSource = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~@-]+)+$/u;

/** Validate the operator's agent skill source; unset keeps the upstream skill. */
export function parseAgentSkillSource(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return defaultAgentSkillSource;
  const source = value.trim();
  if (
    source.length > maximumAgentSkillSourceLength ||
    !(shorthandSource.test(source) || httpsSource.test(source))
  ) {
    throw new Error(
      "ARTIFACT_SERVER_AGENT_SKILL must be owner/repository[/path] or an https:// repository address of at most 200 characters.",
    );
  }
  return source;
}
