import { useEffect, useMemo, useRef, useState } from "react";

import {
  organizerSubmissionStatusSchema,
  type OrganizerSubmissionCommand,
  type OrganizerSubmissionCommandResult,
  type OrganizerSubmissionDetail,
  type OrganizerSubmissionListResponse,
} from "@sessionbox-killer/contracts";
import { StatePanel } from "@sessionbox-killer/ui";

import { safeAuthRedirectPath } from "../auth/authClient";
import {
  applyOrganizerSubmissionResult,
  organizerStatusToView,
  organizerSubmissionDetailView,
  organizerSubmissionListRowView,
  viewStatusToOrganizer,
} from "./organizerSubmissionAdapter";
import {
  createOrganizerSubmissionPort,
  OrganizerSubmissionApiError,
} from "./submissionClient";
import {
  SubmissionDetail,
  SubmissionList,
  type SubmissionFilterValues,
} from "./SubmissionWorkspace";
import type { SubmissionView } from "./submissionModel";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

function initialFilters(): SubmissionFilterValues {
  const params = new URLSearchParams(window.location.search);
  const rawStatus = organizerSubmissionStatusSchema.safeParse(
    params.get("status"),
  );
  const rawTrack = params.get("track") ?? "";
  return {
    query: (params.get("q") ?? "").slice(0, 160),
    status: rawStatus.success ? organizerStatusToView(rawStatus.data) : "all",
    track: identifierPattern.test(rawTrack) ? rawTrack : "all",
  };
}

function replaceListUrl(
  eventKey: string,
  filters: SubmissionFilterValues,
  cursor?: string,
) {
  const params = new URLSearchParams();
  const search = filters.query.trim();
  if (search) params.set("q", search);
  if (filters.status !== "all") {
    params.set("status", viewStatusToOrganizer(filters.status));
  }
  if (filters.track !== "all") params.set("track", filters.track);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    `/app/${eventKey}/submissions${query ? `?${query}` : ""}`,
  );
}

function commandId() {
  return `submission_${crypto.randomUUID().replaceAll("-", "")}`;
}

function preserveCommandForRetry(error: unknown) {
  return (
    !(error instanceof OrganizerSubmissionApiError) ||
    error.status >= 500 ||
    error.code === "invalid_submission_response"
  );
}

function errorPanel(error: unknown, retry: () => void, notFound = false) {
  const apiError =
    error instanceof OrganizerSubmissionApiError ? error : undefined;
  const invalidSession = apiError?.code === "invalid_session";
  const permissionDenied = apiError?.code === "forbidden";
  const submissionMissing =
    notFound && apiError?.code === "submission_not_found";
  const returnPath = safeAuthRedirectPath(
    `${window.location.pathname}${window.location.search}`,
    "/",
  );

  return (
    <div className="submission-page-state">
      <StatePanel
        {...(invalidSession
          ? {
              action: (
                <a
                  className="ui-button ui-button--primary"
                  href={`/auth/sign-in?return_to=${encodeURIComponent(returnPath)}`}
                >
                  Sign in
                </a>
              ),
            }
          : submissionMissing
            ? {
                action: (
                  <a
                    className="ui-button ui-button--secondary"
                    href={window.location.pathname.replace(/\/[^/]+$/, "")}
                  >
                    Return to submissions
                  </a>
                ),
              }
            : {})}
        description={
          invalidSession
            ? "Sign in again to open the private organizer submission workspace."
            : permissionDenied
              ? "Ask an event owner for organizer access. Submission responses and internal notes remain private."
              : submissionMissing
                ? "This submission may have moved, been removed, or may not be visible with your current event access."
                : error instanceof Error
                  ? error.message
                  : "The authoritative submission projection could not be loaded. No fixture data has been substituted."
        }
        {...(invalidSession || permissionDenied || submissionMissing
          ? {}
          : { onRetry: retry })}
        state={permissionDenied ? "permission" : "error"}
        {...(invalidSession
          ? { title: "Your session has expired" }
          : permissionDenied
            ? { title: "Submission access required" }
            : submissionMissing
              ? { title: "Submission not found" }
              : {})}
      />
    </div>
  );
}

function OrganizerSubmissionList({ eventKey }: { eventKey: string }) {
  const port = useMemo(() => createOrganizerSubmissionPort(), []);
  const [filters, setFilters] = useState(initialFilters);
  const [cursor, setCursor] = useState<string | undefined>(() => {
    const value = new URLSearchParams(window.location.search).get("cursor");
    return value && /^[A-Za-z0-9_-]{1,1024}$/.test(value) ? value : undefined;
  });
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>(
    [],
  );
  const [result, setResult] = useState<OrganizerSubmissionListResponse | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const status =
      filters.status === "all"
        ? undefined
        : viewStatusToOrganizer(filters.status);
    void port
      .list(
        eventKey,
        {
          ...(cursor ? { cursor } : {}),
          pageSize: 50,
          ...(filters.query.trim() ? { search: filters.query.trim() } : {}),
          ...(status ? { status } : {}),
          ...(filters.track !== "all" ? { track: filters.track } : {}),
        },
        controller.signal,
      )
      .then(
        (next) => {
          setResult(next);
          setError(null);
        },
        (cause: unknown) => {
          if (!(cause instanceof DOMException && cause.name === "AbortError")) {
            setError(cause);
          }
        },
      );
    return () => controller.abort();
  }, [cursor, eventKey, filters, port, reloadVersion]);

  if (error) {
    return errorPanel(error, () => setReloadVersion((value) => value + 1));
  }
  if (!result) {
    return (
      <div className="submission-page-state">
        <StatePanel
          description="Loading the authoritative organizer queue and its projection status."
          state="loading"
          title="Loading submissions"
        />
      </div>
    );
  }

  const submissions = result.items.map(organizerSubmissionListRowView);
  const selectedTrack = result.items.find(
    (item) => item.track?.id === filters.track,
  )?.track;
  const selectedTrackOption =
    filters.track === "all"
      ? []
      : [selectedTrack ?? { id: filters.track, name: filters.track }];
  const trackFilterOptions = [
    { label: "All tracks", value: "all" },
    ...Array.from(
      new Map(
        result.items
          .flatMap((item) => (item.track ? [item.track] : []))
          .concat(selectedTrackOption)
          .map((track) => [track.id, track]),
      ).values(),
    )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((track) => ({ label: track.name, value: track.id })),
  ];

  function updateFilters(next: SubmissionFilterValues) {
    setFilters(next);
    setCursor(undefined);
    setCursorHistory([]);
    replaceListUrl(eventKey, next);
  }

  return (
    <SubmissionList
      canGoBack={cursorHistory.length > 0}
      eventKey={eventKey}
      filters={filters}
      nextCursor={result.nextCursor}
      onFiltersChange={updateFilters}
      onNextPage={
        result.nextCursor
          ? () => {
              setResult(null);
              setCursorHistory((history) => [...history, cursor]);
              setCursor(result.nextCursor ?? undefined);
              replaceListUrl(eventKey, filters, result.nextCursor ?? undefined);
            }
          : undefined
      }
      onPreviousPage={() => {
        const previous = cursorHistory.at(-1);
        setResult(null);
        setCursorHistory((history) => history.slice(0, -1));
        setCursor(previous);
        replaceListUrl(eventKey, filters, previous);
      }}
      onRefresh={() => setReloadVersion((value) => value + 1)}
      projection={result.projection}
      serverFiltered
      showSummary={false}
      submissions={submissions}
      trackFilterOptions={trackFilterOptions}
    />
  );
}

function OrganizerSubmissionDetailView({
  eventKey,
  submissionId,
}: {
  eventKey: string;
  submissionId: string;
}) {
  const port = useMemo(() => createOrganizerSubmissionPort(), []);
  const [detail, setDetail] = useState<OrganizerSubmissionDetail | null>(null);
  const [pendingView, setPendingView] = useState<SubmissionView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandNotice, setCommandNotice] = useState<{
    message: string;
    tone: "error" | "warning";
    title?: string;
  } | null>(null);
  const commandIntents = useRef(new Map<string, OrganizerSubmissionCommand>());
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void port.detail(eventKey, submissionId, controller.signal).then(
      (next) => {
        commandIntents.current.clear();
        setDetail(next);
        setPendingView(null);
        setCommandNotice(null);
        setError(null);
      },
      (cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setError(cause);
        }
      },
    );
    return () => controller.abort();
  }, [eventKey, port, reloadVersion, submissionId]);

  if (error) {
    return errorPanel(
      error,
      () => setReloadVersion((value) => value + 1),
      true,
    );
  }
  if (!detail) {
    return (
      <div className="submission-page-state">
        <StatePanel
          description="Loading the immutable response, review evidence, and organizer history."
          state="loading"
          title="Loading submission"
        />
      </div>
    );
  }

  const loadedDetail = detail;
  const view = pendingView ?? organizerSubmissionDetailView(loadedDetail);
  const projectionDegraded = loadedDetail.projection.state === "partial";
  const repairPending = commandNotice?.tone === "warning";

  async function refreshAfterCommand(result: OrganizerSubmissionCommandResult) {
    if (result.projection === "repair_pending") {
      setPendingView((current) =>
        applyOrganizerSubmissionResult(
          current ?? organizerSubmissionDetailView(loadedDetail),
          result,
        ),
      );
      setCommandNotice({
        message:
          "The authority accepted the change, but this projection has not caught up. Further edits are paused until refresh confirms the new version.",
        tone: "warning",
      });
      return;
    }
    try {
      const refreshed = await port.detail(eventKey, submissionId);
      setDetail(refreshed);
      setPendingView(null);
    } catch {
      setPendingView((current) =>
        applyOrganizerSubmissionResult(
          current ?? organizerSubmissionDetailView(loadedDetail),
          result,
        ),
      );
      setCommandNotice({
        message:
          "The authority accepted the change, but the refreshed projection could not be loaded. Refresh before making another edit.",
        tone: "warning",
      });
    }
  }

  async function execute(
    intentId: string,
    createCommand: () => OrganizerSubmissionCommand,
  ) {
    const command = commandIntents.current.get(intentId) ?? createCommand();
    commandIntents.current.set(intentId, command);
    setCommandBusy(true);
    setCommandNotice(null);
    try {
      const result = await port.execute(eventKey, command);
      commandIntents.current.delete(intentId);
      await refreshAfterCommand(result);
      return result;
    } catch (cause) {
      const outcomeUnknown = preserveCommandForRetry(cause);
      if (!outcomeUnknown) commandIntents.current.delete(intentId);
      const versionConflict =
        cause instanceof OrganizerSubmissionApiError &&
        cause.code === "submission_version_conflict";
      setCommandNotice({
        message: outcomeUnknown
          ? "The service response was interrupted, so the outcome is not yet known. Retry without editing to safely check the original command, or refresh before making a different change."
          : versionConflict
            ? "Someone changed this submission after you opened it. Your text is preserved; refresh the record before trying again."
            : cause instanceof Error
              ? cause.message
              : "The authoritative service did not accept this change.",
        title: outcomeUnknown
          ? "Confirmation was interrupted"
          : versionConflict
            ? "The submission changed"
            : "The change was not recorded",
        tone: "error",
      });
      throw cause;
    } finally {
      setCommandBusy(false);
    }
  }

  const expectedVersion = view.version;
  if (!expectedVersion) {
    return errorPanel(
      new Error("The submission response did not include a version."),
      () => setReloadVersion((value) => value + 1),
    );
  }

  return (
    <SubmissionDetail
      allowedCommands={loadedDetail.allowedCommands}
      commandBusy={commandBusy}
      commandNotice={commandNotice}
      controlsPaused={repairPending}
      degraded={projectionDegraded}
      eventKey={eventKey}
      initialSubmission={view}
      onAddNote={async (body, intentId) => {
        await execute(intentId, () => ({
          body,
          commandId: commandId(),
          expectedVersion,
          submissionId,
          type: "add_note",
        }));
        return "The note was recorded for organizers and added to the authoritative history.";
      }}
      onCommandIntentAbandon={(intentId) => {
        commandIntents.current.delete(intentId);
      }}
      onLifecycleAction={async (type, reason, intentId) => {
        const result = await execute(intentId, () => ({
          commandId: commandId(),
          expectedVersion,
          reason,
          submissionId,
          type,
        }));
        const label = organizerStatusToView(result.status).replace("_", " ");
        return `The authoritative status is now ${label}. The reason was recorded in organizer history.`;
      }}
      onRefresh={() => {
        commandIntents.current.clear();
        setReloadVersion((value) => value + 1);
      }}
      stale={loadedDetail.projection.state === "stale"}
    />
  );
}

export function OrganizerSubmissionWorkspace({
  eventKey,
  submissionId,
}: {
  eventKey: string;
  submissionId: string | null;
}) {
  return submissionId ? (
    <OrganizerSubmissionDetailView
      eventKey={eventKey}
      submissionId={submissionId}
    />
  ) : (
    <OrganizerSubmissionList eventKey={eventKey} />
  );
}
