import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  Mail,
  MapPin,
  Plus,
  ShieldCheck,
  Trash2,
  Users,
  WifiOff,
} from "lucide-react";

import {
  magicLinkRequestSchema,
  protectedMagicLinkRequestSchema,
  protectedPublicCfpSubmissionRequestSchema,
} from "@sessionbox-killer/contracts";
import {
  evaluateCfpRules,
  resolveCfpTrackRoute,
  visibleFieldTransitions,
} from "@sessionbox-killer/domain";
import {
  Button,
  ErrorSummary,
  LiveRegion,
  SelectField,
  StatePanel,
  StatusPill,
  TextAreaField,
  TextField,
} from "@sessionbox-killer/ui";

import {
  TurnstileWidget,
  type TurnstileWidgetHandle,
} from "../security/TurnstileWidget";

import {
  emptyPublicCfpDraft,
  publicCfpEventFixture,
  publicCfpRuleFields,
  publicCfpSteps,
  publicCfpTrackRoutes,
  resumedPublicCfpDraft,
  type PublicCfpDraft,
  type PublicCfpSaveState,
  type PublicCfpSpeakerDraft,
  type PublicCfpStep,
} from "./publicCfpModel";

import "./public-cfp-flow.css";

export type PublicCfpFixtureState =
  "closed" | "failed" | "interactive" | "limit" | "offline" | "resume";

const draftStorageKey = "opensession.public-cfp.ai-engineer-summit.draft";
const confirmationStorageKey =
  "opensession.public-cfp.ai-engineer-summit.confirmation";
const idempotencyStorageKey =
  "opensession.public-cfp.ai-engineer-summit.idempotency";

function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorage(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Cleanup cannot invalidate an already confirmed server response.
  }
}

type StoredPublicCfpDraft = Omit<
  PublicCfpDraft,
  | "defaultReviewerGroupId"
  | "routeKey"
  | "submissionTrack"
  | "workshopPrerequisites"
> &
  Partial<
    Pick<
      PublicCfpDraft,
      | "defaultReviewerGroupId"
      | "routeKey"
      | "submissionTrack"
      | "workshopPrerequisites"
    >
  >;

function isDraft(value: unknown): value is StoredPublicCfpDraft {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<PublicCfpDraft>;
  const validStep = publicCfpSteps.some((step) => step.id === candidate.step);
  const validSpeakers =
    Array.isArray(candidate.speakers) &&
    candidate.speakers.every(
      (speaker: unknown) =>
        speaker !== null &&
        typeof speaker === "object" &&
        "email" in speaker &&
        typeof speaker.email === "string" &&
        "id" in speaker &&
        typeof speaker.id === "string" &&
        "name" in speaker &&
        typeof speaker.name === "string" &&
        "role" in speaker &&
        typeof speaker.role === "string",
    );
  return (
    typeof candidate.abstract === "string" &&
    typeof candidate.consent === "boolean" &&
    typeof candidate.email === "string" &&
    typeof candidate.format === "string" &&
    typeof candidate.outcomes === "string" &&
    validSpeakers &&
    validStep &&
    typeof candidate.title === "string" &&
    typeof candidate.track === "string" &&
    typeof candidate.verified === "boolean"
  );
}

function normalizeDraft(draft: StoredPublicCfpDraft): PublicCfpDraft {
  const route = resolveCfpTrackRoute(publicCfpTrackRoutes, draft.track);
  const evaluation = evaluateCfpRules(publicCfpRuleFields, {
    abstract: draft.abstract,
    format: draft.format,
    outcomes: draft.outcomes,
    title: draft.title,
    track: draft.track,
    workshopPrerequisites:
      typeof draft.workshopPrerequisites === "string"
        ? draft.workshopPrerequisites
        : "",
  });

  return {
    ...draft,
    defaultReviewerGroupId: route?.defaultReviewerGroupId ?? "",
    routeKey: route?.routeKey ?? "",
    submissionTrack: route?.submissionTrack ?? "",
    workshopPrerequisites:
      typeof evaluation.answers.workshopPrerequisites === "string"
        ? evaluation.answers.workshopPrerequisites
        : "",
  };
}

function readDraft(fixtureState?: PublicCfpFixtureState): PublicCfpDraft {
  if (
    fixtureState === "resume" ||
    fixtureState === "offline" ||
    fixtureState === "failed"
  ) {
    return resumedPublicCfpDraft;
  }

  try {
    const raw = readStorage(draftStorageKey);
    if (!raw) {
      return emptyPublicCfpDraft;
    }
    const stored: unknown = JSON.parse(raw);
    if (!isDraft(stored)) {
      return emptyPublicCfpDraft;
    }
    const parsed = normalizeDraft(stored);
    if (
      parsed.step === "confirmation" &&
      (!fixtureState || !readStorage(confirmationStorageKey))
    ) {
      return {
        ...parsed,
        step: "review",
        verified: fixtureState ? parsed.verified : false,
      };
    }
    return fixtureState ? parsed : { ...parsed, verified: false };
  } catch {
    return emptyPublicCfpDraft;
  }
}

function stepIndex(step: PublicCfpStep) {
  return publicCfpSteps.findIndex((item) => item.id === step);
}

function saveStatePresentation(state: PublicCfpSaveState) {
  switch (state) {
    case "saving":
      return { label: "Saving…", tone: "warning" as const };
    case "saved":
      return { label: "Saved on this device", tone: "success" as const };
    case "offline":
      return {
        label: "Offline · saved on this device",
        tone: "warning" as const,
      };
    case "failed":
      return { label: "Save failed · retry", tone: "warning" as const };
    default:
      return { label: "Not saved yet", tone: "neutral" as const };
  }
}

function PublicCfpBrand() {
  return (
    <a className="public-cfp-brand" href="/e/ai-engineer-summit/cfp">
      <span aria-hidden="true" className="brand-mark">
        <span />
        <span />
        <span />
      </span>
      <span>
        <strong>OpenSession</strong>
        <small>Call for proposals</small>
      </span>
    </a>
  );
}

function PolicyState({ state }: { state: "closed" | "limit" }) {
  const event = publicCfpEventFixture;
  return (
    <div className="public-cfp-policy-state">
      <PublicCfpHeader />
      <main>
        <StatePanel
          action={
            <a
              className="public-cfp-primary-link"
              href={`mailto:${event.contactEmail}`}
            >
              Contact the program team
            </a>
          }
          description={
            state === "closed"
              ? `The call closed ${event.closesLabel} (${event.timezoneLabel}). Existing applicants can still use their private link when edits are allowed.`
              : `This account already has ${event.maxSubmissions} proposals, the limit for this event. Open an existing draft or contact the program team if one should be withdrawn.`
          }
          title={
            state === "closed"
              ? "The call for proposals is closed"
              : "Submission limit reached"
          }
          state="empty"
        />
      </main>
    </div>
  );
}

function PublicCfpHeader() {
  const event = publicCfpEventFixture;
  return (
    <header className="public-cfp-header">
      <PublicCfpBrand />
      <div className="public-cfp-deadline">
        <Clock3 aria-hidden="true" size={16} />
        <span>
          <small>Proposals close</small>
          <strong>{event.closesLabel}</strong>
        </span>
      </div>
    </header>
  );
}

function Progress({ step }: { step: PublicCfpStep }) {
  const activeIndex = stepIndex(step);
  return (
    <nav
      aria-label="Application progress"
      className="public-cfp-progress"
      tabIndex={0}
    >
      <ol>
        {publicCfpSteps.map((item, index) => {
          const complete = index < activeIndex;
          const active = item.id === step;
          return (
            <li
              className={active ? "is-active" : complete ? "is-complete" : ""}
              key={item.id}
            >
              <span aria-hidden="true">
                {complete ? <Check size={14} /> : index + 1}
              </span>
              <strong aria-current={active ? "step" : undefined}>
                {item.label}
              </strong>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function SaveStatus({ state }: { state: PublicCfpSaveState }) {
  const presentation = saveStatePresentation(state);
  return (
    <div className={`public-cfp-save is-${state}`} role="status">
      {state === "offline" ? <WifiOff aria-hidden="true" size={15} /> : null}
      <StatusPill tone={presentation.tone}>{presentation.label}</StatusPill>
    </div>
  );
}

function Welcome({ onStart }: { onStart: () => void }) {
  const event = publicCfpEventFixture;
  return (
    <div className="public-cfp-welcome">
      <section className="public-cfp-hero">
        <p className="overline">Share what you learned building real systems</p>
        <h1>Bring the work behind the breakthrough.</h1>
        <p>
          We are building a practical program for people shipping AI products
          and infrastructure. Show attendees the decisions, tradeoffs, failures,
          and evidence they can use in their own work.
        </p>
        <div className="public-cfp-hero-actions">
          <Button onClick={onStart}>
            Start a proposal <ArrowRight aria-hidden="true" size={17} />
          </Button>
          <a href="#program-notes">Read the program notes</a>
        </div>
        <div className="public-cfp-event-facts">
          <span>
            <CalendarDays aria-hidden="true" size={18} />
            <strong>{event.eventDateLabel}</strong>
          </span>
          <span>
            <MapPin aria-hidden="true" size={18} />
            <strong>{event.location}</strong>
          </span>
          <span>
            <FileText aria-hidden="true" size={18} />
            <strong>Up to {event.maxSubmissions} proposals</strong>
          </span>
        </div>
      </section>

      <section className="public-cfp-section" id="program-notes">
        <div>
          <p className="overline">Program direction</p>
          <h2>Specific beats sweeping.</h2>
          <p>
            The strongest proposals make a focused claim, show credible
            experience, and leave attendees with techniques they can apply.
            Product pitches and lightly repackaged documentation are not a fit.
          </p>
        </div>
        <div className="public-cfp-track-grid">
          {event.tracks.map((track) => (
            <article key={track.routeKey}>
              <span aria-hidden="true" />
              <h3>{track.selection}</h3>
              <p>{track.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section
        className="public-cfp-section public-cfp-selection"
        id="selection"
      >
        <div>
          <p className="overline">Selection & support</p>
          <h2>A clear, human review.</h2>
        </div>
        <ol>
          <li>
            <strong>1</strong>
            <span>
              <b>Submit by the deadline</b>Autosave protects your draft before
              final submission.
            </span>
          </li>
          <li>
            <strong>2</strong>
            <span>
              <b>Independent program review</b>Reviewers score the same
              published rubric and disclose conflicts.
            </span>
          </li>
          <li>
            <strong>3</strong>
            <span>
              <b>Decisions with next steps</b>Every applicant receives a
              decision and accepted speakers enter the portal.
            </span>
          </li>
        </ol>
        <p>
          Need an accommodation or unsure where an idea belongs? Email{" "}
          <a href={`mailto:${event.contactEmail}`}>{event.contactEmail}</a>.
        </p>
      </section>
    </div>
  );
}

interface AccountProps {
  draft: PublicCfpDraft;
  fixtureState: PublicCfpFixtureState | undefined;
  onChange: (draft: PublicCfpDraft) => void;
  onContinue: () => void;
}

function Account({ draft, fixtureState, onChange, onContinue }: AccountProps) {
  const [requestState, setRequestState] = useState<
    "editing" | "sending" | "sent" | "error"
  >(draft.verified ? "sent" : "editing");
  const [error, setError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileWidgetHandle>(null);

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const redirectPath = "/e/ai-engineer-summit/cfp";
    const magicLink = magicLinkRequestSchema.safeParse({
      email: draft.email,
      purpose: "sign_in",
      redirect_path: redirectPath,
    });
    if (!magicLink.success) {
      setError("Enter a valid email address.");
      return;
    }
    if (fixtureState) {
      setRequestState("sending");
      window.setTimeout(() => setRequestState("sent"), 250);
      return;
    }
    const parsed = protectedMagicLinkRequestSchema.safeParse({
      ...magicLink.data,
      event_slug: "ai-engineer-summit",
      turnstile_action: "cfp_account",
      turnstile_token: turnstileToken,
    });
    if (!parsed.success) {
      setError(
        turnstileToken
          ? "Enter a valid email address."
          : "Complete the security check before requesting a link.",
      );
      return;
    }

    setRequestState("sending");

    try {
      const response = await fetch("/api/auth/magic-links", {
        body: JSON.stringify(parsed.data),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("request_failed");
      }
      setRequestState("sent");
    } catch {
      setRequestState("error");
      setError(
        "We couldn’t send the verification link. Your draft is safe; try again.",
      );
    } finally {
      turnstile.current?.reset();
    }
  }

  if (draft.verified) {
    return (
      <section className="public-cfp-card public-cfp-account-result">
        <span className="public-cfp-success-icon" aria-hidden="true">
          <Check size={22} />
        </span>
        <p className="overline">Email verified</p>
        <h1>Welcome back.</h1>
        <p>
          Continue as <strong>{draft.email}</strong>. This address receives your
          receipt and private link to resume later.
        </p>
        <Button onClick={onContinue}>
          Continue to your proposal <ArrowRight aria-hidden="true" size={17} />
        </Button>
      </section>
    );
  }

  return (
    <section className="public-cfp-card">
      <p className="overline">Step 2 of 6</p>
      <h1>Save your place.</h1>
      <p className="public-cfp-intro">
        We will email a private, one-time link. It brings you back to this exact
        application without creating a password.
      </p>
      {requestState === "sent" ? (
        <div className="public-cfp-link-sent" role="status">
          <Mail aria-hidden="true" size={24} />
          <div>
            <h2>Check your inbox</h2>
            <p>
              If <strong>{draft.email}</strong> can continue, a link is on its
              way. It expires in 15 minutes and works once.
            </p>
          </div>
          {fixtureState ? (
            <Button
              onClick={() => {
                onChange({ ...draft, verified: true });
              }}
            >
              Continue from verified fixture
            </Button>
          ) : null}
          <button
            className="public-cfp-text-button"
            onClick={() => setRequestState("editing")}
            type="button"
          >
            Use another email
          </button>
        </div>
      ) : (
        <form className="public-cfp-form" onSubmit={requestLink}>
          {error ? (
            <ErrorSummary
              errors={[{ fieldId: "account-email", message: error }]}
              title="Check your email"
            />
          ) : null}
          <TextField
            autoComplete="email"
            autoFocus
            error={error}
            id="account-email"
            label="Email address"
            onChange={(event) =>
              onChange({ ...draft, email: event.target.value })
            }
            placeholder="you@example.com"
            required
            type="email"
            value={draft.email}
          />
          {!fixtureState ? (
            <TurnstileWidget
              action="cfp_account"
              onTokenChange={setTurnstileToken}
              ref={turnstile}
            />
          ) : null}
          <Button
            disabled={
              requestState === "sending" || (!fixtureState && !turnstileToken)
            }
            type="submit"
          >
            {requestState === "sending"
              ? "Sending secure link…"
              : "Email my private link"}
          </Button>
          {requestState === "error" ? (
            <button
              className="public-cfp-text-button"
              onClick={() => setRequestState("editing")}
              type="button"
            >
              Try again
            </button>
          ) : null}
        </form>
      )}
      <div className="public-cfp-security-note">
        <ShieldCheck aria-hidden="true" size={18} />
        <p>
          <strong>Private and short-lived.</strong> We do not reveal whether an
          arbitrary address already has an application.
        </p>
      </div>
    </section>
  );
}

interface StepProps {
  draft: PublicCfpDraft;
  errors: Record<string, string>;
  onBack: () => void;
  onChange: (draft: PublicCfpDraft) => void;
  onContinue: () => void;
}

interface SubmissionProps extends StepProps {
  onAnnounce: (message: string) => void;
}

function Submission({
  draft,
  errors,
  onAnnounce,
  onBack,
  onChange,
  onContinue,
}: SubmissionProps) {
  const event = publicCfpEventFixture;
  const ruleEvaluation = evaluateCfpRules(publicCfpRuleFields, {
    abstract: draft.abstract,
    format: draft.format,
    outcomes: draft.outcomes,
    title: draft.title,
    track: draft.track,
    workshopPrerequisites: draft.workshopPrerequisites,
  });
  const workshopState = ruleEvaluation.fields.find(
    (field) => field.key === "workshopPrerequisites",
  );

  function changeFormat(format: string) {
    const nextEvaluation = evaluateCfpRules(publicCfpRuleFields, {
      ...ruleEvaluation.answers,
      format,
      workshopPrerequisites: draft.workshopPrerequisites,
    });
    const transition = visibleFieldTransitions(
      ruleEvaluation.fields,
      nextEvaluation.fields,
    ).find((item) => item.key === "workshopPrerequisites");
    onChange({
      ...draft,
      format,
      workshopPrerequisites:
        typeof nextEvaluation.answers.workshopPrerequisites === "string"
          ? nextEvaluation.answers.workshopPrerequisites
          : "",
    });
    if (transition?.visible) {
      onAnnounce("Workshop prerequisites is now visible and required.");
    } else if (transition) {
      onAnnounce(
        "Workshop prerequisites is now hidden. Its saved answer was cleared.",
      );
    }
  }

  function changeTrack(track: string) {
    const route = resolveCfpTrackRoute(publicCfpTrackRoutes, track);
    onChange({
      ...draft,
      defaultReviewerGroupId: route?.defaultReviewerGroupId ?? "",
      routeKey: route?.routeKey ?? "",
      submissionTrack: route?.submissionTrack ?? "",
      track,
    });
    onAnnounce(
      route
        ? `${track} routes to ${route.submissionTrack}.`
        : `${track} does not have a reviewer route.`,
    );
  }
  return (
    <section className="public-cfp-card public-cfp-wide-card">
      <p className="overline">Step 3 of 6</p>
      <h1>Shape the session.</h1>
      <p className="public-cfp-intro">
        Write for reviewers first. If selected, the program team will help
        refine public copy.
      </p>
      {Object.keys(errors).length ? (
        <ErrorSummary
          errors={Object.entries(errors).map(([fieldId, message]) => ({
            fieldId,
            message,
          }))}
          title="Complete the proposal"
        />
      ) : null}
      <div className="public-cfp-form-grid">
        <TextField
          error={errors["proposal-title"] ?? ""}
          id="proposal-title"
          label="Session title"
          maxLength={100}
          onChange={(event) =>
            onChange({ ...draft, title: event.target.value })
          }
          required
          value={draft.title}
        />
        <div className="public-cfp-character-count">
          {draft.title.length} / 100
        </div>
        <TextAreaField
          description="What will attendees learn, and why does it matter now?"
          error={errors["proposal-abstract"] ?? ""}
          id="proposal-abstract"
          label="Abstract"
          maxLength={1200}
          onChange={(event) =>
            onChange({ ...draft, abstract: event.target.value })
          }
          required
          rows={7}
          value={draft.abstract}
        />
        <div className="public-cfp-character-count">
          {draft.abstract.length} / 1,200
        </div>
        <TextAreaField
          description="One outcome per line. Be concrete enough that a reviewer can picture the session."
          error={errors["proposal-outcomes"] ?? ""}
          id="proposal-outcomes"
          label="What will attendees be able to do?"
          onChange={(event) =>
            onChange({ ...draft, outcomes: event.target.value })
          }
          required
          rows={5}
          value={draft.outcomes}
        />
        <div className="public-cfp-two-column">
          <SelectField
            error={errors["proposal-track"] ?? ""}
            id="proposal-track"
            label="Track"
            onChange={(event) => changeTrack(event.target.value)}
            options={event.tracks.map((track) => ({
              label: track.selection,
              value: track.selection,
            }))}
            value={draft.track}
          />
          <SelectField
            id="proposal-format"
            label="Format"
            onChange={(event) => changeFormat(event.target.value)}
            options={event.formats.map((format) => ({
              label: format,
              value: format,
            }))}
            value={draft.format}
          />
        </div>
        <p className="public-cfp-route-note">
          <strong>Review route:</strong>{" "}
          {draft.submissionTrack || "Choose a mapped track"}
        </p>
        {workshopState?.visible ? (
          <TextAreaField
            description="List required software, accounts, setup, and prior experience. Hidden answers are cleared if the format changes."
            error={errors["proposal-workshop-prerequisites"] ?? ""}
            id="proposal-workshop-prerequisites"
            label="Workshop prerequisites"
            onChange={(event) =>
              onChange({
                ...draft,
                workshopPrerequisites: event.target.value,
              })
            }
            required={workshopState.required}
            rows={5}
            value={draft.workshopPrerequisites}
          />
        ) : null}
      </div>
      <StepActions onBack={onBack} onContinue={onContinue} />
    </section>
  );
}

function newSpeaker(index: number): PublicCfpSpeakerDraft {
  return {
    email: "",
    id: `speaker-${Date.now()}-${index}`,
    name: "",
    role: "",
  };
}

function Participants({
  draft,
  errors,
  onBack,
  onChange,
  onContinue,
}: StepProps) {
  const speakers = draft.speakers.length
    ? draft.speakers
    : [{ ...newSpeaker(0), email: draft.email, id: "speaker-primary" }];

  function updateSpeaker(
    index: number,
    changes: Partial<PublicCfpSpeakerDraft>,
  ) {
    const next = speakers.map((speaker, speakerIndex) =>
      speakerIndex === index ? { ...speaker, ...changes } : speaker,
    );
    onChange({ ...draft, speakers: next });
  }

  return (
    <section className="public-cfp-card public-cfp-wide-card">
      <p className="overline">Step 4 of 6</p>
      <h1>Who is presenting?</h1>
      <p className="public-cfp-intro">
        The primary speaker controls this application. Co-speakers receive their
        own profile invitation if the proposal is accepted.
      </p>
      {Object.keys(errors).length ? (
        <ErrorSummary
          errors={Object.entries(errors).map(([fieldId, message]) => ({
            fieldId,
            message,
          }))}
          title="Complete participant details"
        />
      ) : null}
      <div className="public-cfp-speaker-list">
        {speakers.map((speaker, index) => (
          <fieldset key={speaker.id}>
            <legend>
              {index === 0 ? "Primary speaker" : `Co-speaker ${index}`}
            </legend>
            <div className="public-cfp-two-column">
              <TextField
                error={errors[`speaker-${index}-name`] ?? ""}
                id={`speaker-${index}-name`}
                label="Display name"
                onChange={(event) =>
                  updateSpeaker(index, { name: event.target.value })
                }
                required
                value={speaker.name}
              />
              <TextField
                error={errors[`speaker-${index}-email`] ?? ""}
                id={`speaker-${index}-email`}
                label="Email"
                onChange={(event) =>
                  updateSpeaker(index, { email: event.target.value })
                }
                readOnly={index === 0}
                required
                type="email"
                value={speaker.email}
              />
              <TextField
                className="public-cfp-span-two"
                id={`speaker-${index}-role`}
                label="Title or role"
                onChange={(event) =>
                  updateSpeaker(index, { role: event.target.value })
                }
                placeholder="Principal engineer"
                value={speaker.role}
              />
            </div>
            {index > 0 ? (
              <button
                className="public-cfp-remove-speaker"
                onClick={() =>
                  onChange({
                    ...draft,
                    speakers: speakers.filter(
                      (_, speakerIndex) => speakerIndex !== index,
                    ),
                  })
                }
                type="button"
              >
                <Trash2 aria-hidden="true" size={15} /> Remove co-speaker
              </button>
            ) : null}
          </fieldset>
        ))}
      </div>
      <button
        className="public-cfp-add-speaker"
        onClick={() =>
          onChange({
            ...draft,
            speakers: [...speakers, newSpeaker(speakers.length)],
          })
        }
        type="button"
      >
        <Plus aria-hidden="true" size={16} /> Add a co-speaker
      </button>
      <StepActions onBack={onBack} onContinue={onContinue} />
    </section>
  );
}

function ReviewSection({
  children,
  onEdit,
  title,
}: {
  children: React.ReactNode;
  onEdit: () => void;
  title: string;
}) {
  return (
    <section className="public-cfp-review-section">
      <header>
        <h2>{title}</h2>
        <button onClick={onEdit} type="button">
          Edit {title.toLowerCase()}
        </button>
      </header>
      {children}
    </section>
  );
}

interface ReviewProps extends Omit<StepProps, "onContinue"> {
  challengeRequired: boolean;
  onEdit: (step: PublicCfpStep) => void;
  onSubmit: () => void;
  onTurnstileTokenChange: (token: string | null) => void;
  submitError: string;
  submitting: boolean;
  turnstileRef: React.RefObject<TurnstileWidgetHandle | null>;
  turnstileToken: string | null;
}

function Review({
  challengeRequired,
  draft,
  errors,
  onBack,
  onChange,
  onEdit,
  onSubmit,
  onTurnstileTokenChange,
  submitError,
  submitting,
  turnstileRef,
  turnstileToken,
}: ReviewProps) {
  return (
    <section className="public-cfp-card public-cfp-review-card">
      <p className="overline">Step 5 of 6</p>
      <h1>Review before submitting.</h1>
      <p className="public-cfp-intro">
        Submitting locks this version for review. The program team will explain
        whether later edits are allowed.
      </p>
      {Object.keys(errors).length ? (
        <ErrorSummary
          errors={[
            {
              fieldId: "proposal-consent",
              message: errors.consent ?? "Confirm participant consent.",
            },
          ]}
          title="One confirmation remains"
        />
      ) : null}
      {submitError ? (
        <ErrorSummary
          errors={[{ fieldId: "submit-proposal", message: submitError }]}
          title="Your proposal was not submitted"
        />
      ) : null}
      <ReviewSection onEdit={() => onEdit("submission")} title="Proposal">
        <dl>
          <div>
            <dt>Title</dt>
            <dd>{draft.title}</dd>
          </div>
          <div>
            <dt>Track</dt>
            <dd>{draft.submissionTrack}</dd>
          </div>
          <div>
            <dt>Format</dt>
            <dd>{draft.format}</dd>
          </div>
        </dl>
        <h3>Abstract</h3>
        <p>{draft.abstract}</p>
        <h3>Attendee outcomes</h3>
        <ul>
          {draft.outcomes
            .split("\n")
            .filter(Boolean)
            .map((outcome) => (
              <li key={outcome}>{outcome}</li>
            ))}
        </ul>
        {draft.workshopPrerequisites ? (
          <>
            <h3>Workshop prerequisites</h3>
            <p>{draft.workshopPrerequisites}</p>
          </>
        ) : null}
      </ReviewSection>
      <ReviewSection onEdit={() => onEdit("participants")} title="Participants">
        <div className="public-cfp-review-speakers">
          {draft.speakers.map((speaker, index) => (
            <article key={speaker.id}>
              <span aria-hidden="true">
                <Users size={16} />
              </span>
              <div>
                <strong>{speaker.name}</strong>
                <small>
                  {index === 0 ? "Primary speaker" : "Co-speaker"} ·{" "}
                  {speaker.email}
                </small>
              </div>
            </article>
          ))}
        </div>
      </ReviewSection>
      <label className="public-cfp-consent" htmlFor="proposal-consent">
        <input
          aria-describedby={
            errors.consent ? "proposal-consent-error" : undefined
          }
          aria-invalid={Boolean(errors.consent)}
          checked={draft.consent}
          id="proposal-consent"
          onChange={(event) =>
            onChange({ ...draft, consent: event.target.checked })
          }
          type="checkbox"
        />
        <span>
          <strong>I confirm everyone listed agreed to participate.</strong>
          <small>
            I understand this proposal is shared with authorized program
            reviewers and can be withdrawn by contacting the team.
          </small>
        </span>
      </label>
      {errors.consent ? (
        <p className="public-cfp-inline-error" id="proposal-consent-error">
          {errors.consent}
        </p>
      ) : null}
      {challengeRequired ? (
        <TurnstileWidget
          action="cfp_submit"
          onTokenChange={onTurnstileTokenChange}
          ref={turnstileRef}
        />
      ) : null}
      <div className="public-cfp-step-actions">
        <button className="public-cfp-back" onClick={onBack} type="button">
          <ArrowLeft aria-hidden="true" size={16} /> Back
        </button>
        <Button
          disabled={submitting || (challengeRequired && !turnstileToken)}
          id="submit-proposal"
          onClick={onSubmit}
        >
          {submitting ? "Submitting once…" : "Submit proposal"}{" "}
          <ArrowRight aria-hidden="true" size={16} />
        </Button>
      </div>
    </section>
  );
}

function Confirmation({
  confirmationId,
  email,
}: {
  confirmationId: string;
  email: string;
}) {
  return (
    <section className="public-cfp-card public-cfp-confirmation">
      <span className="public-cfp-success-icon" aria-hidden="true">
        <CheckCircle2 size={28} />
      </span>
      <p className="overline">Proposal received</p>
      <h1>You’re in the review queue.</h1>
      <p>
        We sent one receipt to <strong>{email}</strong>. Keep the private link
        in that message to view the submitted version or any permitted edits.
      </p>
      <div className="public-cfp-confirmation-id">
        <small>Confirmation ID</small>
        <strong>{confirmationId}</strong>
      </div>
      <div className="public-cfp-confirmation-next">
        <h2>What happens next</h2>
        <ul>
          <li>Review begins after August 21.</li>
          <li>Decision emails are planned for September 4.</li>
          <li>Accepted speakers receive a private onboarding portal.</li>
        </ul>
      </div>
      <a
        className="public-cfp-primary-link"
        href="/e/ai-engineer-summit/schedule"
      >
        Visit the event schedule <ExternalLink aria-hidden="true" size={15} />
      </a>
    </section>
  );
}

function StepActions({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="public-cfp-step-actions">
      <button className="public-cfp-back" onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={16} /> Back
      </button>
      <Button onClick={onContinue}>
        Continue <ArrowRight aria-hidden="true" size={16} />
      </Button>
    </div>
  );
}

function validationFor(step: PublicCfpStep, draft: PublicCfpDraft) {
  const errors: Record<string, string> = {};
  if (step === "submission") {
    if (draft.title.trim().length < 8)
      errors["proposal-title"] =
        "Use at least 8 characters for the session title.";
    if (draft.abstract.trim().length < 120)
      errors["proposal-abstract"] =
        "Use at least 120 characters so reviewers have enough context.";
    if (!draft.outcomes.trim())
      errors["proposal-outcomes"] = "Add at least one attendee outcome.";
    if (!resolveCfpTrackRoute(publicCfpTrackRoutes, draft.track))
      errors["proposal-track"] =
        "Choose a track with a configured reviewer route.";
    const evaluation = evaluateCfpRules(publicCfpRuleFields, {
      abstract: draft.abstract,
      format: draft.format,
      outcomes: draft.outcomes,
      title: draft.title,
      track: draft.track,
      workshopPrerequisites: draft.workshopPrerequisites,
    });
    const workshopState = evaluation.fields.find(
      (field) => field.key === "workshopPrerequisites",
    );
    if (
      workshopState?.visible &&
      workshopState.required &&
      !draft.workshopPrerequisites.trim()
    )
      errors["proposal-workshop-prerequisites"] =
        "Add workshop prerequisites before continuing.";
  }
  if (step === "participants") {
    const speakers = draft.speakers.length
      ? draft.speakers
      : [{ ...newSpeaker(0), email: draft.email }];
    speakers.forEach((speaker, index) => {
      if (!speaker.name.trim())
        errors[`speaker-${index}-name`] = "Enter this speaker’s display name.";
      if (!/^\S+@\S+\.\S+$/.test(speaker.email))
        errors[`speaker-${index}-email`] = "Enter a valid email address.";
    });
  }
  if (step === "review" && !draft.consent)
    errors.consent = "Confirm participant consent before submitting.";
  return errors;
}

type InteractiveFixtureState = Exclude<
  PublicCfpFixtureState,
  "closed" | "limit"
>;

function InteractivePublicCfpFlow({
  fixtureState,
}: {
  fixtureState: InteractiveFixtureState | undefined;
}) {
  const [draft, setDraft] = useState(() => readDraft(fixtureState));
  const [saveState, setSaveState] = useState<PublicCfpSaveState>(
    fixtureState === "offline"
      ? "offline"
      : fixtureState === "failed"
        ? "failed"
        : fixtureState === "resume" || readStorage(draftStorageKey)
          ? "saved"
          : "idle",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submissionTurnstileToken, setSubmissionTurnstileToken] = useState<
    string | null
  >(null);
  const [confirmationId, setConfirmationId] = useState(() =>
    fixtureState ? (readStorage(confirmationStorageKey) ?? "") : "",
  );
  const saveTimer = useRef<number | null>(null);
  const submissionKey = useRef<string | null>(null);
  const submissionTurnstile = useRef<TurnstileWidgetHandle>(null);

  useEffect(() => {
    if (
      fixtureState ||
      draft.verified ||
      draft.step === "welcome" ||
      draft.step === "confirmation" ||
      !draft.email
    ) {
      return;
    }
    const controller = new AbortController();
    void fetch("/api/auth/session", {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { user?: { email?: string } };
      })
      .then((session) => {
        if (session?.user?.email && session.user.email === draft.email) {
          setDraft((current) => ({ ...current, verified: true }));
          setAnnouncement("Email verified. Continue to your proposal.");
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError"))
          return;
      });
    return () => controller.abort();
  }, [draft.email, draft.step, draft.verified, fixtureState]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  function change(next: PublicCfpDraft) {
    setDraft(next);
    setErrors({});
    if (next.step === "welcome" || next.step === "confirmation") return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    if (fixtureState === "failed") {
      setSaveState("failed");
      setAnnouncement(
        "We could not save this change. Your previous draft remains available.",
      );
      return;
    }

    const saved = writeStorage(draftStorageKey, JSON.stringify(next));
    if (fixtureState === "offline") {
      setSaveState(saved ? "offline" : "failed");
      setAnnouncement(
        saved
          ? "You are offline. This draft is saved on this device and will need to sync later."
          : "We could not save this change on this device.",
      );
      return;
    }
    if (!saved) {
      setSaveState("failed");
      setAnnouncement("We could not save this change on this device.");
      return;
    }

    setSaveState("saving");
    saveTimer.current = window.setTimeout(() => {
      setSaveState("saved");
      setAnnouncement("Draft saved.");
    }, 450);
  }

  function moveTo(step: PublicCfpStep) {
    change({ ...draft, step });
    setAnnouncement(
      `Moved to ${publicCfpSteps.find((item) => item.id === step)?.label}.`,
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function continueFrom(step: PublicCfpStep, next: PublicCfpStep) {
    const nextErrors = validationFor(step, draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setAnnouncement("Check the highlighted fields before continuing.");
      window.setTimeout(
        () =>
          document.querySelector<HTMLElement>(".ui-error-summary a")?.focus(),
        0,
      );
      return;
    }
    moveTo(next);
  }

  function completeSubmission(id: string) {
    writeStorage(confirmationStorageKey, id);
    writeStorage(
      draftStorageKey,
      JSON.stringify({ ...draft, step: "confirmation" }),
    );
    removeStorage(idempotencyStorageKey);
    submissionKey.current = null;
    setConfirmationId(id);
    setDraft((current) => ({ ...current, step: "confirmation" }));
    setSubmitting(false);
    setAnnouncement(`Proposal submitted once. Confirmation ${id}.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submit() {
    const nextErrors = validationFor("review", draft);
    setErrors(nextErrors);
    setSubmitError("");
    if (Object.keys(nextErrors).length) {
      setAnnouncement("Confirm participant consent before submitting.");
      return;
    }
    const route = resolveCfpTrackRoute(publicCfpTrackRoutes, draft.track);
    if (
      !route ||
      route.routeKey !== draft.routeKey ||
      route.submissionTrack !== draft.submissionTrack ||
      route.defaultReviewerGroupId !== draft.defaultReviewerGroupId
    ) {
      setSubmitError(
        "This proposal does not have a valid reviewer route. Return to the proposal and choose a mapped track.",
      );
      setAnnouncement(
        "Submission stopped because the reviewer route is missing or invalid.",
      );
      return;
    }
    if (submitting) return;
    if (!fixtureState && !submissionTurnstileToken) {
      setSubmitError("Complete the security check before submitting.");
      setAnnouncement("Complete the security check before submitting.");
      return;
    }
    setSubmitting(true);

    if (fixtureState) {
      window.setTimeout(() => {
        const existing = readStorage(confirmationStorageKey);
        completeSubmission(
          existing || `AES-${Math.floor(100000 + Math.random() * 900000)}`,
        );
      }, 500);
      return;
    }

    const submission = protectedPublicCfpSubmissionRequestSchema.safeParse({
      answers: {
        abstract: draft.abstract,
        format: draft.format,
        outcomes: draft.outcomes,
        title: draft.title,
        track: draft.track,
        workshop_prerequisites: draft.workshopPrerequisites,
      },
      participants: draft.speakers,
      routing: {
        default_reviewer_group_id: draft.defaultReviewerGroupId,
        route_key: draft.routeKey,
        submission_track: draft.submissionTrack,
      },
      turnstile_action: "cfp_submit",
      turnstile_token: submissionTurnstileToken,
    });
    if (!submission.success) {
      setSubmitting(false);
      setSubmitError(
        "This version exceeds a field or participant limit. Your draft is safe; review the highlighted content.",
      );
      setAnnouncement("Submission stopped because a field limit was exceeded.");
      return;
    }

    const idempotencyKey =
      submissionKey.current ??
      readStorage(idempotencyStorageKey) ??
      window.crypto.randomUUID();
    submissionKey.current = idempotencyKey;
    writeStorage(idempotencyStorageKey, idempotencyKey);

    try {
      const response = await fetch(
        "/api/v1/public/events/ai-engineer-summit/submissions",
        {
          body: JSON.stringify(submission.data),
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          method: "POST",
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      const submissionId =
        payload &&
        typeof payload === "object" &&
        "submission_id" in payload &&
        typeof payload.submission_id === "string"
          ? payload.submission_id
          : null;
      if (response.status === 429) {
        const retryAfter = Number.parseInt(
          response.headers.get("Retry-After") ?? "60",
          10,
        );
        throw new Error(
          `rate_limited:${Number.isFinite(retryAfter) ? retryAfter : 60}`,
        );
      }
      if (!response.ok || !submissionId) {
        throw new Error("submission_failed");
      }
      completeSubmission(submissionId);
    } catch (error) {
      setSubmitting(false);
      setSubmitError(
        error instanceof Error && error.message.startsWith("rate_limited:")
          ? `Too many attempts. Your draft is safe; retry in about ${error.message.split(":")[1]} seconds.`
          : "We couldn’t submit this version. Your draft is still safe; retry when the connection recovers.",
      );
      setAnnouncement("Submission failed. Your draft remains available.");
    } finally {
      submissionTurnstile.current?.reset();
    }
  }

  const visibleSaveState = useMemo(
    () =>
      draft.step === "welcome" || draft.step === "confirmation"
        ? null
        : saveState,
    [draft.step, saveState],
  );

  const effectiveStep =
    !fixtureState &&
    !draft.verified &&
    draft.step !== "welcome" &&
    draft.step !== "confirmation"
      ? "account"
      : draft.step;

  const content =
    effectiveStep === "welcome" ? (
      <Welcome onStart={() => moveTo("account")} />
    ) : effectiveStep === "account" ? (
      <Account
        draft={draft}
        fixtureState={fixtureState}
        onChange={change}
        onContinue={() => moveTo("submission")}
      />
    ) : effectiveStep === "submission" ? (
      <Submission
        draft={draft}
        errors={errors}
        onAnnounce={setAnnouncement}
        onBack={() => moveTo("account")}
        onChange={change}
        onContinue={() => continueFrom("submission", "participants")}
      />
    ) : effectiveStep === "participants" ? (
      <Participants
        draft={draft}
        errors={errors}
        onBack={() => moveTo("submission")}
        onChange={change}
        onContinue={() => continueFrom("participants", "review")}
      />
    ) : effectiveStep === "review" ? (
      <Review
        challengeRequired={!fixtureState}
        draft={draft}
        errors={errors}
        onBack={() => moveTo("participants")}
        onChange={change}
        onEdit={moveTo}
        onSubmit={submit}
        onTurnstileTokenChange={setSubmissionTurnstileToken}
        submitError={submitError}
        submitting={submitting}
        turnstileRef={submissionTurnstile}
        turnstileToken={submissionTurnstileToken}
      />
    ) : (
      <Confirmation confirmationId={confirmationId} email={draft.email} />
    );

  return (
    <div className="public-cfp-flow">
      <PublicCfpHeader />
      {effectiveStep !== "welcome" ? <Progress step={effectiveStep} /> : null}
      {visibleSaveState ? <SaveStatus state={visibleSaveState} /> : null}
      <main>{content}</main>
      <footer>
        <PublicCfpBrand />
        <p>
          Questions?{" "}
          <a href={`mailto:${publicCfpEventFixture.contactEmail}`}>
            {publicCfpEventFixture.contactEmail}
          </a>
        </p>
        <p>Deadlines are shown in {publicCfpEventFixture.timezoneLabel}.</p>
      </footer>
      <LiveRegion message={announcement} />
    </div>
  );
}

export function PublicCfpFlow({
  fixtureState,
}: {
  fixtureState?: PublicCfpFixtureState;
}) {
  if (fixtureState === "closed" || fixtureState === "limit") {
    return <PolicyState state={fixtureState} />;
  }

  return <InteractivePublicCfpFlow fixtureState={fixtureState} />;
}
