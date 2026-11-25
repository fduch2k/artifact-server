import {useEffect, useState} from "react";

import {api, type AgentPresence} from "@/api/client";
import {agentLocationLine, isMailboxAgent} from "@/components/dispatch/agent-destination";
import {PresenceGlyph, presenceRing} from "@/components/dispatch/presence-avatar";
import {ErrorPanel, PageHeader, StatePanel, StatusBadge} from "@/components/product";
import {Button} from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {errorMessage, formatRelativeTime} from "@/lib/presentation";

/**
 * The installation's registered agents, and removal of the ones the signed-in
 * person may forget: their own, or any agent for an administrator (ADR 0042).
 */
export function AgentsScreen({
  administrator,
  principalId,
}: {
  readonly administrator: boolean;
  readonly principalId: string;
}) {
  const [agents, setAgents] = useState<readonly AgentPresence[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [removing, setRemoving] = useState<AgentPresence | null>(null);
  const [pending, setPending] = useState(false);
  const [removeError, setRemoveError] = useState<Error | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      setAgents(await api.agentPresence());
      setNow(Date.now());
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught : new Error("Agent list failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const changeRemoving = (agent: AgentPresence | null): void => {
    setRemoving(agent);
    setRemoveError(null);
  };

  const forget = async (agent: AgentPresence): Promise<void> => {
    setPending(true);
    setRemoveError(null);
    try {
      await api.forgetAgent(agent.id);
      changeRemoving(null);
      await load();
    } catch (caught) {
      setRemoveError(caught instanceof Error ? caught : new Error("Removing the agent failed."));
    } finally {
      setPending(false);
    }
  };

  const removable = (agent: AgentPresence): boolean =>
    administrator || agent.principalId === principalId;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        description={administrator
          ? "Agents connected to this Artifact Server. Remove one to take it out of every send picker; you can remove any agent that holds no send in progress."
          : "Agents connected to this Artifact Server. Remove one of yours to take it out of every send picker while it holds no send in progress."}
        eyebrow="Account"
        title="Agents"
      />

      {loadError === null ? null : <ErrorPanel error={loadError} onRetry={() => void load()} />}
      {loading && agents.length === 0
        ? <StatePanel description="Loading the connected agents." title="Loading agents" />
        : agents.length === 0
          ? (
            <StatePanel
              description="No agent is registered. An agent appears here once it connects with a key that holds agent:connect."
              title="No agents"
            />
          )
          : (
            <div aria-label="Registered agents" className="grid border" role="list">
              {agents.map((agent) => (
                <article
                  aria-label={agent.displayName}
                  className="grid gap-4 border-b p-5 last:border-b-0 sm:grid-cols-[auto_1fr_auto]"
                  key={agent.id}
                  role="listitem"
                >
                  <PresenceGlyph kind={agent.kind} ring={presenceRing(agent)} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <h2 className="font-heading font-semibold">{agent.displayName}</h2>
                      <StatusBadge tone={agent.connected ? "primary" : "neutral"}>
                        {agent.connected
                          ? "Connected"
                          : isMailboxAgent(agent)
                            ? "Mailbox"
                            : "Not connected"}
                      </StatusBadge>
                      {agent.principalId === principalId
                        ? <StatusBadge>Yours</StatusBadge>
                        : null}
                    </div>
                    <p className="mt-2 font-mono text-xs break-all text-muted-foreground">
                      {agentLocationLine(agent)}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {`${agent.kind} · last seen ${formatRelativeTime(agent.lastSeenAt, now)}`}
                    </p>
                  </div>
                  {removable(agent)
                    ? (
                      <div className="flex gap-2 sm:justify-end">
                        <Button
                          aria-label={`Remove ${agent.displayName}`}
                          onClick={() => changeRemoving(agent)}
                          size="xs"
                          type="button"
                          variant="ghost"
                        >
                          Remove
                        </Button>
                      </div>
                    )
                    : null}
                </article>
              ))}
            </div>
          )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) changeRemoving(null);
        }}
        open={removing !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove agent</DialogTitle>
            <DialogDescription>
              {removing === null
                ? null
                : `${removing.displayName} leaves every send picker now. Sends it already finished keep their history. If it connects again, it comes back as a new agent.`}
            </DialogDescription>
          </DialogHeader>
          {removeError === null ? null : (
            <p className="text-sm leading-6 text-destructive" role="alert">
              {errorMessage(removeError)}
            </p>
          )}
          <DialogFooter>
            <Button
              disabled={pending || removing === null}
              onClick={() => {
                if (removing !== null) void forget(removing);
              }}
              type="button"
              variant="destructive"
            >
              {pending ? "Removing…" : "Remove agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
