import { useEffect, useMemo, useRef, useState } from "react";
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
  StatePanel,
  StatusPill,
  TextField,
  ToastRegion,
  type DataTableColumn,
  type ToastMessage,
} from "@sessionbox-killer/ui";
import type {
  ReadinessDashboardQuery,
  ReadinessDashboardResponse,
} from "@sessionbox-killer/contracts/readiness";

import {
  agendaSpeakerScheduleFacts,
  speakerReadinessFixture,
  type SpeakerReadinessView,
} from "./readinessModel";
import { createReadinessClient, type ReadinessClient } from "./readinessClient";

import "./readiness-dashboard.css";

export type ReadinessFixtureState = "lag" | "partial";
type DemoApprovalState = "incomplete" | "submitted" | "approved";

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
  { label: "Revoked", value: "revoked" },
];

const dueOptions = [
  { label: "Any due date", value: "all" },
  { label: "Overdue", value: "overdue" },
  { label: "Next 7 days", value: "next_7_days" },
  { label: "No due date", value: "no_due" },
  { label: "Complete", value: "complete" },
];

function readFilter(name: string) {
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

function getInitialFilter(): SpeakerFilter {
  const filter = readFilter("readiness") || readFilter("filter");
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
  due: string;
  filter: SpeakerFilter;
  page: number;
  portalState: string;
  query: string;
  task: string;
  track: string;
}) {
  const params = new URLSearchParams();
  if (values.query) params.set("q", values.query);
  if (values.filter !== "all") params.set("readiness", values.filter);
  if (values.track !== "all") params.set("track", values.track);
  if (values.portalState !== "all") params.set("portal", values.portalState);
  if (values.task !== "all") params.set("task", values.task);
  if (values.due !== "all") params.set("due", values.due);
  if (values.page > 1) params.set("page", String(values.page));
  const search = params.toString();
  window.history.replaceState(
    null,
    "",
    search ? `${window.location.pathname}?${search}` : window.location.pathname,
  );
}

function initialPage(): number {
  const page = Number(readFilter("page"));
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function nextDueLabel(
  readiness: ReadinessDashboardResponse["speakers"][number]["readiness"],
): string {
  if (readiness.status === "ready") return "Complete";
  if (!readiness.next_due) return "No due date";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(new Date(readiness.next_due.at));
}

function productionSpeakerRows(
  response: ReadinessDashboardResponse,
): SpeakerReadinessView[] {
  return response.speakers.map((speaker) => ({
    company: speaker.company || "Independent",
    completedRequired: speaker.readiness.ratio.complete,
    email: speaker.email,
    id: speaker.contact_id,
    name: speaker.display_name,
    nextDue: nextDueLabel(speaker.readiness),
    overdueCount: speaker.readiness.overdue_count,
    portalState: speaker.portal_state,
    sessions: speaker.sessions.map(({ title }) => title),
    totalRequired: speaker.readiness.ratio.total,
    track: speaker.sessions[0]?.track?.name ?? "Unassigned",
  }));
}

export function ReadinessDashboard({
  eventKey,
  fixtureState,
  suppliedClient,
}: {
  eventKey?: string | undefined;
  fixtureState?: ReadinessFixtureState | undefined;
  suppliedClient?: ReadinessClient | undefined;
}) {
  const client = useMemo(
    () => suppliedClient ?? createReadinessClient(),
    [suppliedClient],
  );
  const [filter, setFilter] = useState<SpeakerFilter>(getInitialFilter);
  const [track, setTrack] = useState(() =>
    eventKey
      ? readFilter("track") || "all"
      : getInitialOption("track", trackOptions),
  );
  const [portalState, setPortalState] = useState(() =>
    getInitialOption("portal", portalOptions),
  );
  const [task, setTask] = useState(() => readFilter("task") || "all");
  const [due, setDue] = useState(() => getInitialOption("due", dueOptions));
  const [page, setPage] = useState(initialPage);
  const [query, setQuery] = useState(() => readFilter("q"));
  const [response, setResponse] = useState<ReadinessDashboardResponse | null>(
    null,
  );
  const responseRef = useRef<ReadinessDashboardResponse | null>(null);
  const [loadState, setLoadState] = useState<"error" | "loading" | "ready">(
    eventKey ? "loading" : "ready",
  );
  const [reloadVersion, setReloadVersion] = useState(0);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [headshotState, setHeadshotState] =
    useState<DemoApprovalState>("incomplete");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  useEffect(() => {
    if (!eventKey) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        setLoadState((current) => (current === "ready" ? "ready" : "loading"));
        const serverQuery: ReadinessDashboardQuery = {
          due: due as ReadinessDashboardQuery["due"],
          page,
          page_size: 25,
          portal: portalState as ReadinessDashboardQuery["portal"],
          q: query,
          readiness: filter,
          task,
          track,
        };
        void client.read(eventKey, serverQuery, controller.signal).then(
          (result) => {
            responseRef.current = result;
            setResponse(result);
            setRefreshFailed(false);
            setLoadState("ready");
          },
          (error: unknown) => {
            if (!(
              error instanceof DOMException && error.name === "AbortError"
            )) {
              if (responseRef.current) {
                setRefreshFailed(true);
                setLoadState("ready");
              } else {
                setLoadState("error");
              }
            }
          },
        );
      },
      query ? 150 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    client,
    due,
    eventKey,
    filter,
    page,
    portalState,
    query,
    reloadVersion,
    task,
    track,
  ]);

  const projectionState = eventKey
    ? refreshFailed
      ? "partial"
      : response?.projection.state === "stale"
        ? "lag"
        : (response?.projection.state ?? "current")
    : (fixtureState ?? "current");
  const completed = useMemo(
    () =>
      headshotState === "approved"
        ? new Set(["speaker-mina"])
        : new Set<string>(),
    [headshotState],
  );

  const fixtureReadyCount = speakerReadinessFixture.filter(
    (speaker) => getReadinessState(speaker, completed) === "ready",
  ).length;
  const fixtureOverdueCount = speakerReadinessFixture.reduce(
    (sum, speaker) =>
      sum + (completed.has(speaker.id) ? 0 : speaker.overdueCount),
    0,
  );

  const eventPathKey = eventKey ?? "ai-engineer-summit";
  const metricValues = response?.metrics;
  const readyCount = metricValues?.speakers_ready ?? fixtureReadyCount;
  const speakerCount =
    metricValues?.speakers_total ?? speakerReadinessFixture.length;
  const overdueCount = metricValues?.overdue_assignments ?? fixtureOverdueCount;
  const metrics = [
    {
      detail: "Since yesterday",
      href: `/app/${eventPathKey}/submissions?status=new`,
      icon: Sparkles,
      label: "New submissions",
      tone: "blue",
      value: String(metricValues?.new_submissions ?? 4),
    },
    {
      detail: response ? "Assigned review queue" : "Across 5 reviewers",
      href: `/app/${eventPathKey}/reviews?status=pending`,
      icon: MessageSquareText,
      label: "Reviews remaining",
      tone: "gold",
      value: String(metricValues?.reviews_remaining ?? 8),
    },
    {
      detail: "Accepted, no room/time",
      href: `/app/${eventPathKey}/agenda?filter=unscheduled`,
      icon: CalendarClock,
      label: "Accepted unscheduled",
      tone: "clay",
      value: String(
        metricValues?.accepted_unscheduled ??
          agendaSpeakerScheduleFacts.acceptedUnscheduledCount,
      ),
    },
    {
      detail: "Blocks publication",
      href: `/app/${eventPathKey}/agenda?filter=conflicts`,
      icon: AlertTriangle,
      label: "Hard conflicts",
      tone: "danger",
      value: response
        ? metricValues?.hard_conflicts === null
          ? "—"
          : String(metricValues?.hard_conflicts ?? "—")
        : "1",
    },
    {
      detail: `${speakerCount - readyCount} still outstanding`,
      href: `/app/${eventPathKey}/people?readiness=ready`,
      icon: UserCheck,
      label: "Speakers ready",
      tone: "success",
      value: `${readyCount} / ${speakerCount}`,
    },
    {
      detail: "Across required tasks",
      href: `/app/${eventPathKey}/people?readiness=overdue`,
      icon: Clock3,
      label: "Overdue assignments",
      tone: "danger",
      value: String(overdueCount),
    },
  ] as const;

  const rows = useMemo(() => {
    if (eventKey && response) return productionSpeakerRows(response);
    return speakerReadinessFixture.filter((speaker) => {
      const readinessState = getReadinessState(speaker, completed);
      const matchesFilter =
        filter === "all" ||
        (filter === "ready" && readinessState === "ready") ||
        (filter === "not_configured" && readinessState === "not_configured") ||
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
      const matchesDue =
        due === "all" ||
        (due === "overdue" && speaker.overdueCount > 0) ||
        (due === "complete" && readinessState === "ready") ||
        (due === "no_due" &&
          speaker.totalRequired === 0 &&
          readinessState !== "ready") ||
        due === "next_7_days";
      return (
        matchesFilter &&
        matchesTrack &&
        matchesPortal &&
        matchesQuery &&
        matchesDue
      );
    });
  }, [completed, due, eventKey, filter, portalState, query, response, track]);

  const visibleTrackOptions = response
    ? [
        { label: "All tracks", value: "all" },
        ...response.filters.tracks.map(({ id, name }) => ({
          label: name,
          value: id,
        })),
      ]
    : trackOptions;
  const taskOptions = response
    ? [
        { label: "All tasks", value: "all" },
        ...response.filters.tasks.map(({ id, name }) => ({
          label: name,
          value: id,
        })),
      ]
    : [{ label: "All tasks", value: "all" }];

  function updateFilters(
    next: Partial<{
      filter: SpeakerFilter;
      due: string;
      page: number;
      portalState: string;
      query: string;
      task: string;
      track: string;
    }>,
  ) {
    const values = {
      filter: next.filter ?? filter,
      due: next.due ?? due,
      page: next.page ?? (eventKey ? 1 : page),
      portalState: next.portalState ?? portalState,
      query: next.query ?? query,
      task: next.task ?? task,
      track: next.track ?? track,
    };
    if (next.filter !== undefined) setFilter(next.filter);
    if (next.due !== undefined) setDue(next.due);
    if (next.portalState !== undefined) setPortalState(next.portalState);
    if (next.query !== undefined) setQuery(next.query);
    if (next.task !== undefined) setTask(next.task);
    if (next.track !== undefined) setTrack(next.track);
    setPage(values.page);
    writeFilters(values);
  }

  function advanceHeadshot() {
    if (headshotState === "incomplete") {
      setHeadshotState("submitted");
      setToasts([
        {
          id: "headshot-submitted",
          title: "Headshot submitted",
          message:
            "Mina remains outstanding until the required organizer approval is recorded.",
          tone: "success",
        },
      ]);
      return;
    }
    setHeadshotState("approved");
    setToasts([
      {
        id: "headshot-approved",
        title: "Final approval recorded",
        message:
          "Mina is now ready. Every required task, including approval, is complete.",
        tone: "success",
      },
    ]);
  }

  function exportCurrentView() {
    const headings = [
      "Speaker",
      "Company",
      "Email",
      "Sessions",
      "Required complete",
      "Required total",
      "Overdue",
      "Portal",
    ];
    const escape = (value: string | number) =>
      `"${String(value).replaceAll('"', '""')}"`;
    const csv = [
      headings.map(escape).join(","),
      ...rows.map((speaker) =>
        [
          speaker.name,
          speaker.company,
          speaker.email,
          speaker.sessions.join("; "),
          speaker.completedRequired,
          speaker.totalRequired,
          speaker.overdueCount,
          speaker.portalState,
        ]
          .map(escape)
          .join(","),
      ),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${eventPathKey}-speaker-readiness.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function composeReminder() {
    const recipients = rows
      .filter((speaker) => speaker.completedRequired < speaker.totalRequired)
      .map(({ email }) => email)
      .join(",");
    window.location.href = `mailto:${recipients}?subject=${encodeURIComponent(
      `${response?.event.name ?? "Event"} speaker readiness`,
    )}`;
  }

  if (eventKey && loadState === "loading" && !response) {
    return (
      <StatePanel
        description="Loading metrics, speaker tasks, and schedule conflicts."
        state="loading"
        title="Loading event readiness"
      />
    );
  }
  if (eventKey && loadState === "error") {
    return (
      <StatePanel
        action={
          <Button
            onClick={() => {
              setLoadState("loading");
              setReloadVersion((current) => current + 1);
            }}
          >
            Retry
          </Button>
        }
        description="The latest readiness projection could not be loaded. No organizer changes were made."
        state="error"
        title="Readiness is unavailable"
      />
    );
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
          <Button onClick={exportCurrentView} variant="secondary">
            <Download aria-hidden="true" size={16} /> Export view
          </Button>
          <Button onClick={composeReminder}>
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
            ? "Showing the latest durable projection. Recent changes may still be synchronizing."
            : projectionState === "partial"
              ? "Counts are not live until every source recovers. Showing the latest available projection."
              : response
                ? `Projected ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(response.projection.as_of))}.`
                : "Updated 18 seconds ago from the event projection."}
        </span>
        {projectionState !== "current" ? (
          <button
            onClick={() => setReloadVersion((current) => current + 1)}
            type="button"
          >
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
              {response
                ? `${rows.length} of ${response.page.total}`
                : `${rows.length} of ${speakerReadinessFixture.length}`}
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
              options={visibleTrackOptions}
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
            <SelectField
              id="readiness-task"
              label="Task"
              onChange={(event) => updateFilters({ task: event.target.value })}
              options={taskOptions}
              value={task}
            />
            <SelectField
              id="readiness-due"
              label="Due"
              onChange={(event) => updateFilters({ due: event.target.value })}
              options={dueOptions}
              value={due}
            />
          </div>
          <DataTable
            caption="Speaker readiness and next actions"
            columns={columns}
            getRowKey={(speaker) => speaker.id}
            rows={rows}
          />
          <div className="readiness-pagination">
            <span>
              Page {response?.page.number ?? 1} of{" "}
              {response?.page.total_pages ?? 1}
              {" · 25 per page"}
            </span>
            <div>
              <Button
                variant="secondary"
                disabled={!response || response.page.number <= 1}
                onClick={() => updateFilters({ page: page - 1 })}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={
                  !response || response.page.number >= response.page.total_pages
                }
                onClick={() => updateFilters({ page: page + 1 })}
              >
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
            <span>{response?.attention.length ?? 3}</span>
          </div>
          {response ? (
            response.attention.length > 0 ? (
              response.attention.map((speaker) => (
                <article key={speaker.contact_id}>
                  <span>
                    {speaker.display_name
                      .split(" ")
                      .map((part) => part[0])
                      .join("")
                      .slice(0, 2)}
                  </span>
                  <div>
                    <strong>{speaker.display_name}</strong>
                    <p>
                      {speaker.readiness.status.replace("_", " ")} ·{" "}
                      {speaker.readiness.outstanding_count} required left
                    </p>
                  </div>
                  <a
                    href={`mailto:${speaker.email}?subject=${encodeURIComponent(
                      `${response.event.name} readiness reminder`,
                    )}`}
                  >
                    {speaker.portal_state === "not_invited"
                      ? "Send invite"
                      : "Send reminder"}
                  </a>
                </article>
              ))
            ) : (
              <p className="readiness-queue-empty">
                No speakers need attention in the current projection.
              </p>
            )
          ) : (
            <>
              <article
                className={headshotState === "approved" ? "is-resolved" : ""}
              >
                <span>MO</span>
                <div>
                  <strong>Mina’s headshot</strong>
                  <p>
                    {headshotState === "approved"
                      ? "Approved just now"
                      : headshotState === "submitted"
                        ? "Submitted · awaiting required approval"
                        : "Overdue · approval required for readiness"}
                  </p>
                </div>
                {headshotState === "approved" ? (
                  <Check aria-hidden="true" size={17} />
                ) : (
                  <button onClick={advanceHeadshot} type="button">
                    {headshotState === "submitted"
                      ? "Approve as organizer"
                      : "Submit as speaker"}
                  </button>
                )}
              </article>
              <article>
                <span>PN</span>
                <div>
                  <strong>Priya’s agreement</strong>
                  <p>Overdue · 2 tasks outstanding</p>
                </div>
                <a href="mailto:priya@example.com?subject=Speaker%20readiness">
                  Send reminder
                </a>
              </article>
              <article>
                <span>NM</span>
                <div>
                  <strong>Noor has no portal</strong>
                  <p>Accepted 3 days ago</p>
                </div>
                <a href="mailto:noor@example.com?subject=Speaker%20portal%20invite">
                  Send invite
                </a>
              </article>
            </>
          )}
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
