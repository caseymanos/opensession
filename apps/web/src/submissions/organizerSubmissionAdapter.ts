import type {
  OrganizerSubmissionCommandResult,
  OrganizerSubmissionDetail,
  OrganizerSubmissionListRow,
  OrganizerSubmissionStatus,
} from "@sessionbox-killer/contracts";

import type {
  SubmissionHistoryView,
  SubmissionStatus,
  SubmissionView,
} from "./submissionModel";

const dateTime = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

export function organizerStatusToView(
  status: OrganizerSubmissionStatus,
): SubmissionStatus {
  return status === "in_review" ? "under_review" : status;
}

export function viewStatusToOrganizer(
  status: SubmissionStatus,
): OrganizerSubmissionStatus {
  return status === "under_review" ? "in_review" : status;
}

function instant(value: string): string {
  return dateTime.format(new Date(value));
}

function answerValue(value: string | boolean | string[] | null): string {
  if (value === null) return "Private answer redacted";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

function rowView(row: OrganizerSubmissionListRow): SubmissionView {
  return {
    ...(row.reviews.aggregateScore === null
      ? {}
      : { aggregateScore: row.reviews.aggregateScore }),
    answers: [],
    format: "",
    formVersion: "Submitted snapshot",
    history: [],
    id: row.id,
    lastActivity: instant(row.lastActivityAt),
    notes: [],
    participants: [],
    reference: row.reference,
    reviewCount: row.reviews.submitted,
    reviewersAssigned: row.reviews.assigned,
    reviews: [],
    routing: [row.routing.routeKey, row.routing.reviewerGroupId].filter(
      (value): value is string => Boolean(value),
    ),
    status: organizerStatusToView(row.status),
    submitter: row.submitter.displayName,
    title: row.title,
    track: row.track?.name ?? "Unassigned",
    trackId: row.track?.id ?? null,
    version: row.version,
  };
}

function historyTitle(entry: OrganizerSubmissionDetail["history"][number]) {
  if (entry.action === "add_note") return "Internal note added";
  if (entry.action === "start_review") return "Moved to review";
  if (entry.action === "withdraw") return "Withdrawn by organizer";
  return "Submission reopened";
}

function historyDetail(
  entry: OrganizerSubmissionDetail["history"][number],
): string {
  if (entry.reason) return entry.reason;
  if (entry.fromStatus && entry.toStatus) {
    return `${organizerStatusToView(entry.fromStatus)} → ${organizerStatusToView(entry.toStatus)}`;
  }
  return "Organizer activity recorded.";
}

export function organizerSubmissionListRowView(
  row: OrganizerSubmissionListRow,
): SubmissionView {
  return rowView(row);
}

export function organizerSubmissionDetailView(
  detail: OrganizerSubmissionDetail,
): SubmissionView {
  return {
    ...rowView(detail.submission),
    answers: [...detail.answerSnapshot.answers]
      .sort((left, right) => left.order - right.order)
      .map((answer) => ({
        label: answer.label,
        value: answerValue(answer.value),
      })),
    formVersion: `CFP form v${detail.answerSnapshot.formVersion} · ${detail.answerSnapshot.state} snapshot`,
    history: detail.history.map<SubmissionHistoryView>((entry) => ({
      actor: entry.actor.displayName,
      detail: historyDetail(entry),
      id: entry.id,
      time: instant(entry.createdAt),
      title: historyTitle(entry),
    })),
    notes: detail.notes.map((note) => ({
      actor: note.actor.displayName,
      id: note.id,
      text: note.body,
      time: instant(note.createdAt),
    })),
    participants: [...detail.participants]
      .sort((left, right) => left.order - right.order)
      .map((participant) => ({
        company: participant.contact.company ?? "Independent",
        name: participant.contact.displayName,
        role: participant.role,
      })),
    reviews: detail.reviews.map((review) => ({
      ...(review.score === null ? {} : { score: review.score }),
      reviewer: review.reviewer.displayName,
      status: review.conflict
        ? ("conflict" as const)
        : review.status === "submitted"
          ? ("submitted" as const)
          : ("assigned" as const),
      summary:
        review.summary ??
        (review.conflict
          ? "Reviewer disclosed a conflict."
          : "No review summary submitted yet."),
    })),
    ...(detail.submittedAt === null
      ? {}
      : { submittedAt: instant(detail.submittedAt) }),
  };
}

export function applyOrganizerSubmissionResult(
  current: SubmissionView,
  result: OrganizerSubmissionCommandResult,
): SubmissionView {
  const next = {
    ...current,
    lastActivity: instant(result.appliedAt),
    status: organizerStatusToView(result.status),
    version: result.version,
  };
  if (!result.note || current.notes.some(({ id }) => id === result.note?.id)) {
    return next;
  }
  return {
    ...next,
    notes: [
      ...current.notes,
      {
        actor: result.note.actor.displayName,
        id: result.note.id,
        text: result.note.body,
        time: instant(result.note.createdAt),
      },
    ],
  };
}
