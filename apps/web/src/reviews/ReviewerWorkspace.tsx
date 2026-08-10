import { useEffect, useMemo, useState } from "react";
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
} from "./reviewModel";

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

function readDrafts(): ReviewDrafts {
  try {
    const raw = window.localStorage.getItem(reviewStorageKey);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as ReviewDraft | { drafts?: ReviewDrafts };
    if ("drafts" in parsed) {
      return parsed.drafts ?? {};
    }

    const firstProposal = reviewerWorkspaceFixture.queue[0];
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

export function ReviewerWorkspace({
  fixtureState = "default",
}: {
  fixtureState?: ReviewerFixtureState;
} = {}) {
  const initialState: ReviewerState =
    fixtureState === "default" ? "active" : fixtureState;
  const firstProposal = reviewerWorkspaceFixture.queue[0];
  const [activeProposalId, setActiveProposalId] = useState(
    firstProposal?.id ?? "",
  );
  const [drafts, setDrafts] = useState<ReviewDrafts>(readDrafts);
  const [saveState, setSaveState] = useState<"saved" | "saving">("saved");
  const [submittedIds, setSubmittedIds] = useState<Set<string>>(
    () =>
      new Set([
        ...reviewerWorkspaceFixture.queue
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
  const [connectionState, setConnectionState] = useState<"online" | "offline">(
    initialState === "offline" ? "offline" : "online",
  );
  const isOffline = connectionState === "offline";
  const activeProposal =
    reviewerWorkspaceFixture.queue.find(
      (item) => item.id === activeProposalId,
    ) ?? firstProposal;
  const activeDraft = drafts[activeProposalId] ?? {
    comment: "",
    scores: {},
  };
  const { comment, scores } = activeDraft;
  const submitted = submittedIds.has(activeProposalId);
  const submittedCount = submittedIds.size;
  const missingCriteria = reviewerWorkspaceFixture.criteria.filter(
    (criterion) => !scores[criterion.id],
  );
  const completedCount =
    reviewerWorkspaceFixture.criteria.length - missingCriteria.length;
  const weightedScore = useMemo(() => {
    const total = reviewerWorkspaceFixture.criteria.reduce(
      (sum, criterion) => sum + (scores[criterion.id] ?? 0) * criterion.weight,
      0,
    );
    return completedCount === reviewerWorkspaceFixture.criteria.length
      ? (total / 100).toFixed(1)
      : "—";
  }, [completedCount, scores]);

  useEffect(() => {
    if (saveState !== "saving") {
      return;
    }

    const timer = window.setTimeout(() => {
      window.localStorage.setItem(reviewStorageKey, JSON.stringify({ drafts }));
      setSaveState("saved");
    }, 650);

    return () => window.clearTimeout(timer);
  }, [drafts, saveState]);

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

  function submitReview() {
    setSubmittedIds((current) => new Set([...current, activeProposalId]));
    setSubmitOpen(false);
    setDrafts((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([id]) => id !== activeProposalId),
      ) as ReviewDrafts;
      window.localStorage.setItem(
        reviewStorageKey,
        JSON.stringify({ drafts: next }),
      );
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

  return (
    <div className="reviewer-workspace">
      <header className="reviewer-topbar">
        <ReviewerBrand />
        <div className="reviewer-event-chip">
          <span>AS</span>
          <div>
            <strong>{reviewerWorkspaceFixture.eventName}</strong>
            <small>Program review · 2026</small>
          </div>
        </div>
        <div className="reviewer-profile">
          <span>ML</span>
          <div>
            <strong>{reviewerWorkspaceFixture.reviewerName}</strong>
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
              {submittedCount} / {reviewerWorkspaceFixture.queue.length}
            </span>
          </div>
          <div
            className="review-progress"
            aria-label={`${submittedCount} of ${reviewerWorkspaceFixture.queue.length} reviews submitted`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={reviewerWorkspaceFixture.queue.length}
            aria-valuenow={submittedCount}
          >
            <span
              style={{
                width: `${(submittedCount / reviewerWorkspaceFixture.queue.length) * 100}%`,
              }}
            />
          </div>
          <p className="review-due">
            <Clock3 aria-hidden="true" size={14} />{" "}
            {reviewerWorkspaceFixture.dueLabel}
          </p>
          <div className="review-queue-list">
            {reviewerWorkspaceFixture.queue.map((item) => {
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
            <button
              onClick={() =>
                setToasts([
                  {
                    id: "conflict",
                    title: "Conflict noted",
                    message: "The program team will reassign this proposal.",
                  },
                ])
              }
              type="button"
            >
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
                  Your review was submitted August 9 at 8:34 PM. Contact the
                  program team to request a reopen.
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
            {reviewerWorkspaceFixture.criteria.map((criterion) => (
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
                  : saveState === "saving"
                    ? "Saving draft…"
                    : "Draft saved"}
            </span>
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
            <Button onClick={submitReview}>Submit final review</Button>
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
