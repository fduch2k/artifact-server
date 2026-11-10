import {agentEvidenceKinds} from "../core/model.js";

/** The refusal every backend gives a send its target agent could not read. */
export const recipientCannotReadMessage =
  "The chosen agent cannot read every artifact in this bundle: its owner has no access to at least one of them.";

/**
 * SQL that is true when a registered agent declared the mailbox evidence tier.
 *
 * A mailbox is a queue the agent drains whenever it next checks its inbox, so
 * a stale heartbeat never fails its queued dispatches as `agent_unavailable`.
 * Reaping the agent row after the retention window still does. The column is
 * always written as normalized JSON by agent registration.
 */
export function mailboxAgentSql(
  alias: string,
  dialect: "postgres" | "sqlite",
): string {
  const evidence = dialect === "postgres"
    ? `(${alias}.capabilities_json::jsonb ->> 'evidence')`
    : `json_extract(${alias}.capabilities_json, '$.evidence')`;
  return `${evidence} = '${agentEvidenceKinds.mailbox}'`;
}
