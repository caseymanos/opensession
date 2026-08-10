import {
  activateEmailTemplate,
  analyzeEmailTemplate,
  archiveEmailTemplate,
  createEmailTemplateRevision,
  EmailTemplateValidationError,
  renderSanitizedEmailTemplateBody,
  renderEmailTemplate,
  type EmailMergeValues,
  type EmailTemplate,
  type EmailTemplateCommand,
} from "@sessionbox-killer/email";

import type { BaseAuthority } from "../authority/base-authority.js";
import type { AuthorityResponse } from "../authority/types.js";
import type {
  D1EmailTemplateProjectionRepository,
  EmailTemplateEventProjection,
} from "./repository.js";

interface EmailTemplateCommandServiceOptions {
  readonly actor: {
    readonly email: string;
    readonly id: string;
    readonly name: string;
  };
  readonly authority: Pick<BaseAuthority, "execute">;
  readonly now?: () => Date;
  readonly projection: Pick<
    D1EmailTemplateProjectionRepository,
    "readTemplateWithHead"
  >;
  readonly requestId: string;
}

export interface EmailTemplateCommandResult {
  readonly projection: "durable" | "repair_pending";
  readonly record: {
    readonly sourceVersion: number;
    readonly template: EmailTemplate;
  };
  readonly replayed: boolean;
}

function nextTimestamp(current: string, now: Date): string {
  const currentMilliseconds = Date.parse(current);
  const nextMilliseconds = Math.max(now.getTime(), currentMilliseconds + 1);
  return new Date(nextMilliseconds).toISOString();
}

function generatedTemplateFields(
  event: EmailTemplateEventProjection,
  template: EmailTemplate,
) {
  const analysis = analyzeEmailTemplate(template);
  if (!analysis.valid) {
    throw new EmailTemplateValidationError(analysis.issues);
  }
  const rendered = renderSanitizedEmailTemplateBody(template);
  return {
    "Audience type": template.audience,
    "Body document JSON": JSON.stringify(template.body),
    "Body HTML": rendered.html,
    "Body text": rendered.text,
    Event: [event.sourceRecordId],
    "Merge schema version": template.mergeSchemaVersion,
    Name: template.internalName,
    "Reply to": template.replyTo,
    "Sender email": template.sender.address,
    "Sender name": template.sender.name,
    Status: template.status,
    Subject: template.subject,
    "Used merge fields JSON": JSON.stringify(analysis.usedFields),
    Version: template.version,
  } as const;
}

export class AirtableEmailTemplateCommandService {
  readonly #actor: EmailTemplateCommandServiceOptions["actor"];
  readonly #authority: EmailTemplateCommandServiceOptions["authority"];
  readonly #now: () => Date;
  readonly #projection: EmailTemplateCommandServiceOptions["projection"];
  readonly #requestId: string;

  constructor(options: EmailTemplateCommandServiceOptions) {
    this.#actor = options.actor;
    this.#authority = options.authority;
    this.#now = options.now ?? (() => new Date());
    this.#projection = options.projection;
    this.#requestId = options.requestId;
  }

  async execute(
    event: EmailTemplateEventProjection,
    command: EmailTemplateCommand,
    activationValues?: EmailMergeValues,
  ): Promise<EmailTemplateCommandResult> {
    const resolved = await this.#projection.readTemplateWithHead(
      event,
      command.baseTemplateId,
    );
    if (!resolved) {
      throw new EmailTemplateNotFoundError(command.baseTemplateId);
    }
    const { current, head } = resolved;
    if (current.template.id !== head.template.id) {
      throw new EmailTemplateHistoricalVersionError(
        current.template.id,
        head.template.id,
      );
    }
    if (current.sourceVersion !== command.expectedSourceVersion) {
      throw new EmailTemplateVersionConflictError(
        command.expectedSourceVersion,
        current.sourceVersion,
      );
    }

    const updatedAt = nextTimestamp(current.template.updatedAt, this.#now());
    const template =
      command.type === "create_revision"
        ? createEmailTemplateRevision(
            current.template,
            command.template,
            updatedAt,
          )
        : command.type === "activate_version"
          ? activateEmailTemplate(current.template, updatedAt, command.template)
          : archiveEmailTemplate(current.template, updatedAt);
    if (command.type === "activate_version") {
      if (!activationValues) {
        throw new TypeError("Activation requires validated preview values.");
      }
      renderEmailTemplate(template, activationValues);
    }
    const fields = generatedTemplateFields(event, template);
    const operation = `email_template.${command.type}`;
    const response: AuthorityResponse = await this.#authority.execute({
      audit: {
        action: operation,
        actorId: this.#actor.id,
        actorType: "user",
        eventId: event.id,
        requestId: this.#requestId,
        safeDiff: {
          base_template_id: current.template.id,
          merge_fields: analyzeEmailTemplate(template).usedFields,
          status: template.status,
          template_id: template.id,
          version: template.version,
        },
      },
      commandId: command.commandId,
      entityId: template.id,
      expectedVersion: 0,
      fields,
      operation,
      organizationId: event.organizationId,
      table: "email_templates",
    });

    return {
      projection: response.projection,
      record: {
        sourceVersion: response.authority.sourceVersion,
        template,
      },
      replayed: response.authority.replayed,
    };
  }
}

export class EmailTemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`Email template ${templateId} was not found.`);
    this.name = "EmailTemplateNotFoundError";
  }
}

export class EmailTemplateVersionConflictError extends Error {
  readonly actualSourceVersion: number;
  readonly expectedSourceVersion: number;

  constructor(expectedSourceVersion: number, actualSourceVersion: number) {
    super("The template changed after this editor was opened.");
    this.name = "EmailTemplateVersionConflictError";
    this.actualSourceVersion = actualSourceVersion;
    this.expectedSourceVersion = expectedSourceVersion;
  }
}

export class EmailTemplateHistoricalVersionError extends Error {
  readonly headTemplateId: string;
  readonly historicalTemplateId: string;

  constructor(historicalTemplateId: string, headTemplateId: string) {
    super("Only the current template-family head can be changed.");
    this.name = "EmailTemplateHistoricalVersionError";
    this.headTemplateId = headTemplateId;
    this.historicalTemplateId = historicalTemplateId;
  }
}
