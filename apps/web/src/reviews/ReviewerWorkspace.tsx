import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  LogOut,
  MessageSquareText,
  ShieldAlert,
  Sparkles,
  WifiOff,
} from "lucide-react";

import {
  Button,
  Dialog,
  ErrorSummary,
  LiveRegion,
  StatePanel,
  StatusPill,
  TextAreaField,
  ToastRegion,
  type ToastMessage,
} from "@sessionbox-killer/ui";

import {
  reviewerWorkspaceFixture,
  type ReviewCriterionView,
  type ReviewQueueItemView,
  type ReviewerWorkspaceView,
} from "./reviewModel";
import {
  createReviewOperationsPort,
  ReviewOperationsApiError,
  type ReviewOperationsPort,
} from "./reviewOperationsClient";
import type {
  ReviewOperationsCommandResult,
  ReviewScoringCommand,
  ReviewerAssignmentListResponse,
} from "@sessionbox-killer/contracts";

import "./reviewer-workspace.css";

type ReviewerState =
  "active" | "expired" | "offline" | "permission" | "submitted";
export type ReviewerFixtureState = Exclude<ReviewerState, "active"> | "default";
type ReviewScores = Record<string, number | undefined>;
interface ReviewDraft {
  comment: string;
  scores: ReviewScores;
}
type ReviewDrafts = Record<string, ReviewDraft>;

const reviewStorageKey = "opensession.reviewer.visual-draft";

function readDrafts(
  workspace = reviewerWorkspaceFixture,
  storageKey = reviewStorageKey,
): ReviewDrafts {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as ReviewDraft | { drafts?: ReviewDrafts };
    if ("drafts" in parsed) {
      return parsed.drafts ?? {};
    }

    const firstProposal = workspace.queue[0];
    return firstProposal ? { [firstProposal.id]: parsed as ReviewDraft } : {};
  } catch {
    return {};
  }
}

function ReviewerBrand() {
  return (
    <div className="reviewer-brand">
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>
        <strong>OpenSession</strong>
        <small>Reviewer workspace</small>
      </span>
    </div>
  );
}

function QueueItem({
  item,
  onSelect,
  selected,
}: {
  item: ReviewQueueItemView;
  onSelect: () => void;
  selected: boolean;
}) {
  const statusLabel =
    item.status === "submitted"
      ? "Submitted"
      : item.status === "draft"
        ? "In progress"
        : "Not started";

  return (
    <button
      aria-current={selected ? "page" : undefined}
      className={
        selected ? "review-queue-item is-current" : "review-queue-item"
      }
      onClick={onSelect}
      type="button"
    >
      <span
        className={`review-queue-status is-${item.status}`}
        aria-hidden="true"
      >
        {item.status === "submitted" ? <Check size={12} /> : null}
      </span>
      <span>
        <small>
          {item.reference} · {item.track}
        </small>
        <strong>{item.title}</strong>
        <em>{statusLabel}</em>
      </span>
      <ChevronRight aria-hidden="true" size={16} />
    </button>
  );
}

function ScoreCriterion({
  criterion,
  disabled,
  onChange,
  score,
}: {
  criterion: ReviewCriterionView;
  disabled: boolean;
  onChange: (score: number) => void;
  score: number | undefined;
}) {
  return (
    <fieldset className="review-criterion" id={`criterion-${criterion.id}`}>
      <legend>
        <span>
          <strong>{criterion.label}</strong>
          <small>{criterion.weight}% of total</small>
        </span>
        {score ? <em>{score} / 5</em> : null}
      </legend>
      <p>
        <CircleHelp aria-hidden="true" size={14} /> {criterion.guidance}
      </p>
      <div className="review-score-options">
        {[1, 2, 3, 4, 5].map((value) => (
          <label key={value}>
            <input
              checked={score === value}
              disabled={disabled}
              name={`score-${criterion.id}`}
              onChange={() => onChange(value)}
              type="radio"
              value={value}
            />
            <span>{value}</span>
          </label>
        ))}
      </div>
      <div className="review-score-scale" aria-hidden="true">
        <span>Needs work</span>
        <span>Exceptional</span>
      </div>
    </fieldset>
  );
}

function ReviewerBlockedState({ state }: { state: "expired" | "permission" }) {
  return (
    <div className="reviewer-state-page">
      <ReviewerBrand />
      <div className="reviewer-state-card">
        {state === "expired" ? (
          <StatePanel
            action={<Button>Send a new sign-in link</Button>}
            description="This link was already used or has expired. We can send a fresh link to morgan@example.com without losing your draft."
            state="error"
            title="This review link has expired"
          />
        ) : (
          <StatePanel
            action={
              <Button variant="secondary">Return to your assignments</Button>
            }
            description="This proposal belongs to another reviewer group. Your current assignments are still available."
            state="permission"
            title="This proposal is not assigned to you"
          />
        )}
      </div>
      <p className="reviewer-state-help">
        AI Engineer Summit · Need help? reviewers@aiengineersummit.com
      </p>
    </div>
  );
}

interface ReviewerWorkspaceSurfaceProps {
  eventKey?: string;
  fixtureState?: ReviewerFixtureState;
  initialDrafts?: ReviewDrafts;
  port?: ReviewOperationsPort;
  workspace?: ReviewerWorkspaceView;
}

function ReviewerWorkspaceSurface({
  eventKey,
  fixtureState = "default",
  initialDrafts,
  port,
  workspace = reviewerWorkspaceFixture,
}: ReviewerWorkspaceSurfaceProps) {
  const initialState: ReviewerState =
    fixtureState === "default" ? "active" : fixtureState;
  const firstProposal = workspace.queue[0];
  const [activeProposalId, setActiveProposalId] = useState(
    firstProposal?.id ?? "",
  );
  const storageKey = eventKey
    ? `${reviewStorageKey}.${eventKey}`
    : reviewStorageKey;
  const [drafts, setDrafts] = useState<ReviewDrafts>(() => ({
    ...(initialDrafts ?? {}),
    ...readDrafts(workspace, storageKey),
  }));
  const [saveState, setSaveState] = useState<"failed" | "saved" | "saving">(
    "saved",
  );
  const [submittedIds, setSubmittedIds] = useState<Set<string>>(
    () =>
      new Set([
        ...workspace.queue
          .filter((item) => item.status === "submitted")
          .map((item) => item.id),
        ...(initialState === "submitted" && firstProposal
          ? [firstProposal.id]
          : []),
      ]),
  );
  const [submitOpen, setSubmitOpen] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [failedCommand, setFailedCommand] =
    useState<ReviewScoringCommand | null>(null);
  const versions = useRef<Record<string, number>>(
    Object.fromEntries(
      workspace.queue.map((item) => [item.id, item.sourceVersion ?? 0]),
    ),
  );
  const saveQueue = useRef(Promise.resolve());
  const saveTimer = useRef<number | null>(null);
  const submitting = useRef(false);
  const draftsRef = useRef(drafts);
  const [connectionState, setConnectionState] = useState<"online" | "offline">(
    initialState === "offline" ? "offline" : "online",
  );
  const isOffline = connectionState === "offline";
  const activeProposal =
    workspace.queue.find((item) => item.id === activeProposalId) ??
    firstProposal;
  const activeDraft = drafts[activeProposalId] ?? {
    comment: "",
    scores: {},
  };
  const { comment, scores } = activeDraft;
  const submitted = submittedIds.has(activeProposalId);
  const submittedCount = submittedIds.size;
  const activeCriteria = activeProposal?.criteria ?? workspace.criteria;
  const missingCriteria = activeCriteria.filter(
    (criterion) => !scores[criterion.id],
  );
  const completedCount = activeCriteria.length - missingCriteria.length;
  const weightedScore = useMemo(() => {
    const total = activeCriteria.reduce(
      (sum, criterion) => sum + (scores[criterion.id] ?? 0) * criterion.weight,
      0,
    );
    return completedCount === activeCriteria.length
      ? (total / 100).toFixed(1)
      : "—";
  }, [activeCriteria, completedCount, scores]);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => {
    if (saveState !== "saving" || submitting.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      saveTimer.current = null;
      window.localStorage.setItem(storageKey, JSON.stringify({ drafts }));
      if (!port || !eventKey || failedCommand) {
        setSaveState(port && failedCommand ? "failed" : "saved");
        return;
      }
      const assignmentId = activeProposalId;
      const draft = drafts[assignmentId] ?? { comment: "", scores: {} };
      const orderedScores = activeCriteria.flatMap((criterion) => {
        const score = draft.scores[criterion.id];
        return score === undefined
          ? []
          : [{ criterionId: criterion.id, score }];
      });
      saveQueue.current = saveQueue.current
        .catch(() => undefined)
        .then(async () => {
          const command: ReviewScoringCommand = {
            assignmentId,
            commandId: `review_save_${crypto.randomUUID()}`,
            draft: { note: draft.comment, scores: orderedScores },
            expectedVersion: versions.current[assignmentId] ?? 0,
            type: "save_review_draft",
          };
          try {
            const result = await port.executeReview(eventKey, command);
            versions.current[assignmentId] = result.version;
            setSaveState("saved");
            setFailedCommand(null);
          } catch {
            setFailedCommand(command);
            setSaveState("failed");
          }
        });
    }, 650);
    saveTimer.current = timer;

    return () => {
      window.clearTimeout(timer);
      if (saveTimer.current === timer) saveTimer.current = null;
    };
  }, [
    activeCriteria,
    activeProposalId,
    drafts,
    eventKey,
    failedCommand,
    port,
    saveState,
    storageKey,
  ]);

  if (initialState === "expired" || initialState === "permission") {
    return <ReviewerBlockedState state={initialState} />;
  }

  function updateScore(id: string, score: number) {
    setDrafts((current) => ({
      ...current,
      [activeProposalId]: {
        comment: current[activeProposalId]?.comment ?? "",
        scores: { ...current[activeProposalId]?.scores, [id]: score },
      },
    }));
    setSaveState("saving");
    setShowErrors(false);
    setAnnouncement(`${id} scored ${score} out of 5.`);
  }

  function requestSubmit() {
    if (missingCriteria.length > 0) {
      setShowErrors(true);
      document.getElementById("review-errors")?.focus();
      return;
    }
    setSubmitOpen(true);
  }

  function cancelPendingAutosave() {
    if (saveTimer.current === null) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
  }

  function markSubmitted() {
    setSubmittedIds((current) => new Set([...current, activeProposalId]));
    setSubmitOpen(false);
    setDrafts((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([id]) => id !== activeProposalId),
      ) as ReviewDrafts;
      window.localStorage.setItem(storageKey, JSON.stringify({ drafts: next }));
      return next;
    });
    setToasts([
      {
        id: "review-submitted",
        message:
          "Your scores are now read-only. The program team can reopen this review if needed.",
        title: "Review submitted",
        tone: "success",
      },
    ]);
  }

  async function replayFailedCommand(): Promise<ReviewOperationsCommandResult | null> {
    if (!failedCommand || !port || !eventKey) return null;
    setSaveState("saving");
    try {
      const result = await port.executeReview(eventKey, failedCommand);
      versions.current[failedCommand.assignmentId] = result.version;
      setFailedCommand(null);
      const current = draftsRef.current[failedCommand.assignmentId] ?? {
        comment: "",
        scores: {},
      };
      const commandDraft =
        failedCommand.type === "save_review_draft" ||
        failedCommand.type === "submit_review"
          ? failedCommand.draft
          : null;
      const currentCriteria =
        workspace.queue.find(({ id }) => id === failedCommand.assignmentId)
          ?.criteria ?? workspace.criteria;
      const currentSnapshot = {
        note: current.comment,
        scores: currentCriteria.flatMap((criterion) => {
          const score = current.scores[criterion.id];
          return score === undefined
            ? []
            : [{ criterionId: criterion.id, score }];
        }),
      };
      setSaveState(
        commandDraft &&
          JSON.stringify(commandDraft) !== JSON.stringify(currentSnapshot)
          ? "saving"
          : "saved",
      );
      if (failedCommand.type === "submit_review") markSubmitted();
      return result;
    } catch {
      setSaveState("failed");
      return null;
    }
  }

  async function submitReview() {
    submitting.current = true;
    cancelPendingAutosave();
    if (!port || !eventKey) {
      markSubmitted();
      submitting.current = false;
      return;
    }
    if (failedCommand && !(await replayFailedCommand())) {
      submitting.current = false;
      return;
    }
    await saveQueue.current.catch(() => undefined);
    const draft = draftsRef.current[activeProposalId] ?? {
      comment: "",
      scores: {},
    };
    const command: ReviewScoringCommand = {
      assignmentId: activeProposalId,
      commandId: `review_submit_${crypto.randomUUID()}`,
      draft: {
        note: draft.comment,
        scores: activeCriteria.map((criterion) => ({
          criterionId: criterion.id,
          score: draft.scores[criterion.id] ?? 0,
        })),
      },
      expectedVersion: versions.current[activeProposalId] ?? 0,
      type: "submit_review",
    };
    setSaveState("saving");
    try {
      const result = await port.executeReview(eventKey, command);
      versions.current[activeProposalId] = result.version;
      setFailedCommand(null);
      setSaveState("saved");
      markSubmitted();
      submitting.current = false;
    } catch {
      submitting.current = false;
      setFailedCommand(command);
      setSaveState("failed");
      setSubmitOpen(false);
      setToasts([
        {
          id: "review-submit-failed",
          message:
            "Your completed review remains in this browser. Retry to confirm the same submission safely.",
          title: "Submission not confirmed",
          tone: "error",
        },
      ]);
    }
  }

  function declareConflict() {
    if (!port || !eventKey || !activeProposal) {
      setToasts([
        {
          id: "conflict",
          title: "Conflict noted",
          message: "The program team will reassign this proposal.",
        },
      ]);
      return;
    }
    const command = {
      assignmentId: activeProposal.id,
      commandId: `review_conflict_${crypto.randomUUID()}`,
      expectedVersion: versions.current[activeProposal.id] ?? 0,
      note: "Reviewer declared a conflict.",
      type: "disclose_conflict" as const,
    };
    void port
      .execute(eventKey, command)
      .then(() => {
        setToasts([
          {
            id: "conflict",
            title: "Conflict noted",
            message: "The proposal is no longer part of your scoring queue.",
          },
        ]);
      })
      .catch(() => {
        setToasts([
          {
            id: "conflict-failed",
            title: "Conflict not confirmed",
            message: "Retry when your connection is available.",
            tone: "error",
          },
        ]);
      });
  }

  return (
    <div
      className="reviewer-workspace"
      style={
        workspace.brand
          ? ({
              "--review-accent": workspace.brand.accent,
              "--review-background": workspace.brand.background,
              "--review-ink": workspace.brand.ink,
            } as CSSProperties)
          : undefined
      }
    >
      <header className="reviewer-topbar">
        <ReviewerBrand />
        <div className="reviewer-event-chip">
          <span>AS</span>
          <div>
            <strong>{workspace.eventName}</strong>
            <small>Program review · 2026</small>
          </div>
        </div>
        <div className="reviewer-profile">
          <span>ML</span>
          <div>
            <strong>{workspace.reviewerName}</strong>
            <small>Reviewer</small>
          </div>
          <button aria-label="Sign out" type="button">
            <LogOut aria-hidden="true" size={17} />
          </button>
        </div>
      </header>

      {isOffline ? (
        <div className="review-offline" role="status">
          <WifiOff aria-hidden="true" size={16} />
          <span>
            <strong>You’re offline.</strong> Changes stay in this browser and
            sync when your connection returns.
          </span>
          <button
            onClick={() => {
              setConnectionState("online");
              setSaveState("saving");
              setAnnouncement("Connection restored. Syncing your draft.");
              setToasts([
                {
                  id: "review-online",
                  message: "Your browser draft is syncing now.",
                  title: "Connection restored",
                  tone: "success",
                },
              ]);
            }}
            type="button"
          >
            Retry now
          </button>
        </div>
      ) : null}

      <div className="reviewer-layout">
        <aside className="review-queue" aria-labelledby="review-queue-title">
          <div className="review-queue-heading">
            <div>
              <p className="overline">Your assignments</p>
              <h1 id="review-queue-title">Review queue</h1>
            </div>
            <span>
              {submittedCount} / {workspace.queue.length}
            </span>
          </div>
          <div
            className="review-progress"
            aria-label={`${submittedCount} of ${workspace.queue.length} reviews submitted`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={workspace.queue.length}
            aria-valuenow={submittedCount}
          >
            <span
              style={{
                width: `${(submittedCount / workspace.queue.length) * 100}%`,
              }}
            />
          </div>
          <p className="review-due">
            <Clock3 aria-hidden="true" size={14} /> {workspace.dueLabel}
          </p>
          <div className="review-queue-list">
            {workspace.queue.map((item) => {
              const draft = drafts[item.id];
              const status = submittedIds.has(item.id)
                ? "submitted"
                : draft &&
                    (draft.comment || Object.keys(draft.scores).length > 0)
                  ? "draft"
                  : item.status;
              return (
                <QueueItem
                  item={{ ...item, status }}
                  key={item.id}
                  onSelect={() => {
                    setActiveProposalId(item.id);
                    setShowErrors(false);
                    setSubmitOpen(false);
                    setAnnouncement(`${item.title} selected.`);
                  }}
                  selected={item.id === activeProposalId}
                />
              );
            })}
          </div>
          <div className="review-conflict-note">
            <ShieldAlert aria-hidden="true" size={17} />
            <div>
              <strong>Know this speaker?</strong>
              <p>
                Declare a conflict and we’ll reassign it without sharing a
                reason.
              </p>
            </div>
            <button onClick={declareConflict} type="button">
              Declare conflict
            </button>
          </div>
        </aside>

        <main className="review-proposal" id="review-main">
          <a className="review-mobile-back" href="#review-queue-title">
            <ArrowLeft aria-hidden="true" size={16} /> Queue
          </a>
          <header className="review-proposal-header">
            <div className="review-proposal-meta">
              <StatusPill tone="preview">{activeProposal?.track}</StatusPill>
              <span>{activeProposal?.reference}</span>
              <span>{activeProposal?.format}</span>
            </div>
            <h1>{activeProposal?.title}</h1>
            <p>Speaker identity is hidden until decisions are complete.</p>
            <button
              className="review-mobile-conflict"
              onClick={declareConflict}
              type="button"
            >
              <ShieldAlert aria-hidden="true" size={15} /> Declare conflict
            </button>
          </header>

          {submitted ? (
            <section
              className="review-submitted-banner"
              aria-label="Submitted review status"
            >
              <CheckCircle2 aria-hidden="true" size={20} />
              <div>
                <strong>Submitted · read only</strong>
                <span>
                  {activeProposal?.submittedAt
                    ? `Your review was submitted ${new Date(activeProposal.submittedAt).toLocaleString()}. `
                    : "Your review was submitted. "}
                  Contact the program team to request a reopen.
                </span>
              </div>
            </section>
          ) : null}

          <article className="review-proposal-section">
            <p className="overline">Abstract</p>
            <p>{activeProposal?.abstract}</p>
          </article>
          <article className="review-proposal-section">
            <p className="overline">Who this is for</p>
            <p>{activeProposal?.audience}</p>
          </article>
          <article className="review-proposal-section">
            <p className="overline">What attendees will learn</p>
            <ol>
              {activeProposal?.outcomes.map((outcome) => (
                <li key={outcome}>{outcome}</li>
              ))}
            </ol>
          </article>
          <article className="review-proposal-note">
            <MessageSquareText aria-hidden="true" size={18} />
            <div>
              <strong>Review the proposal, not the writing style.</strong>
              <p>
                Some speakers are submitting in a second language. Score the
                clarity of the idea and evidence.
              </p>
            </div>
          </article>
        </main>

        <aside className="review-scorecard" aria-labelledby="scorecard-title">
          <div className="review-scorecard-heading">
            <div>
              <p className="overline">Weighted rubric</p>
              <h2 id="scorecard-title">Your score</h2>
            </div>
            <span>{weightedScore}</span>
          </div>
          <p className="review-scorecard-copy">
            Score every criterion. Guidance stays visible while you decide.
          </p>

          {showErrors ? (
            <div id="review-errors" tabIndex={-1}>
              <ErrorSummary
                errors={missingCriteria.map((criterion) => ({
                  fieldId: `criterion-${criterion.id}`,
                  message: `Score ${criterion.label}`,
                }))}
                title="Complete this review"
              />
            </div>
          ) : null}

          <div className="review-criteria-list">
            {activeCriteria.map((criterion) => (
              <ScoreCriterion
                criterion={criterion}
                disabled={submitted}
                key={criterion.id}
                onChange={(score) => updateScore(criterion.id, score)}
                score={scores[criterion.id]}
              />
            ))}
          </div>
          <TextAreaField
            disabled={submitted}
            id="review-comment"
            label="Private note to the program team"
            onChange={(event) => {
              const nextComment = event.target.value;
              setDrafts((current) => ({
                ...current,
                [activeProposalId]: {
                  comment: nextComment,
                  scores: current[activeProposalId]?.scores ?? {},
                },
              }));
              setSaveState("saving");
            }}
            placeholder="Optional context for your scores…"
            rows={4}
            value={comment}
          />
          <div className="review-submit-row">
            <span role="status">
              {submitted
                ? "Submitted"
                : isOffline
                  ? "Saved in this browser"
                  : saveState === "failed"
                    ? "Draft saved in this browser"
                    : saveState === "saving"
                      ? "Saving draft…"
                      : "Draft saved"}
            </span>
            {saveState === "failed" ? (
              <Button
                variant="secondary"
                onClick={() => void replayFailedCommand()}
              >
                Retry save
              </Button>
            ) : null}
            <Button disabled={submitted || isOffline} onClick={requestSubmit}>
              {submitted ? "Review submitted" : "Submit review"}
            </Button>
          </div>
        </aside>
      </div>

      <Dialog
        description="Submitted reviews are read-only and immediately included in the organizer aggregate."
        onClose={() => setSubmitOpen(false)}
        open={submitOpen}
        title="Submit this review?"
      >
        <div className="review-submit-dialog">
          <div>
            <Sparkles aria-hidden="true" size={19} />
            <span>
              <strong>Weighted score</strong>
              <small>{weightedScore} out of 5</small>
            </span>
          </div>
          <p>
            You can ask the program team to reopen this review later. Your
            private note is never shared with the speaker.
          </p>
          <div>
            <Button variant="secondary" onClick={() => setSubmitOpen(false)}>
              Keep editing
            </Button>
            <Button onClick={() => void submitReview()}>
              Submit final review
            </Button>
          </div>
        </div>
      </Dialog>

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

function dueLabel(response: ReviewerAssignmentListResponse): string {
  if (!response.event.reviewDueAt) return "No review deadline set";
  try {
    return `Due ${new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "long",
      timeZone: response.event.timezone,
    }).format(new Date(response.event.reviewDueAt))}`;
  } catch {
    return "Review deadline available from the program team";
  }
}

function productionWorkspace(response: ReviewerAssignmentListResponse): {
  drafts: ReviewDrafts;
  workspace: ReviewerWorkspaceView;
} {
  const drafts: ReviewDrafts = {};
  const queue: ReviewQueueItemView[] = response.assignments.map((entry) => {
    const { assignment, context, draft, submittedAt } = entry;
    drafts[assignment.id] = {
      comment: draft.note,
      scores: Object.fromEntries(
        draft.scores.map(({ criterionId, score }) => [criterionId, score]),
      ),
    };
    return {
      abstract: context.abstract ?? "No abstract was provided.",
      audience: context.audience ?? "No audience guidance was provided.",
      criteria: assignment.rubric.criteria,
      format: context.format ?? "Format not provided",
      id: assignment.id,
      outcomes:
        context.outcomes.length > 0
          ? context.outcomes
          : ["No attendee outcomes were provided."],
      reference: assignment.submission.reference,
      sourceVersion: assignment.sourceVersion,
      status:
        assignment.status === "submitted"
          ? "submitted"
          : assignment.status === "in_progress"
            ? "draft"
            : "not_started",
      submittedAt,
      title: assignment.submission.title,
      track: assignment.submission.track ?? "Unassigned",
    };
  });
  return {
    drafts,
    workspace: {
      brand: response.event.brand,
      criteria: queue[0]?.criteria ?? [],
      dueLabel: dueLabel(response),
      eventName: response.event.name,
      queue,
      reviewerName: response.reviewer.displayName,
      track: queue[0]?.track ?? "Review",
    },
  };
}

function ProductionReviewerWorkspace({
  eventKey,
  port,
}: {
  eventKey: string;
  port?: ReviewOperationsPort;
}) {
  const client = useMemo(() => port ?? createReviewOperationsPort(), [port]);
  const [response, setResponse] =
    useState<ReviewerAssignmentListResponse | null>(null);
  const [error, setError] = useState<ReviewOperationsApiError | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void client
      .reviewerAssignments(eventKey, controller.signal)
      .then(setResponse)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof ReviewOperationsApiError
            ? cause
            : new ReviewOperationsApiError(
                "review_assignments_unavailable",
                "Your review assignments could not be loaded.",
                0,
              ),
        );
      });
    return () => controller.abort();
  }, [client, eventKey, reload]);

  if (error) {
    const permission = error.status === 403 || error.status === 404;
    return (
      <div className="reviewer-state-page">
        <ReviewerBrand />
        <div className="reviewer-state-card">
          <StatePanel
            action={
              permission ? undefined : (
                <Button
                  onClick={() => {
                    setError(null);
                    setResponse(null);
                    setReload((value) => value + 1);
                  }}
                >
                  Retry
                </Button>
              )
            }
            description={
              permission
                ? "This account does not have an active review assignment for this event."
                : "Your browser drafts are still safe. Retry when your connection returns."
            }
            state={permission ? "permission" : "error"}
            title={
              permission
                ? "Review access is unavailable"
                : "Your review queue could not be loaded"
            }
          />
        </div>
      </div>
    );
  }
  if (!response) {
    return (
      <div className="reviewer-state-page">
        <ReviewerBrand />
        <div className="reviewer-state-card">
          <StatePanel
            description="Loading your assigned proposals and immutable rubric snapshots."
            state="loading"
            title="Loading your review queue"
          />
        </div>
      </div>
    );
  }
  if (response.assignments.length === 0) {
    return (
      <div className="reviewer-state-page">
        <ReviewerBrand />
        <div className="reviewer-state-card">
          <StatePanel
            description="The program team has not assigned any proposals to this reviewer account."
            state="empty"
            title="No reviews assigned"
          />
        </div>
      </div>
    );
  }
  const production = productionWorkspace(response);
  return (
    <ReviewerWorkspaceSurface
      eventKey={eventKey}
      initialDrafts={production.drafts}
      port={client}
      workspace={production.workspace}
    />
  );
}

export function ReviewerWorkspace({
  eventKey,
  fixtureState,
  port,
}: {
  eventKey?: string;
  fixtureState?: ReviewerFixtureState;
  port?: ReviewOperationsPort;
} = {}) {
  if (fixtureState) {
    return <ReviewerWorkspaceSurface fixtureState={fixtureState} />;
  }
  const routeEventKey =
    eventKey ?? window.location.pathname.split("/").filter(Boolean)[1] ?? "";
  return (
    <ProductionReviewerWorkspace
      eventKey={routeEventKey}
      {...(port ? { port } : {})}
    />
  );
}
