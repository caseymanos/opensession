import {
  createDeterministicEmailPreviewValues,
  createEmailTemplateRevision,
  createSeedEmailTemplates,
  emailTemplateDraft,
  emailTemplateVersionId,
  type EmailTemplate,
  type EmailTemplateCommand,
  type EmailTemplateRecord,
} from "@sessionbox-killer/email";
import { describe, expect, it, vi } from "vitest";

import { parseBaseAuthorityCommand } from "../src/authority/types";
import type { AuthorityResponse } from "../src/authority/types";
import { AirtableEmailTemplateCommandService } from "../src/email-templates/service";
import type { EmailTemplateVersionConflictError } from "../src/email-templates/service";

const event = {
  id: "event_ai_engineer_summit",
  name: "AI Engineer Summit",
  organizationId: "org_opensession",
  slug: "ai-engineer-summit",
  sourceRecordId: "rec_event_ai_engineer_summit",
  timezone: "America/Los_Angeles",
  venue: "Pier 27",
} as const;

function seed(): EmailTemplate {
  const template = createSeedEmailTemplates({
    createdAt: "2026-08-10T20:00:00.000Z",
    eventId: event.id,
    replyTo: "program@example.test",
    sender: { address: "updates@example.test", name: "OpenSession" },
  }).find(({ id }) => id === "template_submission_accepted");
  if (!template) throw new Error("Missing acceptance seed.");
  return template;
}

function authorityResponse(
  template: EmailTemplate,
  sourceVersion = 1,
): AuthorityResponse {
  return {
    authority: {
      entityId: template.id,
      fields: {},
      recordId: "rec_email_template",
      replayed: false,
      sourceVersion,
    },
    commandId: "email_template_command",
    projection: "durable",
    status: "committed",
  };
}

function service(current: EmailTemplateRecord, head = current) {
  const execute = vi.fn(async (value: unknown) => {
    const command = parseBaseAuthorityCommand(value);
    return authorityResponse({ ...current.template, id: command.entityId });
  });
  return {
    execute,
    service: new AirtableEmailTemplateCommandService({
      actor: {
        email: "casey@example.test",
        id: "user_casey_manos",
        name: "Casey Manos",
      },
      authority: { execute },
      now: () => new Date("2026-08-10T20:01:00.000Z"),
      projection: {
        readTemplateWithHead: async () => ({ current, head }),
      },
      requestId: "request_email_template",
    }),
  };
}

function revisionCommand(
  template: EmailTemplate,
): Extract<EmailTemplateCommand, { type: "create_revision" }> {
  return {
    baseTemplateId: template.id,
    commandId: "email_template_command",
    expectedSourceVersion: 7,
    template: emailTemplateDraft(template),
    type: "create_revision",
  };
}

describe("authoritative email-template commands", () => {
  it("creates a new immutable Airtable record with a non-PII audit diff", async () => {
    const current = { sourceVersion: 7, template: seed() };
    const harness = service(current);
    const command = revisionCommand(current.template);
    const result = await harness.service.execute(event, {
      ...command,
      template: {
        ...command.template,
        body: {
          ...command.template.body,
          blocks: [
            {
              text: "Welcome <script>alert('unsafe')</script>, {{recipient.first_name}}",
              type: "heading",
            },
            ...command.template.body.blocks.slice(1),
          ],
        },
      },
    });

    expect(result.record.template).toMatchObject({
      id: emailTemplateVersionId(current.template.id, 2),
      status: "draft",
      version: 2,
    });
    expect(current.template).toMatchObject({
      id: "template_submission_accepted",
      status: "active",
      version: 1,
    });
    const submitted = parseBaseAuthorityCommand(
      harness.execute.mock.calls[0]?.[0],
    );
    expect(submitted).toMatchObject({
      entityId: emailTemplateVersionId(current.template.id, 2),
      expectedVersion: 0,
      operation: "email_template.create_revision",
      organizationId: event.organizationId,
      table: "email_templates",
    });
    expect(submitted.fields["Body HTML"]).not.toContain("<script>");
    expect(submitted.fields["Body HTML"]).toContain("&lt;script&gt;");
    expect(submitted.fields["Body HTML"]).toContain("{{recipient.first_name}}");
    expect(submitted.fields["Body HTML"]).not.toContain("Mina");
    expect(submitted.fields["Body text"]).toContain("<script>");
    expect(JSON.stringify(submitted.audit.safeDiff)).not.toContain(
      "casey@example.test",
    );
    expect(submitted.audit.safeDiff).toEqual({
      base_template_id: current.template.id,
      merge_fields: expect.arrayContaining([
        "event.name",
        "recipient.first_name",
      ]),
      status: "draft",
      template_id: emailTemplateVersionId(current.template.id, 2),
      version: 2,
    });
  });

  it("activates a draft as another immutable version", async () => {
    const original = seed();
    const draft: EmailTemplate = {
      ...original,
      id: emailTemplateVersionId(original.id, 2),
      status: "draft",
      updatedAt: "2026-08-10T20:00:30.000Z",
      version: 2,
    };
    const harness = service({ sourceVersion: 7, template: draft });
    const activationDraft = {
      ...emailTemplateDraft(draft),
      internalName: "Accepted and ready",
    };
    const result = await harness.service.execute(
      event,
      {
        baseTemplateId: draft.id,
        commandId: "email_template_activate",
        expectedSourceVersion: 7,
        source: {
          kind: "recipient",
          recipientId: "contact_mina_okafor",
        },
        template: activationDraft,
        type: "activate_version",
      },
      createDeterministicEmailPreviewValues({
        recipientFirstName: "Mina",
        recipientFullName: "Mina Okafor",
      }),
    );

    expect(result.record.template).toMatchObject({
      id: emailTemplateVersionId(draft.id, 3),
      internalName: "Accepted and ready",
      status: "active",
      version: 3,
    });
    expect(draft.status).toBe("draft");
  });

  it("blocks activation against the chosen preview values before authority", async () => {
    const original = seed();
    const draft: EmailTemplate = {
      ...original,
      id: emailTemplateVersionId(original.id, 2),
      status: "draft",
      updatedAt: "2026-08-10T20:00:30.000Z",
      version: 2,
    };
    const harness = service({ sourceVersion: 7, template: draft });
    const activationDraft = {
      ...emailTemplateDraft(draft),
      allowedMergeFields: [...draft.allowedMergeFields, "task.name" as const],
      subject: "Reminder: {{task.name}}",
    };
    const values = { ...createDeterministicEmailPreviewValues() };
    delete values["task.name"];

    await expect(
      harness.service.execute(
        event,
        {
          baseTemplateId: draft.id,
          commandId: "email_template_activate_missing_value",
          expectedSourceVersion: 7,
          source: {
            kind: "recipient",
            recipientId: "contact_mina_okafor",
          },
          template: activationDraft,
          type: "activate_version",
        },
        values,
      ),
    ).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          code: "missing_field_value",
          location: "subject",
        }),
      ],
    });
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("archives by appending a lifecycle version", async () => {
    const current = seed();
    const harness = service({ sourceVersion: 7, template: current });
    const result = await harness.service.execute(event, {
      baseTemplateId: current.id,
      commandId: "email_template_archive",
      expectedSourceVersion: 7,
      type: "archive_version",
    });

    expect(result.record.template).toMatchObject({
      id: emailTemplateVersionId(current.id, 2),
      status: "archived",
      version: 2,
    });
    expect(current.status).toBe("active");
  });

  it("rejects commands against a historical family version", async () => {
    const historical = { sourceVersion: 7, template: seed() };
    const head = {
      sourceVersion: 8,
      template: createEmailTemplateRevision(
        historical.template,
        emailTemplateDraft(historical.template),
        "2026-08-10T20:00:30.000Z",
      ),
    };
    const harness = service(historical, head);

    await expect(
      harness.service.execute(event, revisionCommand(historical.template)),
    ).rejects.toThrow("Only the current template-family head can be changed.");
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("rejects stale source versions before calling authority", async () => {
    const current = { sourceVersion: 8, template: seed() };
    const harness = service(current);

    await expect(
      harness.service.execute(event, revisionCommand(current.template)),
    ).rejects.toEqual(
      expect.objectContaining<Partial<EmailTemplateVersionConflictError>>({
        actualSourceVersion: 8,
        expectedSourceVersion: 7,
      }),
    );
    expect(harness.execute).not.toHaveBeenCalled();
  });
});
