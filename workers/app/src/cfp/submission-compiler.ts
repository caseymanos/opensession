import type { ProtectedPublicCfpSubmissionRequest } from "@sessionbox-killer/contracts";
import {
  evaluateCfpRules,
  resolveCfpTrackRoute,
  type CfpRuleField,
} from "@sessionbox-killer/domain";

import { sha256Hex } from "../auth/crypto.js";
import type { AuthenticatedSession } from "../auth/service.js";
import type {
  CfpSubmissionPlanFieldValue,
  CfpSubmissionPlanInput,
  CfpSubmissionPlanItem,
} from "./submission-authority.js";
import type { PublicCfpPolicy } from "./policy.js";

const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/;

interface ContactRow {
  email_normalized: string;
  id: string;
  source_record_id: string;
}

interface ReservationRow {
  plan_id: string;
  request_hash: string;
  user_id: string;
}

export type CfpSubmissionErrorCode =
  | "cfp_closed"
  | "duplicate_participant"
  | "form_version_conflict"
  | "idempotency_conflict"
  | "invalid_answer"
  | "invalid_idempotency_key"
  | "invalid_participant"
  | "submission_limit_reached";

export class CfpSubmissionError extends Error {
  readonly code: CfpSubmissionErrorCode;
  readonly status: 400 | 409 | 422;

  constructor(
    code: CfpSubmissionErrorCode,
    message: string,
    status: 400 | 409 | 422 = 422,
  ) {
    super(message);
    this.name = "CfpSubmissionError";
    this.code = code;
    this.status = status;
  }
}

export interface CfpSubmissionCoordinates {
  readonly friendlyId: string;
  readonly planId: string;
  readonly requestHash: string;
  readonly submissionId: string;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("The CFP submission contains an unsupported value.");
}

function semanticRequest(
  request: ProtectedPublicCfpSubmissionRequest,
): Record<string, unknown> {
  return {
    answers: request.answers,
    form_version: request.form_version,
    mode: request.mode,
    participants: request.participants,
  };
}

export async function cfpSubmissionCoordinates(
  policy: PublicCfpPolicy,
  session: AuthenticatedSession,
  idempotencyKey: string,
  request: ProtectedPublicCfpSubmissionRequest,
): Promise<CfpSubmissionCoordinates> {
  if (!idempotencyKeyPattern.test(idempotencyKey)) {
    throw new CfpSubmissionError(
      "invalid_idempotency_key",
      "Provide a valid Idempotency-Key for this save.",
      400,
    );
  }
  const requestHash = await sha256Hex(canonicalJson(semanticRequest(request)));
  const identityHash = await sha256Hex(
    `${policy.organizationId}\u0000${policy.eventId}\u0000${session.user.id}\u0000${idempotencyKey}`,
  );
  return {
    friendlyId: `OS-${identityHash.slice(0, 12).toUpperCase()}`,
    planId: `cfp_plan_${identityHash.slice(0, 32)}`,
    requestHash,
    submissionId: `submission_${identityHash.slice(0, 32)}`,
  };
}

function emptyAnswer(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0) ||
    value === false
  );
}

function invalidAnswer(message: string): never {
  throw new CfpSubmissionError("invalid_answer", message);
}

function validateAnswer(
  field: PublicCfpPolicy["publicConfiguration"]["form"]["fields"][number],
  value: unknown,
  final: boolean,
): void {
  if (value === undefined) return;
  const length = typeof value === "string" ? value.trim().length : undefined;
  const maximum = field.validation.maxLength;
  const minimum = field.validation.minLength;

  if (field.type === "checkbox") {
    if (typeof value !== "boolean") {
      invalidAnswer(`${field.label} must be a checkbox value.`);
    }
    return;
  }
  if (field.type === "multi_select") {
    if (
      !Array.isArray(value) ||
      value.some(
        (entry) =>
          typeof entry !== "string" || !field.options.includes(entry.trim()),
      ) ||
      new Set(value.map((entry) => entry.trim())).size !== value.length
    ) {
      invalidAnswer(`${field.label} contains an unsupported choice.`);
    }
    return;
  }
  if (field.type === "participant") {
    invalidAnswer(`${field.label} must be supplied through participants.`);
  }
  if (typeof value !== "string") {
    invalidAnswer(`${field.label} must contain text.`);
  }
  if (field.type === "single_select" && !field.options.includes(value.trim())) {
    invalidAnswer(`${field.label} contains an unsupported choice.`);
  }
  if (
    field.type === "file" &&
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  ) {
    invalidAnswer(`${field.label} references an invalid upload.`);
  }
  if (maximum !== undefined && length !== undefined && length > maximum) {
    invalidAnswer(`${field.label} exceeds its maximum length.`);
  }
  if (
    final &&
    minimum !== undefined &&
    length !== undefined &&
    length < minimum
  ) {
    invalidAnswer(`${field.label} does not meet its minimum length.`);
  }
}

function validatedAnswers(
  policy: PublicCfpPolicy,
  request: ProtectedPublicCfpSubmissionRequest,
): Record<string, unknown> {
  const fields = policy.publicConfiguration.form.fields;
  const knownKeys = new Set(fields.map((field) => field.key));
  if (Object.keys(request.answers).some((key) => !knownKeys.has(key))) {
    invalidAnswer("The submission contains an answer for an unknown field.");
  }
  const evaluation = evaluateCfpRules(
    fields as readonly CfpRuleField[],
    request.answers,
  );
  const stateByKey = new Map(
    evaluation.fields.map((field) => [field.key, field]),
  );
  const normalized = { ...evaluation.answers };

  for (const field of fields) {
    const state = stateByKey.get(field.key);
    if (!state?.visible) continue;
    const value = evaluation.answers[field.key];
    validateAnswer(field, value, request.mode === "submit");
    if (field.type === "single_select" && typeof value === "string") {
      normalized[field.key] = value.trim();
    }
    if (field.type === "multi_select" && Array.isArray(value)) {
      normalized[field.key] = value.map((entry) => entry.trim());
    }
    if (
      request.mode === "submit" &&
      state.required &&
      field.type !== "participant" &&
      emptyAnswer(value)
    ) {
      invalidAnswer(`${field.label} is required.`);
    }
  }
  return normalized;
}

function normalizedParticipants(
  session: AuthenticatedSession,
  request: ProtectedPublicCfpSubmissionRequest,
) {
  const participants = request.participants.map((participant) => ({
    ...participant,
    email: participant.email.toLocaleLowerCase("en-US"),
  }));
  if (
    participants[0]?.email !== session.user.email.toLocaleLowerCase("en-US")
  ) {
    throw new CfpSubmissionError(
      "invalid_participant",
      "The signed-in submitter must be the primary participant.",
    );
  }
  if (
    new Set(participants.map((participant) => participant.email)).size !==
    participants.length
  ) {
    throw new CfpSubmissionError(
      "duplicate_participant",
      "Each participant email address may appear only once.",
    );
  }
  return participants;
}

async function contactRows(
  database: D1Database,
  organizationId: string,
  emails: readonly string[],
): Promise<Map<string, ContactRow>> {
  const placeholders = emails.map((_, index) => `?${index + 2}`).join(", ");
  const result = await database
    .prepare(
      `SELECT id, email_normalized, source_record_id
       FROM p_contacts
       WHERE organization_id = ?1 AND source_deleted_at IS NULL
         AND email_normalized IN (${placeholders})
       ORDER BY email_normalized, id
       LIMIT 17`,
    )
    .bind(organizationId, ...emails)
    .all<ContactRow>();
  const byEmail = new Map<string, ContactRow>();
  for (const row of result.results) {
    const email = row.email_normalized.toLocaleLowerCase("en-US");
    if (byEmail.has(email)) {
      throw new CfpSubmissionError(
        "invalid_participant",
        "A participant identity is ambiguous. Contact the event organizer.",
        409,
      );
    }
    byEmail.set(email, row);
  }
  return byEmail;
}

async function derivedId(prefix: string, value: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(value)).slice(0, 32)}`;
}

function providerReference(recordId: string): CfpSubmissionPlanFieldValue {
  return { kind: "provider_record", recordId };
}

function itemReference(itemKey: string): CfpSubmissionPlanFieldValue {
  return { itemKey, kind: "plan_item_record" };
}

function contactReference(
  references: ReadonlyMap<string, CfpSubmissionPlanFieldValue>,
  email: string,
): CfpSubmissionPlanFieldValue {
  const reference = references.get(email);
  if (!reference) {
    throw new Error("The CFP participant has no authority contact reference.");
  }
  return reference;
}

export class D1CfpSubmissionCompiler {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async #reserve(
    policy: PublicCfpPolicy,
    session: AuthenticatedSession,
    coordinates: CfpSubmissionCoordinates,
    at: Date,
  ): Promise<void> {
    const now = at.toISOString();
    await this.#database
      .prepare(
        `INSERT INTO cfp_submission_reservations (
           organization_id, event_id, submission_id, user_id, plan_id,
           request_hash, created_at, updated_at
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?9, ?9
         WHERE ?7 IS NULL OR (
           SELECT COUNT(*)
           FROM cfp_submission_reservations AS reservation
           WHERE reservation.organization_id = ?1
             AND reservation.event_id = ?2
             AND reservation.user_id = ?4
         ) + (
           SELECT COUNT(*)
           FROM p_submissions AS submission
           JOIN p_contacts AS contact
             ON contact.organization_id = submission.organization_id
            AND contact.id = submission.submitter_contact_id
           WHERE submission.organization_id = ?1
             AND submission.event_id = ?2
             AND submission.status <> 'withdrawn'
             AND submission.source_deleted_at IS NULL
             AND contact.email_normalized = ?8
             AND contact.source_deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM cfp_submission_reservations AS prior
               WHERE prior.organization_id = submission.organization_id
                 AND prior.event_id = submission.event_id
                 AND prior.submission_id = submission.id
             )
         ) < ?7
         ON CONFLICT (organization_id, event_id, submission_id) DO NOTHING`,
      )
      .bind(
        policy.organizationId,
        policy.eventId,
        coordinates.submissionId,
        session.user.id,
        coordinates.planId,
        coordinates.requestHash,
        policy.publicConfiguration.form.submissionLimit,
        session.user.email,
        now,
      )
      .run();
    const reservation = await this.#database
      .prepare(
        `SELECT user_id, plan_id, request_hash
         FROM cfp_submission_reservations
         WHERE organization_id = ?1 AND event_id = ?2 AND submission_id = ?3`,
      )
      .bind(policy.organizationId, policy.eventId, coordinates.submissionId)
      .first<ReservationRow>();
    if (!reservation) {
      throw new CfpSubmissionError(
        "submission_limit_reached",
        "This account has reached the submission limit for this event.",
        409,
      );
    }
    if (
      reservation.user_id !== session.user.id ||
      reservation.plan_id !== coordinates.planId ||
      reservation.request_hash !== coordinates.requestHash
    ) {
      throw new CfpSubmissionError(
        "idempotency_conflict",
        "This save key was already used for a different version.",
        409,
      );
    }
  }

  async compile(
    policy: PublicCfpPolicy,
    session: AuthenticatedSession,
    request: ProtectedPublicCfpSubmissionRequest,
    coordinates: CfpSubmissionCoordinates,
    at = new Date(),
  ): Promise<CfpSubmissionPlanInput> {
    if (request.form_version !== policy.formVersion) {
      throw new CfpSubmissionError(
        "form_version_conflict",
        "The CFP form changed. Refresh before saving this proposal.",
        409,
      );
    }
    if (!policy.acceptingSubmissions) {
      throw new CfpSubmissionError(
        "cfp_closed",
        "This call for proposals is not accepting new submissions.",
        409,
      );
    }
    const answers = validatedAnswers(policy, request);
    const participants = normalizedParticipants(session, request);
    const primaryParticipant = participants[0];
    if (!primaryParticipant) {
      throw new CfpSubmissionError(
        "invalid_participant",
        "A primary participant is required.",
      );
    }
    const draftJson = canonicalJson({ answers, participants });
    if (draftJson.length > 100_000) {
      throw new CfpSubmissionError(
        "invalid_answer",
        "This proposal exceeds the maximum saved draft size.",
      );
    }
    const existingContacts = await contactRows(
      this.#database,
      policy.organizationId,
      participants.map((participant) => participant.email),
    );
    await this.#reserve(policy, session, coordinates, at);

    const contactItems: CfpSubmissionPlanItem[] = [];
    const contactReferences = new Map<string, CfpSubmissionPlanFieldValue>();
    for (const participant of participants) {
      const existing = existingContacts.get(participant.email);
      if (existing) {
        contactReferences.set(
          participant.email,
          providerReference(existing.source_record_id),
        );
        continue;
      }
      const entityId = await derivedId(
        "contact",
        `${policy.organizationId}\u0000${participant.email}`,
      );
      const itemKey = `contact_${contactItems.length + 1}`;
      contactItems.push({
        entityId,
        expectedVersion: 0,
        fields: {
          "Display name": participant.name,
          "Email normalized": participant.email,
          Organization: providerReference(
            policy.authority.organizationRecordId,
          ),
          ...(participant.role ? { Title: participant.role } : {}),
        },
        itemKey,
        table: "contacts",
      });
      contactReferences.set(participant.email, itemReference(itemKey));
    }

    const trackSelection = answers.track;
    const route =
      typeof trackSelection === "string"
        ? resolveCfpTrackRoute(policy.routes, trackSelection)
        : null;
    if (request.mode === "submit" && !route) {
      invalidAnswer("Choose a track with a valid reviewer route.");
    }
    const authorityTrack = route
      ? policy.authority.tracks.find(
          (track) => track.route.routeKey === route.routeKey,
        )
      : null;
    if (route && !authorityTrack) {
      throw new Error("The canonical CFP track has no authority reference.");
    }

    const title =
      typeof answers.title === "string" && answers.title.trim()
        ? answers.title.trim()
        : "Untitled proposal";
    const submissionFields: Record<string, CfpSubmissionPlanFieldValue> = {
      "Draft JSON": draftJson,
      Event: providerReference(policy.authority.eventRecordId),
      Form: providerReference(policy.authority.formRecordId),
      "Form version": policy.formVersion,
      "Friendly ID": coordinates.friendlyId,
      Status: request.mode === "submit" ? "submitted" : "draft",
      "Submitter contact": contactReference(
        contactReferences,
        primaryParticipant.email,
      ),
      Title: title,
      ...(authorityTrack
        ? { Track: providerReference(authorityTrack.providerRecordId) }
        : {}),
      ...(route
        ? {
            "Default reviewer group ID": route.defaultReviewerGroupId,
            "Route key": route.routeKey,
          }
        : {}),
      ...(request.mode === "submit"
        ? { "Submitted at": at.toISOString() }
        : {}),
    };
    const submissionItem: CfpSubmissionPlanItem = {
      entityId: coordinates.submissionId,
      expectedVersion: 0,
      fields: submissionFields,
      itemKey: "submission",
      table: "submissions",
    };

    const answerItems: CfpSubmissionPlanItem[] = [];
    for (const [
      index,
      field,
    ] of policy.publicConfiguration.form.fields.entries()) {
      if (field.type === "participant" || !Object.hasOwn(answers, field.key)) {
        continue;
      }
      answerItems.push({
        entityId: await derivedId(
          "answer",
          `${coordinates.submissionId}\u0000${field.key}`,
        ),
        expectedVersion: 0,
        fields: {
          "Field label snapshot": field.label,
          "Field stable key": field.key,
          Order: index + 1,
          Submission: itemReference("submission"),
          Type: field.type,
          "Value JSON": canonicalJson(answers[field.key]),
        },
        itemKey: `answer_${answerItems.length + 1}`,
        table: "submission_answers",
      });
    }

    const participantItems = await Promise.all(
      participants.map(async (participant, index) => ({
        entityId: await derivedId(
          "participant",
          `${coordinates.submissionId}\u0000${participant.email}`,
        ),
        expectedVersion: 0,
        fields: {
          Contact: contactReference(contactReferences, participant.email),
          "Is primary": index === 0,
          Order: index + 1,
          Role: "speaker",
          Submission: itemReference("submission"),
        },
        itemKey: `participant_${index + 1}`,
        table: "submission_participants" as const,
      })),
    );

    return {
      actorId: session.user.id,
      eventId: policy.eventId,
      items: [
        ...contactItems,
        submissionItem,
        ...answerItems,
        ...participantItems,
      ],
      mode: request.mode,
      operation: "cfp.submission.persist",
      organizationId: policy.organizationId,
      planId: coordinates.planId,
      requestHash: coordinates.requestHash,
      submissionId: coordinates.submissionId,
    };
  }
}
