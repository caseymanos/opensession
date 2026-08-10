import {
  activateEmailTemplate,
  archiveEmailTemplate,
  createDeterministicEmailPreviewValues,
  createEmailTemplateRevision,
  createSeedEmailTemplates,
  emailTemplateFamilyId,
  emailTemplateHead,
  emailTemplateVersionId,
  emailMergeFieldDefinitions,
  EmailTemplateValidationError,
  renderEmailTemplate,
  resolvedEmailMergeFields,
  type EmailMergeValues,
  type EmailTemplate,
  type EmailTemplateCommand,
  type EmailTemplatePreviewRequest,
  type EmailTemplatePreviewResponse,
  type EmailTemplateRecord,
  type EmailTemplateWorkspace,
} from "@sessionbox-killer/email";

import type { EmailTemplatePort } from "./emailTemplateClient";

const fixtureCreatedAt = "2026-08-10T20:00:00.000Z";
const fixtureRecipients = [
  {
    email: "mina.okafor@demo.opensession.invalid",
    firstName: "Mina",
    id: "contact_mina_okafor",
    name: "Mina Okafor",
    roles: ["speaker"],
  },
  {
    email: "arun.iyer@demo.opensession.invalid",
    firstName: "Arun",
    id: "contact_arun_iyer",
    name: "Arun Iyer",
    roles: ["speaker", "moderator"],
  },
] as const;

function fixtureWorkspace(): EmailTemplateWorkspace {
  return {
    event: {
      id: "event_ai_engineer_summit",
      name: "AI Engineer Summit 2026",
      slug: "ai-engineer-summit",
    },
    mergeFields: Object.entries(emailMergeFieldDefinitions).map(
      ([name, definition]) => ({
        name: name as keyof typeof emailMergeFieldDefinitions,
        type: definition.type,
      }),
    ),
    recipients: fixtureRecipients.map(({ email, id, name, roles }) => ({
      email,
      id,
      name,
      roles: [...roles],
    })),
    templates: createSeedEmailTemplates({
      createdAt: fixtureCreatedAt,
      eventId: "event_ai_engineer_summit",
      replyTo: "program@demo.opensession.invalid",
      sender: {
        address: "updates@demo.opensession.invalid",
        name: "OpenSession Program Team",
      },
    }).map((template) => ({ sourceVersion: 1, template })),
  };
}

function previewValues(
  source: EmailTemplatePreviewRequest["source"],
): EmailMergeValues {
  if (source.kind === "seed") return createDeterministicEmailPreviewValues();
  const recipient = fixtureRecipients.find(
    ({ id }) => id === source.recipientId,
  );
  if (!recipient) return {};
  return createDeterministicEmailPreviewValues({
    recipientFirstName: recipient.firstName,
    recipientFullName: recipient.name,
  });
}

function previewTemplate(
  base: EmailTemplate,
  request: EmailTemplatePreviewRequest,
): EmailTemplate {
  return {
    ...base,
    ...request.template,
    id: emailTemplateVersionId(base.id, base.version + 1),
    status: "draft",
    version: base.version + 1,
  };
}

function fixturePreview(
  base: EmailTemplate,
  request: EmailTemplatePreviewRequest,
): EmailTemplatePreviewResponse {
  const template = previewTemplate(base, request);
  const values = previewValues(request.source);
  const resolvedFields = resolvedEmailMergeFields(template, values);
  try {
    return {
      ok: true,
      preview: renderEmailTemplate(template, values),
      resolvedFields: [...resolvedFields],
      source: request.source,
    };
  } catch (error) {
    if (!(error instanceof EmailTemplateValidationError)) throw error;
    return {
      issues: [...error.issues],
      ok: false,
      resolvedFields: [...resolvedFields],
      source: request.source,
    };
  }
}

function commandResult(
  template: EmailTemplate,
): Awaited<ReturnType<EmailTemplatePort["execute"]>> {
  return {
    projection: "durable",
    record: { sourceVersion: 1, template },
    replayed: false,
  };
}

export function createFixtureEmailTemplatePort(): EmailTemplatePort {
  let workspace = fixtureWorkspace();

  function current(command: EmailTemplateCommand): EmailTemplateRecord {
    const record = workspace.templates.find(
      ({ template }) => template.id === command.baseTemplateId,
    );
    if (!record) throw new Error("Fixture template is missing.");
    const head = emailTemplateHead(
      workspace.templates.map(({ template }) => template),
      emailTemplateFamilyId(record.template.id),
    );
    if (head?.id !== record.template.id) {
      throw new Error("Only the latest immutable template version can change.");
    }
    return record;
  }

  return {
    async execute(command) {
      const record = current(command);
      const timestamp = new Date(
        Date.parse(record.template.updatedAt) + 60_000,
      ).toISOString();
      const template =
        command.type === "create_revision"
          ? createEmailTemplateRevision(
              record.template,
              command.template,
              timestamp,
            )
          : command.type === "activate_version"
            ? activateEmailTemplate(
                record.template,
                timestamp,
                command.template,
              )
            : archiveEmailTemplate(record.template, timestamp);
      const result = commandResult(template);
      if (
        workspace.templates.some(
          ({ template: candidate }) => candidate.id === template.id,
        )
      ) {
        throw new Error("Fixture attempted to create a duplicate template ID.");
      }
      workspace = {
        ...workspace,
        templates: [result.record, ...workspace.templates],
      };
      return result;
    },
    async preview(request) {
      const base = workspace.templates.find(
        ({ template }) => template.id === request.baseTemplateId,
      );
      if (!base) throw new Error("Fixture template is missing.");
      return fixturePreview(base.template, request);
    },
    async read() {
      return structuredClone(workspace);
    },
  };
}
