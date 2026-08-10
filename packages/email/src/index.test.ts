import { describe, expect, it } from "vitest";

import {
  activateEmailTemplate,
  analyzeEmailTemplate,
  createCampaignMessageKey,
  createCampaignPlan,
  createEmailTemplateRevision,
  createSeedEmailTemplates,
  EmailTemplateValidationError,
  renderEmailTemplate,
  serializeCampaignPlan,
  serializeEmailTemplateSnapshot,
  snapshotEmailTemplate,
  validateEmailMergeValues,
  type EmailMergeValues,
  type EmailTemplate,
  type CampaignAudienceCandidate,
} from "./index.js";

const createdAt = "2026-08-09T20:00:00.000Z";
const templates = createSeedEmailTemplates({
  createdAt,
  eventId: "evt_demo",
  replyTo: "program@example.test",
  sender: { address: "notifications@example.test", name: "OpenSession" },
});
const values = {
  "event.location": { type: "text", value: "Pier 27" },
  "event.name": { type: "text", value: "AI Engineer Summit 2026" },
  "event.public_url": {
    type: "url",
    value: "https://events.example.test/ai-engineer-summit",
  },
  "organizer.email": { type: "email", value: "program@example.test" },
  "organizer.name": { type: "text", value: "Program team" },
  "recipient.first_name": { type: "text", value: "Mina" },
  "recipient.full_name": { type: "text", value: "Mina Patel" },
  "session.end_at": {
    display: "September 18 at 10:40 AM PT",
    type: "date_time",
    value: "2026-09-18T17:40:00.000Z",
  },
  "session.public_url": {
    type: "url",
    value: "https://events.example.test/ai-engineer-summit/sessions/ses-104",
  },
  "session.room": { type: "text", value: "Harbor Stage" },
  "session.start_at": {
    display: "September 18 at 10:00 AM PT",
    type: "date_time",
    value: "2026-09-18T17:00:00.000Z",
  },
  "session.title": { type: "text", value: "Reliable Agents in Production" },
  "submission.friendly_id": { type: "text", value: "SUB-0104" },
  "submission.portal_url": {
    type: "url",
    value:
      "https://events.example.test/ai-engineer-summit/submissions/SUB-0104",
  },
  "submission.title": { type: "text", value: "Reliable Agents in Production" },
  "task.due_at": {
    display: "September 2 at 5:00 PM PT",
    type: "date_time",
    value: "2026-09-03T00:00:00.000Z",
  },
  "task.name": { type: "text", value: "Upload your final slides" },
  "task.portal_url": {
    type: "url",
    value:
      "https://events.example.test/ai-engineer-summit/portal/tasks/task_slides",
  },
} satisfies EmailMergeValues;

function template(id: string): EmailTemplate {
  const result = templates.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing seed template ${id}`);
  return result;
}

describe("typed email templates", () => {
  it("ships five valid, active seed templates", () => {
    expect(templates.map(({ id }) => id)).toEqual([
      "template_submission_receipt",
      "template_submission_accepted",
      "template_submission_declined",
      "template_task_reminder",
      "template_schedule_updated",
    ]);
    expect(
      templates.map((candidate) => analyzeEmailTemplate(candidate)),
    ).toEqual(
      templates.map((candidate) => ({
        issues: [],
        usedFields: expect.arrayContaining([...candidate.allowedMergeFields]),
        valid: true,
      })),
    );
  });

  it("renders deterministic HTML and plain-text previews for every seed", () => {
    const rendered = templates.map((candidate) => {
      const preview = renderEmailTemplate(candidate, values);
      return {
        from: preview.from,
        html: preview.html,
        id: candidate.id,
        replyTo: preview.replyTo,
        subject: preview.subject,
        text: preview.text,
        version: preview.templateVersion,
      };
    });

    expect(rendered).toMatchSnapshot();
  });

  it("reports an intentional unknown token at its exact body location", () => {
    const receipt = template("template_submission_receipt");
    const invalid: EmailTemplate = {
      ...receipt,
      body: {
        ...receipt.body,
        blocks: [
          { text: "Hello {{recipient.nickname}}", type: "heading" },
          ...receipt.body.blocks.slice(1),
        ],
      },
    };
    const analysis = analyzeEmailTemplate(invalid);

    expect(analysis.valid).toBe(false);
    expect(analysis.issues).toContainEqual({
      code: "unknown_field",
      location: "body.blocks[0].text",
      message: "Unknown merge field recipient.nickname.",
      offset: 6,
    });
    expect(
      analyzeEmailTemplate({ ...receipt, subject: "{{constructor}}" }).issues,
    ).toContainEqual(
      expect.objectContaining({ code: "unknown_field", location: "subject" }),
    );
  });

  it("blocks missing, mistyped, and unsafe URL values before rendering", () => {
    const receipt = template("template_submission_receipt");
    const missing = validateEmailMergeValues(receipt, {
      "event.name": values["event.name"],
    });
    const mistyped = validateEmailMergeValues(receipt, {
      ...values,
      "submission.portal_url": { type: "text", value: "not a URL" },
    });
    const unsafeValues: EmailMergeValues = {
      ...values,
      "submission.portal_url": {
        type: "url",
        value: "javascript:alert(1)",
      },
    };
    const unsafe = validateEmailMergeValues(receipt, unsafeValues);

    expect(missing.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_field_value",
          location: "body.blocks[0].text",
        }),
      ]),
    );
    expect(mistyped.issues).toContainEqual(
      expect.objectContaining({ code: "invalid_field_value" }),
    );
    expect(unsafe.issues).toContainEqual(
      expect.objectContaining({ code: "unsafe_url" }),
    );
    expect(() => renderEmailTemplate(receipt, unsafeValues)).toThrow();
  });

  it("rejects unsafe targets and header injection, and quotes display names", () => {
    const receipt = template("template_submission_receipt");
    const unsafeTarget: EmailTemplate = {
      ...receipt,
      body: {
        ...receipt.body,
        blocks: [
          ...receipt.body.blocks,
          { label: "Insecure", type: "button", url: "http://example.test" },
        ],
      },
    };
    const injectedSender: EmailTemplate = {
      ...receipt,
      sender: {
        ...receipt.sender,
        name: "OpenSession\r\nBcc: attacker@example.test",
      },
    };
    const subjectWithRecipient: EmailTemplate = {
      ...receipt,
      subject: "Hello {{recipient.first_name}}",
    };

    expect(analyzeEmailTemplate(unsafeTarget).issues).toContainEqual(
      expect.objectContaining({ code: "unsafe_url" }),
    );
    expect(analyzeEmailTemplate(injectedSender).issues).toContainEqual(
      expect.objectContaining({
        code: "invalid_template",
        location: "sender.name",
      }),
    );
    expect(() =>
      renderEmailTemplate(subjectWithRecipient, {
        ...values,
        "recipient.first_name": { type: "text", value: "Mina\nBcc: attacker" },
      }),
    ).toThrowError(EmailTemplateValidationError);
    expect(
      renderEmailTemplate(
        {
          ...receipt,
          sender: { ...receipt.sender, name: 'Open "Session" \\ Team' },
        },
        values,
      ).from,
    ).toBe('"Open \\"Session\\" \\\\ Team" <notifications@example.test>');
  });

  it("escapes recipient values instead of executing them in previews", () => {
    const rendered = renderEmailTemplate(
      template("template_submission_receipt"),
      {
        ...values,
        "recipient.first_name": {
          type: "text",
          value: "<script>alert('recipient')</script>",
        },
      },
    );

    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain(
      "&lt;script&gt;alert(&#39;recipient&#39;)&lt;/script&gt;",
    );
    expect(rendered.text).toContain("<script>alert('recipient')</script>");
  });

  it("creates immutable, exact snapshots and versions every change", () => {
    const receipt = template("template_submission_receipt");
    const revision = createEmailTemplateRevision(
      receipt,
      { subject: "Updated: {{submission.friendly_id}}" },
      "2026-08-09T20:01:00.000Z",
    );
    const active = activateEmailTemplate(revision, "2026-08-09T20:02:00.000Z");
    const snapshot = snapshotEmailTemplate(active);
    const serialized = serializeEmailTemplateSnapshot(active);

    expect(revision).toMatchObject({ status: "draft", version: 2 });
    expect(active).toMatchObject({ status: "active", version: 3 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.body.blocks)).toBe(true);
    expect(JSON.parse(serialized)).toEqual(active);
    expect(() =>
      createEmailTemplateRevision(
        active,
        { internalName: "Time travel" },
        "2026-08-09T20:01:00.000Z",
      ),
    ).toThrow("timestamp must advance");
  });

  it("permits campaign snapshots only from active templates", () => {
    const receipt = template("template_submission_receipt");
    const inactiveTemplates: readonly EmailTemplate[] = [
      { ...receipt, status: "draft" },
      { ...receipt, status: "archived" },
    ];

    for (const inactive of inactiveTemplates) {
      expect(() => snapshotEmailTemplate(inactive)).toThrowError(
        EmailTemplateValidationError,
      );
      expect(() => serializeEmailTemplateSnapshot(inactive)).toThrow(
        "status: Only an active template can become a campaign snapshot.",
      );
    }
    expect(snapshotEmailTemplate(receipt)).toEqual(receipt);
  });

  it("enforces the provider-friendly rendered body budget", () => {
    const receipt = template("template_submission_receipt");
    const oversized: EmailTemplate = {
      ...receipt,
      allowedMergeFields: [],
      body: {
        blocks: Array.from({ length: 13 }, () => ({
          text: "x".repeat(8_000),
          type: "paragraph" as const,
        })),
        previewText: "",
      },
      subject: "Static subject",
    };

    expect(() => renderEmailTemplate(oversized, {})).toThrowError(
      EmailTemplateValidationError,
    );
    try {
      renderEmailTemplate(oversized, {});
    } catch (error) {
      expect(error).toMatchObject({
        issues: [expect.objectContaining({ code: "output_too_large" })],
      });
    }
  });
});

describe("campaign plans", () => {
  function candidate(
    index: number,
    overrides: Partial<CampaignAudienceCandidate> = {},
  ): CampaignAudienceCandidate {
    return {
      contactId: `contact_${String(index).padStart(2, "0")}`,
      displayName: `Recipient ${index}`,
      email: `recipient${index}@example.test`,
      eventId: "evt_demo",
      mergeValues: {
        ...values,
        "recipient.first_name": { type: "text", value: `Recipient ${index}` },
      },
      ...overrides,
    };
  }

  it("freezes an exact event-scoped audience with exclusions and five samples", () => {
    const candidates = [
      ...Array.from({ length: 6 }, (_, index) => candidate(index + 1)),
      candidate(7, { email: "recipient1@example.test" }),
      candidate(8, { eventId: "evt_other" }),
      candidate(9, { email: "invalid address" }),
      candidate(10, { suppressionReason: "complained" }),
      candidate(11, {
        mergeValues: { "event.name": values["event.name"] },
      }),
      candidate(1),
    ].reverse();

    const plan = createCampaignPlan({
      candidates,
      createdAt: "2026-08-09T21:00:00.000Z",
      eventId: "evt_demo",
      filter: {
        portalStates: ["active", "invited", "active"],
        readiness: "all",
        roles: ["speaker", "submitter", "speaker"],
      },
      schedule: {
        mode: "scheduled",
        scheduledAt: "2026-08-09T22:00:00.000Z",
      },
      template: template("template_submission_receipt"),
    });

    expect(plan.audience).toMatchObject({
      eventId: "evt_demo",
      excludedCount: 6,
      filter: {
        portalStates: ["active", "invited"],
        readiness: "all",
        roles: ["speaker", "submitter"],
      },
      includedContactIds: [
        "contact_01",
        "contact_02",
        "contact_03",
        "contact_04",
        "contact_05",
        "contact_06",
      ],
      includedCount: 6,
      totalCandidates: 12,
    });
    expect(plan.audience.samples).toHaveLength(5);
    expect(plan.schedule).toEqual({
      mode: "scheduled",
      scheduledAt: "2026-08-09T22:00:00.000Z",
    });
    expect(plan.sender).toEqual(plan.template.sender);
    expect(plan.audience.excluded.map(({ reason }) => reason)).toEqual([
      "duplicate_contact",
      "duplicate_email",
      "cross_event",
      "invalid_email",
      "complained",
      "invalid_merge_values",
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.audience.excluded)).toBe(true);
    expect(JSON.parse(serializeCampaignPlan(plan))).toEqual(plan);
  });

  it("binds message idempotency to campaign, recipient, template, and version", async () => {
    const input = {
      campaignId: "campaign_demo",
      contactId: "contact_01",
      templateId: "template_submission_receipt",
      templateVersion: 1,
    };
    const original = await createCampaignMessageKey(input);

    expect(original).toMatch(/^email_[a-f\d]{64}$/);
    await expect(createCampaignMessageKey(input)).resolves.toBe(original);
    await expect(
      createCampaignMessageKey({ ...input, templateVersion: 2 }),
    ).resolves.not.toBe(original);
  });

  it("excludes every contact sharing a suppressed normalized address", () => {
    const plan = createCampaignPlan({
      candidates: [
        candidate(1, { email: "shared-one@example.test" }),
        candidate(2, {
          email: "SHARED-ONE@example.test",
          suppressionReason: "complained",
        }),
        candidate(3, {
          email: "shared-two@example.test",
          suppressionReason: "bounced",
        }),
        candidate(4, { email: "shared-two@example.test" }),
      ],
      createdAt: "2026-08-09T21:00:00.000Z",
      eventId: "evt_demo",
      filter: { portalStates: [], readiness: "all", roles: ["speaker"] },
      schedule: { mode: "now" },
      template: template("template_submission_receipt"),
    });

    expect(plan.audience.includedCount).toBe(0);
    expect(plan.audience.excluded).toEqual([
      { contactId: "contact_01", reason: "complained" },
      { contactId: "contact_02", reason: "complained" },
      { contactId: "contact_03", reason: "bounced" },
      { contactId: "contact_04", reason: "bounced" },
    ]);
  });

  it("refuses a template from another event", () => {
    expect(() =>
      createCampaignPlan({
        candidates: [],
        createdAt: "2026-08-09T21:00:00.000Z",
        eventId: "evt_other",
        filter: { portalStates: [], readiness: "all", roles: ["speaker"] },
        schedule: { mode: "now" },
        template: template("template_submission_receipt"),
      }),
    ).toThrow("Template belongs to another event");
  });

  it("refuses a scheduled send that is not after confirmation", () => {
    expect(() =>
      createCampaignPlan({
        candidates: [],
        createdAt: "2026-08-09T21:00:00.000Z",
        eventId: "evt_demo",
        filter: { portalStates: [], readiness: "all", roles: ["speaker"] },
        schedule: {
          mode: "scheduled",
          scheduledAt: "2026-08-09T20:59:59.000Z",
        },
        template: template("template_submission_receipt"),
      }),
    ).toThrow("Scheduled delivery must be after confirmation");
  });
});
