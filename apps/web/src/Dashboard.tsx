import { ArrowRight, Inbox, Library, Mic2, Sparkles } from "lucide-react";

import { Button, MetricCard } from "@sessionbox-killer/ui";

const actions = [
  {
    eyebrow: "CFP",
    title: "Review 4 new submissions",
    detail: "All routed to AI Engineering",
    icon: Inbox,
    tone: "clay",
  },
  {
    eyebrow: "Reviews",
    title: "Assign 8 pending reviews",
    detail: "2 proposals need a second reviewer",
    icon: Sparkles,
    tone: "gold",
  },
  {
    eyebrow: "Speakers",
    title: "Nudge 3 overdue speakers",
    detail: "Slides and headshots are still missing",
    icon: Mic2,
    tone: "blue",
  },
] as const;

export function Dashboard() {
  return (
    <div className="workspace-content">
      <section className="welcome" aria-labelledby="page-title">
        <div>
          <p className="overline">Saturday, August 8</p>
          <h1 id="page-title">Good afternoon, Casey.</h1>
          <p className="welcome-copy">
            Your program is moving. Three decisions will clear the path to a
            publishable agenda.
          </p>
        </div>
        <Button
          onClick={() => {
            window.location.assign(
              "/app/ai-engineer-summit/settings#setup-checklist",
            );
          }}
          variant="primary"
        >
          Open setup checklist
          <ArrowRight size={16} aria-hidden="true" />
        </Button>
      </section>

      <section className="metric-grid" aria-label="Event readiness">
        <MetricCard
          label="Submissions"
          value="42"
          detail="4 new today"
          tone="ink"
        />
        <MetricCard
          label="Reviews complete"
          value="68%"
          detail="17 of 25"
          tone="gold"
        />
        <MetricCard
          label="Speakers ready"
          value="5 / 8"
          detail="3 need attention"
          tone="blue"
        />
        <MetricCard
          label="Agenda conflicts"
          value="1"
          detail="Blocking publish"
          tone="clay"
        />
      </section>

      <div className="content-grid">
        <section
          className="panel action-panel"
          aria-labelledby="next-actions-title"
        >
          <div className="panel-heading">
            <div>
              <p className="overline">Priority queue</p>
              <h2 id="next-actions-title">What needs you next</h2>
            </div>
            <button className="text-button" type="button">
              View all work <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>

          <div className="action-list">
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <button className="action-row" type="button" key={action.title}>
                  <span className={`action-icon ${action.tone}`}>
                    <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
                  </span>
                  <span className="action-copy">
                    <small>{action.eyebrow}</small>
                    <strong>{action.title}</strong>
                    <span>{action.detail}</span>
                  </span>
                  <ArrowRight
                    className="row-arrow"
                    size={18}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </section>

        <aside className="panel launch-panel" aria-labelledby="launch-title">
          <div className="launch-visual" aria-hidden="true">
            <div className="launch-orbit orbit-one" />
            <div className="launch-orbit orbit-two" />
            <Library size={32} strokeWidth={1.4} />
          </div>
          <p className="overline">Launch readiness</p>
          <h2 id="launch-title">Your CFP is live</h2>
          <p>
            Four of six setup areas are complete. Sender verification and review
            routing remain.
          </p>
          <div
            className="progress-track"
            aria-label="Setup completion"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={67}
            role="progressbar"
          >
            <span style={{ width: "67%" }} />
          </div>
          <div className="progress-meta">
            <span>4 of 6 complete</span>
            <strong>67%</strong>
          </div>
          <Button
            className="launch-action"
            onClick={() => {
              window.location.assign("/app/ai-engineer-summit/settings");
            }}
            variant="secondary"
          >
            Continue setup
          </Button>
        </aside>
      </div>
    </div>
  );
}
