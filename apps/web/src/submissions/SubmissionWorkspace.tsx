import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileClock,
  FileText,
  MessageSquareText,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  UserRound,
  UsersRound,
} from "lucide-react";

import {
  Button,
  DataTable,
  Dialog,
  LiveRegion,
  SelectField,
  StatePanel,
  StatusPill,
  TextAreaField,
  TextField,
  ToastRegion,
  type DataTableColumn,
  type ToastMessage,
} from "@sessionbox-killer/ui";

import {
  submissionFixture,
  submissionStatusLabels,
  submissionStatusTone,
  type SubmissionHistoryView,
  type SubmissionStatus,
  type SubmissionView,
} from "./submissionModel";

import "./submission-workspace.css";

export type SubmissionFixtureState =
  "empty" | "empty-filter" | "partial" | "permission" | "stale";

type LifecycleAction = "reopen" | "start_review" | "withdraw";

const statusOptions = [
  { label: "All statuses", value: "all" },
  ...Object.entries(submissionStatusLabels).map(([value, label]) => ({
    label,
    value,
  })),
];

const trackOptions = [
  { label: "All tracks", value: "all" },
  ...Array.from(new Set(submissionFixture.map((item) => item.track))).map(
    (track) => ({ label: track, value: track }),
  ),
];

function readFilter(name: string) {
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

function readStatusFilter() {
  const status = readFilter("status");
  return status === "all" || status in submissionStatusLabels ? status : "all";
}

function readTrackFilter() {
  const track = readFilter("track");
  return trackOptions.some((option) => option.value === track) ? track : "all";
}

function getDetailId() {
  if (window.location.pathname.startsWith("/fixtures/")) return undefined;
  const segments = window.location.pathname.split("/").filter(Boolean);
  const submissionsIndex = segments.indexOf("submissions");
  return submissionsIndex >= 0 ? segments[submissionsIndex + 1] : undefined;
}

function writeFilters(values: {
  query: string;
  status: string;
  track: string;
}) {
  const params = new URLSearchParams();
  if (values.query) params.set("q", values.query);
  if (values.status !== "all") params.set("status", values.status);
  if (values.track !== "all") params.set("track", values.track);
  const search = params.toString();
  window.history.replaceState(
    null,
    "",
    search ? `${window.location.pathname}?${search}` : window.location.pathname,
  );
}

function statusMetric(submissions: SubmissionView[], status: SubmissionStatus) {
  return submissions.filter((submission) => submission.status === status)
    .length;
}

function SubmissionSummary({ submissions }: { submissions: SubmissionView[] }) {
  const metrics = [
    {
      detail: "Ready for routing",
      icon: Send,
      label: "Newly submitted",
      value: statusMetric(submissions, "submitted"),
    },
    {
      detail: "Reviews in motion",
      icon: FileClock,
      label: "Under review",
      value: statusMetric(submissions, "under_review"),
    },
    {
      detail: "Program seats held",
      icon: CheckCircle2,
      label: "Accepted",
      value: statusMetric(submissions, "accepted"),
    },
    {
      detail: "Needs a final call",
      icon: Clock3,
      label: "Waitlisted",
      value: statusMetric(submissions, "waitlisted"),
    },
  ];

  return (
    <section aria-label="Submission summary" className="submission-metrics">
      {metrics.map((metric) => {
        const Icon = metric.icon;
        return (
          <article key={metric.label}>
            <span>
              <Icon aria-hidden="true" size={17} />
            </span>
            <small>{metric.label}</small>
            <strong>{metric.value}</strong>
            <em>{metric.detail}</em>
          </article>
        );
      })}
    </section>
  );
}

function ReviewProgress({ submission }: { submission: SubmissionView }) {
  return (
    <span className="submission-progress">
      <strong>
        {submission.reviewCount} / {submission.reviewersAssigned}
      </strong>
      <small>
        {submission.reviewersAssigned === 0
          ? "Not routed"
          : submission.reviewCount === submission.reviewersAssigned
            ? "Complete"
            : "Submitted"}
      </small>
    </span>
  );
}

function SubmissionCards({ submissions }: { submissions: SubmissionView[] }) {
  return (
    <div className="submission-cards" aria-label="Submission cards">
      {submissions.map((submission) => (
        <article key={submission.id}>
          <header>
            <span>{submission.id}</span>
            <StatusPill tone={submissionStatusTone(submission.status)}>
              {submissionStatusLabels[submission.status]}
            </StatusPill>
          </header>
          <h3>{submission.title}</h3>
          <p>
            {submission.submitter} · {submission.track}
          </p>
          <dl>
            <div>
              <dt>Reviews</dt>
              <dd>
                {submission.reviewCount} / {submission.reviewersAssigned}
              </dd>
            </div>
            <div>
              <dt>Aggregate</dt>
              <dd>{submission.aggregateScore?.toFixed(2) ?? "—"}</dd>
            </div>
            <div>
              <dt>Activity</dt>
              <dd>{submission.lastActivity}</dd>
            </div>
          </dl>
          <a href={`/app/ai-engineer-summit/submissions/${submission.id}`}>
            Open submission <ArrowRight aria-hidden="true" size={15} />
          </a>
        </article>
      ))}
    </div>
  );
}

function SubmissionList({
  fixtureState,
  submissions,
}: {
  fixtureState?: SubmissionFixtureState | undefined;
  submissions: SubmissionView[];
}) {
  const [query, setQuery] = useState(
    fixtureState === "empty-filter" ? "no matching proposal" : readFilter("q"),
  );
  const [status, setStatus] = useState(readStatusFilter);
  const [track, setTrack] = useState(readTrackFilter);
  const [stale, setStale] = useState(fixtureState === "stale");

  const source = useMemo(
    () => (fixtureState === "empty" ? [] : submissions),
    [fixtureState, submissions],
  );
  const visible = useMemo(
    () =>
      source.filter((submission) => {
        const haystack =
          `${submission.id} ${submission.title} ${submission.submitter} ${submission.track}`.toLowerCase();
        return (
          haystack.includes(query.toLowerCase()) &&
          (status === "all" || submission.status === status) &&
          (track === "all" || submission.track === track)
        );
      }),
    [query, source, status, track],
  );

  function update(next: { query?: string; status?: string; track?: string }) {
    const values = {
      query: next.query ?? query,
      status: next.status ?? status,
      track: next.track ?? track,
    };
    if (next.query !== undefined) setQuery(next.query);
    if (next.status !== undefined) setStatus(next.status);
    if (next.track !== undefined) setTrack(next.track);
    writeFilters(values);
  }

  const columns: DataTableColumn<SubmissionView>[] = [
    {
      header: "Submission",
      key: "submission",
      render: (submission) => (
        <a
          className="submission-title-link"
          href={`/app/ai-engineer-summit/submissions/${submission.id}`}
        >
          <strong>{submission.title}</strong>
          <span>
            {submission.id} · {submission.format}
          </span>
        </a>
      ),
    },
    {
      header: "Submitter",
      key: "submitter",
      render: (submission) => (
        <span className="submission-person">
          <span aria-hidden="true">
            {submission.submitter
              .split(" ")
              .map((part) => part[0])
              .join("")}
          </span>
          <strong>{submission.submitter}</strong>
        </span>
      ),
    },
    {
      header: "Track",
      key: "track",
      render: (submission) => submission.track,
    },
    {
      header: "Status",
      key: "status",
      render: (submission) => (
        <StatusPill tone={submissionStatusTone(submission.status)}>
          {submissionStatusLabels[submission.status]}
        </StatusPill>
      ),
    },
    {
      header: "Reviews",
      key: "reviews",
      render: (submission) => <ReviewProgress submission={submission} />,
    },
    {
      header: "Aggregate",
      key: "aggregate",
      render: (submission) => (
        <strong>{submission.aggregateScore?.toFixed(2) ?? "—"}</strong>
      ),
    },
    {
      header: "Activity",
      key: "activity",
      render: (submission) => submission.lastActivity,
    },
  ];

  if (fixtureState === "permission") {
    return (
      <StatePanel
        description="Ask an event owner for organizer access to submission content and status history."
        state="permission"
        title="Submissions are restricted"
      />
    );
  }

  return (
    <div className="submission-list">
      <header className="submission-header">
        <div>
          <p className="overline">Collect · Submissions</p>
          <h1>Every proposal, in context.</h1>
          <p>
            Search the queue, inspect the exact submitted form, and make legal
            lifecycle moves without losing who changed what.
          </p>
        </div>
        <div className="submission-header-proof">
          <StatusPill tone="success">Form snapshots preserved</StatusPill>
          <span>
            <ShieldCheck aria-hidden="true" size={15} /> Organizer view ·
            private fields protected
          </span>
        </div>
      </header>

      {stale ? (
        <section className="submission-freshness is-stale" role="status">
          <AlertTriangle aria-hidden="true" size={18} />
          <span>
            <strong>This snapshot may be behind</strong>
            Showing the last complete view from 6 minutes ago. Your filters are
            preserved while the projection catches up.
          </span>
          <button onClick={() => setStale(false)} type="button">
            <RefreshCw aria-hidden="true" size={14} /> Refresh
          </button>
        </section>
      ) : (
        <section className="submission-freshness" role="status">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>
            <strong>Submission projection is current</strong>
            Updated 24 seconds ago. Status history is included.
          </span>
        </section>
      )}

      <SubmissionSummary submissions={source} />

      {source.length === 0 ? (
        <StatePanel
          action={
            <Button variant="secondary">
              <FileText aria-hidden="true" size={16} /> Preview public CFP
            </Button>
          }
          description="Published CFP responses will appear here with their submitted form snapshot and lifecycle history."
          state="empty"
          title="No submissions yet"
        />
      ) : (
        <section
          className="submission-table-panel"
          aria-labelledby="queue-title"
        >
          <div className="submission-panel-heading">
            <div>
              <p className="overline">Live work queue</p>
              <h2 id="queue-title">All submissions</h2>
            </div>
            <span>{visible.length} shown</span>
          </div>
          <div className="submission-filters">
            <TextField
              label="Search submissions"
              onChange={(event) => update({ query: event.target.value })}
              placeholder="Title, ID, speaker, or track"
              type="search"
              value={query}
            />
            <SelectField
              label="Status"
              onChange={(event) => update({ status: event.target.value })}
              options={statusOptions}
              value={status}
            />
            <SelectField
              label="Track"
              onChange={(event) => update({ track: event.target.value })}
              options={trackOptions}
              value={track}
            />
          </div>
          {visible.length ? (
            <>
              <div className="submission-table-desktop">
                <DataTable
                  caption="Organizer submission queue"
                  columns={columns}
                  getRowKey={(submission) => submission.id}
                  rows={visible}
                />
              </div>
              <SubmissionCards submissions={visible} />
            </>
          ) : (
            <StatePanel
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery("");
                    setStatus("all");
                    setTrack("all");
                    writeFilters({ query: "", status: "all", track: "all" });
                  }}
                >
                  Clear filters
                </Button>
              }
              description="Clear a filter or try a different title, ID, speaker, or track."
              state="empty"
              title="No submissions match"
            />
          )}
        </section>
      )}
    </div>
  );
}

function SubmissionTimeline({ submission }: { submission: SubmissionView }) {
  return (
    <ol className="submission-timeline">
      {[...submission.history].reverse().map((event) => (
        <li key={event.id}>
          <span aria-hidden="true" />
          <div>
            <strong>{event.title}</strong>
            <p>{event.detail}</p>
            <small>
              {event.actor} · {event.time}
            </small>
          </div>
        </li>
      ))}
    </ol>
  );
}

function lifecycleLabel(action: LifecycleAction) {
  if (action === "start_review") return "Move to review";
  if (action === "withdraw") return "Withdraw submission";
  return "Reopen submission";
}

function SubmissionDetail({
  degraded,
  initialSubmission,
}: {
  degraded: boolean;
  initialSubmission: SubmissionView;
}) {
  const [submission, setSubmission] = useState(initialSubmission);
  const [action, setAction] = useState<LifecycleAction | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showStartReview = submission.status === "submitted";
  const showReopen =
    submission.status !== "submitted" && submission.status !== "under_review";
  const showWithdraw = submission.status !== "withdrawn";

  function announce(title: string, message: string) {
    setAnnouncement(message);
    setToasts((current) => [
      ...current,
      { id: `${Date.now()}-${title}`, message, title, tone: "success" },
    ]);
  }

  function recordAction() {
    if (!action || !reason.trim()) return;
    const nextStatus: SubmissionStatus =
      action === "withdraw"
        ? "withdrawn"
        : action === "start_review"
          ? "under_review"
          : "submitted";
    const history: SubmissionHistoryView = {
      actor: "Casey Manos",
      detail: reason.trim(),
      id: `history-${Date.now()}`,
      time: "Just now",
      title:
        action === "withdraw"
          ? "Withdrawn by organizer"
          : action === "start_review"
            ? "Moved to review"
            : "Reopened for organizer review",
    };
    setSubmission((current) => ({
      ...current,
      history: [...current.history, history],
      lastActivity: "Just now",
      status: nextStatus,
    }));
    setAction(null);
    setReason("");
    announce(
      "Status updated",
      `${submission.id} is now ${submissionStatusLabels[nextStatus].toLowerCase()}. An audit entry was recorded.`,
    );
  }

  function addNote() {
    if (!note.trim()) return;
    setSubmission((current) => ({
      ...current,
      notes: [
        ...current.notes,
        {
          actor: "Casey Manos",
          id: `note-${Date.now()}`,
          text: note.trim(),
          time: "Just now",
        },
      ],
    }));
    setNote("");
    announce(
      "Internal note added",
      "The note is visible to organizers only and was added to this submission.",
    );
  }

  return (
    <div className="submission-detail">
      <a className="submission-back" href="/app/ai-engineer-summit/submissions">
        <ArrowLeft aria-hidden="true" size={15} /> All submissions
      </a>

      {degraded ? (
        <section className="submission-degraded" role="alert">
          <AlertTriangle aria-hidden="true" size={18} />
          <span>
            <strong>Upstream history is temporarily unavailable</strong>
            The last complete submission snapshot remains visible. Status and
            note controls are paused until history can be recorded safely.
          </span>
        </section>
      ) : null}

      <header className="submission-detail-header">
        <div>
          <p className="overline">
            {submission.id} · {submission.track}
          </p>
          <h1>{submission.title}</h1>
          <p>
            Submitted by {submission.submitter}
            {submission.submittedAt ? ` on ${submission.submittedAt}` : ""}.
          </p>
        </div>
        <div>
          <StatusPill tone={submissionStatusTone(submission.status)}>
            {submissionStatusLabels[submission.status]}
          </StatusPill>
          <small>Last activity {submission.lastActivity}</small>
        </div>
      </header>

      <div className="submission-detail-layout">
        <div className="submission-detail-main">
          <section
            className="submission-section"
            aria-labelledby="response-title"
          >
            <header className="submission-section-heading">
              <div>
                <p className="overline">Immutable response</p>
                <h2 id="response-title">Submitted form</h2>
              </div>
              <StatusPill tone="neutral">{submission.formVersion}</StatusPill>
            </header>
            {submission.answers.length ? (
              <dl className="submission-answers">
                {submission.answers.map((answer) => (
                  <div key={answer.label}>
                    <dt>{answer.label}</dt>
                    <dd>{answer.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="submission-unavailable-copy">
                The full response snapshot is available from the authoritative
                submission projection once this record is connected.
              </p>
            )}
          </section>

          <section
            className="submission-section"
            aria-labelledby="reviews-title"
          >
            <header className="submission-section-heading">
              <div>
                <p className="overline">Review evidence</p>
                <h2 id="reviews-title">Raw review summaries</h2>
              </div>
              <strong className="submission-score">
                {submission.aggregateScore?.toFixed(2) ?? "—"}
                <small>aggregate</small>
              </strong>
            </header>
            {submission.reviews.length ? (
              <div className="submission-review-list">
                {submission.reviews.map((review) => (
                  <article key={review.reviewer}>
                    <header>
                      <div>
                        <strong>{review.reviewer}</strong>
                        <small>{review.status}</small>
                      </div>
                      {review.score ? <b>{review.score.toFixed(2)}</b> : null}
                    </header>
                    <p>{review.summary}</p>
                  </article>
                ))}
              </div>
            ) : (
              <p className="submission-unavailable-copy">
                No review summaries have been submitted.
              </p>
            )}
          </section>

          <section className="submission-section" aria-labelledby="notes-title">
            <header className="submission-section-heading">
              <div>
                <p className="overline">Organizer only</p>
                <h2 id="notes-title">Internal notes</h2>
              </div>
              <MessageSquareText aria-hidden="true" size={20} />
            </header>
            <div className="submission-notes">
              {submission.notes.map((item) => (
                <article key={item.id}>
                  <p>{item.text}</p>
                  <small>
                    {item.actor} · {item.time}
                  </small>
                </article>
              ))}
            </div>
            <TextAreaField
              disabled={degraded}
              label="Add an internal note"
              onChange={(event) => setNote(event.target.value)}
              placeholder="Context for organizers…"
              rows={3}
              value={note}
            />
            <Button disabled={degraded || !note.trim()} onClick={addNote}>
              Add note
            </Button>
          </section>
        </div>

        <aside
          className="submission-detail-aside"
          aria-label="Submission context"
        >
          <section className="submission-side-card">
            <p className="overline">Lifecycle controls</p>
            <h2>Change status safely</h2>
            <p>
              Every change requires a reason. The server remains authoritative
              when this view is connected to the command API.
            </p>
            <div className="submission-lifecycle-actions">
              {showStartReview ? (
                <Button
                  disabled={degraded}
                  onClick={() => setAction("start_review")}
                >
                  <Send aria-hidden="true" size={16} /> Move to review
                </Button>
              ) : null}
              {showReopen ? (
                <Button disabled={degraded} onClick={() => setAction("reopen")}>
                  <RotateCcw aria-hidden="true" size={16} /> Reopen
                </Button>
              ) : null}
              {showWithdraw ? (
                <Button
                  disabled={degraded}
                  onClick={() => setAction("withdraw")}
                  variant="secondary"
                >
                  Withdraw
                </Button>
              ) : null}
            </div>
          </section>

          <section className="submission-side-card">
            <p className="overline">Participants</p>
            <h2>Speakers</h2>
            <div className="submission-participants">
              {submission.participants.map((participant) => (
                <article key={participant.name}>
                  <span>
                    <UserRound aria-hidden="true" size={16} />
                  </span>
                  <div>
                    <strong>{participant.name}</strong>
                    <small>
                      {participant.role} · {participant.company}
                    </small>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="submission-side-card">
            <p className="overline">Review routing</p>
            <h2>Queue context</h2>
            <div className="submission-route-tags">
              {submission.routing.map((route) => (
                <span key={route}>{route}</span>
              ))}
            </div>
            <p className="submission-review-count">
              <UsersRound aria-hidden="true" size={17} />
              <strong>
                {submission.reviewCount} of {submission.reviewersAssigned}
              </strong>{" "}
              assigned reviews submitted
            </p>
          </section>

          <section className="submission-side-card">
            <p className="overline">Immutable audit trail</p>
            <h2>Status history</h2>
            <SubmissionTimeline submission={submission} />
          </section>
        </aside>
      </div>

      <Dialog
        description={`${submission.id} · ${submission.title}`}
        onClose={() => {
          setAction(null);
          setReason("");
        }}
        open={Boolean(action)}
        title={action ? lifecycleLabel(action) : "Update submission"}
      >
        <div className="submission-action-dialog">
          <p>
            This UI records one local audit entry for the demo. The eventual
            command API validates the transition and persists the authoritative
            status.
          </p>
          <TextAreaField
            label="Reason for change"
            onChange={(event) => setReason(event.target.value)}
            placeholder="Explain why this transition is needed…"
            required
            rows={4}
            value={reason}
          />
          <div>
            <Button
              onClick={() => {
                setAction(null);
                setReason("");
              }}
              variant="secondary"
            >
              Cancel
            </Button>
            <Button disabled={!reason.trim()} onClick={recordAction}>
              Record change
            </Button>
          </div>
        </div>
      </Dialog>
      <ToastRegion
        messages={toasts}
        onDismiss={(id) =>
          setToasts((current) => current.filter((toast) => toast.id !== id))
        }
      />
      <LiveRegion message={announcement} />
    </div>
  );
}

export function SubmissionWorkspace({
  fixtureSubmissionId,
  fixtureState,
}: {
  fixtureSubmissionId?: string | undefined;
  fixtureState?: SubmissionFixtureState | undefined;
}) {
  const detailId = fixtureSubmissionId ?? getDetailId();
  const detail = submissionFixture.find(
    (submission) => submission.id === detailId,
  );

  if (detailId && !detail) {
    return (
      <div className="submission-page-state">
        <StatePanel
          action={
            <a
              className="ui-button ui-button--secondary"
              href="/app/ai-engineer-summit/submissions"
            >
              Return to submissions
            </a>
          }
          description="This submission may have moved, been removed, or may not be visible with your current event access."
          state="error"
          title="Submission not found"
        />
      </div>
    );
  }

  return detail ? (
    <SubmissionDetail
      degraded={fixtureState === "partial"}
      initialSubmission={detail}
    />
  ) : (
    <SubmissionList
      fixtureState={fixtureState}
      submissions={submissionFixture}
    />
  );
}
