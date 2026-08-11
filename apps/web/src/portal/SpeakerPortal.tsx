import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ExternalLink,
  FileText,
  HelpCircle,
  Home,
  LogOut,
  MapPin,
  Mic2,
  UserRound,
} from "lucide-react";

import { Button, StatePanel, StatusPill } from "@sessionbox-killer/ui";

import { logoutAuthSession } from "../auth/authClient";
import {
  TurnstileWidget,
  type TurnstileWidgetHandle,
} from "../security/TurnstileWidget";
import {
  readSpeakerPortal,
  requestSpeakerPortalLink,
  SpeakerPortalApiError,
} from "./portalClient";
import {
  speakerPortalFixture,
  speakerPortalView,
  type PortalTaskView,
  type SpeakerPortalView,
} from "./portalModel";
import { SpeakerProfileWorkspace } from "./SpeakerProfileWorkspace";
import {
  SpeakerTaskWorkspace,
  type TaskFixtureState,
} from "../tasks/TaskCompletionWorkspace";
import { ProductionSpeakerTaskWorkspace } from "../tasks/ProductionTaskCompletionWorkspace";

import "./speaker-portal.css";

type PortalState =
  "active" | "empty" | "expired" | "permission" | "redeemed" | "revoked";
export type PortalFixtureState = Exclude<PortalState, "active"> | "default";
export type PortalFixtureView = "home" | "profile" | "task";

type PortalRuntime =
  | { data: SpeakerPortalView; state: "active" }
  | {
      data: null;
      state: "checking" | "error" | "permission" | "unauthenticated";
    };

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("en-US") ?? "")
    .join("");
}

function PortalBrand({
  href = "/portal/ai-engineer-summit",
}: {
  href?: string;
}) {
  return (
    <a className="portal-brand" href={href}>
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>
        <strong>OpenSession</strong>
        <small>Speaker portal</small>
      </span>
    </a>
  );
}

function TaskRow({
  eventSlug,
  fixtureRoute,
  task,
}: {
  eventSlug: string;
  fixtureRoute: boolean;
  task: PortalTaskView;
}) {
  const complete =
    task.assignmentState === "complete" || task.assignmentState === "approved";
  const action = fixtureRoute
    ? task.id === "final-slides"
      ? {
          label: "Review submission",
          path: "/fixtures/portal-task/default",
        }
      : {
          label: task.id === "headshot" ? "Upload headshot" : "Review profile",
          path: "/fixtures/portal/profile",
        }
    : {
        label:
          task.assignmentState === "submitted"
            ? "Review submission"
            : task.assignmentState === "rejected"
              ? "Respond to changes"
              : "Open task",
        path: `/portal/${encodeURIComponent(eventSlug)}/tasks/${encodeURIComponent(task.id)}`,
      };
  return (
    <article
      className={`portal-task is-${task.status} is-${task.sourceStatus}${task.required ? "" : " is-optional"}`}
    >
      <span className="portal-task-check" aria-hidden="true">
        {complete ? <Check size={15} /> : null}
      </span>
      <div>
        <strong>{task.title}</strong>
        <p>{task.description}</p>
      </div>
      <span className="portal-task-due">{task.dueLabel}</span>
      {!complete && action && fixtureRoute ? (
        <button
          onClick={() => {
            window.location.href = action.path;
          }}
          type="button"
        >
          {action.label}
          <ArrowRight aria-hidden="true" size={15} />
        </button>
      ) : !complete && action ? (
        <a className="portal-task-action" href={action.path}>
          {action.label}
          <ArrowRight aria-hidden="true" size={15} />
        </a>
      ) : null}
    </article>
  );
}

function PortalHeader({
  activeSection,
  displayName,
  eventSlug,
  fixtureRoute,
  onSignOut,
  openTaskCount,
  signingOut,
}: {
  activeSection: "home" | "profile" | "tasks";
  displayName: string;
  eventSlug: string;
  fixtureRoute: boolean;
  onSignOut?: (() => void) | undefined;
  openTaskCount: number;
  signingOut?: boolean | undefined;
}) {
  const homePath = fixtureRoute
    ? "/fixtures/portal/active"
    : `/portal/${encodeURIComponent(eventSlug)}`;
  const profilePath = fixtureRoute
    ? "/fixtures/portal/profile"
    : `${homePath}#portal-profile`;
  return (
    <header className="portal-topbar">
      <PortalBrand href={homePath} />
      <nav aria-label="Speaker portal">
        <a
          aria-current={activeSection === "home" ? "page" : undefined}
          href={homePath}
        >
          <Home aria-hidden="true" size={16} /> Home
        </a>
        <a
          aria-current={activeSection === "tasks" ? "page" : undefined}
          href={`${homePath}#portal-tasks`}
        >
          <CheckCircle2 aria-hidden="true" size={16} /> Tasks{" "}
          <span>{openTaskCount}</span>
        </a>
        <a href={`${homePath}#portal-sessions`}>
          <Mic2 aria-hidden="true" size={16} /> Sessions
        </a>
        {fixtureRoute ? (
          <a
            aria-current={activeSection === "profile" ? "page" : undefined}
            href={profilePath}
          >
            <UserRound aria-hidden="true" size={16} /> Profile
          </a>
        ) : null}
      </nav>
      <div className="portal-profile-chip">
        <span>{initials(displayName)}</span>
        <div>
          <strong>{displayName}</strong>
          <small>Speaker</small>
        </div>
        <button
          aria-label={signingOut ? "Signing out" : "Sign out"}
          disabled={signingOut || !onSignOut}
          onClick={onSignOut}
          type="button"
        >
          <LogOut aria-hidden="true" size={17} />
        </button>
      </div>
    </header>
  );
}

function InvitationState({
  state,
}: {
  state: "expired" | "permission" | "redeemed" | "revoked";
}) {
  const [linkRequested, setLinkRequested] = useState(false);
  const content = {
    expired: {
      description:
        "The invitation sent to mina@example.com expired after 48 hours. Request a new one without changing the invited email or event.",
      title: "This invitation has expired",
    },
    permission: {
      description:
        "This portal link belongs to a different event or speaker. Sign in with the invited email, or return to your current event.",
      title: "This portal is not available to this account",
    },
    redeemed: {
      description:
        "The one-time invitation was already accepted. Use the same email to receive a fresh sign-in link for your existing portal.",
      title: "Your portal is already active",
    },
    revoked: {
      description:
        "The program team ended access for this event. No speaker or session data is available from this link; contact the team if you think this is a mistake.",
      title: "Your portal access has ended",
    },
  }[state];
  const canRequestLink = state === "expired" || state === "redeemed";

  return (
    <div className="portal-invitation-page">
      <PortalBrand />
      <main className="portal-invitation-card">
        <div className="portal-invitation-event">
          <span>AS</span>
          <div>
            <strong>AI Engineer Summit</strong>
            <small>August 18–19, 2026 · San Francisco</small>
          </div>
        </div>
        <StatePanel
          action={
            <>
              <div className="portal-invitation-actions">
                <Button
                  disabled={linkRequested}
                  onClick={() => {
                    if (canRequestLink) {
                      setLinkRequested(true);
                    } else {
                      window.location.assign("/auth/ai-engineer-summit");
                    }
                  }}
                >
                  {canRequestLink
                    ? linkRequested
                      ? "Sign-in link requested"
                      : "Email me a sign-in link"
                    : state === "permission"
                      ? "Sign in with another email"
                      : "Return to sign in"}
                </Button>
                <Button
                  onClick={() =>
                    window.location.assign(
                      "mailto:speakers@aiengineersummit.com",
                    )
                  }
                  variant="secondary"
                >
                  Contact the program team
                </Button>
              </div>
              {linkRequested ? (
                <p className="portal-invitation-requested" role="status">
                  If mina@example.com still has access, a new link is on its
                  way. You can request another in 60 seconds.
                </p>
              ) : null}
            </>
          }
          description={content.description}
          state={
            state === "permission" || state === "revoked"
              ? "permission"
              : "error"
          }
          title={content.title}
        />
      </main>
      <p>
        Invitation for mina@example.com ·{" "}
        <a href="mailto:speakers@aiengineersummit.com">
          speakers@aiengineersummit.com
        </a>
      </p>
    </div>
  );
}

function PortalAuthenticationState({
  eventSlug,
  onRetry,
  onSignOut,
  signOutError,
  signingOut,
  state,
}: {
  eventSlug: string;
  onRetry: () => void;
  onSignOut: () => void;
  signOutError: string;
  signingOut: boolean;
  state: "checking" | "error" | "permission" | "unauthenticated";
}) {
  const [email, setEmail] = useState("");
  const [requestError, setRequestError] = useState("");
  const [requestState, setRequestState] = useState<
    "editing" | "sending" | "sent"
  >("editing");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileWidgetHandle>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!turnstileToken) {
      setRequestError("Complete the security check before requesting a link.");
      return;
    }
    setRequestError("");
    setRequestState("sending");
    try {
      await requestSpeakerPortalLink(eventSlug, email, turnstileToken);
      setRequestState("sent");
    } catch (error) {
      setRequestError(
        error instanceof Error
          ? error.message
          : "We couldn’t request a link just now. Try again.",
      );
      setRequestState("editing");
    } finally {
      turnstile.current?.reset();
      setTurnstileToken(null);
    }
  };
  const panel =
    state === "checking"
      ? {
          description:
            "We’re checking your private session before loading any speaker or event information.",
          panelState: "loading" as const,
          title: "Opening your speaker portal…",
        }
      : state === "unauthenticated"
        ? {
            description:
              "Use the invited email address. We’ll send a private one-time link and return you to this event.",
            panelState: "permission" as const,
            title: "Sign in to your speaker portal",
          }
        : state === "permission"
          ? {
              description:
                "This signed-in account is not an active speaker for this event. Sign out, then use the email address that received the invitation.",
              panelState: "permission" as const,
              title: "This portal is not available to this account",
            }
          : {
              description:
                "Your speaker information remains private. Check your connection and try loading the portal again.",
              panelState: "error" as const,
              title: "We couldn’t verify your session",
            };

  return (
    <div className="portal-invitation-page">
      <PortalBrand href={`/portal/${encodeURIComponent(eventSlug)}`} />
      <main className="portal-invitation-card">
        <div className="portal-invitation-event">
          <span>OS</span>
          <div>
            <strong>OpenSession speaker portal</strong>
            <small>Private event access</small>
          </div>
        </div>
        <StatePanel
          action={
            state === "unauthenticated" ? (
              requestState === "sent" ? (
                <p className="portal-invitation-requested" role="status">
                  If <strong>{email}</strong> still has access, a private link
                  is on its way. It expires in 15 minutes and works once.
                </p>
              ) : (
                <form className="portal-link-form" onSubmit={submit}>
                  <label htmlFor="portal-link-email">Invited email</label>
                  <input
                    autoComplete="email"
                    id="portal-link-email"
                    inputMode="email"
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="speaker@example.com"
                    required
                    type="email"
                    value={email}
                  />
                  <TurnstileWidget
                    action="sign_in"
                    onTokenChange={setTurnstileToken}
                    ref={turnstile}
                  />
                  {requestError ? (
                    <p className="portal-auth-error" role="alert">
                      {requestError}
                    </p>
                  ) : null}
                  <Button
                    disabled={
                      requestState === "sending" || !turnstileToken || !email
                    }
                    type="submit"
                  >
                    {requestState === "sending"
                      ? "Sending private link…"
                      : "Email me a sign-in link"}
                  </Button>
                </form>
              )
            ) : state === "permission" ? (
              <Button
                disabled={signingOut}
                onClick={onSignOut}
                variant="secondary"
              >
                {signingOut ? "Signing out…" : "Sign out and use invited email"}
              </Button>
            ) : undefined
          }
          description={panel.description}
          onRetry={state === "error" ? onRetry : undefined}
          state={panel.panelState}
          title={panel.title}
        />
        {signOutError ? (
          <p className="portal-auth-error" role="alert">
            {signOutError}
          </p>
        ) : null}
      </main>
      <p>Speaker and session details stay hidden until access is verified.</p>
    </div>
  );
}

export function SpeakerPortal({
  fixtureState = "default",
  fixtureTaskState,
  fixtureView = "home",
}: {
  fixtureState?: PortalFixtureState | undefined;
  fixtureTaskState?: TaskFixtureState;
  fixtureView?: PortalFixtureView | undefined;
} = {}) {
  const fixtureRoute = window.location.pathname.startsWith("/fixtures/");
  const eventSlug = fixtureRoute
    ? "ai-engineer-summit"
    : (window.location.pathname.split("/")[2] ?? "");
  const [authenticationAttempt, setAuthenticationAttempt] = useState(0);
  const [runtime, setRuntime] = useState<PortalRuntime>({
    data: null,
    state: "checking",
  });
  const [signOutState, setSignOutState] = useState<"idle" | "signing-out">(
    "idle",
  );
  const [signOutError, setSignOutError] = useState("");

  useEffect(() => {
    if (fixtureRoute) return;
    const controller = new AbortController();
    void readSpeakerPortal(
      eventSlug,
      window.fetch.bind(window),
      controller.signal,
    )
      .then((response) => {
        setRuntime({ data: speakerPortalView(response), state: "active" });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setRuntime({
          data: null,
          state:
            error instanceof SpeakerPortalApiError && error.status === 401
              ? "unauthenticated"
              : error instanceof SpeakerPortalApiError && error.status === 403
                ? "permission"
                : "error",
        });
      });
    return () => controller.abort();
  }, [authenticationAttempt, eventSlug, fixtureRoute]);

  const state: PortalState =
    fixtureState === "default" ? "active" : fixtureState;
  if (
    state === "expired" ||
    state === "permission" ||
    state === "redeemed" ||
    state === "revoked"
  ) {
    return <InvitationState state={state} />;
  }

  const signOut = async () => {
    setSignOutError("");
    setSignOutState("signing-out");
    try {
      await logoutAuthSession(document.cookie);
      window.location.assign(`/portal/${encodeURIComponent(eventSlug)}`);
    } catch (error) {
      setSignOutError(
        error instanceof Error
          ? error.message
          : "We couldn’t sign you out. Refresh and try again.",
      );
      setSignOutState("idle");
    }
  };

  if (runtime.state !== "active" && !fixtureRoute) {
    return (
      <PortalAuthenticationState
        eventSlug={eventSlug}
        onRetry={() => {
          setRuntime({ data: null, state: "checking" });
          setAuthenticationAttempt((attempt) => attempt + 1);
        }}
        onSignOut={signOut}
        signOutError={signOutError}
        signingOut={signOutState === "signing-out"}
        state={runtime.state}
      />
    );
  }

  const portal = fixtureRoute ? speakerPortalFixture : runtime.data;
  if (!portal) return null;
  const authenticatedDisplayName = portal.speakerName;
  const sessions = state === "empty" ? [] : portal.sessions;
  const openTasks = portal.tasks.filter((task) => task.status !== "complete");
  const actionableRequiredTasks = openTasks.filter(
    (task) => task.required && task.assignmentState !== "submitted",
  );
  const actionableOverdueTasks = actionableRequiredTasks.filter(
    (task) => task.status === "overdue",
  );
  const submittedRequiredTasks = openTasks.filter(
    (task) => task.required && task.assignmentState === "submitted",
  );
  const optionalTasks = portal.tasks.filter((task) => !task.required);
  const profileActive =
    fixtureRoute &&
    (fixtureView === "profile" ||
      window.location.pathname.endsWith("/profile"));
  const taskActive =
    (fixtureRoute &&
      (fixtureView === "task" ||
        Boolean(fixtureTaskState) ||
        window.location.pathname.endsWith("/tasks/final-slides"))) ||
    (!fixtureRoute &&
      /^\/portal\/[^/]+\/tasks\/[^/]+\/?$/.test(window.location.pathname));
  const productionAssignmentId = !fixtureRoute
    ? (window.location.pathname.split("/")[4] ?? "")
    : "";

  if (profileActive) {
    return (
      <div className="speaker-portal">
        <PortalHeader
          activeSection="profile"
          displayName={authenticatedDisplayName}
          eventSlug={eventSlug}
          fixtureRoute={fixtureRoute}
          openTaskCount={openTasks.length}
        />
        <SpeakerProfileWorkspace />
      </div>
    );
  }

  if (taskActive) {
    return (
      <div className="speaker-portal">
        <PortalHeader
          activeSection="tasks"
          displayName={authenticatedDisplayName}
          eventSlug={eventSlug}
          fixtureRoute={fixtureRoute}
          openTaskCount={openTasks.length}
        />
        {fixtureRoute ? (
          <SpeakerTaskWorkspace fixtureState={fixtureTaskState ?? "default"} />
        ) : (
          <ProductionSpeakerTaskWorkspace
            assignmentId={productionAssignmentId}
            eventKey={eventSlug}
          />
        )}
      </div>
    );
  }

  return (
    <div className="speaker-portal">
      <PortalHeader
        activeSection="home"
        displayName={authenticatedDisplayName}
        eventSlug={eventSlug}
        fixtureRoute={fixtureRoute}
        onSignOut={fixtureRoute ? undefined : signOut}
        openTaskCount={openTasks.length}
        signingOut={signOutState === "signing-out"}
      />

      <main className="portal-main">
        {signOutError ? (
          <p className="portal-auth-error" role="alert">
            {signOutError}
          </p>
        ) : null}
        <section className="portal-hero">
          <div>
            <p className="overline">Your speaker home</p>
            <h1>
              You’re on the program, {portal.speakerName.split(/\s+/)[0]}.
            </h1>
            <p>
              Everything the team needs from you is collected here, with the
              next deadline always clear.
            </p>
            <div className="portal-hero-meta">
              <span>
                <CalendarDays aria-hidden="true" size={16} />{" "}
                {portal.eventDateLabel}
              </span>
              <span>
                <MapPin aria-hidden="true" size={16} /> {portal.location}
              </span>
            </div>
          </div>
          <div className="portal-countdown">
            <span>{portal.countdownValue}</span>
            <strong>{portal.countdownLabel}</strong>
            <small>{portal.eventDateLabel}</small>
          </div>
        </section>

        <div className="portal-summary-grid">
          <section
            className="portal-readiness"
            aria-labelledby="portal-readiness-title"
          >
            <div className="portal-card-heading">
              <div>
                <p className="overline">Speaker readiness</p>
                <h2 id="portal-readiness-title">
                  {portal.readinessStatus === "not_configured"
                    ? "No required tasks assigned"
                    : `${portal.completedTasks} of ${portal.totalTasks} required complete`}
                </h2>
              </div>
              <StatusPill
                tone={
                  portal.readinessStatus === "not_configured"
                    ? "neutral"
                    : actionableRequiredTasks.length > 0
                      ? "warning"
                      : portal.outstandingTasks > 0
                        ? "preview"
                        : "success"
                }
              >
                {portal.readinessStatus === "not_configured"
                  ? "Not configured"
                  : actionableRequiredTasks.length > 0 &&
                      submittedRequiredTasks.length > 0
                    ? `${actionableRequiredTasks.length} your action · ${submittedRequiredTasks.length} submitted`
                    : actionableRequiredTasks.length > 0
                      ? `${actionableRequiredTasks.length} required ${actionableRequiredTasks.length === 1 ? "task needs" : "tasks need"} attention`
                      : submittedRequiredTasks.length > 0
                        ? `${submittedRequiredTasks.length} submitted to program team`
                        : portal.outstandingTasks > 0
                          ? `${portal.outstandingTasks} required outstanding`
                          : "Required tasks ready"}
              </StatusPill>
            </div>
            {portal.totalTasks > 0 ? (
              <div
                className="portal-readiness-progress"
                role="progressbar"
                aria-label={`${portal.completedTasks} of ${portal.totalTasks} required speaker tasks complete`}
                aria-valuemin={0}
                aria-valuemax={portal.totalTasks}
                aria-valuenow={portal.completedTasks}
              >
                <span
                  style={{
                    width: `${(portal.completedTasks / portal.totalTasks) * 100}%`,
                  }}
                />
              </div>
            ) : null}
            <p>
              {portal.readinessStatus === "not_configured"
                ? optionalTasks.length > 0
                  ? `No required tasks are assigned. ${optionalTasks.length} optional ${optionalTasks.length === 1 ? "request appears" : "requests appear"} below.`
                  : "The program team has not assigned any speaker tasks yet."
                : actionableOverdueTasks.length > 0
                  ? `${actionableOverdueTasks.length} overdue required ${actionableOverdueTasks.length === 1 ? "task needs" : "tasks need"} your attention.${submittedRequiredTasks.length > 0 ? ` ${submittedRequiredTasks.length} submitted required ${submittedRequiredTasks.length === 1 ? "task remains" : "tasks remain"} with the program team.` : ""}`
                  : actionableRequiredTasks.length > 0
                    ? submittedRequiredTasks.length > 0
                      ? `Finish ${actionableRequiredTasks.length} open required ${actionableRequiredTasks.length === 1 ? "task" : "tasks"} on your side. ${submittedRequiredTasks.length} submitted required ${submittedRequiredTasks.length === 1 ? "task remains" : "tasks remain"} with the program team.`
                      : `Complete ${actionableRequiredTasks.length} open required ${actionableRequiredTasks.length === 1 ? "task" : "tasks"} to be ready.`
                    : submittedRequiredTasks.length > 0
                      ? `${submittedRequiredTasks.length} required ${submittedRequiredTasks.length === 1 ? "task is" : "tasks are"} submitted and being processed by the program team. No speaker action is needed right now.`
                      : portal.outstandingTasks > 0
                        ? "The program team is processing your submitted work. No speaker action is needed right now."
                        : "Every required speaker task is complete. Optional requests may still appear below."}
            </p>
            {actionableRequiredTasks.length > 0 ? (
              <Button
                onClick={() =>
                  document
                    .querySelector("#portal-tasks")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
              >
                Review required tasks{" "}
                <ArrowRight aria-hidden="true" size={16} />
              </Button>
            ) : null}
          </section>
          <aside className="portal-event-card">
            <div className="portal-event-art">
              {portal.eventName
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 3)
                .map((word) => (
                  <span key={word}>{word.toLocaleUpperCase("en-US")}</span>
                ))}
            </div>
            <div>
              <strong>{portal.eventName}</strong>
              <p>
                {portal.eventDateLabel}
                <br />
                {portal.location}
              </p>
              <a href="#portal-resources">
                View speaker resources{" "}
                <ExternalLink aria-hidden="true" size={13} />
              </a>
            </div>
          </aside>
        </div>

        <div className="portal-content-grid">
          <section
            className="portal-panel"
            id="portal-tasks"
            aria-labelledby="portal-tasks-title"
          >
            <div className="portal-panel-heading">
              <div>
                <p className="overline">What’s next</p>
                <h2 id="portal-tasks-title">Your tasks</h2>
              </div>
              <span>{openTasks.length} open</span>
            </div>
            <div className="portal-task-list">
              {portal.tasks.length > 0 ? (
                portal.tasks.map((task) => (
                  <TaskRow
                    eventSlug={eventSlug}
                    fixtureRoute={fixtureRoute}
                    key={task.id}
                    task={task}
                  />
                ))
              ) : (
                <StatePanel
                  description="There is nothing you need to complete right now. New requests from the program team will appear here."
                  state="empty"
                  title="No speaker tasks assigned"
                />
              )}
            </div>
          </section>

          <section
            className="portal-panel"
            id="portal-sessions"
            aria-labelledby="portal-sessions-title"
          >
            <div className="portal-panel-heading">
              <div>
                <p className="overline">Program</p>
                <h2 id="portal-sessions-title">Your sessions</h2>
              </div>
              <span>{sessions.length}</span>
            </div>
            {sessions.length > 0 ? (
              sessions.map((session) => (
                <article className="portal-session" key={session.id}>
                  <div className="portal-session-top">
                    <StatusPill tone="preview">{session.track}</StatusPill>
                    <span>{session.format}</span>
                  </div>
                  <h3>{session.title}</h3>
                  <div className="portal-session-schedule">
                    <CalendarDays aria-hidden="true" size={17} />
                    <span>
                      <strong>
                        {session.scheduleLabel ?? "Schedule to be announced"}
                      </strong>
                      <small>{session.room ?? "Room to be announced"}</small>
                    </span>
                  </div>
                  {session.coSpeakers.length > 0 ? (
                    <p className="portal-session-speakers">
                      With {session.coSpeakers.join(", ")}
                    </p>
                  ) : null}
                  {fixtureRoute ? (
                    <div className="portal-session-actions">
                      <Button variant="secondary">
                        Review session details
                      </Button>
                      <button type="button">
                        Public preview{" "}
                        <ExternalLink aria-hidden="true" size={14} />
                      </button>
                    </div>
                  ) : null}
                </article>
              ))
            ) : (
              <StatePanel
                description="Your portal is active, but no sessions are assigned yet. The program team will notify you when the schedule is ready."
                state="empty"
                title="No sessions assigned yet"
              />
            )}
          </section>
        </div>

        <section className="portal-help" id="portal-resources">
          <HelpCircle aria-hidden="true" size={22} />
          <div>
            <strong>Need a hand?</strong>
            <p>
              Read the speaker guide or email the program team. We usually reply
              within one business day.
            </p>
          </div>
          {fixtureRoute ? (
            <>
              <a href="#guide">
                <FileText aria-hidden="true" size={15} /> Speaker guide
              </a>
              <a href="mailto:speakers@aiengineersummit.com">
                Email speakers@…
              </a>
            </>
          ) : (
            <span>
              Reply to your invitation email to reach the program team.
            </span>
          )}
        </section>
      </main>
    </div>
  );
}
