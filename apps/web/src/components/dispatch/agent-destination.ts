import type { AgentPresence } from "@/api/client";

/**
 * Whether the agent drains a mailbox: it picks up queued sends whenever it next
 * checks its inbox, so a stale heartbeat does not make it unreachable.
 */
export function isMailboxAgent(agent: AgentPresence): boolean {
  return agent.capabilities?.evidence === "mailbox";
}

/**
 * Whether a send to this agent can reach it: a live agent while its heartbeat
 * is fresh, a mailbox agent always — its queue waits for the next check.
 */
export function acceptsSend(agent: AgentPresence): boolean {
  return agent.connected || isMailboxAgent(agent);
}

/** Whether the agent is a mailbox that has not checked in recently. */
export function isWaitingMailbox(agent: AgentPresence): boolean {
  return !agent.connected && isMailboxAgent(agent);
}

/**
 * The line that tells agents apart: where your own agent runs, or whose
 * agent it is when another member's agent keeps its directory private.
 */
export function agentLocationLine(agent: AgentPresence): string {
  if (agent.workingDirectory !== null) return agent.workingDirectory;
  const owner = agent.ownerDisplayName ?? null;
  return owner === null ? "Another member's agent" : `${owner}'s agent`;
}
