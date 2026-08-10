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
  protectedPublicCfpSubmissionUpdateRequestSchema,
  publicCfpConfigurationResponseSchema,
  publicCfpOwnedSubmissionsResponseSchema,
  publicCfpParticipantEmailSchema,
  publicCfpSubmissionResponseSchema,
  type PublicCfpConfigurationResponse,
  type PublicCfpOwnedDraft,
  type PublicCfpOwnedSubmission,
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
  AuthApiError,
  readAuthSession,
  readCsrfToken,
} from "../auth/authClient";

import {
  TurnstileWidget,
  type TurnstileWidgetHandle,
} from "../security/TurnstileWidget";

import {
  emptyPublicCfpDraft,
  publicCfpDraftContent,
  publicCfpDraftForConfiguration,
  publicCfpDraftFromServer,
  publicCfpConfigurationSupportsFlow,
  publicCfpEventFixture,
  publicCfpEventFromConfiguration,
  publicCfpRuleFields,
  publicCfpRuleFieldsFromConfiguration,
  publicCfpSteps,
  publicCfpTrackRoutes,
  resumedPublicCfpDraft,
  type PublicCfpDraft,
  type PublicCfpSaveState,
  type PublicCfpSpeakerDraft,
  type PublicCfpStep,
  type PublicCfpEventView,
} from "./publicCfpModel";

import "./public-cfp-flow.css";

export type PublicCfpFixtureState =
  "closed" | "failed" | "interactive" | "limit" | "offline" | "resume";

const defaultPublicCfpSlug = "ai-engineer-summit";
const publicCfpSlug =
  /^\/e\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/cfp\/?$/u.exec(
    window.location.pathname,
  )?.[1] ?? defaultPublicCfpSlug;
const storageNamespace = `opensession.public-cfp.${publicCfpSlug}`;
const draftStorageKey = `${storageNamespace}.draft`;
const confirmationStorageKey = `${storageNamespace}.confirmation`;
const idempotencyStorageKey = `${storageNamespace}.idempotency`;
const serverDraftStorageKey = `${storageNamespace}.server-draft`;
const unsyncedDraftStorageKey = `${storageNamespace}.unsynced-draft`;
const conflictBackupStorageKey = `${storageNamespace}.conflict-backup`;
const cfpFormVersion = 2;

interface ServerDraftMetadata {
  friendlyId: string;
  formVersion: number;
  lastSyncedFingerprint: string;
  sourceVersion: number;
  submissionId: string;
}

interface DraftReconciliationConflict {
  local: PublicCfpDraft;
  remote: PublicCfpOwnedSubmission;
}

interface DraftSaveContext {
  epoch: number;
}

interface FinalSubmissionIdentity {
  fingerprint: string;
  key: string;
}

function readFinalSubmissionIdentity(): FinalSubmissionIdentity | null {
  try {
    const raw = readStorage(idempotencyStorageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<FinalSubmissionIdentity>;
    return typeof candidate.fingerprint === "string" &&
      candidate.fingerprint.length <= 110_000 &&
      typeof candidate.key === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/.test(candidate.key)
      ? { fingerprint: candidate.fingerprint, key: candidate.key }
      : null;
  } catch {
    return null;
  }
}

function isServerDraftMetadata(value: unknown): value is ServerDraftMetadata {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ServerDraftMetadata>;
  return (
    typeof candidate.friendlyId === "string" &&
    Number.isInteger(candidate.formVersion) &&
    Number(candidate.formVersion) > 0 &&
    typeof candidate.lastSyncedFingerprint === "string" &&
    candidate.lastSyncedFingerprint.length <= 110_000 &&
    Number.isInteger(candidate.sourceVersion) &&
    Number(candidate.sourceVersion) > 0 &&
    typeof candidate.submissionId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(candidate.submissionId)
  );
}

function readServerDraftMetadata(): ServerDraftMetadata | null {
  try {
    const raw = readStorage(serverDraftStorageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return isServerDraftMetadata(value) ? value : null;
  } catch {
    return null;
  }
}

function metadataFromDraft(draft: PublicCfpOwnedDraft): ServerDraftMetadata {
  return {
    friendlyId: draft.friendly_id,
    formVersion: draft.form_version,
    lastSyncedFingerprint: JSON.stringify({
      content: draft.content,
      formVersion: draft.form_version,
    }),
    sourceVersion: draft.source_version,
    submissionId: draft.submission_id,
  };
}

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

function meaningfulLocalDraft(draft: PublicCfpDraft): boolean {
  if (draft.step === "confirmation") return false;
  return Boolean(
    draft.title.trim() ||
    draft.abstract.trim() ||
    draft.outcomes.trim() ||
    draft.workshopPrerequisites.trim() ||
    draft.speakers.length > 1 ||
    draft.speakers.some((speaker) => speaker.role.trim()),
  );
}

function ownedSubmissionTitle(submission: PublicCfpOwnedSubmission): string {
  const title = submission.content.answers.title;
  return typeof title === "string" && title.trim()
    ? title
    : "Untitled proposal";
}

function apiErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return null;
  }
  const error = payload.error;
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
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

function readUnsyncedDraft(): PublicCfpDraft | null {
  try {
    const raw = readStorage(unsyncedDraftStorageKey);
    if (!raw) return null;
    const stored: unknown = JSON.parse(raw);
    if (!isDraft(stored)) return null;
    const draft = normalizeDraft(stored);
    return draft.step === "confirmation"
      ? { ...draft, step: "review", verified: false }
      : { ...draft, verified: false };
  } catch {
    return null;
  }
}

function stepIndex(step: PublicCfpStep) {
  return publicCfpSteps.findIndex((item) => item.id === step);
}

function saveStatePresentation(state: PublicCfpSaveState) {
  switch (state) {
    case "saving":
      return { label: "Saving securely…", tone: "warning" as const };
    case "saved":
      return { label: "Saved securely", tone: "success" as const };
    case "local":
      return { label: "Saved on this device", tone: "neutral" as const };
    case "offline":
      return {
        label: "Offline · saved on this device",
        tone: "warning" as const,
      };
    case "failed":
      return {
        label: "Sync failed · saved on this device",
        tone: "warning" as const,
      };
    default:
      return { label: "Not saved yet", tone: "neutral" as const };
  }
}

function PublicCfpBrand() {
  return (
    <a className="public-cfp-brand" href={`/e/${publicCfpSlug}/cfp`}>
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

function PolicyState({
  event = publicCfpEventFixture,
  state,
}: {
  event?: PublicCfpEventView;
  state: "closed" | "limit" | "upcoming";
}) {
  return (
    <div className="public-cfp-policy-state">
      <PublicCfpHeader event={event} />
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
              ? `The call closed ${event.closesLabel} (${event.timezoneLabel}). Existing applicants can request a new sign-in link when edits are allowed.`
              : state === "upcoming"
                ? `The call opens ${event.opensLabel} (${event.timezoneLabel}). Return then to start a proposal.`
                : event.maxSubmissions === null
                  ? "Open an existing proposal or contact the program team if one should be withdrawn."
                  : `This account already has ${event.maxSubmissions} proposals, the limit for this event. Open an existing draft or contact the program team if one should be withdrawn.`
          }
          title={
            state === "closed"
              ? "The call for proposals is closed"
              : state === "upcoming"
                ? "The call for proposals is not open yet"
                : "Submission limit reached"
          }
          state="empty"
        />
      </main>
    </div>
  );
}

function PublicCfpHeader({
  event = publicCfpEventFixture,
}: {
  event?: PublicCfpEventView;
}) {
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

function Welcome({
  event,
  onStart,
}: {
  event: PublicCfpEventView;
  onStart: () => void;
}) {
  return (
    <div className="public-cfp-welcome">
      <section className="public-cfp-hero">
        <p className="overline">{event.eventName} · Call for proposals</p>
        <h1>Bring the work behind the breakthrough.</h1>
        <p>
          {event.welcomeContent ||
            "Show attendees the decisions, tradeoffs, failures, and evidence they can use in their own work."}
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
            <strong>
              {event.maxSubmissions === null
                ? "No proposal limit"
                : `Up to ${event.maxSubmissions} proposals`}
            </strong>
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
    const redirectPath = `/e/${publicCfpSlug}/cfp`;
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
      event_slug: publicCfpSlug,
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
          receipt. Whenever you return, request a new private sign-in link to
          resume securely.
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
  configuration: PublicCfpConfigurationResponse | null;
  event: PublicCfpEventView;
  onAnnounce: (message: string) => void;
  ruleFields: typeof publicCfpRuleFields;
}

function Submission({
  configuration,
  draft,
  event,
  errors,
  onAnnounce,
  onBack,
  onChange,
  onContinue,
  ruleFields,
}: SubmissionProps) {
  const configuredField = (key: string) =>
    configuration?.form.fields.find((field) => field.key === key);
  const titleField = configuredField("title");
  const abstractField = configuredField("abstract");
  const outcomesField = configuredField("outcomes");
  const trackField = configuredField("track");
  const formatField = configuredField("format");
  const workshopField = configuredField("workshop_prerequisites");
  const ruleEvaluation = evaluateCfpRules(ruleFields, {
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
    const nextEvaluation = evaluateCfpRules(ruleFields, {
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
    const route = resolveCfpTrackRoute(event.tracks, track);
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
          label={titleField?.label ?? "Session title"}
          maxLength={titleField?.validation.maxLength ?? 100}
          onChange={(event) =>
            onChange({ ...draft, title: event.target.value })
          }
          required
          value={draft.title}
        />
        <div className="public-cfp-character-count">
          {draft.title.length} / {titleField?.validation.maxLength ?? 100}
        </div>
        <TextAreaField
          description={
            abstractField?.helpText ||
            "What will attendees learn, and why does it matter now?"
          }
          error={errors["proposal-abstract"] ?? ""}
          id="proposal-abstract"
          label={abstractField?.label ?? "Abstract"}
          maxLength={abstractField?.validation.maxLength ?? 1_200}
          onChange={(event) =>
            onChange({ ...draft, abstract: event.target.value })
          }
          required
          rows={7}
          value={draft.abstract}
        />
        <div className="public-cfp-character-count">
          {draft.abstract.length} /{" "}
          {(abstractField?.validation.maxLength ?? 1_200).toLocaleString()}
        </div>
        <TextAreaField
          description={
            outcomesField?.helpText ||
            "One outcome per line. Be concrete enough that a reviewer can picture the session."
          }
          error={errors["proposal-outcomes"] ?? ""}
          id="proposal-outcomes"
          label={outcomesField?.label ?? "What will attendees be able to do?"}
          maxLength={outcomesField?.validation.maxLength}
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
            label={trackField?.label ?? "Track"}
            onChange={(event) => changeTrack(event.target.value)}
            options={event.tracks.map((track) => ({
              label: track.selection,
              value: track.selection,
            }))}
            value={draft.track}
          />
          <SelectField
            error={errors["proposal-format"] ?? ""}
            id="proposal-format"
            label={formatField?.label ?? "Format"}
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
            description={
              workshopField?.helpText ||
              "List required software, accounts, setup, and prior experience. Hidden answers are cleared if the format changes."
            }
            error={errors["proposal-workshop-prerequisites"] ?? ""}
            id="proposal-workshop-prerequisites"
            label={workshopField?.label ?? "Workshop prerequisites"}
            maxLength={workshopField?.validation.maxLength}
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
                maxLength={160}
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
                maxLength={320}
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
                error={errors[`speaker-${index}-role`] ?? ""}
                id={`speaker-${index}-role`}
                label="Title or role"
                maxLength={160}
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
        disabled={speakers.length >= 8}
        id="add-speaker"
        onClick={() =>
          onChange({
            ...draft,
            speakers: [...speakers, newSpeaker(speakers.length)],
          })
        }
        type="button"
      >
        <Plus aria-hidden="true" size={16} />
        {speakers.length >= 8
          ? "Participant limit reached"
          : "Add a co-speaker"}
      </button>
      <StepActions onBack={onBack} onContinue={onContinue} />
    </section>
  );
}

function ReviewSection({
  children,
  disabled,
  onEdit,
  title,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onEdit: () => void;
  title: string;
}) {
  return (
    <section className="public-cfp-review-section">
      <header>
        <h2>{title}</h2>
        <button disabled={disabled} onClick={onEdit} type="button">
          Edit {title.toLowerCase()}
        </button>
      </header>
      {children}
    </section>
  );
}

interface ReviewProps extends Omit<StepProps, "onContinue"> {
  canSubmit: boolean;
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
  canSubmit,
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
      {!canSubmit ? (
        <div className="public-cfp-inline-notice" role="status">
          <strong>The submission deadline has passed.</strong> Permitted draft
          edits can still be saved, but this version cannot be submitted.
        </div>
      ) : null}
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
      <ReviewSection
        disabled={submitting}
        onEdit={() => onEdit("submission")}
        title="Proposal"
      >
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
      <ReviewSection
        disabled={submitting}
        onEdit={() => onEdit("participants")}
        title="Participants"
      >
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
          disabled={submitting}
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
      {challengeRequired && canSubmit ? (
        <TurnstileWidget
          action="cfp_submit"
          onTokenChange={onTurnstileTokenChange}
          ref={turnstileRef}
        />
      ) : null}
      <div className="public-cfp-step-actions">
        <button
          className="public-cfp-back"
          disabled={submitting}
          onClick={onBack}
          type="button"
        >
          <ArrowLeft aria-hidden="true" size={16} /> Back
        </button>
        <Button
          disabled={
            !canSubmit || submitting || (challengeRequired && !turnstileToken)
          }
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
  status,
}: {
  confirmationId: string;
  email: string;
  status: PublicCfpOwnedSubmission["status"];
}) {
  const presentation = {
    accepted: {
      heading: "Your proposal was accepted.",
      items: [
        "Watch for your private speaker-onboarding invitation.",
        "The program team will confirm schedule and production details.",
        "Keep your confirmation ID for support requests.",
      ],
      overline: "Proposal accepted",
    },
    declined: {
      heading: "The program team completed its review.",
      items: [
        "Your decision notice contains the current outcome.",
        "The submitted version remains part of the event record.",
        "Contact the program team if you need clarification.",
      ],
      overline: "Decision recorded",
    },
    draft: {
      heading: "Your proposal is still a draft.",
      items: [
        "Return to the proposal list to continue editing.",
        "Submit before the published deadline.",
        "Device and server copies are reconciled before every save.",
      ],
      overline: "Draft saved",
    },
    in_review: {
      heading: "Review is underway.",
      items: [
        "Authorized reviewers are evaluating the submitted version.",
        "The program team will send a decision notice.",
        "Keep your confirmation ID for support requests.",
      ],
      overline: "In review",
    },
    submitted: {
      heading: "You’re in the review queue.",
      items: [
        "Review begins after the submission deadline.",
        "The program team will send a decision notice.",
        "Accepted speakers receive a private onboarding portal.",
      ],
      overline: "Proposal received",
    },
    waitlisted: {
      heading: "Your proposal is on the waitlist.",
      items: [
        "The submitted version remains under consideration.",
        "The program team will contact you if space becomes available.",
        "Keep your confirmation ID for support requests.",
      ],
      overline: "Waitlist status",
    },
    withdrawn: {
      heading: "This proposal was withdrawn.",
      items: [
        "It is no longer in the active review pool.",
        "The withdrawal remains in the event record.",
        "Contact the program team if this status is unexpected.",
      ],
      overline: "Proposal withdrawn",
    },
  }[status];
  return (
    <section className="public-cfp-card public-cfp-confirmation">
      <span className="public-cfp-success-icon" aria-hidden="true">
        <CheckCircle2 size={28} />
      </span>
      <p className="overline">{presentation.overline}</p>
      <h1>{presentation.heading}</h1>
      <p>
        This confirmation is securely recorded. The receipt destination is{" "}
        <strong>{email}</strong>; keep the ID below as your durable reference.
        Retrying will not create another receipt.
      </p>
      <div className="public-cfp-confirmation-id">
        <small>Confirmation ID</small>
        <strong>{confirmationId}</strong>
      </div>
      <div className="public-cfp-confirmation-next">
        <h2>What happens next</h2>
        <ul>
          {presentation.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <a
        className="public-cfp-primary-link"
        href={`/e/${publicCfpSlug}/schedule`}
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

function validationFor(
  step: PublicCfpStep,
  draft: PublicCfpDraft,
  configuration: PublicCfpConfigurationResponse | null,
  event: PublicCfpEventView,
  ruleFields: typeof publicCfpRuleFields,
) {
  const errors: Record<string, string> = {};
  if (step === "submission") {
    const configuredField = (key: string) =>
      configuration?.form.fields.find((field) => field.key === key);
    const titleMinimum = configuredField("title")?.validation.minLength ?? 8;
    const abstractMinimum =
      configuredField("abstract")?.validation.minLength ?? 120;
    const outcomesMinimum =
      configuredField("outcomes")?.validation.minLength ?? 1;
    if (draft.title.trim().length < titleMinimum)
      errors["proposal-title"] =
        `Use at least ${titleMinimum} characters for the session title.`;
    if (draft.abstract.trim().length < abstractMinimum)
      errors["proposal-abstract"] =
        `Use at least ${abstractMinimum} characters so reviewers have enough context.`;
    if (draft.outcomes.trim().length < outcomesMinimum)
      errors["proposal-outcomes"] = "Add at least one attendee outcome.";
    if (!resolveCfpTrackRoute(event.tracks, draft.track))
      errors["proposal-track"] =
        "Choose a track with a configured reviewer route.";
    if (!event.formats.includes(draft.format))
      errors["proposal-format"] = "Choose a format offered for this event.";
    const evaluation = evaluateCfpRules(ruleFields, {
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
    if (speakers.length > 8) {
      errors["add-speaker"] = "A proposal can include at most 8 participants.";
    }
    const duplicateIds = new Set<string>();
    const seenIds = new Set<string>();
    const duplicateEmails = new Set<string>();
    const seenEmails = new Set<string>();
    speakers.forEach((speaker) => {
      if (seenIds.has(speaker.id)) duplicateIds.add(speaker.id);
      seenIds.add(speaker.id);
      const email = speaker.email.trim().toLocaleLowerCase("en-US");
      if (seenEmails.has(email)) duplicateEmails.add(email);
      seenEmails.add(email);
    });
    speakers.forEach((speaker, index) => {
      if (!speaker.name.trim())
        errors[`speaker-${index}-name`] = "Enter this speaker’s display name.";
      else if (speaker.name.trim().length > 160)
        errors[`speaker-${index}-name`] =
          "Use 160 characters or fewer for the display name.";
      if (!publicCfpParticipantEmailSchema.safeParse(speaker.email).success)
        errors[`speaker-${index}-email`] = "Enter a valid email address.";
      else if (speaker.email.trim().length > 320)
        errors[`speaker-${index}-email`] =
          "Use 320 characters or fewer for the email address.";
      else if (
        duplicateEmails.has(speaker.email.trim().toLocaleLowerCase("en-US"))
      )
        errors[`speaker-${index}-email`] =
          "Each participant email address must be unique.";
      if (duplicateIds.has(speaker.id))
        errors[`speaker-${index}-name`] =
          "This participant entry is duplicated. Remove it and add it again.";
      if (speaker.role.trim().length > 160)
        errors[`speaker-${index}-role`] =
          "Use 160 characters or fewer for the title or role.";
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
  const [loadedAt] = useState(() => Date.now());
  const [draft, setDraft] = useState(() => readDraft(fixtureState));
  const [saveState, setSaveState] = useState<PublicCfpSaveState>(
    fixtureState === "offline"
      ? "offline"
      : fixtureState === "failed"
        ? "failed"
        : fixtureState === "resume" || readStorage(draftStorageKey)
          ? "local"
          : "idle",
  );
  const [formVersion, setFormVersion] = useState(cfpFormVersion);
  const [configuration, setConfiguration] =
    useState<PublicCfpConfigurationResponse | null>(null);
  const [configurationState, setConfigurationState] = useState<
    "loading" | "ready" | "unavailable" | "unsupported"
  >(fixtureState ? "ready" : "loading");
  const [configurationReady, setConfigurationReady] = useState(
    Boolean(fixtureState),
  );
  const [ownershipReady, setOwnershipReady] = useState(Boolean(fixtureState));
  const [ownershipAttempt, setOwnershipAttempt] = useState(0);
  const [sessionCheckFailed, setSessionCheckFailed] = useState(false);
  const [sessionPrivacyRequired] = useState(
    () =>
      !fixtureState &&
      Boolean(
        draft.email.trim() ||
        draft.speakers.some(
          (speaker) =>
            speaker.email.trim() || speaker.name.trim() || speaker.role.trim(),
        ),
      ),
  );
  const [hasOwnedDraft, setHasOwnedDraft] = useState(false);
  const [ownedSubmissions, setOwnedSubmissions] = useState<
    PublicCfpOwnedSubmission[]
  >([]);
  const [draftConflict, setDraftConflict] =
    useState<DraftReconciliationConflict | null>(null);
  const [conflictBackupReady, setConflictBackupReady] = useState(false);
  const [draftChoices, setDraftChoices] = useState<PublicCfpOwnedSubmission[]>(
    [],
  );
  const [showLocalDraftChoice, setShowLocalDraftChoice] = useState(false);
  const [unsyncedLocalDraft, setUnsyncedLocalDraft] =
    useState<PublicCfpDraft | null>(() =>
      fixtureState ? null : readUnsyncedDraft(),
    );
  const [authenticatedEmail, setAuthenticatedEmail] = useState("");
  const [initialServerDraft] = useState<ServerDraftMetadata | null>(() =>
    fixtureState ? null : readServerDraftMetadata(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [submissionTurnstileToken, setSubmissionTurnstileToken] = useState<
    string | null
  >(null);
  const [confirmationId, setConfirmationId] = useState(() =>
    fixtureState ? (readStorage(confirmationStorageKey) ?? "") : "",
  );
  const [confirmationStatus, setConfirmationStatus] = useState<
    PublicCfpOwnedSubmission["status"] | null
  >(fixtureState && readStorage(confirmationStorageKey) ? "submitted" : null);
  const saveTimer = useRef<number | null>(null);
  const autosaveRequest = useRef<{ fingerprint: string; key: string } | null>(
    null,
  );
  const lastSavedFingerprint = useRef<string | null>(null);
  const latestDraft = useRef(draft);
  const saveChain = useRef<Promise<boolean>>(Promise.resolve(true));
  const saveEpoch = useRef(0);
  const finalized = useRef(false);
  const serverDraftRef = useRef<ServerDraftMetadata | null>(initialServerDraft);
  const unsyncedLocalDraftRef = useRef<PublicCfpDraft | null>(
    unsyncedLocalDraft,
  );
  const submissionIdentity = useRef<FinalSubmissionIdentity | null>(null);
  const submissionTurnstile = useRef<TurnstileWidgetHandle>(null);
  const conflictDialog = useRef<HTMLElement>(null);
  const conflictReturnFocusId = useRef<string | null>(null);
  const conflictWasOpen = useRef(false);
  const flowMain = useRef<HTMLElement>(null);
  const event = useMemo(
    () =>
      configuration
        ? publicCfpEventFromConfiguration(configuration)
        : publicCfpEventFixture,
    [configuration],
  );
  const ruleFields = useMemo(
    () =>
      configuration
        ? publicCfpRuleFieldsFromConfiguration(configuration)
        : publicCfpRuleFields,
    [configuration],
  );

  useEffect(() => {
    if (fixtureState) return;
    const controller = new AbortController();
    void (async () => {
      let sessionEstablished = false;
      try {
        const session = await readAuthSession(
          window.fetch.bind(window),
          controller.signal,
        );
        sessionEstablished = true;
        setSessionCheckFailed(false);
        setAuthenticatedEmail(session.user.email);
        const retainedUnsynced = unsyncedLocalDraftRef.current;
        if (
          retainedUnsynced &&
          retainedUnsynced.email.toLocaleLowerCase("en-US") ===
            session.user.email.toLocaleLowerCase("en-US")
        ) {
          const verifiedUnsynced = {
            ...retainedUnsynced,
            email: session.user.email,
            verified: true,
          };
          unsyncedLocalDraftRef.current = verifiedUnsynced;
          setUnsyncedLocalDraft(verifiedUnsynced);
          writeStorage(
            unsyncedDraftStorageKey,
            JSON.stringify(verifiedUnsynced),
          );
        } else if (retainedUnsynced) {
          unsyncedLocalDraftRef.current = null;
          setUnsyncedLocalDraft(null);
        }
        const localBeforeOwnership = latestDraft.current;
        if (
          !localBeforeOwnership.email ||
          localBeforeOwnership.email.toLocaleLowerCase("en-US") ===
            session.user.email.toLocaleLowerCase("en-US")
        ) {
          const signedInDraft: PublicCfpDraft = {
            ...localBeforeOwnership,
            email: session.user.email,
            speakers: localBeforeOwnership.speakers.length
              ? localBeforeOwnership.speakers
              : [
                  {
                    email: session.user.email,
                    id: "speaker-primary",
                    name: session.user.display_name ?? "",
                    role: "",
                  },
                ],
            verified: true,
          };
          latestDraft.current = signedInDraft;
          setDraft(signedInDraft);
          writeStorage(draftStorageKey, JSON.stringify(signedInDraft));
        } else {
          writeStorage(
            conflictBackupStorageKey,
            JSON.stringify({
              backedUpAt: new Date().toISOString(),
              device: localBeforeOwnership,
              reason: "account_changed",
            }),
          );
          const signedInDraft: PublicCfpDraft = {
            ...emptyPublicCfpDraft,
            email: session.user.email,
            speakers: [
              {
                email: session.user.email,
                id: "speaker-primary",
                name: session.user.display_name ?? "",
                role: "",
              },
            ],
            step:
              localBeforeOwnership.step === "welcome" ? "welcome" : "account",
            verified: true,
          };
          latestDraft.current = signedInDraft;
          setDraft(signedInDraft);
          writeStorage(draftStorageKey, JSON.stringify(signedInDraft));
        }
        const draftResponse = await fetch(
          `/api/v1/public/events/${publicCfpSlug}/submissions`,
          { credentials: "same-origin", signal: controller.signal },
        );
        if (!draftResponse.ok) throw new Error("owned_submissions_unavailable");
        const ownedSubmissions = publicCfpOwnedSubmissionsResponseSchema.parse(
          await draftResponse.json(),
        ).submissions;
        setOwnedSubmissions(ownedSubmissions);
        setOwnershipReady(true);
        setSaveError("");
        setDraftChoices([]);
        setShowLocalDraftChoice(false);
        const local = latestDraft.current;
        const storedMetadata = readServerDraftMetadata();
        const storedSubmission = ownedSubmissions.find(
          (submission) =>
            submission.submission_id === storedMetadata?.submissionId,
        );
        const draftSubmissions = ownedSubmissions.filter(
          (submission) => submission.status === "draft",
        );
        const unmatchedLocalDraft =
          meaningfulLocalDraft(local) &&
          !readStorage(confirmationStorageKey) &&
          local.email.toLocaleLowerCase("en-US") ===
            session.user.email.toLocaleLowerCase("en-US") &&
          !storedSubmission;
        if (unmatchedLocalDraft && ownedSubmissions.length > 0) {
          unsyncedLocalDraftRef.current = local;
          setUnsyncedLocalDraft(local);
          writeStorage(unsyncedDraftStorageKey, JSON.stringify(local));
          setDraftChoices(ownedSubmissions);
          setShowLocalDraftChoice(true);
          setSaveState("local");
          setAnnouncement(
            "An unsynced device proposal and server proposals are both available. Choose one to continue.",
          );
          return;
        }
        if (!storedSubmission && ownedSubmissions.length > 1) {
          setDraftChoices(ownedSubmissions);
          setShowLocalDraftChoice(false);
          return;
        }
        const remote =
          storedSubmission ??
          draftSubmissions[0] ??
          ownedSubmissions[0] ??
          null;

        if (remote) {
          setHasOwnedDraft(remote.status === "draft");
          const metadata = metadataFromDraft(remote);
          serverDraftRef.current = metadata;
          lastSavedFingerprint.current = metadata.lastSyncedFingerprint;
          writeStorage(serverDraftStorageKey, JSON.stringify(metadata));
          if (remote.status !== "draft") {
            const next: PublicCfpDraft = {
              ...publicCfpDraftFromServer(remote, session.user.email),
              consent: true,
              step: "confirmation",
            };
            latestDraft.current = next;
            finalized.current = true;
            setDraft(next);
            setConfirmationId(remote.friendly_id);
            setConfirmationStatus(remote.status);
            setSaveState("saved");
            writeStorage(draftStorageKey, JSON.stringify(next));
            writeStorage(confirmationStorageKey, remote.friendly_id);
            setAnnouncement(
              `Submitted proposal ${remote.friendly_id} restored securely.`,
            );
            return;
          }
          const localBelongsToRemote =
            local.email.toLocaleLowerCase("en-US") ===
              session.user.email.toLocaleLowerCase("en-US") &&
            storedMetadata?.submissionId === remote.submission_id;
          const localFingerprint = JSON.stringify({
            content: publicCfpDraftContent(local),
            formVersion: storedMetadata?.formVersion ?? remote.form_version,
          });
          const localContentMatches =
            localBelongsToRemote &&
            localFingerprint === metadata.lastSyncedFingerprint;
          const localDirty =
            localBelongsToRemote &&
            localFingerprint !== storedMetadata.lastSyncedFingerprint;
          const remoteAdvanced =
            localBelongsToRemote &&
            storedMetadata.sourceVersion !== remote.source_version;
          if (localDirty && remoteAdvanced) {
            const next: PublicCfpDraft = {
              ...local,
              email: session.user.email,
              verified: true,
            };
            latestDraft.current = next;
            setDraft(next);
            setConflictBackupReady(false);
            conflictReturnFocusId.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement.id || null
                : null;
            setDraftConflict({ local: next, remote });
            setSaveState("local");
            setAnnouncement(
              "This device and the server both changed. Choose which version to keep.",
            );
            return;
          }
          const useRemoteCopy = !localBelongsToRemote || remoteAdvanced;
          const next = useRemoteCopy
            ? publicCfpDraftFromServer(remote, session.user.email)
            : { ...local, email: session.user.email, verified: true };
          latestDraft.current = next;
          setDraft(next);
          writeStorage(draftStorageKey, JSON.stringify(next));
          setSaveState(
            useRemoteCopy || localContentMatches ? "saved" : "local",
          );
          setAnnouncement(
            !useRemoteCopy && !localContentMatches
              ? "Your newer device copy is preserved and ready to sync."
              : `Draft ${remote.friendly_id} resumed securely.`,
          );
          return;
        }

        serverDraftRef.current = null;
        setHasOwnedDraft(false);
        removeStorage(serverDraftStorageKey);
        const candidate: PublicCfpDraft =
          !local.email || local.email === session.user.email
            ? { ...local, email: session.user.email, verified: true }
            : {
                ...emptyPublicCfpDraft,
                email: session.user.email,
                step: local.step === "welcome" ? "welcome" : "account",
                verified: true,
              };
        const next: PublicCfpDraft = candidate.speakers.length
          ? candidate
          : {
              ...candidate,
              speakers: [
                {
                  email: session.user.email,
                  id: "speaker-primary",
                  name: session.user.display_name ?? "",
                  role: "",
                },
              ],
            };
        latestDraft.current = next;
        setDraft(next);
        if (next.step !== "welcome") {
          setAnnouncement("Email verified. Continue to your proposal.");
        }
      } catch (error) {
        if (
          error instanceof AuthApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          setSessionCheckFailed(false);
          return;
        }
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setSessionCheckFailed(!sessionEstablished);
          setOwnershipReady(false);
          setSaveState((current) => (current === "idle" ? current : "offline"));
          setAnnouncement(
            "Your server drafts could not be checked. Device changes remain local until this page reconnects.",
          );
        }
      }
    })();
    return () => controller.abort();
  }, [fixtureState, ownershipAttempt]);

  useEffect(() => {
    if (fixtureState) return;
    const retry = () => setOwnershipAttempt((current) => current + 1);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [fixtureState]);

  useEffect(() => {
    if (fixtureState) return;
    const controller = new AbortController();
    void fetch(`/api/v1/public/events/${publicCfpSlug}/cfp`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("configuration_unavailable");
        return publicCfpConfigurationResponseSchema.parse(
          await response.json(),
        );
      })
      .then((configuration) => {
        setConfiguration(configuration);
        setFormVersion(configuration.form.version);
        const supported = publicCfpConfigurationSupportsFlow(configuration);
        setConfigurationReady(supported);
        setConfigurationState(supported ? "ready" : "unsupported");
        if (
          supported &&
          !serverDraftRef.current &&
          !latestDraft.current.title.trim() &&
          !latestDraft.current.abstract.trim() &&
          !latestDraft.current.outcomes.trim() &&
          !latestDraft.current.workshopPrerequisites.trim()
        ) {
          const next = publicCfpDraftForConfiguration(
            latestDraft.current,
            configuration,
          );
          latestDraft.current = next;
          setDraft(next);
          writeStorage(draftStorageKey, JSON.stringify(next));
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setConfigurationReady(false);
          setConfigurationState("unavailable");
        }
      });
    return () => controller.abort();
  }, [fixtureState]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!draftConflict) {
      if (!conflictWasOpen.current) return;
      conflictWasOpen.current = false;
      window.requestAnimationFrame(() => {
        const returnTarget = conflictReturnFocusId.current
          ? document.getElementById(conflictReturnFocusId.current)
          : null;
        (returnTarget ?? flowMain.current)?.focus();
        conflictReturnFocusId.current = null;
      });
      return;
    }
    conflictWasOpen.current = true;
    const dialog = conflictDialog.current;
    if (!dialog) return;
    const containFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!controls.length) return;
      const first = controls[0];
      const last = controls.at(-1);
      if (
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    dialog.addEventListener("keydown", containFocus);
    return () => dialog.removeEventListener("keydown", containFocus);
  }, [draftConflict]);

  function setServerDraftMetadata(metadata: ServerDraftMetadata | null) {
    serverDraftRef.current = metadata;
    if (metadata) {
      writeStorage(serverDraftStorageKey, JSON.stringify(metadata));
    } else {
      removeStorage(serverDraftStorageKey);
    }
  }

  function preserveUnsyncedDraft(value: PublicCfpDraft) {
    unsyncedLocalDraftRef.current = value;
    setUnsyncedLocalDraft(value);
    writeStorage(unsyncedDraftStorageKey, JSON.stringify(value));
  }

  function clearUnsyncedDraft() {
    unsyncedLocalDraftRef.current = null;
    setUnsyncedLocalDraft(null);
    removeStorage(unsyncedDraftStorageKey);
  }

  function invalidatePendingSave() {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    saveEpoch.current += 1;
    saveChain.current = Promise.resolve(true);
    autosaveRequest.current = null;
  }

  function upsertOwnedDraft(
    content: ReturnType<typeof publicCfpDraftContent>,
    metadata: ServerDraftMetadata,
  ) {
    const next: PublicCfpOwnedSubmission = {
      content,
      form_version: metadata.formVersion,
      friendly_id: metadata.friendlyId,
      source_version: metadata.sourceVersion,
      status: "draft",
      submission_id: metadata.submissionId,
      updated_at: new Date().toISOString(),
    };
    setOwnedSubmissions((current) => {
      const existingIndex = current.findIndex(
        (submission) => submission.submission_id === metadata.submissionId,
      );
      if (existingIndex === -1) return [...current, next];
      return current.map((submission, index) =>
        index === existingIndex ? next : submission,
      );
    });
    setDraftChoices((current) => {
      if (!current.length) return current;
      const existingIndex = current.findIndex(
        (submission) => submission.submission_id === metadata.submissionId,
      );
      if (existingIndex === -1) return [...current, next];
      return current.map((submission, index) =>
        index === existingIndex ? next : submission,
      );
    });
  }

  async function reconcileServerConflict(
    local: PublicCfpDraft,
    submissionId: string,
  ): Promise<boolean> {
    try {
      const response = await fetch(
        `/api/v1/public/events/${publicCfpSlug}/submissions`,
        { credentials: "same-origin" },
      );
      if (!response.ok) return false;
      const submissions = publicCfpOwnedSubmissionsResponseSchema.parse(
        await response.json(),
      ).submissions;
      setOwnedSubmissions(submissions);
      const remote = submissions.find(
        (submission) => submission.submission_id === submissionId,
      );
      if (!remote) return false;
      if (remote.status !== "draft") {
        const next: PublicCfpDraft = {
          ...publicCfpDraftFromServer(remote, local.email),
          consent: true,
          step: "confirmation",
        };
        finalized.current = true;
        saveEpoch.current += 1;
        latestDraft.current = next;
        setDraft(next);
        setDraftConflict(null);
        setConfirmationId(remote.friendly_id);
        setConfirmationStatus(remote.status);
        setSaveState("saved");
        writeStorage(draftStorageKey, JSON.stringify(next));
        writeStorage(confirmationStorageKey, remote.friendly_id);
        setAnnouncement(
          `Proposal ${remote.friendly_id} changed status on another device.`,
        );
        return true;
      }
      const next = { ...local, email: local.email, verified: true };
      const metadata = metadataFromDraft(remote);
      latestDraft.current = next;
      setDraft(next);
      setServerDraftMetadata(metadata);
      lastSavedFingerprint.current = metadata.lastSyncedFingerprint;
      setConflictBackupReady(false);
      conflictReturnFocusId.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement.id || null
          : null;
      setDraftConflict({ local: next, remote });
      setSaveState("local");
      writeStorage(draftStorageKey, JSON.stringify(next));
      setAnnouncement(
        "The server changed during this save. Choose which version to keep.",
      );
      return true;
    } catch {
      return false;
    }
  }

  function downloadConflictBackup() {
    if (!draftConflict) return;
    const backedUpAt = new Date().toISOString();
    const backup = JSON.stringify(
      {
        backedUpAt,
        device: draftConflict.local,
        server: draftConflict.remote,
      },
      null,
      2,
    );
    writeStorage(conflictBackupStorageKey, backup);
    const url = URL.createObjectURL(
      new Blob([backup], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.download = `opensession-draft-conflict-${backedUpAt.replaceAll(":", "-")}.json`;
    anchor.href = url;
    anchor.click();
    URL.revokeObjectURL(url);
    setConflictBackupReady(true);
    setAnnouncement(
      "Both versions were downloaded. Choose which version to keep.",
    );
  }

  function useServerConflictCopy() {
    if (!draftConflict || !conflictBackupReady) return;
    invalidatePendingSave();
    const next = publicCfpDraftFromServer(
      draftConflict.remote,
      draftConflict.local.email,
    );
    const metadata = metadataFromDraft(draftConflict.remote);
    latestDraft.current = next;
    setDraft(next);
    setServerDraftMetadata(metadata);
    lastSavedFingerprint.current = metadata.lastSyncedFingerprint;
    writeStorage(draftStorageKey, JSON.stringify(next));
    setDraftConflict(null);
    setSaveState("saved");
    setAnnouncement("The server version is now open on this device.");
  }

  function openOwnedDraft(submission: PublicCfpOwnedSubmission) {
    if (submitting) return;
    if (!serverDraftRef.current && meaningfulLocalDraft(latestDraft.current)) {
      preserveUnsyncedDraft(latestDraft.current);
    }
    invalidatePendingSave();
    const terminal = submission.status !== "draft";
    const next = {
      ...publicCfpDraftFromServer(submission, authenticatedEmail),
      ...(terminal ? { consent: true, step: "confirmation" as const } : {}),
    };
    const metadata = metadataFromDraft(submission);
    latestDraft.current = next;
    setDraft(next);
    setServerDraftMetadata(metadata);
    lastSavedFingerprint.current = metadata.lastSyncedFingerprint;
    writeStorage(draftStorageKey, JSON.stringify(next));
    setDraftChoices([]);
    setShowLocalDraftChoice(false);
    setHasOwnedDraft(!terminal);
    setConfirmationId(terminal ? submission.friendly_id : "");
    setConfirmationStatus(submission.status);
    finalized.current = terminal;
    setSaveState("saved");
    setAnnouncement(
      terminal
        ? `Proposal ${submission.friendly_id} status opened securely.`
        : `Draft ${submission.friendly_id} resumed securely.`,
    );
  }

  function startAnotherProposal() {
    if (submitting) return;
    if (unsyncedLocalDraftRef.current) {
      setAnnouncement(
        "Open and sync the device proposal before starting another one.",
      );
      return;
    }
    if (
      !configuration?.acceptingSubmissions ||
      (event.maxSubmissions !== null &&
        ownedSubmissions.length >= event.maxSubmissions)
    ) {
      setAnnouncement("This account cannot start another proposal right now.");
      return;
    }
    invalidatePendingSave();
    const base = publicCfpDraftForConfiguration(
      {
        ...emptyPublicCfpDraft,
        email: authenticatedEmail,
        speakers: [
          {
            email: authenticatedEmail,
            id: window.crypto.randomUUID(),
            name: "",
            role: "",
          },
        ],
        step: "submission",
        verified: true,
      },
      configuration,
    );
    finalized.current = false;
    latestDraft.current = base;
    setDraft(base);
    setDraftChoices([]);
    setShowLocalDraftChoice(false);
    setHasOwnedDraft(false);
    setConfirmationId("");
    setConfirmationStatus(null);
    setServerDraftMetadata(null);
    lastSavedFingerprint.current = null;
    autosaveRequest.current = null;
    submissionIdentity.current = null;
    removeStorage(confirmationStorageKey);
    removeStorage(idempotencyStorageKey);
    writeStorage(draftStorageKey, JSON.stringify(base));
    setSaveState("local");
    setAnnouncement("Started a new proposal on this device.");
  }

  function useLocalConflictCopy() {
    if (!draftConflict || !conflictBackupReady) return;
    invalidatePendingSave();
    const metadata = metadataFromDraft(draftConflict.remote);
    setServerDraftMetadata(metadata);
    lastSavedFingerprint.current = metadata.lastSyncedFingerprint;
    setDraftConflict(null);
    setSaveState("saving");
    void queueServerDraft(draftConflict.local);
  }

  function openUnsyncedLocalDraft() {
    if (submitting) return;
    const retained = unsyncedLocalDraftRef.current;
    if (!retained) return;
    invalidatePendingSave();
    const next = { ...retained, verified: true };
    latestDraft.current = next;
    setDraft(next);
    writeStorage(draftStorageKey, JSON.stringify(next));
    setServerDraftMetadata(null);
    lastSavedFingerprint.current = null;
    finalized.current = false;
    setDraftChoices([]);
    setShowLocalDraftChoice(false);
    setHasOwnedDraft(false);
    setConfirmationId("");
    setConfirmationStatus(null);
    setSaveState("local");
    setAnnouncement("Unsynced device proposal opened without replacing it.");
  }

  function showProposalChoices() {
    if (!serverDraftRef.current && meaningfulLocalDraft(latestDraft.current)) {
      preserveUnsyncedDraft(latestDraft.current);
    }
    setDraftChoices(ownedSubmissions);
    setShowLocalDraftChoice(Boolean(unsyncedLocalDraftRef.current));
  }

  async function persistDraftNow(
    next: PublicCfpDraft,
    context: DraftSaveContext,
  ): Promise<boolean> {
    const primary = next.speakers[0];
    if (
      context.epoch !== saveEpoch.current ||
      fixtureState ||
      finalized.current ||
      !configurationReady ||
      !ownershipReady ||
      !next.verified ||
      !primary ||
      primary.email.toLocaleLowerCase("en-US") !==
        next.email.toLocaleLowerCase("en-US")
    ) {
      return false;
    }
    const csrf = readCsrfToken(document.cookie);
    if (!csrf) {
      setSaveState("failed");
      return false;
    }
    const content = publicCfpDraftContent(next);
    const fingerprint = JSON.stringify({ content, formVersion });
    if (
      serverDraftRef.current &&
      lastSavedFingerprint.current === fingerprint
    ) {
      setSaveState("saved");
      return true;
    }
    const requestIdentity =
      autosaveRequest.current?.fingerprint === fingerprint
        ? autosaveRequest.current
        : { fingerprint, key: window.crypto.randomUUID() };
    autosaveRequest.current = requestIdentity;
    const currentServerDraft = serverDraftRef.current
      ? { ...serverDraftRef.current }
      : null;
    const body = currentServerDraft
      ? protectedPublicCfpSubmissionUpdateRequestSchema.safeParse({
          ...content,
          expected_source_version: currentServerDraft.sourceVersion,
          form_version: formVersion,
          mode: "draft",
        })
      : protectedPublicCfpSubmissionRequestSchema.safeParse({
          ...content,
          form_version: formVersion,
          mode: "draft",
        });
    if (!body.success) {
      setSaveState("failed");
      return false;
    }

    try {
      const response = await fetch(
        currentServerDraft
          ? `/api/v1/public/events/${publicCfpSlug}/submissions/${currentServerDraft.submissionId}`
          : `/api/v1/public/events/${publicCfpSlug}/submissions`,
        {
          body: JSON.stringify(body.data),
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": requestIdentity.key,
            "X-CSRF-Token": csrf,
          },
          method: currentServerDraft ? "PUT" : "POST",
        },
      );
      const responsePayload = await response.json().catch(() => null);
      const result =
        publicCfpSubmissionResponseSchema.safeParse(responsePayload);
      if (
        context.epoch !== saveEpoch.current &&
        response.ok &&
        result.success &&
        result.data.status === "draft"
      ) {
        const metadata: ServerDraftMetadata = {
          friendlyId: result.data.friendly_id,
          formVersion,
          lastSyncedFingerprint: fingerprint,
          sourceVersion: result.data.source_version,
          submissionId: result.data.submission_id,
        };
        upsertOwnedDraft(content, metadata);
        const retained = unsyncedLocalDraftRef.current;
        if (
          !currentServerDraft &&
          retained &&
          JSON.stringify(publicCfpDraftContent(retained)) ===
            JSON.stringify(content)
        ) {
          clearUnsyncedDraft();
        }
        return false;
      }
      if (context.epoch !== saveEpoch.current) return false;
      if (
        response.status === 409 &&
        currentServerDraft &&
        ["save_conflict", "source_version_conflict"].includes(
          apiErrorCode(responsePayload) ?? "",
        ) &&
        (await reconcileServerConflict(next, currentServerDraft.submissionId))
      ) {
        return false;
      }
      if (response.status === 409) {
        const code = apiErrorCode(responsePayload);
        const message =
          code === "cfp_closed"
            ? "The call no longer permits this save. Refresh to load the current deadline policy."
            : code === "form_version_conflict"
              ? "The proposal form changed. Refresh before saving this version."
              : "This draft could not be saved under the current event policy.";
        setSaveState("failed");
        setSaveError(message);
        setAnnouncement(message);
        return false;
      }
      if (!response.ok || !result.success || result.data.status !== "draft") {
        throw new Error(`autosave_failed:${response.status}`);
      }
      const metadata: ServerDraftMetadata = {
        friendlyId: result.data.friendly_id,
        formVersion,
        lastSyncedFingerprint: fingerprint,
        sourceVersion: result.data.source_version,
        submissionId: result.data.submission_id,
      };
      setServerDraftMetadata(metadata);
      upsertOwnedDraft(content, metadata);
      setHasOwnedDraft(true);
      setShowLocalDraftChoice(false);
      const retained = unsyncedLocalDraftRef.current;
      if (
        !currentServerDraft &&
        retained &&
        JSON.stringify(publicCfpDraftContent(retained)) ===
          JSON.stringify(content)
      ) {
        clearUnsyncedDraft();
      }
      lastSavedFingerprint.current = fingerprint;
      autosaveRequest.current = null;
      setSaveError("");
      if (
        JSON.stringify(publicCfpDraftContent(latestDraft.current)) ===
        JSON.stringify(content)
      ) {
        setSaveState("saved");
        setAnnouncement(`Draft ${metadata.friendlyId} saved securely.`);
      }
      return true;
    } catch {
      setSaveState(navigator.onLine ? "failed" : "offline");
      setAnnouncement(
        navigator.onLine
          ? "Secure sync failed. Your current draft remains saved on this device."
          : "You are offline. This draft remains saved on this device.",
      );
      return false;
    }
  }

  function queueServerDraft(next: PublicCfpDraft): Promise<boolean> {
    const context: DraftSaveContext = {
      epoch: saveEpoch.current,
    };
    const queued = saveChain.current.then(() =>
      context.epoch === saveEpoch.current && !finalized.current
        ? persistDraftNow(next, context)
        : false,
    );
    saveChain.current = queued.catch(() => false);
    return queued;
  }

  function change(next: PublicCfpDraft) {
    if (draftConflict || submitting) return;
    latestDraft.current = next;
    setDraft(next);
    setErrors({});
    setSaveError("");
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
    if (
      !fixtureState &&
      !serverDraftRef.current &&
      unsyncedLocalDraftRef.current
    ) {
      preserveUnsyncedDraft(next);
    }
    if (fixtureState === "offline" || (!fixtureState && !navigator.onLine)) {
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

    if (fixtureState) {
      setSaveState("local");
      setAnnouncement("Draft saved on this device.");
      return;
    }
    const primary = next.speakers[0];
    if (
      !configurationReady ||
      !ownershipReady ||
      !next.verified ||
      !primary ||
      primary.email.toLocaleLowerCase("en-US") !==
        next.email.toLocaleLowerCase("en-US")
    ) {
      setSaveState("local");
      setAnnouncement("Draft saved on this device.");
      return;
    }

    setSaveState("saving");
    saveTimer.current = window.setTimeout(() => {
      void queueServerDraft(next);
    }, 700);
  }

  function moveTo(step: PublicCfpStep) {
    if (submitting || draftConflict) return;
    change({ ...draft, step });
    setAnnouncement(
      `Moved to ${publicCfpSteps.find((item) => item.id === step)?.label}.`,
    );
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function continueFrom(step: PublicCfpStep, next: PublicCfpStep) {
    const nextErrors = validationFor(
      step,
      draft,
      configuration,
      event,
      ruleFields,
    );
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

  function completeSubmission(
    id: string,
    sourceVersion?: number,
    submissionId?: string,
  ) {
    finalized.current = true;
    saveEpoch.current += 1;
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    writeStorage(confirmationStorageKey, id);
    writeStorage(
      draftStorageKey,
      JSON.stringify({ ...draft, step: "confirmation" }),
    );
    removeStorage(idempotencyStorageKey);
    setServerDraftMetadata(null);
    setHasOwnedDraft(false);
    lastSavedFingerprint.current = null;
    submissionIdentity.current = null;
    if (submissionId && sourceVersion) {
      setOwnedSubmissions((current) => [
        ...current.filter(
          (submission) => submission.submission_id !== submissionId,
        ),
        {
          content: publicCfpDraftContent(draft),
          form_version: formVersion,
          friendly_id: id,
          source_version: sourceVersion,
          status: "submitted",
          submission_id: submissionId,
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    setConfirmationId(id);
    setConfirmationStatus("submitted");
    setDraft((current) => ({ ...current, step: "confirmation" }));
    setSubmitting(false);
    setAnnouncement(`Proposal submitted once. Confirmation ${id}.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submit() {
    const submissionErrors = validationFor(
      "submission",
      draft,
      configuration,
      event,
      ruleFields,
    );
    const participantErrors = validationFor(
      "participants",
      draft,
      configuration,
      event,
      ruleFields,
    );
    const reviewErrors = validationFor(
      "review",
      draft,
      configuration,
      event,
      ruleFields,
    );
    const nextErrors = {
      ...submissionErrors,
      ...participantErrors,
      ...reviewErrors,
    };
    setErrors(nextErrors);
    setSubmitError("");
    if (Object.keys(nextErrors).length) {
      const invalidStep: PublicCfpStep = Object.keys(submissionErrors).length
        ? "submission"
        : Object.keys(participantErrors).length
          ? "participants"
          : "review";
      if (invalidStep !== "review") {
        const next = { ...draft, step: invalidStep };
        latestDraft.current = next;
        setDraft(next);
        writeStorage(draftStorageKey, JSON.stringify(next));
      }
      setAnnouncement(
        "Review the highlighted proposal details before submitting.",
      );
      window.setTimeout(
        () =>
          document.querySelector<HTMLElement>(".ui-error-summary a")?.focus(),
        0,
      );
      return;
    }
    if (submitting) return;
    if (!fixtureState && !configurationReady) {
      setSubmitError(
        "The current form could not be verified. Refresh before submitting.",
      );
      setAnnouncement("Submission stopped until the current form is loaded.");
      return;
    }
    if (!fixtureState && configuration?.acceptingSubmissions === false) {
      setSubmitError(
        "The call is closed. You may save permitted draft edits, but cannot submit a new final version.",
      );
      setAnnouncement("Final submission is unavailable after the deadline.");
      return;
    }
    if (!fixtureState && !submissionTurnstileToken) {
      setSubmitError("Complete the security check before submitting.");
      setAnnouncement("Complete the security check before submitting.");
      return;
    }
    const submissionEpoch = saveEpoch.current;
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

    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (
      !(await queueServerDraft(draft)) ||
      submissionEpoch !== saveEpoch.current
    ) {
      setSubmitting(false);
      setSubmitError(
        "We could not sync this exact version securely. Your device copy is safe; reconnect and try again.",
      );
      setAnnouncement("Submission stopped until this draft syncs securely.");
      return;
    }

    const content = publicCfpDraftContent(draft);
    const currentServerDraft = serverDraftRef.current;
    const submission = currentServerDraft
      ? protectedPublicCfpSubmissionUpdateRequestSchema.safeParse({
          ...content,
          expected_source_version: currentServerDraft.sourceVersion,
          form_version: formVersion,
          mode: "submit",
          participant_consent: draft.consent,
          turnstile_action: "cfp_submit",
          turnstile_token: submissionTurnstileToken,
        })
      : protectedPublicCfpSubmissionRequestSchema.safeParse({
          ...content,
          form_version: formVersion,
          mode: "submit",
          participant_consent: draft.consent,
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

    const finalFingerprint = JSON.stringify({
      consent: draft.consent,
      content,
      expectedSourceVersion: currentServerDraft?.sourceVersion ?? 0,
      formVersion,
      submissionId: currentServerDraft?.submissionId ?? "new",
    });
    const priorIdentity =
      submissionIdentity.current ?? readFinalSubmissionIdentity();
    const identity =
      priorIdentity?.fingerprint === finalFingerprint
        ? priorIdentity
        : { fingerprint: finalFingerprint, key: window.crypto.randomUUID() };
    submissionIdentity.current = identity;
    writeStorage(idempotencyStorageKey, JSON.stringify(identity));
    const csrf = readCsrfToken(document.cookie);
    if (!csrf) {
      setSubmitting(false);
      setSubmitError(
        "Your sign-in session needs to be refreshed before submitting.",
      );
      setAnnouncement(
        "Submission stopped because the sign-in session expired.",
      );
      return;
    }

    try {
      const response = await fetch(
        currentServerDraft
          ? `/api/v1/public/events/${publicCfpSlug}/submissions/${currentServerDraft.submissionId}`
          : `/api/v1/public/events/${publicCfpSlug}/submissions`,
        {
          body: JSON.stringify(submission.data),
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": identity.key,
            "X-CSRF-Token": csrf,
          },
          method: currentServerDraft ? "PUT" : "POST",
        },
      );
      const responsePayload = await response.json().catch(() => null);
      const responseCode = apiErrorCode(responsePayload);
      if (
        response.status === 409 &&
        currentServerDraft &&
        ["save_conflict", "source_version_conflict"].includes(
          responseCode ?? "",
        ) &&
        (await reconcileServerConflict(draft, currentServerDraft.submissionId))
      ) {
        setSubmitting(false);
        return;
      }
      if (response.status === 409) {
        const message =
          responseCode === "cfp_closed"
            ? "The submission deadline passed before this version was finalized. Your draft remains safe."
            : responseCode === "form_version_conflict"
              ? "The proposal form changed before submission. Refresh and review the updated form."
              : responseCode === "submission_locked"
                ? "This proposal is already locked for review. Refresh to load its current status."
                : "The current event policy does not permit this submission.";
        setSubmitting(false);
        setSubmitError(message);
        setAnnouncement(message);
        return;
      }
      const payload =
        publicCfpSubmissionResponseSchema.safeParse(responsePayload);
      if (response.status === 429) {
        const retryAfter = Number.parseInt(
          response.headers.get("Retry-After") ?? "60",
          10,
        );
        throw new Error(
          `rate_limited:${Number.isFinite(retryAfter) ? retryAfter : 60}`,
        );
      }
      if (
        !response.ok ||
        !payload.success ||
        payload.data.status !== "submitted"
      ) {
        throw new Error("submission_failed");
      }
      completeSubmission(
        payload.data.friendly_id,
        payload.data.source_version,
        payload.data.submission_id,
      );
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
    !fixtureState && sessionCheckFailed && sessionPrivacyRequired ? (
      <StatePanel
        description="Retry the secure session check before viewing or changing account data. Your device copy remains stored locally."
        state="error"
        title="We could not verify this session"
      />
    ) : !fixtureState && configurationState !== "ready" ? (
      <StatePanel
        description={
          configurationState === "loading"
            ? "Checking the current form, deadline, and submission policy."
            : configurationState === "unsupported"
              ? "This published form uses fields this application cannot safely render yet. The program team has been notified."
              : "The current form could not be loaded. Refresh before entering or changing a proposal."
        }
        state={configurationState === "loading" ? "loading" : "error"}
        title={
          configurationState === "loading"
            ? "Loading the call for proposals"
            : "The proposal form is unavailable"
        }
      />
    ) : effectiveStep === "welcome" ? (
      <Welcome event={event} onStart={() => moveTo("account")} />
    ) : effectiveStep === "account" ? (
      <Account
        draft={draft}
        fixtureState={fixtureState}
        onChange={change}
        onContinue={() => moveTo("submission")}
      />
    ) : effectiveStep === "submission" ? (
      <Submission
        configuration={configuration}
        draft={draft}
        event={event}
        errors={errors}
        onAnnounce={setAnnouncement}
        onBack={() => moveTo("account")}
        onChange={change}
        onContinue={() => continueFrom("submission", "participants")}
        ruleFields={ruleFields}
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
        canSubmit={configuration?.acceptingSubmissions !== false}
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
      <Confirmation
        confirmationId={confirmationId}
        email={draft.email}
        status={confirmationStatus ?? "submitted"}
      />
    );

  const editableClosedDraft =
    configuration?.acceptingSubmissions === false &&
    configuration.form.editAfterClose &&
    (hasOwnedDraft || draftChoices.length > 0);
  if (
    !fixtureState &&
    configurationState === "ready" &&
    configuration?.acceptingSubmissions === false &&
    !editableClosedDraft &&
    effectiveStep !== "confirmation"
  ) {
    return (
      <PolicyState
        event={event}
        state={
          event.opensAt && new Date(event.opensAt).getTime() > loadedAt
            ? "upcoming"
            : "closed"
        }
      />
    );
  }

  return (
    <div className="public-cfp-flow">
      <PublicCfpHeader event={event} />
      {effectiveStep !== "welcome" ? <Progress step={effectiveStep} /> : null}
      {visibleSaveState ? <SaveStatus state={visibleSaveState} /> : null}
      {!fixtureState &&
      (sessionCheckFailed || (authenticatedEmail && !ownershipReady)) ? (
        <div className="public-cfp-ownership-warning" role="alert">
          <div>
            <strong>
              {sessionCheckFailed
                ? "Your sign-in session could not be checked."
                : "Server drafts could not be checked."}
            </strong>
            <span>
              {sessionCheckFailed
                ? "No account data will be shown or sent until the session check succeeds."
                : "This device copy is safe, but saving and final submission stay paused until the connection is restored."}
            </span>
          </div>
          <button
            className="public-cfp-back"
            onClick={() => setOwnershipAttempt((current) => current + 1)}
            type="button"
          >
            Retry connection
          </button>
        </div>
      ) : null}
      {saveError ? (
        <div className="public-cfp-ownership-warning" role="alert">
          <div>
            <strong>Secure sync stopped.</strong>
            <span>{saveError}</span>
          </div>
        </div>
      ) : null}
      {!draftConflict &&
      draftChoices.length === 0 &&
      !showLocalDraftChoice &&
      ownedSubmissions.length > 0 ? (
        <nav aria-label="Proposal navigation">
          <button
            className="public-cfp-back"
            disabled={submitting}
            onClick={showProposalChoices}
            type="button"
          >
            View all your proposals
          </button>
        </nav>
      ) : null}
      <main ref={flowMain} tabIndex={-1}>
        {draftConflict ? (
          <section
            aria-labelledby="draft-conflict-title"
            className="public-cfp-card"
            ref={conflictDialog}
            role="alertdialog"
          >
            <p className="overline">Draft conflict</p>
            <h2 id="draft-conflict-title">Choose the version to keep.</h2>
            <p>
              This device changed after the server draft also advanced. Nothing
              will be overwritten until you choose.
            </p>
            <dl>
              <div>
                <dt>This device</dt>
                <dd>{draftConflict.local.title || "Untitled proposal"}</dd>
              </div>
              <div>
                <dt>Server · updated</dt>
                <dd>
                  {typeof draftConflict.remote.content.answers.title ===
                  "string"
                    ? draftConflict.remote.content.answers.title
                    : "Untitled proposal"}{" "}
                  ·{" "}
                  {new Intl.DateTimeFormat("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(draftConflict.remote.updated_at))}
                </dd>
              </div>
            </dl>
            <p>
              Download a JSON backup of both versions before choosing. The
              replacement controls unlock after the download starts.
            </p>
            <button
              autoFocus
              className="public-cfp-back"
              onClick={downloadConflictBackup}
              type="button"
            >
              Download both versions
            </button>
            <div className="public-cfp-step-actions">
              <button
                className="public-cfp-back"
                disabled={!conflictBackupReady}
                onClick={useServerConflictCopy}
                type="button"
              >
                Use server version
              </button>
              <Button
                disabled={!conflictBackupReady}
                onClick={useLocalConflictCopy}
              >
                Overwrite server with device copy
              </Button>
            </div>
          </section>
        ) : draftChoices.length || showLocalDraftChoice ? (
          <section className="public-cfp-card">
            <p className="overline">Your proposals</p>
            <h1>Choose a proposal.</h1>
            <div className="public-cfp-review-speakers">
              {showLocalDraftChoice ? (
                <article>
                  <div>
                    <strong>
                      {unsyncedLocalDraft?.title || "Untitled proposal"}
                    </strong>
                    <small>This device · Not yet synced</small>
                  </div>
                  <Button
                    aria-label={`Continue device proposal: ${unsyncedLocalDraft?.title || "Untitled proposal"}`}
                    disabled={submitting}
                    onClick={openUnsyncedLocalDraft}
                  >
                    Continue device proposal
                  </Button>
                </article>
              ) : null}
              {draftChoices.map((choice) => (
                <article key={choice.submission_id}>
                  <div>
                    <strong>{ownedSubmissionTitle(choice)}</strong>
                    <small>
                      {choice.friendly_id} · {choice.status.replace("_", " ")} ·
                      Updated{" "}
                      {new Intl.DateTimeFormat("en-US", {
                        dateStyle: "medium",
                      }).format(new Date(choice.updated_at))}
                    </small>
                  </div>
                  <Button
                    aria-label={`${
                      choice.status === "draft"
                        ? "Continue this draft"
                        : "View this status"
                    }: ${ownedSubmissionTitle(choice)} (${choice.friendly_id})`}
                    disabled={submitting}
                    onClick={() => openOwnedDraft(choice)}
                  >
                    {choice.status === "draft"
                      ? "Continue this draft"
                      : "View this status"}
                  </Button>
                </article>
              ))}
            </div>
            {configuration?.acceptingSubmissions &&
            !unsyncedLocalDraft &&
            (event.maxSubmissions === null ||
              ownedSubmissions.length < event.maxSubmissions) ? (
              <Button onClick={startAnotherProposal}>
                <Plus aria-hidden="true" size={16} /> Start another proposal
              </Button>
            ) : (
              <p>
                {unsyncedLocalDraft
                  ? "Open and sync the device proposal before starting another one."
                  : event.maxSubmissions !== null &&
                      ownedSubmissions.length >= event.maxSubmissions
                    ? `This account has reached the ${event.maxSubmissions}-proposal limit.`
                    : "The call is closed to new proposals."}
              </p>
            )}
          </section>
        ) : (
          content
        )}
      </main>
      <footer>
        <PublicCfpBrand />
        <p>
          Questions?{" "}
          <a href={`mailto:${event.contactEmail}`}>{event.contactEmail}</a>
        </p>
        <p>Deadlines are shown in {event.timezoneLabel}.</p>
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
