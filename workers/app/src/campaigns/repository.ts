import {
  campaignDeliveryLogSchema,
  campaignWorkspaceSchema,
  emailTemplateFamilyId,
  emailTemplateHead,
  type CampaignAudienceCandidate,
  type CampaignDeliveryCounts,
  type CampaignDeliveryLog,
  type CampaignDeliveryMessage,
  type CampaignSummary,
  type CampaignSuppressionReason,
  type CampaignWorkspace,
  type EmailTemplate,
} from "@sessionbox-killer/email";

import { sha256Hex } from "../auth/crypto.js";
import {
  D1EmailTemplateProjectionRepository,
  EmailTemplateProjectionError,
  type EmailTemplateEventProjection,
} from "../email-templates/repository.js";
import type { EmailDeliveryMode } from "../email/config.js";

interface AudienceRow {
  contact_id: string;
  display_name: string;
  email_normalized: string;
  event_id: string;
  portal_state: string;
  roles_json: string;
  source_record_id: string;
  speaker_ready: number;
}

interface CampaignRow {
  audience_filter_snapshot_json: string;
  created_at: string;
  id: string;
  scheduled_at: string | null;
  status: string;
  template_id: string;
  template_snapshot_json: string;
  template_version: number;
}

interface DeliveryCountRow {
  campaign_id: string;
  count: number;
  status: string;
}

interface DeliveryMessageRow {
  attempt_count: number;
  error_code: string | null;
  id: string;
  last_provider_event_at: string | null;
  provider_message_id: string | null;
  queue_payload_json: string | null;
  status: string;
}

const campaignStatuses = new Set([
  "complete",
  "draft",
  "failed",
  "scheduled",
  "sending",
]);
const deliveryStatuses = new Set([
  "bounced",
  "complained",
  "delivered",
  "failed",
  "queued",
  "sending",
  "sent",
  "suppressed",
]);
const audienceRoles = new Set([
  "organizer",
  "reviewer",
  "speaker",
  "submitter",
]);
const portalStates = new Set(["active", "invited", "not_invited", "revoked"]);
const suppressionReasons = new Set<CampaignSuppressionReason>([
  "bounced",
  "complained",
  "manual",
  "provider_suppressed",
]);
const maximumAudienceCandidates = 2_000;

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CampaignProjectionError(`${label} is not valid JSON.`);
  }
}

function emptyCounts(): CampaignDeliveryCounts {
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

function activeTemplateHeads(
  templates: readonly EmailTemplate[],
): readonly EmailTemplate[] {
  const families = new Set(
    templates.map(({ id }) => emailTemplateFamilyId(id)),
  );
  return [...families]
    .flatMap((familyId) => {
      const head = emailTemplateHead(templates, familyId);
      return head?.status === "active" ? [head] : [];
    })
    .sort((left, right) =>
      left.internalName.localeCompare(right.internalName, "en-US"),
    );
}

function campaignSummary(
  row: CampaignRow,
  counts: CampaignDeliveryCounts,
): CampaignSummary {
  const template = parseJson(
    row.template_snapshot_json,
    "Campaign template snapshot",
  ) as Partial<EmailTemplate>;
  if (
    !campaignStatuses.has(row.status) ||
    typeof template.internalName !== "string"
  ) {
    throw new CampaignProjectionError("Campaign projection is invalid.");
  }
  const messageCount = Object.values(counts).reduce(
    (total, count) => total + count,
    0,
  );
  return {
    campaignId: row.id,
    counts,
    createdAt: row.created_at,
    messageCount,
    scheduledAt: row.scheduled_at ?? row.created_at,
    status: row.status as CampaignSummary["status"],
    templateId: row.template_id,
    templateName: template.internalName,
    templateVersion: row.template_version,
  };
}

export class D1CampaignRepository {
  readonly #database: D1Database;
  readonly #templates: D1EmailTemplateProjectionRepository;

  constructor(database: D1Database) {
    this.#database = database;
    this.#templates = new D1EmailTemplateProjectionRepository(database);
  }

  findEventCandidates(
    eventKey: string,
  ): Promise<readonly EmailTemplateEventProjection[]> {
    return this.#templates.findEventCandidates(eventKey);
  }

  async readWorkspace(
    event: EmailTemplateEventProjection,
    deliveryMode: EmailDeliveryMode,
  ): Promise<CampaignWorkspace> {
    const [templateWorkspace, campaignRows, countRows] = await Promise.all([
      this.#templates.readWorkspace(event),
      this.#database
        .prepare(
          `SELECT campaign.id, campaign.template_id,
                  campaign.template_version, campaign.template_snapshot_json,
                  campaign.audience_filter_snapshot_json,
                  campaign.scheduled_at, campaign.status,
                  campaign.projected_at AS created_at
           FROM p_campaigns AS campaign
           WHERE campaign.organization_id = ?1 AND campaign.event_id = ?2
             AND campaign.source_deleted_at IS NULL
           ORDER BY campaign.projected_at DESC, campaign.id
           LIMIT 100`,
        )
        .bind(event.organizationId, event.id)
        .all<CampaignRow>(),
      this.#database
        .prepare(
          `SELECT campaign_id, status, COUNT(*) AS count
           FROM provider_messages
           WHERE organization_id = ?1 AND event_id = ?2
             AND kind = 'campaign' AND campaign_id IS NOT NULL
           GROUP BY campaign_id, status`,
        )
        .bind(event.organizationId, event.id)
        .all<DeliveryCountRow>(),
    ]);
    const countsByCampaign = new Map<string, CampaignDeliveryCounts>();
    for (const row of countRows.results) {
      if (!deliveryStatuses.has(row.status)) continue;
      const counts = countsByCampaign.get(row.campaign_id) ?? emptyCounts();
      counts[row.status as keyof CampaignDeliveryCounts] = row.count;
      countsByCampaign.set(row.campaign_id, counts);
    }
    const templates = activeTemplateHeads(
      templateWorkspace.templates.map(({ template }) => template),
    );
    return campaignWorkspaceSchema.parse({
      campaigns: campaignRows.results.map((row) =>
        campaignSummary(row, countsByCampaign.get(row.id) ?? emptyCounts()),
      ),
      deliveryMode,
      event: templateWorkspace.event,
      templates: templates.map((template) => ({
        audience: template.audience,
        id: template.id,
        internalName: template.internalName,
        sender: template.sender,
        subject: template.subject,
        version: template.version,
      })),
    });
  }

  async readTemplatePlanInputs(
    event: EmailTemplateEventProjection,
    templateId: string,
  ): Promise<{
    readonly selected: EmailTemplate;
    readonly sourceRecordId: string;
    readonly versions: readonly EmailTemplate[];
  } | null> {
    const workspace = await this.#templates.readWorkspace(event);
    const versions = workspace.templates.map(({ template }) => template);
    const selected = versions.find(({ id }) => id === templateId);
    if (!selected) return null;
    const source = await this.#database
      .prepare(
        `SELECT source_record_id FROM p_email_templates
         WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
           AND source_deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(event.organizationId, event.id, templateId)
      .first<{ source_record_id: string }>();
    return source
      ? { selected, sourceRecordId: source.source_record_id, versions }
      : null;
  }

  async readAudienceCandidates(options: {
    readonly event: EmailTemplateEventProjection;
    readonly organizer: { readonly email: string; readonly name: string };
    readonly requestUrl: string;
  }): Promise<readonly CampaignAudienceCandidate[]> {
    const rows = await this.#database
      .prepare(
        `SELECT contact.id AS contact_id, contact.display_name,
                contact.email_normalized, event_contact.event_id,
                event_contact.portal_state, event_contact.roles_json,
                contact.source_record_id, event_contact.speaker_ready
         FROM p_event_contacts AS event_contact
         JOIN p_contacts AS contact
           ON contact.organization_id = event_contact.organization_id
          AND contact.id = event_contact.contact_id
          AND contact.source_deleted_at IS NULL
         WHERE event_contact.organization_id = ?1
           AND event_contact.event_id = ?2
           AND event_contact.source_deleted_at IS NULL
         ORDER BY contact.id
         LIMIT ?3`,
      )
      .bind(
        options.event.organizationId,
        options.event.id,
        maximumAudienceCandidates + 1,
      )
      .all<AudienceRow>();
    if (rows.results.length > maximumAudienceCandidates) {
      throw new CampaignProjectionError(
        `Campaign audiences are limited to ${maximumAudienceCandidates} contacts.`,
      );
    }
    const suppressions = await this.#database
      .prepare(
        `SELECT recipient_hash, reason FROM email_suppressions
         WHERE organization_id = ?1 AND lifted_at IS NULL`,
      )
      .bind(options.event.organizationId)
      .all<{ reason: string; recipient_hash: string }>();
    const suppressionByHash = new Map(
      suppressions.results.flatMap((row) =>
        suppressionReasons.has(row.reason as CampaignSuppressionReason)
          ? [[row.recipient_hash, row.reason as CampaignSuppressionReason]]
          : [],
      ),
    );
    return Promise.all(
      rows.results.map(async (row): Promise<CampaignAudienceCandidate> => {
        const roles = parseJson(row.roles_json, "Campaign recipient roles");
        if (!Array.isArray(roles)) {
          throw new CampaignProjectionError(
            "Campaign recipient roles are invalid.",
          );
        }
        if (!portalStates.has(row.portal_state)) {
          throw new CampaignProjectionError(
            "Campaign recipient portal state is invalid.",
          );
        }
        const mergeValues = await this.#templates.readContactMergeValues({
          event: options.event,
          organizer: options.organizer,
          recipientId: row.contact_id,
          requestUrl: options.requestUrl,
        });
        if (!mergeValues) {
          throw new CampaignProjectionError(
            "Campaign recipient projection disappeared while planning.",
          );
        }
        const recipientHash = await sha256Hex(
          row.email_normalized.trim().toLowerCase(),
        );
        const suppressionReason = suppressionByHash.get(recipientHash);
        return {
          contactId: row.contact_id,
          displayName: row.display_name,
          email: row.email_normalized,
          eventId: row.event_id,
          mergeValues,
          portalState:
            row.portal_state as CampaignAudienceCandidate["portalState"],
          readiness: row.speaker_ready === 1 ? "ready" : "outstanding",
          roles: roles.flatMap((role) =>
            typeof role === "string" && audienceRoles.has(role)
              ? [role as CampaignAudienceCandidate["roles"][number]]
              : [],
          ),
          ...(suppressionReason ? { suppressionReason } : {}),
        };
      }),
    );
  }

  async readContactSourceRecordId(
    event: EmailTemplateEventProjection,
    contactId: string,
  ): Promise<string | null> {
    const row = await this.#database
      .prepare(
        `SELECT contact.source_record_id
         FROM p_event_contacts AS event_contact
         JOIN p_contacts AS contact
           ON contact.organization_id = event_contact.organization_id
          AND contact.id = event_contact.contact_id
          AND contact.source_deleted_at IS NULL
         WHERE event_contact.organization_id = ?1
           AND event_contact.event_id = ?2
           AND event_contact.contact_id = ?3
           AND event_contact.source_deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(event.organizationId, event.id, contactId)
      .first<{ source_record_id: string }>();
    return row?.source_record_id ?? null;
  }

  async readDeliveryLog(
    event: EmailTemplateEventProjection,
    campaignId: string,
  ): Promise<CampaignDeliveryLog | null> {
    const campaign = await this.#database
      .prepare(
        `SELECT id, template_id, template_version, template_snapshot_json,
                audience_filter_snapshot_json, scheduled_at, status,
                projected_at AS created_at
         FROM p_campaigns
         WHERE organization_id = ?1 AND event_id = ?2 AND id = ?3
           AND source_deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(event.organizationId, event.id, campaignId)
      .first<CampaignRow>();
    if (!campaign) return null;
    const rows = await this.#database
      .prepare(
        `SELECT id, status, attempt_count, error_code, provider_message_id,
                last_provider_event_at, queue_payload_json
         FROM provider_messages
         WHERE organization_id = ?1 AND event_id = ?2 AND campaign_id = ?3
           AND kind = 'campaign'
         ORDER BY created_at, id
         LIMIT 10000`,
      )
      .bind(event.organizationId, event.id, campaignId)
      .all<DeliveryMessageRow>();
    const counts = emptyCounts();
    const messages: CampaignDeliveryMessage[] = rows.results.map((row) => {
      if (!deliveryStatuses.has(row.status)) {
        throw new CampaignProjectionError(
          "Campaign delivery state is invalid.",
        );
      }
      counts[row.status as keyof CampaignDeliveryCounts] += 1;
      return {
        attemptCount: row.attempt_count,
        errorCode: row.error_code,
        lastEventAt: row.last_provider_event_at,
        messageId: row.id,
        providerMessageId: row.provider_message_id,
        replayable: row.status === "failed" && row.queue_payload_json !== null,
        status: row.status as CampaignDeliveryMessage["status"],
      };
    });
    return campaignDeliveryLogSchema.parse({
      campaign: campaignSummary(campaign, counts),
      messages,
    });
  }
}

export class CampaignProjectionError extends EmailTemplateProjectionError {
  constructor(message: string) {
    super(message);
    this.name = "CampaignProjectionError";
  }
}
