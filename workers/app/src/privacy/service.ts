import {
  privacyExportResponseSchema,
  privacyPolicyResponseSchema,
  type PrivacyExportResponse,
  type PrivacyPolicyResponse,
} from "@sessionbox-killer/contracts";

const maximumRowsPerFamily = 1_000;
export const maximumPrivacyExportBytes = 4 * 1024 * 1024;

export class PrivacyExportTooLargeError extends Error {
  constructor() {
    super("The privacy export exceeds the bounded online export limit.");
    this.name = "PrivacyExportTooLargeError";
  }
}

export class PrivacyProjectionUnavailableError extends Error {
  constructor() {
    super("The privacy export projection is unavailable.");
    this.name = "PrivacyProjectionUnavailableError";
  }
}

export const privacyPolicy: PrivacyPolicyResponse =
  privacyPolicyResponseSchema.parse({
    deletion: {
      completion_target_days: 30,
      mode: "coordinated_operator_request",
      partial_delete_api: false,
      reason:
        "Airtable is authoritative and subject files live in private R2. A D1-only deletion would be incomplete and could be rehydrated by projection repair.",
      required_steps: [
        "Verify the requester through the existing passwordless account or another documented identity check.",
        "Create and retain the organization-scoped export before destructive work begins.",
        "Delete or anonymize the authoritative Airtable records and any downstream provider copies before removing projections.",
        "Delete subject-owned R2 objects, then purge or anonymize D1 authentication and projection data.",
        "Run projection repair and export-by-email again to prove the subject no longer resolves, while retaining only documented pseudonymous safety records.",
      ],
    },
    export: {
      format: "application/json",
      mode: "organization_owner_api",
      scope: "one_organization",
    },
    policy_version: "2026-08-11",
    retention: [
      {
        category: "request evidence",
        policy:
          "Keep identity-verification, scope, completion, and denial receipts without raw tokens or exported payloads; remove temporary export packages within 30 days after closure.",
      },
      {
        category: "operational telemetry",
        policy:
          "Operational events are metadata-only and expire after 30 days under the existing retention job.",
      },
      {
        category: "audit and delivery safety",
        policy:
          "Retain only pseudonymous audit, suppression, and delivery facts needed for security, abuse prevention, and proof of prior actions; never retain magic links, session tokens, message bodies, or private URLs in those records.",
      },
      {
        category: "event business records",
        policy:
          "Where an organizer must retain event decisions or financial/legal evidence, replace direct identifiers with a deletion marker and document the reason and review date in the request receipt.",
      },
    ],
  });

interface AccountRow {
  created_at: string;
  disabled_at: string | null;
  display_name: string | null;
  id: string;
  status: "active" | "disabled";
  updated_at: string;
}

interface OrganizationMembershipRow {
  created_at: string;
  revoked_at: string | null;
  role: "owner" | "organizer" | "viewer";
  updated_at: string;
}

interface EventMembershipRow {
  event_id: string;
  revoked_at: string | null;
  role: "organizer" | "reviewer" | "viewer";
}

interface ContactRow {
  bio: string | null;
  company: string | null;
  display_name: string;
  first_name: string | null;
  headshot_alt_text: string | null;
  id: string;
  last_name: string | null;
  profile_publication_state: "approved" | "draft" | "published";
  pronouns: string | null;
  social_json: string;
  title: string | null;
}

interface EventParticipationRow {
  event_id: string;
  invitation_at: string | null;
  last_active_at: string | null;
  portal_state: "active" | "invited" | "not_invited" | "revoked";
  roles_json: string;
}

interface SubmissionRow {
  event_id: string;
  friendly_id: string;
  id: string;
  relationship: "participant" | "submitter";
  status: string;
  submitted_at: string | null;
  title: string;
  updated_at: string;
}

interface SubmissionAnswerRow {
  answer_type: string;
  field_label_snapshot: string;
  field_stable_key: string;
  submission_id: string;
  value_json: string;
}

interface ReviewRow {
  conflict: number;
  conflict_note: string | null;
  event_id: string;
  id: string;
  reviewer_note: string | null;
  status: string;
  submission_id: string;
  submitted_at: string | null;
  updated_at: string;
}

interface ReviewScoreRow {
  comment: string | null;
  criterion_id: string;
  numeric_score: number | null;
  review_id: string;
}

interface SessionParticipationRow {
  confirmed_state: string;
  event_id: string;
  friendly_id: string;
  role: string;
  session_id: string;
  status: string;
  title: string;
}

interface TaskAssignmentRow {
  completed_at: string | null;
  due_at: string | null;
  event_id: string;
  file_object_ids_json: string;
  id: string;
  required: number;
  response_json: string;
  status: string;
  task_name: string;
  task_type: string;
  updated_at: string;
}

interface FileRow {
  byte_size: number;
  created_at: string;
  declared_mime_type: string;
  detected_mime_type: string | null;
  display_filename: string;
  finalized_at: string | null;
  id: string;
  purpose: string;
  status: string;
}

interface MessageRow {
  campaign_id: string;
  delivered_at: string | null;
  event_id: string;
  id: string;
  queued_at: string | null;
  sent_at: string | null;
  status: string;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new PrivacyProjectionUnavailableError();
  }
}

async function boundedRows<Row>(
  statement: D1PreparedStatement,
): Promise<Row[]> {
  const result = await statement.all<Row>();
  if (result.results.length > maximumRowsPerFamily) {
    throw new PrivacyExportTooLargeError();
  }
  return result.results;
}

const contactScope = `contact.organization_id = ?1
  AND contact.email_normalized = ?2 COLLATE NOCASE`;

export class PrivacyExportService {
  readonly #database: D1Database;
  readonly #now: () => Date;

  constructor(options: { database: D1Database; now?: () => Date }) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
  }

  async exportByEmail(
    organizationId: string,
    inputEmail: string,
  ): Promise<{ body: string; data: PrivacyExportResponse }> {
    const email = inputEmail.trim().toLocaleLowerCase("en-US");
    try {
      const [
        accounts,
        organizationMemberships,
        eventMemberships,
        contacts,
        eventParticipation,
        submissions,
        submissionAnswers,
        reviews,
        reviewScores,
        sessionParticipation,
        taskAssignments,
        files,
        messages,
      ] = await Promise.all([
        boundedRows<AccountRow>(
          this.#database
            .prepare(
              `SELECT user.id, user.display_name, user.status, user.created_at,
                      user.updated_at, user.disabled_at
               FROM users user
               WHERE user.email_normalized = ?2 COLLATE NOCASE
                 AND EXISTS (
                   SELECT 1 FROM organization_memberships membership
                   WHERE membership.organization_id = ?1
                     AND membership.user_id = user.id
                 )
               ORDER BY user.id
               LIMIT ${maximumRowsPerFamily + 1}`,
            )
            .bind(organizationId, email),
        ),
        boundedRows<OrganizationMembershipRow>(
          this.#database
            .prepare(
              `SELECT membership.role, membership.created_at,
                      membership.updated_at, membership.revoked_at
               FROM organization_memberships membership
               JOIN users user ON user.id = membership.user_id
               WHERE membership.organization_id = ?1
                 AND user.email_normalized = ?2 COLLATE NOCASE
               ORDER BY membership.id
               LIMIT ${maximumRowsPerFamily + 1}`,
            )
            .bind(organizationId, email),
        ),
        boundedRows<EventMembershipRow>(
          this.#database
            .prepare(
              `SELECT membership.event_id, membership.role,
                      membership.revoked_at
               FROM event_memberships membership
               JOIN users user ON user.id = membership.user_id
               WHERE membership.organization_id = ?1
                 AND user.email_normalized = ?2 COLLATE NOCASE
               ORDER BY membership.event_id, membership.role
               LIMIT ${maximumRowsPerFamily + 1}`,
            )
            .bind(organizationId, email),
        ),
        boundedRows<ContactRow>(
          this.#database
            .prepare(
              `SELECT contact.id, contact.display_name, contact.first_name,
                      contact.last_name, contact.pronouns, contact.title,
                      contact.company, contact.bio, contact.headshot_alt_text,
                      contact.social_json, contact.profile_publication_state
               FROM p_contacts contact
               WHERE ${contactScope}
               ORDER BY contact.id
               LIMIT ${maximumRowsPerFamily + 1}`,
            )
            .bind(organizationId, email),
        ),
        boundedRows<EventParticipationRow>(
          this.#database
            .prepare(
              `SELECT event_contact.event_id, event_contact.roles_json,
                      event_contact.portal_state, event_contact.invitation_at,
                      event_contact.last_active_at
               FROM p_event_contacts event_contact
               JOIN p_contacts contact
                 ON contact.organization_id = event_contact.organization_id
                AND contact.id = event_contact.contact_id
               WHERE ${contactScope}
               ORDER BY event_contact.event_id, event_contact.id
               LIMIT ${maximumRowsPerFamily + 1}`,
            )
            .bind(organizationId, email),
        ),
        boundedRows<SubmissionRow>(
          this.#database
            .prepare(
              `SELECT submission.id, submission.event_id,
                      submission.friendly_id, submission.title,
                      submission.status, submission.submitted_at,
                      submission.updated_at,
                      CASE WHEN submitter.email_normalized = ?2 COLLATE NOCASE
                           THEN 'submitter' ELSE 'participant' END AS relationship
               FROM p_submissions submission
               JOIN p_contacts submitter
                 ON submitter.organization_id = submission.organization_id
                AND submitter.id = submission.submitter_contact_id
               WHERE submission.organization_id = ?1
                 AND (
                   submitter.email_normalized = ?2 COLLATE NOCASE
                   OR EXISTS (
                     SELECT 1
                     FROM p_submission_participants participant
                     JOIN p_contacts contact
                       ON contact.organization_id = participant.organization_id
                      AND contact.id = participant.contact_id
                     WHERE participant.organization_id = submission.organization_id
                       AND participant.event_id = submission.event_id
                       AND participant.submission_id = submission.id
                       AND contact.email_normalized = ?2 COLLATE NOCASE
                   )
                 )
               ORDER BY submission.event_id, submission.id
               LIMIT ${maximumRowsPerFamily + 1}`,
            )
            .bind(organizationId, email),
        ),
        boundedRows<SubmissionAnswerRow>(
          this.#database
            .prepare(
              `SELECT answer.submission_id, answer.field_stable_key,
                      answer.field_label_snapshot, answer.answer_type,
                      answer.value_json
               FROM p_submission_answers answer
               JOIN p_submissions submission
                 ON submission.organization_id = answer.organization_id
                AND submission.event_id = answer.event_id
                AND submission.id = answer.submission_id
               JOIN p_contacts submitter
                 ON submitter.organization_id = submission.organization_id
                AND submitter.id = submission.submitter_contact_id
               WHERE answer.organization_id = ?1
                 AND submitter.email_normalized = ?2 COLLATE NOCASE
               ORDER BY answer.submission_id, answer.sort_order, answer.id
               LIMIT ${maximumRowsPerFamily + 1}`,
            )
            .bind(organizationId, email),
        ),
        boundedRows<ReviewRow>(
          this.#database
            .prepare(
              `SELECT review.id, review.event_id, review.submission_id,
                      review.status, review.conflict, review.conflict_note,
                      review.reviewer_note, review.submitted_at, review.updated_at
               FROM p_reviews review
               JOIN p_event_contacts event_contact
                 ON event_contact.organization_id = review.organization_id
                AND event_contact.event_id = review.event_id
                AND event_contact.id = review.reviewer_id
               JOIN p_contacts contact
                 ON contact.organization_id = event_contact.organization_id
                AND contact.id = event_contact.contact_id
               WHERE ${contactScope}
               ORDER BY review.event_id, review.id
               LIMIT ${maximumRowsPerFamily + 1}`,
            )
            .bind(organizationId, email),
        ),
        boundedRows<ReviewScoreRow>(
          this.#database
            .prepare(
              `SELECT score.review_id, score.criterion_id,
                      score.numeric_score, score.comment
               FROM p_review_scores score
               JOIN p_reviews review
                 ON review.organization_id = score.organization_id
                AND review.event_id = score.event_id
                AND review.id = score.review_id
               JOIN p_event_contacts event_contact
                 ON event_contact.organization_id = review.organization_id
                AND event_contact.event_id = review.event_id
                AND event_contact.id = review.reviewer_id
               JOIN p_contacts contact
                 ON contact.organization_id = event_contact.organization_id
                AND contact.id = event_contact.contact_id
               WHERE ${contactScope}
               ORDER BY score.review_id, score.criterion_id
               LIMIT ${maximumRowsPerFamily + 1}`,
            )
            .bind(organizationId, email),
        ),
        boundedRows<SessionParticipationRow>(
          this.#database
            .prepare(
              `SELECT participant.event_id, participant.session_id,
                      participant.role, participant.confirmed_state,
                      session.friendly_id, session.title, session.status
               FROM p_session_participants participant
               JOIN p_contacts contact
                 ON contact.organization_id = participant.organization_id
                AND contact.id = participant.contact_id
               JOIN p_sessions session
                 ON session.organization_id = participant.organization_id
                AND session.event_id = participant.event_id
                AND session.id = participant.session_id
               WHERE ${contactScope}
               ORDER BY participant.event_id, participant.session_id,
                        participant.role
               LIMIT ${maximumRowsPerFamily + 1}`,
            )
            .bind(organizationId, email),
        ),
        boundedRows<TaskAssignmentRow>(
          this.#database
            .prepare(
              `SELECT assignment.id, assignment.event_id, definition.name AS task_name,
                      definition.type AS task_type, assignment.due_at,
                      assignment.required, assignment.status,
                      assignment.completed_at, assignment.response_json,
                      assignment.file_object_ids_json, assignment.updated_at
               FROM p_task_assignments assignment
               JOIN p_contacts contact
                 ON contact.organization_id = assignment.organization_id
                AND contact.id = assignment.contact_id
               JOIN p_task_definitions definition
                 ON definition.organization_id = assignment.organization_id
                AND definition.event_id = assignment.event_id
                AND definition.id = assignment.definition_id
               WHERE ${contactScope}
               ORDER BY assignment.event_id, assignment.id
               LIMIT ${maximumRowsPerFamily + 1}`,
            )
            .bind(organizationId, email),
        ),
        boundedRows<FileRow>(
          this.#database
            .prepare(
              `SELECT file.id, file.display_filename, file.declared_mime_type,
                      file.detected_mime_type, file.byte_size, file.status,
                      file.purpose, file.created_at, file.finalized_at
               FROM file_objects file
               JOIN p_contacts contact
                 ON contact.organization_id = file.organization_id
                AND contact.id = file.owner_contact_id
               WHERE ${contactScope}
               ORDER BY file.created_at, file.id
               LIMIT ${maximumRowsPerFamily + 1}`,
            )
            .bind(organizationId, email),
        ),
        boundedRows<MessageRow>(
          this.#database
            .prepare(
              `SELECT message.id, message.event_id, message.campaign_id,
                      message.status, message.queued_at, message.sent_at,
                      message.delivered_at
               FROM p_messages message
               JOIN p_contacts contact
                 ON contact.organization_id = message.organization_id
                AND contact.id = message.contact_id
               WHERE ${contactScope}
               ORDER BY message.event_id, message.id
               LIMIT ${maximumRowsPerFamily + 1}`,
            )
            .bind(organizationId, email),
        ),
      ]);

      if (accounts.length > 1 || organizationMemberships.length > 1) {
        throw new PrivacyProjectionUnavailableError();
      }

      const answersBySubmission = new Map<
        string,
        {
          field_label: string;
          field_stable_key: string;
          type: string;
          value: unknown;
        }[]
      >();
      for (const answer of submissionAnswers) {
        const exported = {
          field_label: answer.field_label_snapshot,
          field_stable_key: answer.field_stable_key,
          type: answer.answer_type,
          value: parseJson(answer.value_json),
        };
        const existing = answersBySubmission.get(answer.submission_id);
        if (existing) existing.push(exported);
        else answersBySubmission.set(answer.submission_id, [exported]);
      }

      const scoresByReview = new Map<
        string,
        {
          comment: string | null;
          criterion_id: string;
          numeric_score: number | null;
        }[]
      >();
      for (const score of reviewScores) {
        const exported = {
          comment: score.comment,
          criterion_id: score.criterion_id,
          numeric_score: score.numeric_score,
        };
        const existing = scoresByReview.get(score.review_id);
        if (existing) existing.push(exported);
        else scoresByReview.set(score.review_id, [exported]);
      }

      const data = privacyExportResponseSchema.parse({
        account: accounts[0] ?? null,
        contacts: contacts.map(({ social_json: socialJson, ...contact }) => ({
          ...contact,
          social: parseJson(socialJson),
        })),
        email,
        event_memberships: eventMemberships,
        event_participation: eventParticipation.map(
          ({ roles_json: rolesJson, ...participation }) => ({
            ...participation,
            roles: parseJson(rolesJson),
          }),
        ),
        exclusions: [
          "Magic links, session and CSRF tokens, API keys, browser bindings, internal hashes, provider identifiers, storage object keys, private URLs, and source record IDs are never included.",
          "Third-party participant and contact profiles are excluded; relationship rows include only the subject's role and the related resource identifiers.",
          "Private file bytes and provider-held message bodies require the coordinated operator runbook; this bounded JSON export includes safe file and delivery metadata only.",
          "Pseudonymous audit, abuse, suppression, delivery-attempt, projection-repair, and operational telemetry records are excluded from user content and handled by the published retention policy.",
        ],
        files,
        generated_at: this.#now().toISOString(),
        messages,
        organization_id: organizationId,
        organization_membership: organizationMemberships[0] ?? null,
        reviews: reviews.map((review) => ({
          ...review,
          conflict: review.conflict === 1,
          scores: scoresByReview.get(review.id) ?? [],
        })),
        schema_version: 1,
        session_participation: sessionParticipation,
        subject_found:
          accounts.length > 0 ||
          organizationMemberships.length > 0 ||
          contacts.length > 0,
        submissions: submissions.map((submission) => ({
          ...submission,
          answers: answersBySubmission.get(submission.id) ?? [],
        })),
        task_assignments: taskAssignments.map(
          ({
            file_object_ids_json: fileIdsJson,
            required,
            response_json: responseJson,
            ...assignment
          }) => ({
            ...assignment,
            file_ids: parseJson(fileIdsJson),
            required: required === 1,
            response: parseJson(responseJson),
          }),
        ),
      });
      const body = JSON.stringify(data);
      if (
        new TextEncoder().encode(body).byteLength > maximumPrivacyExportBytes
      ) {
        throw new PrivacyExportTooLargeError();
      }
      return { body, data };
    } catch (error) {
      if (
        error instanceof PrivacyExportTooLargeError ||
        error instanceof PrivacyProjectionUnavailableError
      ) {
        throw error;
      }
      throw new PrivacyProjectionUnavailableError();
    }
  }
}
