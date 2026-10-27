import {useEffect, useState} from "react";

import {
  api,
  type IssuedApiKey,
  type ManagedApiKey,
  type PrincipalCapability,
} from "@/api/client";
import { ErrorPanel, PageHeader, StatePanel, StatusBadge } from "@/components/product";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatTimestamp } from "@/lib/presentation";
import { formatDatetimeLocalMinimum, SecretDialog } from "./settings-api-keys.tsx";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
// Leave room for clock skew between this browser and the server's limit check.
const expirationSafetyMilliseconds = 5 * 60 * 1_000;

/** The capabilities a member may give a key that acts as themselves. */
const personalCapabilities: readonly {
  readonly description: string;
  readonly label: string;
  readonly value: PrincipalCapability;
}[] = [
  { description: "List and read artifact metadata.", label: "Read artifacts", value: "artifact:read" },
  { description: "Create new artifacts, owned by you.", label: "Create artifacts", value: "artifact:create" },
  { description: "Publish new versions of your own artifacts.", label: "Publish your versions", value: "artifact:publish:own" },
  { description: "Restore, tag, change access of, or delete your own artifacts.", label: "Manage your artifacts", value: "artifact:manage:own" },
  { description: "Open account-required artifact content.", label: "Issue content sessions", value: "content-session:issue" },
  { description: "Read, reply to, and resolve review comments.", label: "Manage comments", value: "comment:write" },
];

/** Keys that act as the signed-in member, and self-service issuance when enabled. */
export function PersonalApiKeysScreen({
  maxLifetimeDays,
  principalId,
}: {
  /** Null when this installation keeps key issuance with administrators. */
  readonly maxLifetimeDays: number | null;
  readonly principalId: string;
}) {
  const [apiKeys, setApiKeys] = useState<readonly ManagedApiKey[]>([]);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  const [expiration, setExpiration] = useState("");
  const [selectedCapabilities, setSelectedCapabilities] = useState<
    readonly PrincipalCapability[]
  >(personalCapabilities.map(({value}) => value));

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setApiKeys(await api.personalApiKeys());
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key list failed."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const latestExpiration = (): string | null => maxLifetimeDays === null
    ? null
    : formatDatetimeLocalMinimum(new Date(
      Date.now() + maxLifetimeDays * millisecondsPerDay - expirationSafetyMilliseconds,
    ));

  const openIssue = (open: boolean) => {
    if (open && expiration === "") setExpiration(latestExpiration() ?? "");
    setIssueOpen(open);
  };

  const toggleCapability = (capability: PrincipalCapability, checked: boolean) => {
    setSelectedCapabilities((current) => checked
      ? [...current, capability]
      : current.filter((candidate) => candidate !== capability));
  };

  const issue = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await api.issuePersonalApiKey(
        name,
        new Date(expiration).toISOString(),
        selectedCapabilities,
      );
      setIssueOpen(false);
      setIssued(result);
      setName("");
      setExpiration("");
      setSelectedCapabilities(personalCapabilities.map(({value}) => value));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key issuance failed."));
    } finally {
      setPending(false);
    }
  };

  const revoke = async (keyId: string) => {
    setPending(true);
    setError(null);
    try {
      await api.revokePersonalApiKey(keyId);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("API key revocation failed."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        actions={maxLifetimeDays === null ? undefined : (
          <Dialog onOpenChange={openIssue} open={issueOpen}>
            <DialogTrigger render={<Button type="button" />}>Issue personal key</DialogTrigger>
            <DialogContent className="sm:max-w-xl">
              <DialogHeader>
                <DialogTitle>Issue personal key</DialogTitle>
                <DialogDescription>
                  The key acts as you and reaches only your own artifacts. The secret appears once,
                  and the key expires within {maxLifetimeDays} days.
                </DialogDescription>
              </DialogHeader>
              <div className="grid max-h-[60svh] gap-5 overflow-y-auto pr-1">
                <div className="grid gap-2">
                  <Label htmlFor="personal-api-key-name">Name</Label>
                  <Input
                    id="personal-api-key-name"
                    maxLength={200}
                    onChange={(event) => setName(event.currentTarget.value)}
                    placeholder="Laptop agent"
                    value={name}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="personal-api-key-expiration">Expires at</Label>
                  <Input
                    id="personal-api-key-expiration"
                    max={latestExpiration() ?? undefined}
                    min={formatDatetimeLocalMinimum(new Date())}
                    onChange={(event) => setExpiration(event.currentTarget.value)}
                    type="datetime-local"
                    value={expiration}
                  />
                </div>
                <fieldset className="grid gap-3">
                  <legend className="text-sm font-medium">Capabilities</legend>
                  {personalCapabilities.map((capability) => {
                    const checked = selectedCapabilities.includes(capability.value);
                    return (
                      <label
                        className="group/field grid cursor-pointer grid-cols-[auto_1fr] gap-x-3 border p-3"
                        key={capability.value}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) => toggleCapability(capability.value, next)}
                        />
                        <span>
                          <span className="block text-sm font-medium">{capability.label}</span>
                          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                            {capability.description}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              </div>
              <DialogFooter>
                <Button
                  disabled={pending
                    || name.trim() === ""
                    || expiration === ""
                    || selectedCapabilities.length === 0}
                  onClick={() => void issue()}
                  type="button"
                >
                  {pending ? "Issuing…" : "Issue personal key"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
        description="Keys that act as you, for agents and the command line. Revoking one stops it at once; leaving the team revokes them all."
        eyebrow="Account"
        title="Personal API keys"
      />

      <SecretDialog issued={issued} onDiscard={() => setIssued(null)} />
      {error === null ? null : <ErrorPanel error={error} onRetry={() => void load()} />}
      {maxLifetimeDays === null
        ? (
          <StatePanel
            description="This Artifact Server keeps key issuance with administrators. Ask one for a key bound to you."
            title="Self-service keys are off"
          />
        )
        : null}
      {loading && apiKeys.length === 0
        ? <StatePanel description="Loading your API keys." title="Loading API keys" />
        : apiKeys.length === 0
          ? (
            <StatePanel
              description="No key acts as you yet."
              title="No personal API keys"
            />
          )
          : (
            <div className="grid border">
              {apiKeys.map((apiKey) => (
                <article className="grid gap-4 border-b p-5 last:border-b-0 lg:grid-cols-[1fr_1.5fr_auto]" key={apiKey.id}>
                  <div>
                    <div className="flex flex-wrap items-center gap-3">
                      <h2 className="font-heading font-semibold">{apiKey.name}</h2>
                      <StatusBadge tone={apiKey.revokedAt === null ? "primary" : "danger"}>
                        {apiKey.revokedAt === null ? "Active" : "Revoked"}
                      </StatusBadge>
                    </div>
                    <p className="mt-2 font-mono text-xs break-all text-muted-foreground">
                      {apiKey.prefix}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Expires {formatTimestamp(apiKey.expiresAt)}
                      {apiKey.authorizedByPrincipalId === principalId
                        ? null
                        : " · Issued by an administrator"}
                    </p>
                  </div>
                  <div className="flex flex-wrap content-start gap-x-3 gap-y-2">
                    {apiKey.capabilities.map((capability) => (
                      <StatusBadge key={capability}>{capability}</StatusBadge>
                    ))}
                  </div>
                  {apiKey.revokedAt === null
                    ? (
                      <div className="flex gap-2 lg:justify-end">
                        <Dialog>
                          <DialogTrigger render={<Button size="xs" type="button" variant="ghost" />}>
                            Revoke
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Revoke API key</DialogTitle>
                              <DialogDescription>
                                Requests using {apiKey.name} will stop immediately. Revocation does
                                not remove prior action attribution.
                              </DialogDescription>
                            </DialogHeader>
                            <DialogFooter>
                              <Button
                                disabled={pending}
                                onClick={() => void revoke(apiKey.id)}
                                type="button"
                                variant="destructive"
                              >
                                {pending ? "Revoking…" : "Revoke API key"}
                              </Button>
                            </DialogFooter>
                          </DialogContent>
                        </Dialog>
                      </div>
                    )
                    : null}
                </article>
              ))}
            </div>
          )}
    </div>
  );
}
