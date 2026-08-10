import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  Mail,
  MessageSquareText,
  RefreshCw,
  Sparkles,
  UserCheck,
  Users,
} from "lucide-react";

import {
  Button,
  DataTable,
  SelectField,
  StatusPill,
  TextField,
  ToastRegion,
  type DataTableColumn,
  type ToastMessage,
} from "@sessionbox-killer/ui";

import {
  speakerReadinessFixture,
  type SpeakerReadinessView,
} from "./readinessModel";

import "./readiness-dashboard.css";

export type ReadinessFixtureState = "lag" | "partial";

type SpeakerFilter =
  "all" | "not_configured" | "outstanding" | "overdue" | "ready";

const trackOptions = [
  { label: "All tracks", value: "all" },
  ...Array.from(
    new Set(speakerReadinessFixture.map((speaker) => speaker.track)),
  ).map((track) => ({ label: track, value: track })),
];

const portalOptions = [
  { label: "All portal states", value: "all" },
  { label: "Active", value: "active" },
  { label: "Invited", value: "invited" },
  { label: "Not invited", value: "not_invited" },
];

function readFilter(name: string) {
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

function getInitialFilter(): SpeakerFilter {
  const filter = readFilter("filter");
  return filter === "not_configured" ||
    filter === "outstanding" ||
    filter === "overdue" ||
    filter === "ready"
    ? filter
    : "all";
}

function getInitialOption(name: string, options: { value: string }[]) {
  const value = readFilter(name);
  return options.some((option) => option.value === value) ? value : "all";
}

function getReadinessState(
  speaker: SpeakerReadinessView,
  completed: Set<string>,
) {
  if (completed.has(speaker.id)) return "ready";
  if (speaker.totalRequired === 0) return "not_configured";
  return speaker.completedRequired >= speaker.totalRequired
    ? "ready"
    : "outstanding";
}

function writeFilters(values: {
  filter: SpeakerFilter;
  portalState: string;
  query: string;
  track: string;
}) {
  const params = new URLSearchParams();
  if (values.query) params.set("q", values.query);
  if (values.filter !== "all") params.set("filter", values.filter);
  if (values.track !== "all") params.set("track", values.track);
  if (values.portalState !== "all") params.set("portal", values.portalState);
  const search = params.toString();
  window.history.replaceState(
    null,
    "",
    search ? `${window.location.pathname}?${search}` : window.location.pathname,
  );
}

export function ReadinessDashboard({
  fixtureState,
}: {
  fixtureState?: ReadinessFixtureState | undefined;
}) {
  const [filter, setFilter] = useState<SpeakerFilter>(getInitialFilter);
  const [track, setTrack] = useState(() =>
    getInitialOption("track", trackOptions),
  );
  const [portalState, setPortalState] = useState(() =>
    getInitialOption("portal", portalOptions),
  );
  const [query, setQuery] = useState(() => readFilter("q"));
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const projectionState = fixtureState ?? "current";

  const readyCount = speakerReadinessFixture.filter(
    (speaker) => getReadinessState(speaker, completed) === "ready",
  ).length;
  const overdueCount = speakerReadinessFixture.reduce(
    (sum, speaker) =>
      sum + (completed.has(speaker.id) ? 0 : speaker.overdueCount),
    0,
  );

  const metrics = [
    {
      detail: "Since yesterday",
      href: "/app/ai-engineer-summit/submissions?status=new",
      icon: Sparkles,
      label: "New submissions",
      tone: "blue",
      value: "4",
    },
    {
      detail: "Across 5 reviewers",
      href: "/app/ai-engineer-summit/reviews?status=pending",
      icon: MessageSquareText,
      label: "Reviews remaining",
      tone: "gold",
      value: "8",
    },
    {
      detail: "Accepted, no room/time",
      href: "/app/ai-engineer-summit/agenda?filter=unscheduled",
      icon: CalendarClock,
      label: "Accepted unscheduled",
      tone: "clay",
      value: "4",
    },
    {
      detail: "Blocks publication",
      href: "/app/ai-engineer-summit/agenda?filter=conflicts",
      icon: AlertTriangle,
      label: "Hard conflicts",
      tone: "danger",
      value: "1",
    },
    {
      detail: `${speakerReadinessFixture.length - readyCount} still outstanding`,
      href: "/app/ai-engineer-summit/people?filter=ready",
      icon: UserCheck,
      label: "Speakers ready",
      tone: "success",
      value: `${readyCount} / ${speakerReadinessFixture.length}`,
    },
    {
      detail: "Across required tasks",
      href: "/app/ai-engineer-summit/people?filter=overdue",
      icon: Clock3,
      label: "Overdue assignments",
      tone: "danger",
      value: String(overdueCount),
    },
  ] as const;

  const rows = useMemo(
    () =>
      speakerReadinessFixture.filter((speaker) => {
        const readinessState = getReadinessState(speaker, completed);
        const matchesFilter =
          filter === "all" ||
          (filter === "ready" && readinessState === "ready") ||
          (filter === "not_configured" &&
            readinessState === "not_configured") ||
          (filter === "outstanding" && readinessState !== "ready") ||
          (filter === "overdue" &&
            !completed.has(speaker.id) &&
            speaker.overdueCount > 0);
        const matchesTrack = track === "all" || speaker.track === track;
        const matchesPortal =
          portalState === "all" || speaker.portalState === portalState;
        const matchesQuery =
          `${speaker.name} ${speaker.company} ${speaker.sessions.join(" ")}`
            .toLowerCase()
            .includes(query.toLowerCase());
        return matchesFilter && matchesTrack && matchesPortal && matchesQuery;
      }),
    [completed, filter, portalState, query, track],
  );

  function updateFilters(
    next: Partial<{
      filter: SpeakerFilter;
      portalState: string;
      query: string;
      track: string;
    }>,
  ) {
    const values = {
      filter: next.filter ?? filter,
      portalState: next.portalState ?? portalState,
      query: next.query ?? query,
      track: next.track ?? track,
    };
    if (next.filter !== undefined) setFilter(next.filter);
    if (next.portalState !== undefined) setPortalState(next.portalState);
    if (next.query !== undefined) setQuery(next.query);
    if (next.track !== undefined) setTrack(next.track);
    writeFilters(values);
  }

  function completeHeadshot() {
    setCompleted((current) => new Set([...current, "speaker-mina"]));
    setToasts([
      {
        id: "headshot-approved",
        title: "Headshot approved",
        message:
          "Mina is now ready. Exact speaker and overdue counts updated immediately.",
        tone: "success",
      },
    ]);
  }

  const columns: DataTableColumn<SpeakerReadinessView>[] = [
    {
      header: "Speaker",
      key: "speaker",
      render: (speaker) => (
        <div className="readiness-speaker-cell">
          <span>
            {speaker.name
              .split(" ")
              .map((part) => part[0])
              .join("")}
          </span>
          <div>
            <strong>{speaker.name}</strong>
            <small>{speaker.company}</small>
          </div>
        </div>
      ),
    },
    {
      header: "Sessions",
      key: "sessions",
      render: (speaker) => (
        <div className="readiness-session-cell">
          {speaker.sessions.map((session) => (
            <span key={session}>{session}</span>
          ))}
        </div>
      ),
    },
    {
      header: "Required",
      key: "required",
      render: (speaker) => {
        const readinessState = getReadinessState(speaker, completed);
        const ready = readinessState === "ready";
        const complete = completed.has(speaker.id)
          ? speaker.totalRequired
          : speaker.completedRequired;
        return (
          <span
            className={ready ? "readiness-ratio is-ready" : "readiness-ratio"}
          >
            <strong>
              {readinessState === "not_configured"
                ? "Not configured"
                : `${complete} / ${speaker.totalRequired}`}
            </strong>
            <small>
              {readinessState === "not_configured"
                ? "No required tasks assigned"
                : ready
                  ? "All required complete"
                  : `${speaker.totalRequired - complete} required left`}
            </small>
          </span>
        );
      },
    },
    {
      header: "Next due",
      key: "due",
      render: (speaker) => (
        <span className="readiness-due">
          <strong>
            {completed.has(speaker.id) ? "Complete" : speaker.nextDue}
          </strong>
          {!completed.has(speaker.id) && speaker.overdueCount > 0 ? (
            <small>{speaker.overdueCount} overdue</small>
          ) : null}
        </span>
      ),
    },
    {
      header: "Portal",
      key: "portal",
      render: (speaker) => (
        <StatusPill
          tone={
            speaker.portalState === "active"
              ? "success"
              : speaker.portalState === "invited"
                ? "preview"
                : "neutral"
          }
        >
          {speaker.portalState.replace("_", " ")}
        </StatusPill>
      ),
    },
    {
      header: "Contact",
      key: "contact",
      render: (speaker) => (
        <a
          className="readiness-contact"
          aria-label={`Contact ${speaker.name}`}
          href={`mailto:${speaker.email}?subject=${encodeURIComponent(
            "AI Engineer Summit speaker readiness",
          )}`}
        >
          <Mail aria-hidden="true" size={15} />
        </a>
      ),
    },
  ];

  return (
    <div className="readiness-page">
      <header className="readiness-header">
        <div>
          <p className="overline">Prepare · People</p>
          <h1>Readiness you can act on.</h1>
          <p>
            Every number opens the work behind it. Required-task formulas stay
            explicit, including speakers with zero required tasks.
          </p>
        </div>
        <div className="readiness-header-actions">
          <Button variant="secondary">
            <Download aria-hidden="true" size={16} /> Export view
          </Button>
          <Button>
            <Mail aria-hidden="true" size={16} /> Compose reminder
          </Button>
        </div>
      </header>

      <div
        className={
          projectionState === "lag"
            ? "readiness-freshness is-lagging"
            : projectionState === "partial"
              ? "readiness-freshness is-partial"
              : "readiness-freshness"
        }
        role="status"
      >
        {projectionState === "lag" || projectionState === "partial" ? (
          <AlertTriangle aria-hidden="true" size={16} />
        ) : (
          <CheckCircle2 aria-hidden="true" size={16} />
        )}
        <span>
          <strong>
            {projectionState === "lag"
              ? "Read model is catching up"
              : projectionState === "partial"
                ? "Some readiness sources are unavailable"
                : "Metrics are current"}
          </strong>
          {projectionState === "lag"
            ? "Showing data projected 4 minutes ago. Recent task changes may not appear yet."
            : projectionState === "partial"
              ? "Showing the last complete projection. Counts are not live until every source recovers."
              : "Updated 18 seconds ago from the event projection."}
        </span>
        {projectionState !== "current" ? (
          <button onClick={() => window.location.reload()} type="button">
            <RefreshCw aria-hidden="true" size={14} /> Retry
          </button>
        ) : null}
      </div>

      <section
        className="readiness-metrics"
        aria-label="Event readiness metrics"
      >
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <a
              className={`readiness-metric is-${metric.tone}`}
              href={metric.href}
              key={metric.label}
            >
              <span>
                <Icon aria-hidden="true" size={18} />
              </span>
              <small>{metric.label}</small>
              <strong>{metric.value}</strong>
              <em>{metric.detail}</em>
              <ArrowRight aria-hidden="true" size={16} />
            </a>
          );
        })}
      </section>

      <div className="readiness-content-grid">
        <section
          className="readiness-table-panel"
          aria-labelledby="speaker-readiness-title"
        >
          <div className="readiness-panel-heading">
            <div>
              <p className="overline">Drilldown</p>
              <h2 id="speaker-readiness-title">Speaker readiness</h2>
            </div>
            <span>
              {rows.length} of {speakerReadinessFixture.length}
            </span>
          </div>
          <div className="readiness-filters">
            <TextField
              id="readiness-search"
              label="Search"
              onChange={(event) => updateFilters({ query: event.target.value })}
              placeholder="Speaker, company, session…"
              value={query}
            />
            <SelectField
              id="readiness-status"
              label="Readiness"
              onChange={(event) =>
                updateFilters({
                  filter: event.target.value as SpeakerFilter,
                })
              }
              options={[
                { label: "All readiness", value: "all" },
                { label: "Ready", value: "ready" },
                { label: "Outstanding", value: "outstanding" },
                { label: "Overdue", value: "overdue" },
                { label: "Not configured", value: "not_configured" },
              ]}
              value={filter}
            />
            <SelectField
              id="readiness-track"
              label="Track"
              onChange={(event) => updateFilters({ track: event.target.value })}
              options={trackOptions}
              value={track}
            />
            <SelectField
              id="readiness-portal"
              label="Portal"
              onChange={(event) =>
                updateFilters({ portalState: event.target.value })
              }
              options={portalOptions}
              value={portalState}
            />
          </div>
          <DataTable
            caption="Speaker readiness and next actions"
            columns={columns}
            getRowKey={(speaker) => speaker.id}
            rows={rows}
          />
          <div className="readiness-pagination">
            <span>Page 1 of 1 · 25 per page</span>
            <div>
              <Button variant="secondary" disabled>
                Previous
              </Button>
              <Button variant="secondary" disabled>
                Next
              </Button>
            </div>
          </div>
        </section>

        <aside
          className="readiness-queue"
          aria-labelledby="readiness-queue-title"
        >
          <div className="readiness-panel-heading">
            <div>
              <p className="overline">Priority queue</p>
              <h2 id="readiness-queue-title">Needs attention</h2>
            </div>
            <span>3</span>
          </div>
          <article
            className={completed.has("speaker-mina") ? "is-resolved" : ""}
          >
            <span>MO</span>
            <div>
              <strong>Mina’s headshot</strong>
              <p>
                {completed.has("speaker-mina")
                  ? "Approved just now"
                  : "Overdue · blocks public profile"}
              </p>
            </div>
            {completed.has("speaker-mina") ? (
              <Check aria-hidden="true" size={17} />
            ) : (
              <button onClick={completeHeadshot} type="button">
                Mark received
              </button>
            )}
          </article>
          <article>
            <span>PN</span>
            <div>
              <strong>Priya’s agreement</strong>
              <p>Overdue · 2 tasks outstanding</p>
            </div>
            <button type="button">Send reminder</button>
          </article>
          <article>
            <span>NM</span>
            <div>
              <strong>Noor has no portal</strong>
              <p>Accepted 3 days ago</p>
            </div>
            <button type="button">Send invite</button>
          </article>
          <div className="readiness-policy">
            <Users aria-hidden="true" size={18} />
            <div>
              <strong>How “ready” is calculated</strong>
              <p>
                A speaker is ready only when every required task is complete.
                Speakers with zero required tasks stay not configured so missing
                assignments never read as ready.
              </p>
            </div>
          </div>
        </aside>
      </div>

      <ToastRegion
        messages={toasts}
        onDismiss={(id) =>
          setToasts((current) => current.filter((toast) => toast.id !== id))
        }
      />
    </div>
  );
}
