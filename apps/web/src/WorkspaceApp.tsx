import { useEffect, useState } from "react";

import { healthResponseSchema } from "@sessionbox-killer/contracts";
import type { AppEnvironment } from "@sessionbox-killer/ui";

import { AppShell } from "./AppShell";
import { AgendaBuilder, type AgendaFixtureState } from "./agenda/AgendaBuilder";
import { CfpBuilder } from "./cfp/CfpBuilder";
import { Dashboard } from "./Dashboard";
import { DecisionWorkspace } from "./decisions/DecisionWorkspace";
import {
  ReadinessDashboard,
  type ReadinessFixtureState,
} from "./readiness/ReadinessDashboard";
import { ReviewOperations } from "./reviews/ReviewOperations";
import { EventSetup } from "./setup/EventSetup";
import {
  SubmissionWorkspace,
  type SubmissionFixtureState,
} from "./submissions/SubmissionWorkspace";
import { OrganizerTaskReviewWorkspace } from "./tasks/TaskCompletionWorkspace";

function useRuntimeEnvironment() {
  const [environment, setEnvironment] = useState<AppEnvironment | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void fetch("/health/live", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          return null;
        }

        const result = healthResponseSchema.safeParse(await response.json());
        return result.success ? result.data.environment : null;
      })
      .then((result) => {
        if (result) {
          setEnvironment(result);
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setEnvironment(null);
        }
      });

    return () => {
      controller.abort();
    };
  }, []);

  return environment;
}

export function WorkspaceApp({
  agendaFixtureState,
  readinessFixtureState,
  submissionFixtureState,
}: {
  agendaFixtureState?: AgendaFixtureState | undefined;
  readinessFixtureState?: ReadinessFixtureState | undefined;
  submissionFixtureState?: SubmissionFixtureState | undefined;
}) {
  const environment = useRuntimeEnvironment();
  const [resetVersion, setResetVersion] = useState(0);
  const currentPath = window.location.pathname;
  const isAgendaRoute =
    currentPath.endsWith("/agenda") ||
    currentPath.startsWith("/fixtures/agenda/");
  const isReadinessRoute =
    currentPath.endsWith("/people") ||
    currentPath.startsWith("/fixtures/readiness/");
  const content = currentPath.endsWith("/cfp") ? (
    <CfpBuilder key={resetVersion} />
  ) : currentPath.includes("/submissions") ? (
    <SubmissionWorkspace
      fixtureState={submissionFixtureState}
      fixtureSubmissionId={
        submissionFixtureState === "partial" ? "AI-1042" : undefined
      }
      key={resetVersion}
    />
  ) : currentPath.endsWith("/reviews") ? (
    <ReviewOperations key={resetVersion} />
  ) : currentPath.endsWith("/decisions") ? (
    <DecisionWorkspace key={resetVersion} />
  ) : isAgendaRoute ? (
    <AgendaBuilder fixtureState={agendaFixtureState} key={resetVersion} />
  ) : currentPath.endsWith("/people/mina-okafor/tasks/final-slides") ? (
    <OrganizerTaskReviewWorkspace key={resetVersion} />
  ) : isReadinessRoute ? (
    <ReadinessDashboard
      fixtureState={readinessFixtureState}
      key={resetVersion}
    />
  ) : currentPath.endsWith("/settings") ? (
    <EventSetup key={resetVersion} />
  ) : (
    <Dashboard key={resetVersion} />
  );

  return (
    <AppShell
      environment={environment}
      isDemoEvent
      onResetDemo={() => {
        setResetVersion((current) => current + 1);
      }}
    >
      {content}
    </AppShell>
  );
}
