import { useEffect, useState } from "react";

import { healthResponseSchema } from "@sessionbox-killer/contracts";
import { demoEventSlug } from "@sessionbox-killer/domain";
import { StatePanel, type AppEnvironment } from "@sessionbox-killer/ui";

import { AppShell } from "./AppShell";
import { resetDemoEventFromBrowser } from "./demo/demoClient";
import { AgendaBuilder, type AgendaFixtureState } from "./agenda/AgendaBuilder";
import { workspaceEventSlug } from "./agenda/agendaRoute";
import { AgendaWorkspace } from "./agenda/AgendaWorkspace";
import { CfpBuilder } from "./cfp/CfpBuilder";
import { Dashboard } from "./Dashboard";
import { DecisionWorkspace } from "./decisions/DecisionWorkspace";
import { EmailTemplateWorkspace } from "./email-templates/EmailTemplateWorkspace";
import { emailTemplateEventKey } from "./email-templates/emailTemplateRoute";
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
import { OrganizerSubmissionWorkspace } from "./submissions/OrganizerSubmissionWorkspace";
import { organizerSubmissionRoute } from "./submissions/submissionRoute";
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
  const isAgendaFixtureRoute = currentPath.startsWith("/fixtures/agenda/");
  const agendaEventSlug = workspaceEventSlug(currentPath);
  const emailTemplateEvent = emailTemplateEventKey(currentPath);
  const isReadinessRoute =
    currentPath.endsWith("/people") ||
    currentPath.startsWith("/fixtures/readiness/");
  const isSubmissionFixtureRoute = currentPath.startsWith(
    "/fixtures/submissions/",
  );
  const submissionRoute = organizerSubmissionRoute(currentPath);
  const content = currentPath.endsWith("/cfp") ? (
    <CfpBuilder key={resetVersion} />
  ) : isSubmissionFixtureRoute ? (
    <SubmissionWorkspace
      fixtureState={submissionFixtureState}
      fixtureSubmissionId={
        submissionFixtureState === "partial"
          ? "AI-1042"
          : submissionFixtureState === "interactive"
            ? currentPath.split("/")[4]
            : undefined
      }
      key={resetVersion}
    />
  ) : submissionRoute ? (
    <OrganizerSubmissionWorkspace
      eventKey={submissionRoute.eventKey}
      key={`${submissionRoute.eventKey}:${submissionRoute.submissionId ?? "list"}:${resetVersion}`}
      submissionId={submissionRoute.submissionId}
    />
  ) : currentPath.includes("/submissions") ? (
    <StatePanel
      description="Open submissions from a valid event workspace."
      state="error"
      title="Submission route not found"
    />
  ) : currentPath.endsWith("/reviews") ? (
    <ReviewOperations key={resetVersion} />
  ) : currentPath.endsWith("/decisions") ? (
    <DecisionWorkspace key={resetVersion} />
  ) : isAgendaRoute ? (
    isAgendaFixtureRoute ? (
      <AgendaBuilder fixtureState={agendaFixtureState} key={resetVersion} />
    ) : agendaEventSlug ? (
      <AgendaWorkspace
        eventSlug={agendaEventSlug}
        key={`${agendaEventSlug}:${resetVersion}`}
      />
    ) : (
      <StatePanel
        description="Open the agenda from a valid event workspace."
        state="error"
        title="Event route not found"
      />
    )
  ) : currentPath.endsWith("/people/mina-okafor/tasks/final-slides") ? (
    <OrganizerTaskReviewWorkspace key={resetVersion} />
  ) : emailTemplateEvent ? (
    <EmailTemplateWorkspace
      eventKey={emailTemplateEvent}
      fixture={currentPath.startsWith("/fixtures/email-templates/")}
      key={`${emailTemplateEvent}:${resetVersion}`}
    />
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
      onResetDemo={async (confirmation) => {
        const result = await resetDemoEventFromBrowser(
          demoEventSlug,
          confirmation,
        );
        setResetVersion((current) => current + 1);
        return result;
      }}
    >
      {content}
    </AppShell>
  );
}
