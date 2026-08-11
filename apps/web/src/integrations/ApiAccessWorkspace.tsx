import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  Check,
  Clipboard,
  Clock3,
  ExternalLink,
  KeyRound,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import {
  publicApiScopes,
  type ApiKeyCreateRequest,
  type ApiKeyMetadata,
  type ApiKeyScope,
} from "@sessionbox-killer/contracts/public-api";
import {
  Button,
  Card,
  Dialog,
  LiveRegion,
  SelectField,
  StatePanel,
  StatusPill,
  TextField,
} from "@sessionbox-killer/ui";

import {
  ApiKeyClientError,
  createApiKeyPort,
  type ApiKeyPort,
} from "./apiKeyClient";

import "./api-access-workspace.css";

const scopeCopy: Record<ApiKeyScope, { description: string; label: string }> = {
  "events:read": {
    description: "Event details and lifecycle state",
    label: "Events · read",
  },
  "integrations:read": {
    description: "Provider-neutral export-run status",
    label: "Export runs · read",
  },
  "schedule:read": {
    description: "The currently published schedule",
    label: "Schedule · read",
  },
  "sessions:read": {
    description: "Session details and program state",
    label: "Sessions · read",
  },
  "speakers:read": {
    description: "Speaker profiles and readiness",
    label: "Speakers · read",
  },
  "submissions:read": {
    description: "Submission status and metadata",
    label: "Submissions · read",
  },
  "submissions:write": {
    description: "Move submissions through supported workflow transitions",
    label: "Submissions · write",
  },
  "tasks:read": {
    description: "Read-only canonical task assignments",
    label: "Tasks · read",
  },
};

const defaultScopes = publicApiScopes.filter(
  (scope) => scope !== "submissions:write" && scope !== "integrations:read",
);

function dateLabel(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function relativeLastUsed(value: string | null): string {
  return value ? dateLabel(value) : "Not used yet";
}

function expiration(days: string): string | null {
  if (days === "never") return null;
  const count = Number(days);
  return new Date(Date.now() + count * 24 * 60 * 60 * 1_000).toISOString();
}

function stateTone(state: ApiKeyMetadata["state"]) {
  return state === "active"
    ? ("success" as const)
    : state === "expired"
      ? ("warning" as const)
      : ("neutral" as const);
}

function requestMessage(error: unknown): string {
  if (error instanceof ApiKeyClientError) {
    return `${error.message}${error.requestId ? ` Request ${error.requestId}.` : ""}`;
  }
  return "API key management is temporarily unavailable.";
}

export function ApiAccessWorkspace({
  eventKey,
  port: suppliedPort,
}: {
  eventKey: string;
  port?: ApiKeyPort;
}) {
  const port = useMemo(
    () => suppliedPort ?? createApiKeyPort(eventKey),
    [eventKey, suppliedPort],
  );
  const [keys, setKeys] = useState<ApiKeyMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  const [keyScope, setKeyScope] = useState<"event" | "organization">("event");
  const [expiresIn, setExpiresIn] = useState("90");
  const [selectedScopes, setSelectedScopes] =
    useState<readonly ApiKeyScope[]>(defaultScopes);
  const [created, setCreated] = useState<
    { key: ApiKeyMetadata; plaintext: string } | undefined
  >();
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<
    ApiKeyMetadata | undefined
  >();
  const [revokeConfirmation, setRevokeConfirmation] = useState("");
  const [revokePending, setRevokePending] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setKeys(await port.list());
    } catch (error) {
      setLoadError(requestMessage(error));
    } finally {
      setLoading(false);
    }
  }, [port]);

  useEffect(() => {
    let active = true;
    void port
      .list()
      .then((result) => {
        if (active) setKeys(result);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(requestMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [port]);

  function closeCreate(): void {
    if (createPending) return;
    setCreateOpen(false);
    setCreateError(null);
  }

  function closeCreated(): void {
    setCreated(undefined);
    setCopied(false);
  }

  function toggleScope(scope: ApiKeyScope): void {
    setSelectedScopes((current) =>
      current.includes(scope)
        ? current.filter((candidate) => candidate !== scope)
        : publicApiScopes.filter(
            (candidate) => candidate === scope || current.includes(candidate),
          ),
    );
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createPending || !keyName.trim() || selectedScopes.length === 0) return;
    setCreatePending(true);
    setCreateError(null);
    const input: ApiKeyCreateRequest = {
      expires_at: expiration(expiresIn),
      name: keyName.trim(),
      scope: keyScope,
      scopes: [...selectedScopes],
    };
    try {
      const response = await port.create(input);
      const { plaintext, ...metadata } = response.data;
      setKeys((current) => [metadata, ...current]);
      setCreated({ key: metadata, plaintext });
      setCreateOpen(false);
      setKeyName("");
      setKeyScope("event");
      setExpiresIn("90");
      setSelectedScopes(defaultScopes);
      setAnnouncement(
        `${metadata.name} was created. Its secret is shown once.`,
      );
    } catch (error) {
      setCreateError(requestMessage(error));
      if (
        error instanceof ApiKeyClientError &&
        error.code === "api_key_plaintext_unavailable"
      ) {
        await load();
      }
    } finally {
      setCreatePending(false);
    }
  }

  async function copyPlaintext(): Promise<void> {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.plaintext);
      setCopied(true);
      setAnnouncement("API key copied to the clipboard.");
    } catch {
      setCopied(false);
      setAnnouncement(
        "The clipboard was unavailable. Select and copy the key manually.",
      );
    }
  }

  function closeRevoke(): void {
    if (revokePending) return;
    setRevokeTarget(undefined);
    setRevokeConfirmation("");
    setRevokeError(null);
  }

  async function revoke(): Promise<void> {
    if (
      !revokeTarget ||
      revokePending ||
      revokeConfirmation !== revokeTarget.name
    ) {
      return;
    }
    setRevokePending(true);
    setRevokeError(null);
    try {
      const updated = await port.revoke(revokeTarget.id);
      setKeys((current) =>
        current.map((key) => (key.id === updated.id ? updated : key)),
      );
      setAnnouncement(
        `${updated.name} was revoked and can no longer authenticate.`,
      );
      closeRevoke();
    } catch (error) {
      setRevokeError(requestMessage(error));
    } finally {
      setRevokePending(false);
    }
  }

  return (
    <div className="api-access">
      <LiveRegion message={announcement} />
      <header className="api-access__hero">
        <div>
          <p className="api-access__eyebrow">Integrations</p>
          <h1>API access</h1>
          <p>
            Give trusted systems the smallest durable slice of event data they
            need. Every credential is scoped, auditable, and instantly
            revocable.
          </p>
        </div>
        <div className="api-access__hero-actions">
          <a href="/docs/api" rel="noreferrer" target="_blank">
            API documentation <ExternalLink aria-hidden="true" size={15} />
          </a>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden="true" size={17} /> Create API key
          </Button>
        </div>
      </header>

      <section className="api-access__trust" aria-label="API key safeguards">
        <div>
          <ShieldCheck aria-hidden="true" size={21} />
          <span>
            <strong>One-time secret</strong> Plaintext is never recoverable.
          </span>
        </div>
        <div>
          <KeyRound aria-hidden="true" size={21} />
          <span>
            <strong>Least privilege</strong> Choose event or organization scope.
          </span>
        </div>
        <div>
          <Clock3 aria-hidden="true" size={21} />
          <span>
            <strong>Operational trail</strong> Creation, use, and revocation are
            recorded.
          </span>
        </div>
      </section>

      <section
        className="api-access__section"
        aria-labelledby="api-keys-heading"
      >
        <div className="api-access__section-heading">
          <div>
            <h2 id="api-keys-heading">Keys</h2>
            <p>Only the safe prefix and operational metadata remain visible.</p>
          </div>
          {!loading && !loadError ? (
            <span>
              {keys.length} {keys.length === 1 ? "key" : "keys"}
            </span>
          ) : null}
        </div>

        {loading ? (
          <StatePanel
            description="Loading scoped API credentials."
            state="loading"
            title="Loading API keys"
          />
        ) : loadError ? (
          <StatePanel
            description={loadError}
            onRetry={() => void load()}
            state="error"
            title="API keys could not be loaded"
          />
        ) : keys.length === 0 ? (
          <StatePanel
            action={
              <Button onClick={() => setCreateOpen(true)}>
                Create the first key
              </Button>
            }
            description="Create a narrowly scoped credential when a trusted integration is ready."
            state="empty"
            title="No API keys yet"
          />
        ) : (
          <div className="api-access__key-list">
            {keys.map((key) => (
              <Card className="api-key-card" key={key.id}>
                <div className="api-key-card__topline">
                  <div>
                    <h3>{key.name}</h3>
                    <code>{key.prefix}</code>
                  </div>
                  <StatusPill tone={stateTone(key.state)}>
                    {key.state}
                  </StatusPill>
                </div>
                <dl className="api-key-card__metadata">
                  <div>
                    <dt>Access</dt>
                    <dd>
                      {key.scope.kind === "organization"
                        ? "Organization"
                        : "This event"}
                    </dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{dateLabel(key.created_at)}</dd>
                  </div>
                  <div>
                    <dt>Last used</dt>
                    <dd>{relativeLastUsed(key.last_used_at)}</dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd>{dateLabel(key.expires_at)}</dd>
                  </div>
                </dl>
                <div
                  className="api-key-card__scopes"
                  aria-label={`${key.name} scopes`}
                >
                  {key.scopes.map((scope) => (
                    <code key={scope}>{scope}</code>
                  ))}
                </div>
                <div className="api-key-card__footer">
                  <span>
                    {key.revoked_at
                      ? `Revoked ${dateLabel(key.revoked_at)}`
                      : "Secret cannot be viewed again"}
                  </span>
                  {key.state === "active" ? (
                    <Button
                      className="api-access__danger-link"
                      onClick={() => setRevokeTarget(key)}
                      variant="secondary"
                    >
                      <Trash2 aria-hidden="true" size={15} /> Revoke
                    </Button>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <Dialog
        description="Choose the smallest scope that lets this integration do its work."
        onClose={closeCreate}
        open={createOpen}
        title="Create API key"
      >
        <form
          className="api-key-create"
          onSubmit={(event) => void submitCreate(event)}
        >
          {createError ? (
            <div className="api-access__inline-error" role="alert">
              {createError}
            </div>
          ) : null}
          <TextField
            autoComplete="off"
            description="Use the system or workflow name, such as “Schedule signage”."
            label="Key name"
            maxLength={120}
            onChange={(event) => setKeyName(event.target.value)}
            required
            value={keyName}
          />
          <div className="api-key-create__row">
            <SelectField
              description="Event scope cannot cross into another event."
              label="Access boundary"
              onChange={(event) =>
                setKeyScope(event.target.value as typeof keyScope)
              }
              options={[
                { label: "This event only", value: "event" },
                { label: "Entire organization", value: "organization" },
              ]}
              value={keyScope}
            />
            <SelectField
              description="Shorter lifetimes reduce exposure."
              label="Expiration"
              onChange={(event) => setExpiresIn(event.target.value)}
              options={[
                { label: "90 days", value: "90" },
                { label: "30 days", value: "30" },
                { label: "1 year", value: "365" },
                { label: "No expiration", value: "never" },
              ]}
              value={expiresIn}
            />
          </div>
          <fieldset className="api-key-create__scopes">
            <legend>Permissions</legend>
            <p>Select at least one. Write access is intentionally separate.</p>
            <div>
              {publicApiScopes.map((scope) => (
                <label key={scope}>
                  <input
                    checked={selectedScopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                    type="checkbox"
                  />
                  <span>
                    <strong>{scopeCopy[scope].label}</strong>
                    <small>{scopeCopy[scope].description}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="api-key-create__actions">
            <Button
              disabled={createPending}
              onClick={closeCreate}
              variant="secondary"
            >
              Cancel
            </Button>
            <Button
              disabled={
                createPending || !keyName.trim() || selectedScopes.length === 0
              }
              type="submit"
            >
              {createPending ? "Creating…" : "Create key"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        description="This is the only time OpenSession will display the complete credential."
        onClose={closeCreated}
        open={Boolean(created)}
        title="Store this API key now"
      >
        {created ? (
          <div className="api-key-secret">
            <div className="api-key-secret__warning">
              <ShieldCheck aria-hidden="true" size={22} />
              <p>
                <strong>No recovery path</strong>
                <br />
                If this key is lost, revoke it and create a replacement.
              </p>
            </div>
            <label htmlFor="created-api-key">
              API key for {created.key.name}
            </label>
            <div className="api-key-secret__value">
              <textarea
                id="created-api-key"
                readOnly
                rows={3}
                value={created.plaintext}
              />
              <Button onClick={() => void copyPlaintext()} variant="secondary">
                {copied ? (
                  <Check aria-hidden="true" size={16} />
                ) : (
                  <Clipboard aria-hidden="true" size={16} />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <div className="api-key-create__actions">
              <Button onClick={closeCreated}>I have stored this key</Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        description="Revocation is immediate and cannot be undone. Calls using this key will fail authentication."
        onClose={closeRevoke}
        open={Boolean(revokeTarget)}
        title={`Revoke ${revokeTarget?.name ?? "API key"}?`}
      >
        {revokeTarget ? (
          <div className="api-key-revoke">
            {revokeError ? (
              <div className="api-access__inline-error" role="alert">
                {revokeError}
              </div>
            ) : null}
            <p>
              The safe prefix <code>{revokeTarget.prefix}</code> will remain in
              the audit trail.
            </p>
            <TextField
              autoComplete="off"
              description={`Type “${revokeTarget.name}” exactly to confirm.`}
              label="Key name"
              onChange={(event) => setRevokeConfirmation(event.target.value)}
              value={revokeConfirmation}
            />
            <div className="api-key-create__actions">
              <Button
                disabled={revokePending}
                onClick={closeRevoke}
                variant="secondary"
              >
                Cancel
              </Button>
              <Button
                className="api-access__danger-button"
                disabled={
                  revokePending || revokeConfirmation !== revokeTarget.name
                }
                onClick={() => void revoke()}
              >
                <Trash2 aria-hidden="true" size={15} />{" "}
                {revokePending ? "Revoking…" : "Revoke key"}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
