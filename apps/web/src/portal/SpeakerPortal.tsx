import { useEffect, useState } from "react";
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

import {
  AuthApiError,
  logoutAuthSession,
  readAuthSession,
  type AuthSessionIdentity,
} from "../auth/authClient";
import { speakerPortalFixture, type PortalTaskView } from "./portalModel";
import { SpeakerProfileWorkspace } from "./SpeakerProfileWorkspace";
import {
  SpeakerTaskWorkspace,
  type TaskFixtureState,
} from "../tasks/TaskCompletionWorkspace";

import "./speaker-portal.css";

type PortalState =
  "active" | "empty" | "expired" | "permission" | "redeemed" | "revoked";
export type PortalFixtureState = Exclude<PortalState, "active"> | "default";
export type PortalFixtureView = "home" | "profile" | "task";

type PortalAuthentication =
  | { session: AuthSessionIdentity; state: "authenticated" }
  | { session: null; state: "checking" | "error" | "unauthenticated" };

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
  fixtureRoute,
  task,
}: {
  fixtureRoute: boolean;
  task: PortalTaskView;
}) {
  const complete = task.status === "complete";
  const action =
    task.id === "final-slides"
      ? {
          label: "Review submission",
          path: fixtureRoute
            ? "/fixtures/portal-task/default"
            : "/portal/ai-engineer-summit/tasks/final-slides",
        }
      : {
          label: task.id === "headshot" ? "Upload headshot" : "Review profile",
          path: fixtureRoute
            ? "/fixtures/portal/profile"
            : "/portal/ai-engineer-summit/profile",
        };
  return (
    <article className={`portal-task is-${task.status}`}>
      <span className="portal-task-check" aria-hidden="true">
        {complete ? <Check size={15} /> : null}
      </span>
      <div>
        <strong>{task.title}</strong>
        <p>{task.description}</p>
      </div>
      <span className="portal-task-due">{task.dueLabel}</span>
      {!complete ? (
        <button
          onClick={() => {
            window.location.href = action.path;
          }}
          type="button"
        >
          {action.label}
          <ArrowRight aria-hidden="true" size={15} />
        </button>
      ) : null}
    </article>
  );
}

function PortalHeader({
  activeSection,
  displayName,
  fixtureRoute,
  onSignOut,
  openTaskCount,
  signingOut,
}: {
  activeSection: "home" | "profile" | "tasks";
  displayName: string;
  fixtureRoute: boolean;
  onSignOut?: (() => void) | undefined;
  openTaskCount: number;
  signingOut?: boolean | undefined;
}) {
  const homePath = fixtureRoute
    ? "/fixtures/portal/active"
    : "/portal/ai-engineer-summit";
  const profilePath = fixtureRoute
    ? "/fixtures/portal/profile"
    : "/portal/ai-engineer-summit/profile";
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
        <a
          aria-current={activeSection === "profile" ? "page" : undefined}
          href={profilePath}
        >
          <UserRound aria-hidden="true" size={16} /> Profile
        </a>
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
  onRetry,
  state,
}: {
  onRetry: () => void;
  state: "checking" | "error" | "unauthenticated";
}) {
  const returnPath = window.location.pathname;
  const signInPath = `/auth/sign-in?return_to=${encodeURIComponent(returnPath)}`;
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
        : {
            description:
              "Your speaker information remains private. Check your connection and try loading the portal again.",
            panelState: "error" as const,
            title: "We couldn’t verify your session",
          };

  return (
    <div className="portal-invitation-page">
      <PortalBrand />
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
              <Button onClick={() => window.location.assign(signInPath)}>
                Email me a sign-in link
              </Button>
            ) : undefined
          }
          description={panel.description}
          onRetry={state === "error" ? onRetry : undefined}
          state={panel.panelState}
          title={panel.title}
        />
      </main>
      <p>Speaker and session details stay hidden until access is verified.</p>
    </div>
  );
}

function PortalVerifiedSessionState({
  displayName,
  onSignOut,
  signOutError,
  signingOut,
}: {
  displayName: string;
  onSignOut: () => void;
  signOutError: string;
  signingOut: boolean;
}) {
  return (
    <div className="portal-invitation-page">
      <PortalBrand />
      <main className="portal-invitation-card">
        <div className="portal-invitation-event">
          <span>{initials(displayName)}</span>
          <div>
            <strong>Signed in as {displayName}</strong>
            <small>Speaker portal session verified</small>
          </div>
        </div>
        <StatePanel
          action={
            <Button
              disabled={signingOut}
              onClick={onSignOut}
              variant="secondary"
            >
              {signingOut ? "Signing out…" : "Sign out and use invited link"}
            </Button>
          }
          description="Your sign-in is valid, but this URL cannot yet verify your speaker relationship to the event. No speaker, task, or session data has been shown. Open the event-specific invitation from your email or contact the program team."
          state="permission"
          title="We couldn’t verify access to this event"
        />
        {signOutError ? (
          <p className="portal-auth-error" role="alert">
            {signOutError}
          </p>
        ) : null}
      </main>
      <p>
        Event-scoped access is checked before private portal data is loaded.
      </p>
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
  const [authenticationAttempt, setAuthenticationAttempt] = useState(0);
  const [authentication, setAuthentication] = useState<PortalAuthentication>({
    session: null,
    state: "checking",
  });
  const [signOutState, setSignOutState] = useState<"idle" | "signing-out">(
    "idle",
  );
  const [signOutError, setSignOutError] = useState("");

  useEffect(() => {
    if (fixtureRoute) return;
    const controller = new AbortController();
    void readAuthSession(window.fetch.bind(window), controller.signal)
      .then((session) => {
        setAuthentication({ session, state: "authenticated" });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setAuthentication({
          session: null,
          state:
            error instanceof AuthApiError &&
            (error.status === 401 || error.status === 403)
              ? "unauthenticated"
              : "error",
        });
      });
    return () => controller.abort();
  }, [authenticationAttempt, fixtureRoute]);

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

  if (authentication.state !== "authenticated" && !fixtureRoute) {
    return (
      <PortalAuthenticationState
        onRetry={() => {
          setAuthentication({ session: null, state: "checking" });
          setAuthenticationAttempt((attempt) => attempt + 1);
        }}
        state={authentication.state}
      />
    );
  }

  const authenticatedDisplayName =
    authentication.state === "authenticated"
      ? (authentication.session.user.display_name ??
        authentication.session.user.email)
      : speakerPortalFixture.speakerName;
  const signOut = async () => {
    setSignOutError("");
    setSignOutState("signing-out");
    try {
      await logoutAuthSession(document.cookie);
      const returnPath = encodeURIComponent(window.location.pathname);
      window.location.assign(`/auth/sign-in?return_to=${returnPath}`);
    } catch (error) {
      setSignOutError(
        error instanceof Error
          ? error.message
          : "We couldn’t sign you out. Refresh and try again.",
      );
      setSignOutState("idle");
    }
  };

  if (!fixtureRoute && authentication.state === "authenticated") {
    return (
      <PortalVerifiedSessionState
        displayName={authenticatedDisplayName}
        onSignOut={signOut}
        signOutError={signOutError}
        signingOut={signOutState === "signing-out"}
      />
    );
  }

  const sessions = state === "empty" ? [] : speakerPortalFixture.sessions;
  const openTasks = speakerPortalFixture.tasks.filter(
    (task) => task.status !== "complete",
  );
  const profileActive =
    fixtureView === "profile" || window.location.pathname.endsWith("/profile");
  const taskActive =
    fixtureView === "task" ||
    Boolean(fixtureTaskState) ||
    window.location.pathname.endsWith("/tasks/final-slides");

  if (profileActive) {
    return (
      <div className="speaker-portal">
        <PortalHeader
          activeSection="profile"
          displayName={authenticatedDisplayName}
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
          fixtureRoute={fixtureRoute}
          openTaskCount={openTasks.length}
        />
        <SpeakerTaskWorkspace fixtureState={fixtureTaskState ?? "default"} />
      </div>
    );
  }

  return (
    <div className="speaker-portal">
      <PortalHeader
        activeSection="home"
        displayName={authenticatedDisplayName}
        fixtureRoute={fixtureRoute}
        openTaskCount={openTasks.length}
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
            <h1>You’re on the program, Mina.</h1>
            <p>
              Everything the team needs from you is collected here, with the
              next deadline always clear.
            </p>
            <div className="portal-hero-meta">
              <span>
                <CalendarDays aria-hidden="true" size={16} />{" "}
                {speakerPortalFixture.eventDateLabel}
              </span>
              <span>
                <MapPin aria-hidden="true" size={16} />{" "}
                {speakerPortalFixture.location}
              </span>
            </div>
          </div>
          <div className="portal-countdown">
            <span>9</span>
            <strong>days to go</strong>
            <small>Tuesday, August 18</small>
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
                <h2 id="portal-readiness-title">Three of six complete</h2>
              </div>
              <StatusPill tone="warning">2 need attention</StatusPill>
            </div>
            <div
              className="portal-readiness-progress"
              role="progressbar"
              aria-label="3 of 6 speaker tasks complete"
              aria-valuemin={0}
              aria-valuemax={6}
              aria-valuenow={3}
            >
              <span style={{ width: "50%" }} />
            </div>
            <p>
              Your headshot is overdue. Complete all three open tasks to be
              ready for publication.
            </p>
            <Button
              onClick={() => {
                window.location.href =
                  "/portal/ai-engineer-summit/tasks/final-slides";
              }}
            >
              Review final presentation{" "}
              <ArrowRight aria-hidden="true" size={16} />
            </Button>
          </section>
          <aside className="portal-event-card">
            <div className="portal-event-art">
              <span>AI</span>
              <span>ENGINEER</span>
              <span>SUMMIT</span>
            </div>
            <div>
              <strong>{speakerPortalFixture.eventName}</strong>
              <p>
                {speakerPortalFixture.eventDateLabel}
                <br />
                {speakerPortalFixture.location}
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
              {speakerPortalFixture.tasks.map((task) => (
                <TaskRow
                  fixtureRoute={fixtureRoute}
                  key={task.id}
                  task={task}
                />
              ))}
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
                      <strong>{session.scheduleLabel}</strong>
                      <small>{session.room}</small>
                    </span>
                  </div>
                  <div className="portal-session-actions">
                    <Button variant="secondary">Review session details</Button>
                    <button type="button">
                      Public preview{" "}
                      <ExternalLink aria-hidden="true" size={14} />
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <StatePanel
                action={
                  <Button variant="secondary">Contact the program team</Button>
                }
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
          <a href="#guide">
            <FileText aria-hidden="true" size={15} /> Speaker guide
          </a>
          <a href="mailto:speakers@aiengineersummit.com">Email speakers@…</a>
        </section>
      </main>
    </div>
  );
}
