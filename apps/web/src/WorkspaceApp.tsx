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
import { CampaignWorkspace } from "./campaigns/CampaignWorkspace";
import { campaignEventKey } from "./campaigns/campaignRoute";
import { Dashboard } from "./Dashboard";
import { DecisionWorkspace } from "./decisions/DecisionWorkspace";
import { EmailTemplateWorkspace } from "./email-templates/EmailTemplateWorkspace";
import { emailTemplateEventKey } from "./email-templates/emailTemplateRoute";
import { ApiAccessWorkspace } from "./integrations/ApiAccessWorkspace";
import { apiAccessEventKey } from "./integrations/apiAccessRoute";
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

function cfpEventKey(pathname: string): string | null {
  const value = /^\/app\/([^/]+)\/cfp\/?$/.exec(pathname)?.[1];
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function reviewEventKey(pathname: string): string | null {
  const value = /^\/app\/([^/]+)\/reviews\/?$/.exec(pathname)?.[1];
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function decisionEventKey(pathname: string): string | null {
  const value = /^\/app\/([^/]+)\/decisions\/?$/.exec(pathname)?.[1];
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function readinessEventKey(pathname: string): string | null {
  const value = /^\/app\/([^/]+)\/people\/?$/.exec(pathname)?.[1];
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

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
  const campaignEvent = campaignEventKey(currentPath);
  const apiAccessEvent = apiAccessEventKey(currentPath);
  const isReadinessRoute =
    currentPath.endsWith("/people") ||
    currentPath.startsWith("/fixtures/readiness/");
  const readinessEvent = readinessEventKey(currentPath);
  const isSubmissionFixtureRoute = currentPath.startsWith(
    "/fixtures/submissions/",
  );
  const submissionRoute = organizerSubmissionRoute(currentPath);
  const cfpEvent = cfpEventKey(currentPath);
  const reviewEvent = reviewEventKey(currentPath);
  const decisionEvent = decisionEventKey(currentPath);
  const isDecisionFixtureRoute = currentPath === "/fixtures/decisions";
  const isReviewFixtureRoute = currentPath.startsWith("/fixtures/reviews/");
  const content = apiAccessEvent ? (
    <ApiAccessWorkspace
      eventKey={apiAccessEvent}
      key={`${apiAccessEvent}:${resetVersion}`}
    />
  ) : currentPath.endsWith("/cfp") && cfpEvent ? (
    <CfpBuilder eventKey={cfpEvent} key={resetVersion} />
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
  ) : isReviewFixtureRoute ? (
    <ReviewOperations key={resetVersion} />
  ) : reviewEvent ? (
    <ReviewOperations
      eventKey={reviewEvent}
      key={`${reviewEvent}:${resetVersion}`}
    />
  ) : currentPath.includes("/reviews") ? (
    <StatePanel
      description="Open review operations from a valid event workspace."
      state="error"
      title="Review operations route not found"
    />
  ) : isDecisionFixtureRoute ? (
    <DecisionWorkspace fixture key={resetVersion} />
  ) : decisionEvent ? (
    <DecisionWorkspace
      eventKey={decisionEvent}
      key={`${decisionEvent}:${resetVersion}`}
    />
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
  ) : campaignEvent ? (
    <CampaignWorkspace
      eventKey={campaignEvent}
      fixture={currentPath.startsWith("/fixtures/campaigns/")}
      key={`${campaignEvent}:${resetVersion}`}
    />
  ) : emailTemplateEvent ? (
    <EmailTemplateWorkspace
      eventKey={emailTemplateEvent}
      fixture={currentPath.startsWith("/fixtures/email-templates/")}
      key={`${emailTemplateEvent}:${resetVersion}`}
    />
  ) : isReadinessRoute ? (
    <ReadinessDashboard
      eventKey={readinessEvent ?? undefined}
      fixtureState={readinessFixtureState}
      key={`${readinessEvent ?? "fixture"}:${resetVersion}`}
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
