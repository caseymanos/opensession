import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Eye,
  MailCheck,
  RefreshCw,
  Send,
  ShieldCheck,
} from "lucide-react";

import type {
  CampaignAudienceFilter,
  CampaignDeliveryLog,
  CampaignPreviewRequest,
  CampaignPreviewResponse,
  CampaignSchedule,
  CampaignSummary,
  CampaignWorkspace as CampaignWorkspaceData,
} from "@sessionbox-killer/email";
import {
  Button,
  Dialog,
  LiveRegion,
  SelectField,
  StatePanel,
  StatusPill,
  TextField,
} from "@sessionbox-killer/ui";

import {
  CampaignApiError,
  createCampaignPort,
  type CampaignPort,
} from "./campaignClient";
import { createFixtureCampaignPort } from "./campaignFixture";

import "./campaign-workspace.css";

function commandId() {
  return `campaign_confirm_${crypto.randomUUID().replaceAll("-", "")}`;
}

function displayTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusTone(status: CampaignSummary["status"]) {
  if (status === "complete") return "success" as const;
  if (status === "failed") return "warning" as const;
  if (status === "scheduled") return "preview" as const;
  return "neutral" as const;
}

function reasonLabel(value: string) {
  return value.replaceAll("_", " ");
}

function templateOptions(workspace: CampaignWorkspaceData) {
  return workspace.templates.map((template) => ({
    label: `${template.internalName} · v${template.version}`,
    value: template.id,
  }));
}

function DeliveryCounts({ campaign }: { campaign: CampaignSummary }) {
  const visible = Object.entries(campaign.counts).filter(
    ([, count]) => count > 0,
  );
  return (
    <dl className="campaign-counts" aria-label="Delivery counts">
      {visible.length > 0 ? (
        visible.map(([status, count]) => (
          <div key={status}>
            <dt>{reasonLabel(status)}</dt>
            <dd>{count}</dd>
          </div>
        ))
      ) : (
        <div>
          <dt>messages</dt>
          <dd>{campaign.messageCount}</dd>
        </div>
      )}
    </dl>
  );
}

export function CampaignWorkspace({
  eventKey,
  fixture = false,
}: {
  eventKey: string;
  fixture?: boolean;
}) {
  const port = useMemo<CampaignPort>(
    () =>
      fixture ? createFixtureCampaignPort() : createCampaignPort(eventKey),
    [eventKey, fixture],
  );
  const [workspace, setWorkspace] = useState<CampaignWorkspaceData | null>(
    null,
  );
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [templateId, setTemplateId] = useState("");
  const [portalStates, setPortalStates] = useState<
    CampaignAudienceFilter["portalStates"]
  >(["active", "invited"]);
  const [readiness, setReadiness] =
    useState<CampaignAudienceFilter["readiness"]>("all");
  const [scheduleMode, setScheduleMode] =
    useState<CampaignSchedule["mode"]>("now");
  const [scheduledLocal, setScheduledLocal] = useState("2026-08-12T09:00");
  const [preview, setPreview] = useState<CampaignPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [delivery, setDelivery] = useState<CampaignDeliveryLog | null>(null);
  const [deliveryLoading, setDeliveryLoading] = useState(false);
  const [replaying, setReplaying] = useState<string | null>(null);
  const confirmationCommand = useRef<{
    readonly commandId: string;
    readonly previewId: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    void port.read().then(
      (result) => {
        if (!active) return;
        setWorkspace(result);
        setTemplateId((current) => current || result.templates[0]?.id || "");
        setLoadError(null);
      },
      (error: unknown) => {
        if (active) setLoadError(error);
      },
    );
    return () => {
      active = false;
    };
  }, [port, retryVersion]);

  const selectedTemplate = workspace?.templates.find(
    ({ id }) => id === templateId,
  );

  function reload() {
    setWorkspace(null);
    setLoadError(null);
    setRetryVersion((current) => current + 1);
  }

  function currentRequest(): CampaignPreviewRequest | null {
    if (!selectedTemplate || portalStates.length === 0) return null;
    let schedule: CampaignSchedule = { mode: "now" };
    if (scheduleMode === "scheduled") {
      const parsed = new Date(scheduledLocal);
      if (!Number.isFinite(parsed.getTime())) return null;
      schedule = { mode: "scheduled", scheduledAt: parsed.toISOString() };
    }
    return {
      filter: {
        portalStates: [...portalStates],
        readiness,
        roles: [selectedTemplate.audience],
      },
      schedule,
      templateId: selectedTemplate.id,
    };
  }

  async function buildPreview() {
    const request = currentRequest();
    if (!request) {
      setNotice({
        kind: "error",
        message: "Choose at least one portal state and a valid schedule.",
      });
      return;
    }
    setPreviewing(true);
    setNotice(null);
    try {
      const result = await port.preview(request);
      confirmationCommand.current = {
        commandId: commandId(),
        previewId: result.previewId,
      };
      setPreview(result);
      setAnnouncement("Campaign audience preview is ready for confirmation.");
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The campaign preview could not be created.",
      });
    } finally {
      setPreviewing(false);
    }
  }

  async function confirm() {
    const request = currentRequest();
    if (!request || !preview) return;
    const stableCommand =
      confirmationCommand.current?.previewId === preview.previewId
        ? confirmationCommand.current.commandId
        : commandId();
    confirmationCommand.current = {
      commandId: stableCommand,
      previewId: preview.previewId,
    };
    setConfirming(true);
    try {
      const result = await port.confirm({
        ...request,
        commandId: stableCommand,
        previewCreatedAt: preview.createdAt,
        previewId: preview.previewId,
      });
      confirmationCommand.current = null;
      setPreview(null);
      setNotice({
        kind: "success",
        message: `${result.messages.total} messages are durably queued for ${displayTime(result.scheduledAt)}. ${result.projection === "repair_pending" ? "The authoritative projection is catching up." : "No duplicate can be created by retrying this command."}`,
      });
      setAnnouncement("Campaign confirmed and durably queued.");
      setWorkspace(await port.read());
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The campaign could not be confirmed.",
      });
    } finally {
      setConfirming(false);
    }
  }

  async function openDelivery(campaignId: string) {
    setDeliveryLoading(true);
    setNotice(null);
    try {
      setDelivery(await port.delivery(campaignId));
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The delivery log could not be loaded.",
      });
    } finally {
      setDeliveryLoading(false);
    }
  }

  async function replay(messageId: string) {
    if (!delivery) return;
    setReplaying(messageId);
    try {
      const result = await port.replay(delivery.campaign.campaignId, {
        messageId,
      });
      setNotice({
        kind: "success",
        message: `${result.queued} failed message queued for a safe idempotent retry.`,
      });
      const refreshed = await port.delivery(delivery.campaign.campaignId);
      setDelivery(refreshed);
      setWorkspace(await port.read());
      setAnnouncement("Failed delivery replay queued.");
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The failed delivery could not be replayed.",
      });
    } finally {
      setReplaying(null);
    }
  }

  function togglePortalState(
    state: CampaignAudienceFilter["portalStates"][number],
  ) {
    setPortalStates((current) =>
      current.includes(state)
        ? current.filter((candidate) => candidate !== state)
        : [...current, state],
    );
    setPreview(null);
  }

  if (!workspace) {
    const permission =
      loadError instanceof CampaignApiError && loadError.code === "forbidden";
    return (
      <div className="campaign-page">
        <StatePanel
          description={
            permission
              ? "Ask an event owner for campaign access. Recipient data and delivery evidence remain private."
              : loadError instanceof Error
                ? loadError.message
                : "Loading active templates, campaigns, and delivery state."
          }
          {...(loadError ? { onRetry: reload } : {})}
          state={permission ? "permission" : loadError ? "error" : "loading"}
          {...(permission ? { title: "Campaign access required" } : {})}
        />
      </div>
    );
  }

  return (
    <div className="campaign-page">
      <LiveRegion message={announcement} />
      <header className="campaign-hero">
        <div>
          <p className="overline">Communications · Campaigns</p>
          <h1>Know exactly who receives every message.</h1>
          <p>
            Freeze the event audience, template version, sender, and schedule
            before anything enters the delivery queue.
          </p>
        </div>
        <nav className="campaign-tabs" aria-label="Communications">
          <a
            aria-current="page"
            href={`/app/${workspace.event.slug}/communications`}
          >
            Campaigns
          </a>
          <a href={`/app/${workspace.event.slug}/communications/templates`}>
            Templates
          </a>
        </nav>
      </header>

      <section className={`campaign-mode-banner is-${workspace.deliveryMode}`}>
        <ShieldCheck size={18} aria-hidden="true" />
        <div>
          <strong>
            {workspace.deliveryMode === "sink"
              ? "Local sink mode"
              : workspace.deliveryMode === "allowlist"
                ? "Preview allowlist mode"
                : "Production live mode"}
          </strong>
          <p>
            {workspace.deliveryMode === "sink"
              ? "Messages are recorded as delivered locally; no provider send is possible."
              : workspace.deliveryMode === "allowlist"
                ? "Only configured preview recipients can leave the queue; every other address is suppressed."
                : "Live delivery is active. Confirmation is protected by a recomputed audience snapshot and stable message keys."}
          </p>
        </div>
      </section>

      {notice ? (
        <section
          className={`campaign-notice is-${notice.kind}`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.kind === "error" ? (
            <CircleAlert size={17} aria-hidden="true" />
          ) : (
            <CheckCircle2 size={17} aria-hidden="true" />
          )}
          <p>{notice.message}</p>
        </section>
      ) : null}

      <div className="campaign-layout">
        <section className="campaign-composer" aria-labelledby="composer-title">
          <div className="campaign-section-heading">
            <span>
              <Send size={18} aria-hidden="true" />
            </span>
            <div>
              <h2 id="composer-title">Compose a campaign</h2>
              <p>
                Every field below becomes part of the confirmation snapshot.
              </p>
            </div>
          </div>

          {workspace.templates.length === 0 ? (
            <StatePanel
              action={
                <a
                  className="ui-button ui-button--secondary"
                  href={`/app/${workspace.event.slug}/communications/templates`}
                >
                  Open templates
                </a>
              }
              description="Activate an immutable template version before planning an audience."
              state="empty"
              title="No active templates"
            />
          ) : (
            <div className="campaign-form">
              <SelectField
                description="Only the current active immutable version can be selected."
                label="Template version"
                onChange={(event) => {
                  setTemplateId(event.target.value);
                  setPreview(null);
                }}
                options={templateOptions(workspace)}
                value={templateId}
              />
              {selectedTemplate ? (
                <dl className="campaign-template-proof">
                  <div>
                    <dt>Audience role</dt>
                    <dd>{selectedTemplate.audience}</dd>
                  </div>
                  <div>
                    <dt>Sender</dt>
                    <dd>
                      {selectedTemplate.sender.name} &lt;
                      {selectedTemplate.sender.address}&gt;
                    </dd>
                  </div>
                  <div>
                    <dt>Subject</dt>
                    <dd>{selectedTemplate.subject}</dd>
                  </div>
                </dl>
              ) : null}

              <fieldset className="campaign-checks">
                <legend>Portal state</legend>
                <p>
                  Contacts outside these event-scoped states are counted and
                  excluded.
                </p>
                <div>
                  {(
                    ["active", "invited", "not_invited", "revoked"] as const
                  ).map((state) => (
                    <label key={state}>
                      <input
                        checked={portalStates.includes(state)}
                        onChange={() => togglePortalState(state)}
                        type="checkbox"
                      />
                      {reasonLabel(state)}
                    </label>
                  ))}
                </div>
              </fieldset>

              <SelectField
                label="Readiness"
                onChange={(event) => {
                  setReadiness(
                    event.target.value as CampaignAudienceFilter["readiness"],
                  );
                  setPreview(null);
                }}
                options={[
                  { label: "All readiness states", value: "all" },
                  { label: "Ready only", value: "ready" },
                  { label: "Outstanding only", value: "outstanding" },
                ]}
                value={readiness}
              />
              <SelectField
                label="Delivery schedule"
                onChange={(event) => {
                  setScheduleMode(
                    event.target.value as CampaignSchedule["mode"],
                  );
                  setPreview(null);
                }}
                options={[
                  { label: "Queue after confirmation", value: "now" },
                  { label: "Schedule for later", value: "scheduled" },
                ]}
                value={scheduleMode}
              />
              {scheduleMode === "scheduled" ? (
                <TextField
                  description="Stored and queued as an exact UTC instant."
                  label="Send date and time"
                  onChange={(event) => {
                    setScheduledLocal(event.target.value);
                    setPreview(null);
                  }}
                  type="datetime-local"
                  value={scheduledLocal}
                />
              ) : null}
              <Button
                disabled={
                  previewing || !selectedTemplate || portalStates.length === 0
                }
                onClick={() => void buildPreview()}
              >
                <Eye size={16} aria-hidden="true" />
                {previewing
                  ? "Recomputing audience…"
                  : "Preview exact audience"}
              </Button>
            </div>
          )}
        </section>

        <section
          className="campaign-history"
          aria-labelledby="campaign-history-title"
        >
          <div className="campaign-section-heading">
            <span>
              <MailCheck size={18} aria-hidden="true" />
            </span>
            <div>
              <h2 id="campaign-history-title">Delivery log</h2>
              <p>
                Safe status and provider correlation, without recipient or body
                data.
              </p>
            </div>
          </div>
          <div className="campaign-list">
            {workspace.campaigns.length === 0 ? (
              <p className="campaign-empty">
                No campaigns have been confirmed yet.
              </p>
            ) : (
              workspace.campaigns.map((campaign) => (
                <article className="campaign-card" key={campaign.campaignId}>
                  <div className="campaign-card-title">
                    <div>
                      <h3>{campaign.templateName}</h3>
                      <p>
                        v{campaign.templateVersion} ·{" "}
                        {displayTime(campaign.scheduledAt)}
                      </p>
                    </div>
                    <StatusPill tone={statusTone(campaign.status)}>
                      {campaign.status}
                    </StatusPill>
                  </div>
                  <DeliveryCounts campaign={campaign} />
                  <div className="campaign-card-footer">
                    <code>{campaign.campaignId}</code>
                    <Button
                      disabled={deliveryLoading}
                      onClick={() => void openDelivery(campaign.campaignId)}
                      variant="secondary"
                    >
                      View delivery log
                    </Button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </div>

      <Dialog
        description="This audience is recomputed from current event projections. Confirmation will persist the exact counts, exclusions, samples, sender, template version, and schedule shown here."
        onClose={() => {
          if (!confirming) setPreview(null);
        }}
        open={preview !== null}
        title="Confirm campaign snapshot"
      >
        {preview ? (
          <div className="campaign-confirmation">
            <div className="campaign-confirm-metrics">
              <div>
                <strong>{preview.audience.includedCount}</strong>
                <span>included</span>
              </div>
              <div>
                <strong>{preview.audience.excludedCount}</strong>
                <span>excluded</span>
              </div>
              <div>
                <strong>{preview.audience.totalCandidates}</strong>
                <span>event contacts</span>
              </div>
            </div>
            <dl className="campaign-confirm-facts">
              <div>
                <dt>Template</dt>
                <dd>
                  {preview.template.internalName} · v{preview.template.version}
                </dd>
              </div>
              <div>
                <dt>Sender</dt>
                <dd>
                  {preview.sender.name} &lt;{preview.sender.address}&gt;
                </dd>
              </div>
              <div>
                <dt>Schedule</dt>
                <dd>
                  {preview.schedule.mode === "now"
                    ? "Immediately after confirmation"
                    : displayTime(preview.schedule.scheduledAt)}
                </dd>
              </div>
              <div>
                <dt>Preview expires</dt>
                <dd>{displayTime(preview.expiresAt)}</dd>
              </div>
            </dl>
            <section>
              <h3>Exact exclusion reasons</h3>
              {preview.audience.excludedByReason.length > 0 ? (
                <ul className="campaign-exclusions">
                  {preview.audience.excludedByReason.map(
                    ({ count, reason }) => (
                      <li key={reason}>
                        <span>{reasonLabel(reason)}</span>
                        <strong>{count}</strong>
                      </li>
                    ),
                  )}
                </ul>
              ) : (
                <p>No contacts are excluded.</p>
              )}
            </section>
            <section>
              <h3>Five safe samples</h3>
              <ul className="campaign-samples">
                {preview.audience.samples.map((sample) => (
                  <li key={sample.contactId}>
                    <span aria-hidden="true">
                      {sample.displayName.slice(0, 1)}
                    </span>
                    <div>
                      <strong>{sample.displayName}</strong>
                      <small>{sample.email}</small>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
            <div className="campaign-confirm-actions">
              <Button
                disabled={confirming}
                onClick={() => setPreview(null)}
                variant="secondary"
              >
                Cancel
              </Button>
              <Button disabled={confirming} onClick={() => void confirm()}>
                <ShieldCheck size={16} aria-hidden="true" />
                {confirming
                  ? "Confirming durably…"
                  : `Queue ${preview.audience.includedCount} messages`}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        description="Message and provider identifiers support incident correlation. Recipient addresses, rendered bodies, tokens, and secrets are never returned by this log."
        onClose={() => setDelivery(null)}
        open={delivery !== null}
        title="Redacted delivery log"
      >
        {delivery ? (
          <div className="campaign-delivery-detail">
            <DeliveryCounts campaign={delivery.campaign} />
            <p className="campaign-correlation">
              <strong>Campaign</strong>
              <code>{delivery.campaign.campaignId}</code>
            </p>
            {delivery.messages.length === 0 ? (
              <p className="campaign-empty">
                Messages are queued; delivery state will appear here.
              </p>
            ) : (
              <div className="campaign-message-list">
                {delivery.messages.map((message) => (
                  <article key={message.messageId}>
                    <div>
                      <StatusPill
                        tone={
                          message.status === "delivered"
                            ? "success"
                            : message.status === "failed"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {message.status}
                      </StatusPill>
                      <span>
                        {message.attemptCount} attempt
                        {message.attemptCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <dl>
                      <div>
                        <dt>Message</dt>
                        <dd>
                          <code>{message.messageId}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Provider</dt>
                        <dd>
                          <code>
                            {message.providerMessageId ?? "not assigned"}
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt>Last event</dt>
                        <dd>
                          {message.lastEventAt
                            ? displayTime(message.lastEventAt)
                            : "No provider event"}
                        </dd>
                      </div>
                      <div>
                        <dt>Safe error</dt>
                        <dd>
                          <code>{message.errorCode ?? "none"}</code>
                        </dd>
                      </div>
                    </dl>
                    {message.replayable ? (
                      <Button
                        disabled={replaying !== null}
                        onClick={() => void replay(message.messageId)}
                        variant="secondary"
                      >
                        <RefreshCw size={15} aria-hidden="true" />
                        {replaying === message.messageId
                          ? "Queueing retry…"
                          : "Replay failed message"}
                      </Button>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
