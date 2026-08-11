import {
  createSeedEmailTemplates,
  type CampaignConfirmResponse,
  type CampaignDeliveryLog,
  type CampaignPreviewRequest,
  type CampaignPreviewResponse,
  type CampaignSummary,
  type CampaignWorkspace,
} from "@sessionbox-killer/email";

import type { CampaignPort } from "./campaignClient";

const createdAt = "2026-08-10T20:00:00.000Z";
const samples = [
  ["contact_mina_okafor", "Mina Okafor", "mina@allowlist.example.test"],
  ["contact_arun_iyer", "Arun Iyer", "arun@allowlist.example.test"],
  ["contact_lee_robinson", "Lee Robinson", "lee@allowlist.example.test"],
  ["contact_sara_vieira", "Sara Vieira", "sara@allowlist.example.test"],
  ["contact_ben_holmes", "Ben Holmes", "ben@allowlist.example.test"],
] as const;

function zeroCounts() {
  return {
    bounced: 0,
    complained: 0,
    delivered: 0,
    failed: 0,
    queued: 0,
    sending: 0,
    sent: 0,
    suppressed: 0,
  };
}

function workspaceFixture(): CampaignWorkspace {
  const templates = createSeedEmailTemplates({
    createdAt,
    eventId: "event_ai_engineer_summit",
    replyTo: "program@demo.opensession.invalid",
    sender: {
      address: "updates@demo.opensession.invalid",
      name: "OpenSession Program Team",
    },
  })
    .filter(({ status }) => status === "active")
    .map((template) => ({
      audience: template.audience,
      id: template.id,
      internalName: template.internalName,
      sender: template.sender,
      subject: template.subject,
      version: template.version,
    }));
  const receipt = templates.find(
    ({ id }) => id === "template_submission_receipt",
  );
  if (!receipt) throw new Error("Campaign fixture has no receipt template.");
  return {
    campaigns: [
      {
        campaignId: "campaign_program_update",
        counts: { ...zeroCounts(), delivered: 16, failed: 1, sent: 1 },
        createdAt: "2026-08-09T18:00:00.000Z",
        messageCount: 18,
        scheduledAt: "2026-08-09T18:00:00.000Z",
        status: "sending",
        templateId: receipt.id,
        templateName: receipt.internalName,
        templateVersion: receipt.version,
      },
    ],
    deliveryMode: "allowlist",
    event: {
      id: "event_ai_engineer_summit",
      name: "AI Engineer Summit 2026",
      slug: "ai-engineer-summit",
    },
    templates,
  };
}

function previewFixture(
  workspace: CampaignWorkspace,
  request: CampaignPreviewRequest,
): CampaignPreviewResponse {
  const template = workspace.templates.find(
    ({ id }) => id === request.templateId,
  );
  if (!template) throw new Error("Fixture template is missing.");
  const reasons = [
    { count: 1, reason: "manual" as const },
    { count: 3, reason: "role_mismatch" as const },
    ...(request.filter.portalStates.includes("revoked")
      ? []
      : [{ count: 1, reason: "portal_state_mismatch" as const }]),
    ...(request.filter.readiness === "ready"
      ? [{ count: 4, reason: "readiness_mismatch" as const }]
      : []),
  ];
  const excludedCount = reasons.reduce(
    (total, reason) => total + reason.count,
    0,
  );
  return {
    audience: {
      excludedByReason: reasons,
      excludedCount,
      includedCount: 23 - excludedCount,
      samples: samples.map(([contactId, displayName, email]) => ({
        contactId,
        displayName,
        email,
      })),
      totalCandidates: 23,
    },
    createdAt,
    expiresAt: "2026-08-10T20:15:00.000Z",
    filter: request.filter,
    previewId: `campaign_preview_${"a".repeat(64)}`,
    schedule: request.schedule,
    sender: template.sender,
    template: {
      audience: template.audience,
      id: template.id,
      internalName: template.internalName,
      subject: template.subject,
      version: template.version,
    },
  };
}

function logFixture(campaign: CampaignSummary): CampaignDeliveryLog {
  return {
    campaign,
    messages: [
      {
        attemptCount: 1,
        errorCode: null,
        lastEventAt: "2026-08-09T18:02:00.000Z",
        messageId: `email_${"1".repeat(64)}`,
        providerMessageId: "resend_delivered_demo",
        replayable: false,
        status: "delivered",
      },
      {
        attemptCount: 5,
        errorCode: "retry_exhausted",
        lastEventAt: null,
        messageId: `email_${"2".repeat(64)}`,
        providerMessageId: null,
        replayable: true,
        status: "failed",
      },
      {
        attemptCount: 1,
        errorCode: null,
        lastEventAt: "2026-08-09T18:01:00.000Z",
        messageId: `email_${"3".repeat(64)}`,
        providerMessageId: "resend_sent_demo",
        replayable: false,
        status: "sent",
      },
    ],
  };
}

export function createFixtureCampaignPort(): CampaignPort {
  let workspace = workspaceFixture();
  const logs = new Map<string, CampaignDeliveryLog>();
  const confirmations = new Map<string, CampaignConfirmResponse>();
  let loseNextConfirmationResponse = true;
  const existing = workspace.campaigns[0];
  if (existing) logs.set(existing.campaignId, logFixture(existing));

  return {
    async confirm(request) {
      const confirmed = confirmations.get(request.commandId);
      if (confirmed) return { ...structuredClone(confirmed), replayed: true };
      const preview = previewFixture(workspace, request);
      if (
        preview.previewId !== request.previewId ||
        preview.createdAt !== request.previewCreatedAt
      ) {
        throw new Error("The campaign preview changed.");
      }
      const campaignId = `campaign_${request.commandId.slice(-24)}`;
      const scheduledAt =
        request.schedule.mode === "scheduled"
          ? request.schedule.scheduledAt
          : request.previewCreatedAt;
      const summary: CampaignSummary = {
        campaignId,
        counts: {
          ...zeroCounts(),
          queued: preview.audience.includedCount,
        },
        createdAt: request.previewCreatedAt,
        messageCount: preview.audience.includedCount,
        scheduledAt,
        status: request.schedule.mode === "scheduled" ? "scheduled" : "sending",
        templateId: preview.template.id,
        templateName: preview.template.internalName,
        templateVersion: preview.template.version,
      };
      workspace = {
        ...workspace,
        campaigns: [summary, ...workspace.campaigns],
      };
      logs.set(summary.campaignId, { campaign: summary, messages: [] });
      const result: CampaignConfirmResponse = {
        campaignId,
        messages: {
          alreadyQueued: 0,
          queued: preview.audience.includedCount,
          suppressed: 0,
          total: preview.audience.includedCount,
        },
        projection: "durable",
        replayed: false,
        scheduledAt,
      };
      confirmations.set(request.commandId, result);
      if (loseNextConfirmationResponse) {
        loseNextConfirmationResponse = false;
        throw new Error(
          "The queue accepted this confirmation but its response was lost. Retry to recover the same command.",
        );
      }
      return result;
    },
    async delivery(campaignId) {
      const log = logs.get(campaignId);
      if (!log) throw new Error("Fixture campaign is missing.");
      return structuredClone(log);
    },
    async preview(request) {
      return structuredClone(previewFixture(workspace, request));
    },
    async read() {
      return structuredClone(workspace);
    },
    async replay(campaignId, request) {
      const log = logs.get(campaignId);
      if (!log) throw new Error("Fixture campaign is missing.");
      const selected = request.messageId
        ? log.messages.filter(
            ({ messageId }) => messageId === request.messageId,
          )
        : log.messages;
      let queued = 0;
      let notReplayable = 0;
      log.messages = log.messages.map((message) => {
        if (!selected.includes(message)) return message;
        if (!message.replayable) {
          notReplayable += 1;
          return message;
        }
        queued += 1;
        return {
          ...message,
          errorCode: null,
          replayable: false,
          status: "queued" as const,
        };
      });
      log.campaign = {
        ...log.campaign,
        counts: {
          ...log.campaign.counts,
          failed: Math.max(0, log.campaign.counts.failed - queued),
          queued: log.campaign.counts.queued + queued,
        },
      };
      workspace = {
        ...workspace,
        campaigns: workspace.campaigns.map((campaign) =>
          campaign.campaignId === campaignId ? log.campaign : campaign,
        ),
      };
      return { campaignId, notReplayable, queued, suppressed: 0 };
    },
  };
}
