import { useEffect, useMemo, useState } from "react";

import type { ScheduleSnapshot } from "@sessionbox-killer/contracts";
import { StatePanel } from "@sessionbox-killer/ui";

import { AgendaBuilder } from "./AgendaBuilder";
import { createScheduleCommandPort, ScheduleApiError } from "./scheduleClient";

export function AgendaWorkspace({ eventSlug }: { eventSlug: string }) {
  const commandPort = useMemo(() => createScheduleCommandPort(), []);
  const [{ error, snapshot }, setResult] = useState<{
    error: unknown;
    snapshot: ScheduleSnapshot | null;
  }>({ error: null, snapshot: null });
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    let active = true;

    void commandPort.read(eventSlug).then(
      (result) => {
        if (active) setResult({ error: null, snapshot: result });
      },
      (cause: unknown) => {
        if (active) setResult({ error: cause, snapshot: null });
      },
    );

    return () => {
      active = false;
    };
  }, [commandPort, eventSlug, retryVersion]);

  if (snapshot) {
    return (
      <AgendaBuilder
        commandPort={commandPort}
        initialSnapshot={snapshot}
        key={`${snapshot.event.eventId}:${snapshot.event.version}`}
      />
    );
  }

  const permissionDenied =
    error instanceof ScheduleApiError && error.code === "forbidden";
  return (
    <div className="agenda-page">
      <StatePanel
        description={
          permissionDenied
            ? "Ask an event owner for schedule access, or return to an event you can manage."
            : error instanceof ScheduleApiError
              ? error.message
              : error
                ? "The authoritative schedule could not be loaded. No fixture data has been substituted."
                : "Loading the authoritative rooms, sessions, and placements for this event."
        }
        onRetry={
          error
            ? () => {
                setResult({ error: null, snapshot: null });
                setRetryVersion((current) => current + 1);
              }
            : undefined
        }
        state={permissionDenied ? "permission" : error ? "error" : "loading"}
        {...(permissionDenied ? { title: "Schedule access required" } : {})}
      />
    </div>
  );
}
