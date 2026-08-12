import { lazy, useEffect, useMemo, useState } from "react";

import { StatePanel } from "@sessionbox-killer/ui";

import {
  createReviewOperationsPort,
  type ReviewOperationsPort,
} from "./reviewOperationsClient";

const OrganizerWorkspace = lazy(() =>
  import("../WorkspaceApp").then((module) => ({
    default: module.WorkspaceApp,
  })),
);
const ReviewerWorkspace = lazy(() =>
  import("./ReviewerWorkspace").then((module) => ({
    default: module.ReviewerWorkspace,
  })),
);

export function ReviewWorkspaceRoute({
  eventKey,
  port,
}: {
  eventKey: string;
  port?: ReviewOperationsPort;
}) {
  const client = useMemo(() => port ?? createReviewOperationsPort(), [port]);
  const [surface, setSurface] = useState<"organizer" | "reviewer" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void client
      .workspaceAccess(eventKey, controller.signal)
      .then(({ surface: nextSurface }) => setSurface(nextSurface))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Review access could not be loaded.",
        );
      });
    return () => controller.abort();
  }, [client, eventKey]);

  if (surface === "organizer") return <OrganizerWorkspace />;
  if (surface === "reviewer") {
    return <ReviewerWorkspace eventKey={eventKey} port={client} />;
  }
  if (error) {
    return (
      <main className="route-state">
        <StatePanel
          description={error}
          state="error"
          title="Review access unavailable"
        />
      </main>
    );
  }
  return (
    <main className="route-loading" role="status">
      <span aria-hidden="true" />
      Loading your review workspace…
    </main>
  );
}
