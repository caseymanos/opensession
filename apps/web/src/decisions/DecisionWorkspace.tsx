import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  Eye,
  FileCheck2,
  History,
  Mail,
  Minus,
  Scale,
  ShieldCheck,
  UserRoundCheck,
} from "lucide-react";

import {
  Button,
  Dialog,
  Drawer,
  LiveRegion,
  SelectField,
  StatePanel,
  StatusPill,
  TextAreaField,
  TextField,
  ToastRegion,
  type ToastMessage,
} from "@sessionbox-killer/ui";
import {
  recordDecisionCommandSchema,
  type DecisionWorkspaceResponse,
  type RecordDecisionCommand,
} from "@sessionbox-killer/contracts";

import {
  decisionSubmissionsFixture,
  reviewSummary,
  type DecisionHistoryView,
  type DecisionState,
  type DecisionSubmissionView,
  type RawReviewView,
} from "./decisionModel";
import {
  createDecisionPort,
  DecisionApiError,
  type DecisionPort,
} from "./decisionClient";

import "./decision-workspace.css";

type DecisionAction = Exclude<DecisionState, "undecided">;
type MessageMode = "recorded_only" | "send_queued";

const decisionLabels: Record<DecisionState, string> = {
  accepted: "Accepted",
  declined: "Declined",
  undecided: "Undecided",
  waitlisted: "Waitlisted",
};

const actionLabels: Record<DecisionAction, string> = {
  accepted: "Accept",
  declined: "Decline",
  waitlisted: "Waitlist",
};

function pendingCommandStorageKey(eventKey: string) {
  return `opensession.decisions.pending.${eventKey}`;
}

function readPendingCommand(eventKey: string | undefined) {
  if (!eventKey || typeof window === "undefined") return null;
  const key = pendingCommandStorageKey(eventKey);
  try {
    const value = window.localStorage.getItem(key);
    if (!value) return null;
    const parsed = recordDecisionCommandSchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
    window.localStorage.removeItem(key);
  } catch {
    try {
      window.localStorage.removeItem(key);
    } catch {
      return null;
    }
  }
  return null;
}

function writePendingCommand(
  eventKey: string | undefined,
  command: RecordDecisionCommand | null,
) {
  if (!eventKey || typeof window === "undefined") return;
  try {
    const key = pendingCommandStorageKey(eventKey);
    if (command) window.localStorage.setItem(key, JSON.stringify(command));
    else window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

const reasonOptions: Record<
  DecisionAction,
  { label: string; value: string }[]
> = {
  accepted: [
    { label: "Select a reason", value: "" },
    { label: "Strong program fit", value: "Strong program fit" },
    {
      label: "Highest evidence-backed score",
      value: "Highest evidence-backed score",
    },
    { label: "Balances the program", value: "Balances the program" },
  ],
  declined: [
    { label: "Select a reason", value: "" },
    { label: "Limited program capacity", value: "Limited program capacity" },
    { label: "Topic overlap", value: "Topic overlap" },
    {
      label: "Insufficient specificity",
      value: "Insufficient specificity",
    },
  ],
  waitlisted: [
    { label: "Select a reason", value: "" },
    { label: "Capacity unresolved", value: "Capacity unresolved" },
    { label: "Format fit unresolved", value: "Format fit unresolved" },
    { label: "Hold for program balance", value: "Hold for program balance" },
  ],
};

function decisionTone(state: DecisionState) {
  if (state === "accepted") return "success" as const;
  if (state === "declined") return "warning" as const;
  if (state === "waitlisted") return "warning" as const;
  return "neutral" as const;
}

function reviewTone(status: RawReviewView["status"]) {
  if (status === "submitted") return "success" as const;
  if (status === "conflict") return "warning" as const;
  return "neutral" as const;
}

function formatScore(score: number | undefined) {
  return score === undefined ? "—" : score.toFixed(2);
}

function DecisionHeader() {
  return (
    <header className="decision-header">
      <div>
        <p className="overline">Decide · Program decisions</p>
        <h1>Make the call. Keep the evidence.</h1>
        <p>
          See exactly which reviews contribute, record one legal decision, and
          preview every downstream consequence before anything is sent.
        </p>
      </div>
      <div className="decision-header-proof">
        <StatusPill tone="success">Immutable rubric snapshots</StatusPill>
        <span>
          <ShieldCheck aria-hidden="true" size={15} /> Missing scores are never
          zero-filled
        </span>
      </div>
    </header>
  );
}

function DecisionMetrics({
  submissions,
}: {
  submissions: DecisionSubmissionView[];
}) {
  const ready = submissions.filter(
    (submission) =>
      submission.decision === "undecided" &&
      reviewSummary(submission).submittedCount > 0,
  ).length;
  const waiting = submissions.filter(
    (submission) => reviewSummary(submission).missingCount > 0,
  ).length;

  return (
    <section aria-label="Decision summary" className="decision-metrics">
      <article>
        <small>Ready to decide</small>
        <strong>{ready}</strong>
        <span>At least one submitted review</span>
      </article>
      <article>
        <small>Missing reviews</small>
        <strong>{waiting}</strong>
        <span>Excluded, never scored as zero</span>
      </article>
      <article>
        <small>Accepted</small>
        <strong>
          {submissions.filter((item) => item.decision === "accepted").length}
        </strong>
        <span>Recorded status histories</span>
      </article>
      <article>
        <small>Waitlisted</small>
        <strong>
          {submissions.filter((item) => item.decision === "waitlisted").length}
        </strong>
        <span>Held without duplicate messages</span>
      </article>
    </section>
  );
}

function AggregateCell({ submission }: { submission: DecisionSubmissionView }) {
  const summary = reviewSummary(submission);

  return (
    <div className="decision-aggregate-cell">
      <strong>{formatScore(submission.aggregateScore)}</strong>
      {summary.submittedCount ? (
        <span>
          Range {formatScore(summary.min)}–{formatScore(summary.max)}
        </span>
      ) : (
        <span>No submitted score</span>
      )}
    </div>
  );
}

function ReviewProgress({
  submission,
}: {
  submission: DecisionSubmissionView;
}) {
  const summary = reviewSummary(submission);

  return (
    <div className="decision-review-progress">
      <strong>
        {summary.submittedCount} of {summary.applicableCount} applicable
      </strong>
      <div aria-hidden="true">
        {Array.from({ length: summary.applicableCount }, (_, index) => (
          <span
            className={index < summary.submittedCount ? "is-complete" : ""}
            key={index}
          />
        ))}
      </div>
      <small>
        {summary.missingCount
          ? `${summary.missingCount} missing · excluded`
          : "All applicable reviews submitted"}
        {summary.conflictCount
          ? ` · ${summary.conflictCount} conflict removed`
          : ""}
      </small>
    </div>
  );
}

function DecisionTable({
  onDecide,
  onInspect,
  submissions,
}: {
  onDecide: (
    submission: DecisionSubmissionView,
    action: DecisionAction,
  ) => void;
  onInspect: (submission: DecisionSubmissionView) => void;
  submissions: DecisionSubmissionView[];
}) {
  return (
    <>
      <p className="decision-table-cue">
        Scroll the table to compare aggregate, progress, and status.
      </p>
      <div
        aria-label="Decision candidates; scroll horizontally for more details"
        className="decision-table-wrap"
        role="region"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Proposal</th>
              <th>Aggregate</th>
              <th>Review progress</th>
              <th>Decision</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((submission) => {
              const canDecide =
                submission.decision === "undecided" &&
                reviewSummary(submission).submittedCount > 0;
              return (
                <tr key={submission.id}>
                  <td>
                    <button
                      className="decision-proposal-link"
                      onClick={() => onInspect(submission)}
                      type="button"
                    >
                      <strong>{submission.title}</strong>
                      <span>
                        {submission.id} · {submission.track} ·{" "}
                        {submission.format}
                      </span>
                    </button>
                  </td>
                  <td>
                    <AggregateCell submission={submission} />
                  </td>
                  <td>
                    <ReviewProgress submission={submission} />
                  </td>
                  <td>
                    <StatusPill tone={decisionTone(submission.decision)}>
                      {decisionLabels[submission.decision]}
                    </StatusPill>
                  </td>
                  <td>
                    <div className="decision-row-actions">
                      <button
                        aria-label={`Inspect review evidence for ${submission.id}`}
                        onClick={() => onInspect(submission)}
                        type="button"
                      >
                        <Eye aria-hidden="true" size={15} />
                      </button>
                      {canDecide ? (
                        <button
                          aria-label={`Accept ${submission.id}`}
                          className="is-primary"
                          onClick={() => onDecide(submission, "accepted")}
                          type="button"
                        >
                          <Check aria-hidden="true" size={15} />
                        </button>
                      ) : null}
                      {submission.decision !== "undecided" ? (
                        <button
                          aria-label={`View decision history for ${submission.id}`}
                          onClick={() => onInspect(submission)}
                          type="button"
                        >
                          <History aria-hidden="true" size={15} />
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ScoreBreakdown({ review }: { review: RawReviewView }) {
  if (review.status !== "submitted" || review.overallScore === undefined) {
    return null;
  }

  return (
    <article className="decision-raw-review">
      <header>
        <div>
          <strong>{review.reviewer}</strong>
          <span>{review.submittedAt}</span>
        </div>
        <strong>{review.overallScore.toFixed(2)}</strong>
      </header>
      {review.criteria.length ? (
        <div className="decision-score-formula">
          {review.criteria.map((criterion) => (
            <span key={criterion.criterion}>
              <b>{criterion.score}</b>
              <small>
                {criterion.criterion} · {criterion.weight}%
              </small>
            </span>
          ))}
        </div>
      ) : null}
      {review.note ? <p>{review.note}</p> : null}
    </article>
  );
}

function EvidenceDrawer({
  onClose,
  onRetry,
  submission,
}: {
  onClose: () => void;
  onRetry: (submission: DecisionSubmissionView) => void;
  submission: DecisionSubmissionView | null;
}) {
  const summary = submission ? reviewSummary(submission) : null;
  const history = submission?.history.at(-1);

  return (
    <Drawer
      description={
        submission
          ? `${submission.id} · ${submission.track}`
          : "Review evidence and decision history"
      }
      onClose={onClose}
      open={Boolean(submission)}
      title="Evidence and decision history"
    >
      {submission && summary ? (
        <div className="decision-evidence">
          <div className="decision-evidence-heading">
            <p className="overline">Transparent aggregate</p>
            <h3>{submission.title}</h3>
            <div>
              <strong>{formatScore(submission.aggregateScore)}</strong>
              <span>
                {summary.submittedCount} submitted / {summary.applicableCount}{" "}
                applicable
              </span>
            </div>
          </div>

          <div className="decision-math-note">
            <Scale aria-hidden="true" size={18} />
            <p>
              <strong>Weighted mean of submitted, applicable reviews.</strong>
              Missing reviews and conflicts are excluded; neither becomes a
              zero.
            </p>
          </div>

          {submission.aggregateScore !== undefined ? (
            <div className="decision-equation" aria-label="Aggregate equation">
              <span>
                (
                {submission.reviews
                  .filter((review) => review.status === "submitted")
                  .map((review) => review.overallScore?.toFixed(2))
                  .join(" + ")}
                ) ÷ {summary.submittedCount}
              </span>
              <ArrowRight aria-hidden="true" size={16} />
              <strong>{submission.aggregateScore.toFixed(2)}</strong>
            </div>
          ) : (
            <div className="decision-no-score">
              <Clock3 aria-hidden="true" size={17} />
              No aggregate until an applicable review is submitted.
            </div>
          )}

          <section aria-labelledby="raw-reviews-title">
            <div className="decision-section-title">
              <h4 id="raw-reviews-title">Raw review detail</h4>
              <span>
                Range {formatScore(summary.min)}–{formatScore(summary.max)}
              </span>
            </div>
            <div className="decision-raw-list">
              {submission.reviews.map((review) =>
                review.status === "submitted" ? (
                  <ScoreBreakdown key={review.reviewer} review={review} />
                ) : (
                  <article
                    className={`decision-review-exception is-${review.status}`}
                    key={review.reviewer}
                  >
                    {review.status === "conflict" ? (
                      <CircleAlert aria-hidden="true" size={17} />
                    ) : (
                      <Clock3 aria-hidden="true" size={17} />
                    )}
                    <div>
                      <strong>{review.reviewer}</strong>
                      <p>
                        {review.status === "conflict"
                          ? `Conflict removed · ${review.conflictReason}`
                          : "Review missing · excluded from aggregate"}
                      </p>
                    </div>
                    <StatusPill tone={reviewTone(review.status)}>
                      {review.status}
                    </StatusPill>
                  </article>
                ),
              )}
            </div>
          </section>

          <section aria-labelledby="decision-history-title">
            <div className="decision-section-title">
              <h4 id="decision-history-title">Decision history</h4>
              <StatusPill tone={decisionTone(submission.decision)}>
                {decisionLabels[submission.decision]}
              </StatusPill>
            </div>
            {history ? (
              <article className="decision-history-card">
                <header>
                  <strong>{decisionLabels[history.action]}</strong>
                  <span>
                    {history.actor} · {history.time}
                  </span>
                </header>
                <dl>
                  <div>
                    <dt>Reason</dt>
                    <dd>{history.reason}</dd>
                  </div>
                  <div>
                    <dt>Audience</dt>
                    <dd>{history.audience}</dd>
                  </div>
                  <div>
                    <dt>Message</dt>
                    <dd>
                      {history.messageMode === "send_queued"
                        ? history.template
                        : "Recorded without sending"}
                    </dd>
                  </div>
                  {history.privateNote ? (
                    <div>
                      <dt>Private note</dt>
                      <dd>{history.privateNote}</dd>
                    </div>
                  ) : null}
                </dl>
                {submission.sideEffects ? (
                  <div className="decision-side-effects">
                    <div>
                      <strong>Downstream effects</strong>
                      <span>
                        {submission.decision === "accepted"
                          ? "Session, portal, tasks, message, and calendar intent"
                          : "Decision settled without creating onboarding"}
                      </span>
                    </div>
                    <StatusPill
                      tone={
                        submission.sideEffects.status === "complete"
                          ? "success"
                          : submission.sideEffects.status === "failed"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {submission.sideEffects.status}
                    </StatusPill>
                    {submission.sideEffects.errorCode ? (
                      <small>{submission.sideEffects.errorCode}</small>
                    ) : null}
                  </div>
                ) : null}
                <button
                  className="decision-safe-retry"
                  onClick={() => onRetry(submission)}
                  type="button"
                >
                  <ShieldCheck aria-hidden="true" size={15} /> Retry same
                  command safely
                </button>
              </article>
            ) : (
              <div className="decision-empty-history">
                <FileCheck2 aria-hidden="true" size={21} />
                <strong>No decision recorded</strong>
                <p>
                  Choosing an action creates the first immutable history entry.
                </p>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}

function DecisionDialog({
  action,
  actorName,
  audienceOverride,
  eventName,
  frozen,
  messageMode,
  note,
  onActionChange,
  onClose,
  onConfirm,
  onMessageModeChange,
  onNoteChange,
  onReasonChange,
  open,
  reason,
  submission,
  templateOverride,
}: {
  action: DecisionAction;
  actorName: string;
  audienceOverride?: string;
  eventName: string;
  frozen: boolean;
  messageMode: MessageMode;
  note: string;
  onActionChange: (action: DecisionAction) => void;
  onClose: () => void;
  onConfirm: () => void;
  onMessageModeChange: (mode: MessageMode) => void;
  onNoteChange: (note: string) => void;
  onReasonChange: (reason: string) => void;
  open: boolean;
  reason: string;
  submission: DecisionSubmissionView | null;
  templateOverride?: string;
}) {
  const audience =
    audienceOverride ??
    (submission
      ? `Primary speaker${submission.speakerCount > 1 ? ` + ${submission.speakerCount - 1} co-speaker` : ""}`
      : "Selected proposal speakers");
  const template = templateOverride ?? `${actionLabels[action]} · ${eventName}`;

  return (
    <Dialog
      description={
        submission
          ? `${submission.id} · ${submission.title}`
          : "Preview and record a program decision"
      }
      onClose={onClose}
      open={open}
      title={`${actionLabels[action]} this proposal?`}
    >
      <div className="decision-dialog-content">
        <div
          className="decision-action-picker"
          role="group"
          aria-label="Decision"
        >
          {(["accepted", "waitlisted", "declined"] as DecisionAction[]).map(
            (item) => (
              <button
                aria-pressed={action === item}
                className={action === item ? "is-active" : ""}
                disabled={frozen}
                key={item}
                onClick={() => {
                  onActionChange(item);
                  onReasonChange("");
                }}
                type="button"
              >
                {actionLabels[item]}
              </button>
            ),
          )}
        </div>

        <SelectField
          disabled={frozen}
          label="Decision reason"
          onChange={(event) => onReasonChange(event.target.value)}
          options={reasonOptions[action]}
          required
          value={reason}
        />
        <TextAreaField
          disabled={frozen}
          label="Private program note"
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="Optional context for organizers…"
          rows={3}
          value={note}
        />

        <section
          aria-labelledby="consequence-title"
          className="decision-consequence"
        >
          <header>
            <div>
              <p className="overline">Consequence preview</p>
              <h3 id="consequence-title">What this command will do</h3>
            </div>
            <StatusPill tone="preview">Preview only</StatusPill>
          </header>
          <ul>
            <li>
              <FileCheck2 aria-hidden="true" size={17} />
              <span>
                <strong>Record status and one audit entry</strong>
                {actionLabels[action]} by {actorName} with reason and timestamp
              </span>
            </li>
            <li>
              <UserRoundCheck aria-hidden="true" size={17} />
              <span>
                <strong>Audience</strong>
                {audience}
              </span>
            </li>
            <li>
              <Mail aria-hidden="true" size={17} />
              <span>
                <strong>Selected template</strong>
                {template}
              </span>
            </li>
          </ul>
        </section>

        <fieldset className="decision-message-mode">
          <legend>Message handling</legend>
          <label>
            <input
              checked={messageMode === "send_queued"}
              disabled={frozen}
              name="decision-message-mode"
              onChange={() => onMessageModeChange("send_queued")}
              type="radio"
            />
            <span>
              <strong>Record and prepare message</strong>
              Preserves the selected template and audience for delivery
              orchestration.
            </span>
          </label>
          <label>
            <input
              checked={messageMode === "recorded_only"}
              disabled={frozen}
              name="decision-message-mode"
              onChange={() => onMessageModeChange("recorded_only")}
              type="radio"
            />
            <span>
              <strong>Record without sending</strong>
              Save the decision now; communicate later.
            </span>
          </label>
        </fieldset>

        <div className="decision-idempotency-note">
          <ShieldCheck aria-hidden="true" size={16} />
          Retrying this exact command reuses the same decision key and cannot
          add history or messages twice.
        </div>

        <div className="decision-dialog-actions">
          <Button disabled={frozen} variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!reason} onClick={onConfirm}>
            {frozen
              ? "Retry exact decision"
              : `Record ${actionLabels[action].toLowerCase()}`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function productionSubmissions(
  response: DecisionWorkspaceResponse,
): DecisionSubmissionView[] {
  return response.submissions.map((submission) => ({
    ...(submission.aggregateScore === null
      ? {}
      : { aggregateScore: submission.aggregateScore }),
    authorityId: submission.id,
    decision: submission.decision,
    format: submission.format ?? "Format not provided",
    history: submission.history.map((entry) => ({
      action: entry.action,
      actor: entry.actor,
      audience: entry.audience,
      messageMode: entry.messageMode,
      reason: entry.reason,
      time: new Date(entry.at).toLocaleString(),
      ...(entry.privateNote ? { privateNote: entry.privateNote } : {}),
      ...(entry.template ? { template: entry.template } : {}),
    })),
    id: submission.reference,
    reviews: submission.reviews.map((review) => ({
      criteria: review.criteria.map((criterion) => ({
        criterion: criterion.label,
        score: criterion.score,
        weight: criterion.weight,
      })),
      reviewer: review.reviewer,
      status: review.status,
      ...(review.conflictReason
        ? { conflictReason: review.conflictReason }
        : {}),
      ...(review.note ? { note: review.note } : {}),
      ...(review.overallScore === null
        ? {}
        : { overallScore: review.overallScore }),
      ...(review.submittedAt
        ? { submittedAt: new Date(review.submittedAt).toLocaleString() }
        : {}),
    })),
    ...(submission.sideEffects
      ? {
          sideEffects: {
            ...(submission.sideEffects.errorCode
              ? { errorCode: submission.sideEffects.errorCode }
              : {}),
            status: submission.sideEffects.status,
            updatedAt: new Date(
              submission.sideEffects.updatedAt,
            ).toLocaleString(),
            workflowId: submission.sideEffects.workflowId,
          },
        }
      : {}),
    sourceVersion: submission.sourceVersion,
    speakerCount: submission.speakerCount,
    title: submission.title,
    track: submission.track ?? "Unassigned",
  }));
}

function DecisionWorkspaceSurface({
  actorName = "Casey Manos",
  eventKey,
  eventName = "AI Engineer Summit",
  initialSubmissions = decisionSubmissionsFixture,
  port,
}: {
  actorName?: string;
  eventKey?: string;
  eventName?: string;
  initialSubmissions?: DecisionSubmissionView[];
  port?: DecisionPort;
}) {
  const [submissions, setSubmissions] = useState(initialSubmissions);
  const [pendingCommand, setPendingCommand] =
    useState<RecordDecisionCommand | null>(() => readPendingCommand(eventKey));
  const restoredTarget = pendingCommand
    ? initialSubmissions.find(
        (submission) =>
          (submission.authorityId ?? submission.id) ===
          pendingCommand.submissionId,
      )
    : undefined;
  const [query, setQuery] = useState("");
  const [track, setTrack] = useState("all");
  const [decision, setDecision] = useState("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [decisionTargetId, setDecisionTargetId] = useState<string | null>(
    restoredTarget?.id ?? null,
  );
  const [action, setAction] = useState<DecisionAction>(
    pendingCommand?.decision ?? "accepted",
  );
  const [reason, setReason] = useState(pendingCommand?.reason ?? "");
  const [note, setNote] = useState(pendingCommand?.privateNote ?? "");
  const [messageMode, setMessageMode] = useState<MessageMode>(
    pendingCommand?.messageMode ?? "send_queued",
  );
  const [announcement, setAnnouncement] = useState("");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [lastCommands, setLastCommands] = useState<
    Record<string, RecordDecisionCommand>
  >({});

  const visible = useMemo(
    () =>
      submissions.filter((submission) => {
        const haystack =
          `${submission.id} ${submission.title} ${submission.track} ${submission.format}`.toLowerCase();
        return (
          haystack.includes(query.toLowerCase()) &&
          (track === "all" || submission.track === track) &&
          (decision === "all" || submission.decision === decision)
        );
      }),
    [decision, query, submissions, track],
  );
  const trackOptions = useMemo(
    () => [
      { label: "All tracks", value: "all" },
      ...Array.from(new Set(submissions.map((submission) => submission.track)))
        .sort((left, right) => left.localeCompare(right))
        .map((value) => ({ label: value, value })),
    ],
    [submissions],
  );

  const detailSubmission =
    submissions.find((submission) => submission.id === detailId) ?? null;
  const decisionTarget =
    submissions.find((submission) => submission.id === decisionTargetId) ??
    null;

  function announce(title: string, message: string) {
    setAnnouncement(message);
    setToasts((current) => [
      ...current,
      { id: `${Date.now()}-${title}`, message, title, tone: "success" },
    ]);
  }

  function announceFailure(title: string, message: string) {
    setAnnouncement(message);
    setToasts((current) => [
      ...current,
      { id: `${Date.now()}-${title}`, message, title, tone: "error" },
    ]);
  }

  function openDecision(
    submission: DecisionSubmissionView,
    nextAction: DecisionAction,
  ) {
    setDecisionTargetId(submission.id);
    setAction(nextAction);
    setReason("");
    setNote("");
    setMessageMode("send_queued");
  }

  async function recordDecision() {
    if (!decisionTarget || !reason) return;
    if (port && eventKey) {
      const submissionId = decisionTarget.authorityId ?? decisionTarget.id;
      const command =
        pendingCommand?.submissionId === submissionId
          ? pendingCommand
          : {
              audience: `Primary speaker${decisionTarget.speakerCount > 1 ? ` + ${decisionTarget.speakerCount - 1} co-speaker` : ""}`,
              commandId: `decision_${crypto.randomUUID()}`,
              decision: action,
              expectedVersion: decisionTarget.sourceVersion ?? 0,
              messageMode,
              privateNote: note,
              reason,
              submissionId,
              template:
                messageMode === "send_queued"
                  ? `${actionLabels[action]} · ${eventName}`
                  : null,
              type: "record_decision" as const,
            };
      setPendingCommand(command);
      writePendingCommand(eventKey, command);
      try {
        await port.execute(eventKey, command);
        const response = await port.load(eventKey);
        setSubmissions(productionSubmissions(response));
        setLastCommands((current) => ({
          ...current,
          [decisionTarget.id]: command,
        }));
        setPendingCommand(null);
        writePendingCommand(eventKey, null);
        setDecisionTargetId(null);
        setDetailId(decisionTarget.id);
        announce(
          "Decision recorded",
          command.messageMode === "send_queued"
            ? `${actionLabels[command.decision]} recorded once; the selected message intent is preserved for its previewed audience.`
            : `${actionLabels[command.decision]} recorded once without sending a message.`,
        );
      } catch (error) {
        announceFailure(
          "Decision not confirmed",
          error instanceof DecisionApiError
            ? `${error.message} Retry to replay the exact decision command.`
            : "Retry to replay the exact decision command.",
        );
      }
      return;
    }
    if (
      decisionTarget.decision === action &&
      decisionTarget.history.some((entry) => entry.action === action)
    ) {
      setDecisionTargetId(null);
      announce(
        "Decision already recorded",
        "The safe retry reused the existing command; no history or message was duplicated.",
      );
      return;
    }

    const historyEntry: DecisionHistoryView = {
      action,
      actor: "Casey Manos",
      audience: `Primary speaker${decisionTarget.speakerCount > 1 ? ` + ${decisionTarget.speakerCount - 1} co-speaker` : ""}`,
      messageMode,
      reason,
      time: "Just now",
      ...(note ? { privateNote: note } : {}),
      ...(messageMode === "send_queued"
        ? { template: `${actionLabels[action]} · ${eventName}` }
        : {}),
    };
    const next: DecisionSubmissionView = {
      ...decisionTarget,
      decision: action,
      history: [...decisionTarget.history, historyEntry],
    };
    setSubmissions((current) =>
      current.map((submission) =>
        submission.id === next.id ? next : submission,
      ),
    );
    setDecisionTargetId(null);
    setDetailId(next.id);
    announce(
      "Decision recorded",
      messageMode === "send_queued"
        ? `${actionLabels[action]} recorded once; the selected message intent is preserved for its previewed audience.`
        : `${actionLabels[action]} recorded once without sending a message.`,
    );
  }

  async function retryDecision(submission: DecisionSubmissionView) {
    const command = lastCommands[submission.id];
    if (port && eventKey && command) {
      try {
        await port.execute(eventKey, command);
        announce(
          "No duplicate created",
          `The ${command.decision} command already exists; history and message side effects remain unchanged.`,
        );
      } catch {
        announceFailure(
          "Retry not confirmed",
          "The exact decision command remains safe to retry.",
        );
      }
      return;
    }
    const latest = submission.history.at(-1);
    if (!latest) return;
    announce(
      "No duplicate created",
      `The ${latest.action} command already exists; history and message side effects remain unchanged.`,
    );
  }

  return (
    <div className="decision-workspace">
      <DecisionHeader />
      <DecisionMetrics submissions={submissions} />

      <section aria-labelledby="decision-list-title" className="decision-panel">
        <div className="decision-panel-heading">
          <div>
            <p className="overline">Candidate queue</p>
            <h2 id="decision-list-title">Review evidence, then decide</h2>
            <p>
              Aggregate and range reflect only applicable submitted reviews.
              Open any proposal to inspect the raw snapshot.
            </p>
          </div>
          <StatusPill tone="neutral">{visible.length} proposals</StatusPill>
        </div>

        <div className="decision-filters">
          <TextField
            label="Search proposals"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, ID, track, format…"
            type="search"
            value={query}
          />
          <SelectField
            label="Track"
            onChange={(event) => setTrack(event.target.value)}
            options={trackOptions}
            value={track}
          />
          <SelectField
            label="Decision"
            onChange={(event) => setDecision(event.target.value)}
            options={[
              { label: "All decisions", value: "all" },
              { label: "Undecided", value: "undecided" },
              { label: "Accepted", value: "accepted" },
              { label: "Waitlisted", value: "waitlisted" },
              { label: "Declined", value: "declined" },
            ]}
            value={decision}
          />
        </div>

        {visible.length ? (
          <DecisionTable
            onDecide={openDecision}
            onInspect={(submission) => setDetailId(submission.id)}
            submissions={visible}
          />
        ) : (
          <div className="decision-empty">
            <Minus aria-hidden="true" size={24} />
            <h3>No proposals match</h3>
            <p>Clear the search or filters to restore the decision queue.</p>
          </div>
        )}
      </section>

      <DecisionDialog
        action={action}
        actorName={actorName}
        {...(pendingCommand?.audience
          ? { audienceOverride: pendingCommand.audience }
          : {})}
        eventName={eventName}
        frozen={pendingCommand !== null}
        messageMode={messageMode}
        note={note}
        onActionChange={setAction}
        onClose={() => {
          if (!pendingCommand) setDecisionTargetId(null);
        }}
        onConfirm={() => void recordDecision()}
        onMessageModeChange={setMessageMode}
        onNoteChange={setNote}
        onReasonChange={setReason}
        open={Boolean(decisionTarget)}
        reason={reason}
        submission={decisionTarget}
        {...(pendingCommand?.template
          ? { templateOverride: pendingCommand.template }
          : {})}
      />

      <EvidenceDrawer
        onClose={() => setDetailId(null)}
        onRetry={(submission) => void retryDecision(submission)}
        submission={detailSubmission}
      />

      <LiveRegion message={announcement} />
      <ToastRegion
        messages={toasts}
        onDismiss={(id) =>
          setToasts((current) => current.filter((toast) => toast.id !== id))
        }
      />
    </div>
  );
}

function ProductionDecisionWorkspace({
  eventKey,
  port,
}: {
  eventKey: string;
  port?: DecisionPort;
}) {
  const client = useMemo(() => port ?? createDecisionPort(), [port]);
  const [reload, setReload] = useState(0);
  const requestKey = `${eventKey}:${reload}`;
  const [loadState, setLoadState] = useState<{
    error: DecisionApiError | null;
    key: string;
    response: DecisionWorkspaceResponse | null;
  }>({ error: null, key: "", response: null });

  useEffect(() => {
    const controller = new AbortController();
    void client
      .load(eventKey, controller.signal)
      .then((response) =>
        setLoadState({ error: null, key: requestKey, response }),
      )
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setLoadState({
          error:
            cause instanceof DecisionApiError
              ? cause
              : new DecisionApiError(
                  "decisions_unavailable",
                  "The decision workspace could not be loaded.",
                  0,
                ),
          key: requestKey,
          response: null,
        });
      });
    return () => controller.abort();
  }, [client, eventKey, requestKey]);

  if (loadState.key !== requestKey) {
    return (
      <StatePanel
        description="Loading submitted reviews and authoritative decision history."
        state="loading"
        title="Loading decision evidence"
      />
    );
  }
  if (loadState.error) {
    return (
      <StatePanel
        action={
          loadState.error.status === 403 ? undefined : (
            <Button onClick={() => setReload((value) => value + 1)}>
              Retry
            </Button>
          )
        }
        description={loadState.error.message}
        state={loadState.error.status === 403 ? "permission" : "error"}
        title="Decision workspace unavailable"
      />
    );
  }
  if (!loadState.response) {
    return (
      <StatePanel
        description="Loading submitted reviews and authoritative decision history."
        state="loading"
        title="Loading decision evidence"
      />
    );
  }
  return (
    <DecisionWorkspaceSurface
      actorName={loadState.response.actor}
      eventKey={eventKey}
      eventName={loadState.response.eventName}
      initialSubmissions={productionSubmissions(loadState.response)}
      port={client}
    />
  );
}

export function DecisionWorkspace({
  eventKey,
  fixture = false,
  port,
}: {
  eventKey?: string;
  fixture?: boolean;
  port?: DecisionPort;
} = {}) {
  if (fixture) return <DecisionWorkspaceSurface />;
  return eventKey ? (
    <ProductionDecisionWorkspace
      eventKey={eventKey}
      {...(port ? { port } : {})}
    />
  ) : (
    <StatePanel
      description="Open decisions from a valid event workspace."
      state="error"
      title="Decision route not found"
    />
  );
}
