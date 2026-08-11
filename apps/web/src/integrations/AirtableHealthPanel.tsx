import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Database,
  Link2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import type {
  AirtableIntegrationHealth,
  AirtableReconcilePlan,
} from "@sessionbox-killer/contracts";
import {
  Button,
  Card,
  Dialog,
  LiveRegion,
  StatePanel,
  StatusPill,
  TextField,
} from "@sessionbox-killer/ui";

import {
  AirtableHealthClientError,
  createAirtableHealthPort,
  type AirtableHealthPort,
} from "./airtableHealthClient";

function dateLabel(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function lagLabel(value: number | null): string {
  if (value === null) return "No watermark";
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3_600) return `${Math.round(value / 60)}m`;
  return `${Math.round(value / 3_600)}h`;
}

function message(error: unknown): string {
  if (error instanceof AirtableHealthClientError) {
    return `${error.message}${error.requestId ? ` Request ${error.requestId}.` : ""}`;
  }
  return "Airtable health is temporarily unavailable.";
}

function reconcileTone(
  status: AirtableIntegrationHealth["projection"]["last_reconcile"]["status"],
) {
  if (status === "succeeded") return "success" as const;
  if (status === "failed") return "warning" as const;
  if (status === "running") return "warning" as const;
  return "neutral" as const;
}

export function AirtableHealthPanel({
  eventKey,
  port: suppliedPort,
}: {
  eventKey: string;
  port?: AirtableHealthPort;
}) {
  const port = useMemo(
    () => suppliedPort ?? createAirtableHealthPort(eventKey),
    [eventKey, suppliedPort],
  );
  const [health, setHealth] = useState<AirtableIntegrationHealth>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [reviewing, setReviewing] = useState(false);
  const [plan, setPlan] = useState<AirtableReconcilePlan>();
  const [confirmation, setConfirmation] = useState("");
  const [applying, setApplying] = useState(false);
  const [reconcileError, setReconcileError] = useState<string>();
  const [announcement, setAnnouncement] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      setHealth(await port.health());
    } catch (error) {
      setLoadError(message(error));
    } finally {
      setLoading(false);
    }
  }, [port]);

  useEffect(() => {
    let active = true;
    void port
      .health()
      .then((result) => {
        if (active) setHealth(result);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(message(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [port]);

  async function review(): Promise<void> {
    setReviewing(true);
    setReconcileError(undefined);
    try {
      setPlan(await port.dryRun());
      setConfirmation("");
    } catch (error) {
      setReconcileError(message(error));
    } finally {
      setReviewing(false);
    }
  }

  function closePlan(): void {
    if (applying) return;
    setPlan(undefined);
    setConfirmation("");
    setReconcileError(undefined);
  }

  async function apply(): Promise<void> {
    if (!plan || applying || confirmation !== plan.confirmation) return;
    setApplying(true);
    setReconcileError(undefined);
    try {
      const result = await port.apply(plan, confirmation);
      if (result.mode !== "apply") return;
      setAnnouncement(
        `Airtable reconciliation completed: ${result.result.projected} projected and ${result.result.deleted} missing records repaired.`,
      );
      setPlan(undefined);
      setConfirmation("");
      await load();
    } catch (error) {
      setReconcileError(message(error));
    } finally {
      setApplying(false);
    }
  }

  const divergentTables = plan?.tables.filter(
    ({ create, missing, update }) => create + missing + update > 0,
  );
  const repairBacklog = health
    ? health.projection.repair_backlog.pending +
      health.projection.repair_backlog.failed +
      health.projection.repair_backlog.dead
    : 0;

  return (
    <section className="airtable-health" aria-labelledby="airtable-heading">
      <LiveRegion message={announcement} />
      <div className="api-access__section-heading">
        <div>
          <p className="airtable-health__eyebrow">Authoritative data</p>
          <h2 id="airtable-heading">Airtable</h2>
          <p>
            Airtable owns business truth. D1 is the repairable read projection.
          </p>
        </div>
        <Button
          disabled={reviewing}
          onClick={() => void review()}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" size={15} />
          {reviewing ? "Checking…" : "Review reconcile"}
        </Button>
      </div>

      {reconcileError && !plan ? (
        <div className="api-access__inline-error" role="alert">
          {reconcileError}
        </div>
      ) : null}

      {loading ? (
        <StatePanel
          description="Reading aggregate authority and projection signals."
          state="loading"
          title="Loading Airtable health"
        />
      ) : loadError || !health ? (
        <StatePanel
          description={loadError ?? "Airtable health is unavailable."}
          onRetry={() => void load()}
          state="error"
          title="Airtable health could not be loaded"
        />
      ) : (
        <>
          <div className="airtable-health__metrics">
            <Card>
              <span>Connected base</span>
              <strong>{health.authority.base_suffix}</strong>
              <small>Schema v{health.authority.schema_version}</small>
            </Card>
            <Card>
              <span>Projection watermark</span>
              <strong>{lagLabel(health.projection.lag_seconds)}</strong>
              <small>{dateLabel(health.projection.watermark_at)}</small>
            </Card>
            <Card>
              <span>Repair backlog</span>
              <strong>{repairBacklog}</strong>
              <small>
                {health.projection.repair_backlog.failed} failed ·{" "}
                {health.projection.repair_backlog.dead} dead
              </small>
            </Card>
            <Card>
              <span>Last reconcile</span>
              <StatusPill
                tone={reconcileTone(health.projection.last_reconcile.status)}
              >
                {health.projection.last_reconcile.status}
              </StatusPill>
              <small>
                {dateLabel(health.projection.last_reconcile.completed_at)}
              </small>
            </Card>
          </div>

          <div
            className="airtable-health__activity"
            aria-label="Provider activity"
          >
            <span>
              <Database aria-hidden="true" size={15} /> Last provider read{" "}
              <strong>{dateLabel(health.authority.last_read_at)}</strong>
            </span>
            <span>
              <ShieldCheck aria-hidden="true" size={15} /> Last authoritative
              write <strong>{dateLabel(health.authority.last_write_at)}</strong>
            </span>
          </div>

          <div className="airtable-health__trace">
            <div>
              <h3>Judge-visible record trace</h3>
              <p>
                Aggregate projection counts and human-readable Airtable links;
                no record IDs or field payloads leave the server.
              </p>
            </div>
            <div className="airtable-health__trace-grid">
              {health.judge_trace.map((trace) => (
                <Card key={trace.kind}>
                  <div>
                    <Link2 aria-hidden="true" size={17} />
                    <strong>{trace.label}</strong>
                    <span>{trace.projected_count}</span>
                  </div>
                  <ol aria-label={`${trace.label} Airtable path`}>
                    {trace.tables.map((table, index) => (
                      <li key={table}>
                        {index > 0 ? (
                          <ArrowRight aria-hidden="true" size={13} />
                        ) : null}
                        {table}
                      </li>
                    ))}
                  </ol>
                </Card>
              ))}
            </div>
          </div>
        </>
      )}

      <Dialog
        description="This plan is organization-wide. The apply step is refused if Airtable changes after this dry run."
        onClose={closePlan}
        open={Boolean(plan)}
        title="Review Airtable reconciliation"
      >
        {plan ? (
          <div className="airtable-reconcile">
            {reconcileError ? (
              <div className="api-access__inline-error" role="alert">
                {reconcileError}
              </div>
            ) : null}
            <div className="airtable-reconcile__counts">
              {(["create", "update", "missing", "unchanged"] as const).map(
                (key) => (
                  <div key={key}>
                    <strong>{plan.counts[key]}</strong>
                    <span>{key}</span>
                  </div>
                ),
              )}
            </div>
            <div className="airtable-reconcile__tables">
              <h3>Divergent tables</h3>
              {divergentTables && divergentTables.length > 0 ? (
                <ul>
                  {divergentTables.map((table) => (
                    <li key={table.key}>
                      <strong>{table.name}</strong>
                      <span>
                        {table.create} create · {table.update} update ·{" "}
                        {table.missing} missing
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  No divergence found. Applying will still record a fresh scan.
                </p>
              )}
            </div>
            <TextField
              autoComplete="off"
              description={`Type “${plan.confirmation}” exactly. This confirms organization-wide repair, not only the current event.`}
              label="Confirmation"
              onChange={(event) => setConfirmation(event.target.value)}
              value={confirmation}
            />
            <div className="api-key-create__actions">
              <Button
                disabled={applying}
                onClick={closePlan}
                variant="secondary"
              >
                Cancel
              </Button>
              <Button
                disabled={applying || confirmation !== plan.confirmation}
                onClick={() => void apply()}
              >
                {applying ? "Reconciling…" : "Apply reconcile"}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
