import { useState } from "react";
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

function PortalBrand() {
  return (
    <a className="portal-brand" href="/portal/ai-engineer-summit">
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

function TaskRow({ task }: { task: PortalTaskView }) {
  const complete = task.status === "complete";
  const action =
    task.id === "final-slides"
      ? {
          label: "Review submission",
          path: "/portal/ai-engineer-summit/tasks/final-slides",
        }
      : {
          label: task.id === "headshot" ? "Upload headshot" : "Review profile",
          path: "/portal/ai-engineer-summit/profile",
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
  openTaskCount,
}: {
  activeSection: "home" | "profile" | "tasks";
  openTaskCount: number;
}) {
  return (
    <header className="portal-topbar">
      <PortalBrand />
      <nav aria-label="Speaker portal">
        <a
          aria-current={activeSection === "home" ? "page" : undefined}
          href="/portal/ai-engineer-summit"
        >
          <Home aria-hidden="true" size={16} /> Home
        </a>
        <a
          aria-current={activeSection === "tasks" ? "page" : undefined}
          href="/portal/ai-engineer-summit#portal-tasks"
        >
          <CheckCircle2 aria-hidden="true" size={16} /> Tasks{" "}
          <span>{openTaskCount}</span>
        </a>
        <a href="/portal/ai-engineer-summit#portal-sessions">
          <Mic2 aria-hidden="true" size={16} /> Sessions
        </a>
        <a
          aria-current={activeSection === "profile" ? "page" : undefined}
          href="/portal/ai-engineer-summit/profile"
        >
          <UserRound aria-hidden="true" size={16} /> Profile
        </a>
      </nav>
      <div className="portal-profile-chip">
        <span>MO</span>
        <div>
          <strong>{speakerPortalFixture.speakerName}</strong>
          <small>Speaker</small>
        </div>
        <button aria-label="Sign out" type="button">
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

export function SpeakerPortal({
  fixtureState = "default",
  fixtureTaskState,
}: {
  fixtureState?: PortalFixtureState | undefined;
  fixtureTaskState?: TaskFixtureState;
} = {}) {
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

  const sessions = state === "empty" ? [] : speakerPortalFixture.sessions;
  const openTasks = speakerPortalFixture.tasks.filter(
    (task) => task.status !== "complete",
  );
  const profileActive = window.location.pathname.endsWith("/profile");
  const taskActive =
    Boolean(fixtureTaskState) ||
    window.location.pathname.endsWith("/tasks/final-slides");

  if (profileActive) {
    return (
      <div className="speaker-portal">
        <PortalHeader
          activeSection="profile"
          openTaskCount={openTasks.length}
        />
        <SpeakerProfileWorkspace />
      </div>
    );
  }

  if (taskActive) {
    return (
      <div className="speaker-portal">
        <PortalHeader activeSection="tasks" openTaskCount={openTasks.length} />
        <SpeakerTaskWorkspace fixtureState={fixtureTaskState ?? "default"} />
      </div>
    );
  }

  return (
    <div className="speaker-portal">
      <PortalHeader activeSection="home" openTaskCount={openTasks.length} />

      <main className="portal-main">
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
                <TaskRow key={task.id} task={task} />
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
