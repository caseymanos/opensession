import { lazy, Suspense } from "react";

import { reviewWorkspaceEventKey } from "./reviews/reviewRoute";

const WorkspaceApp = lazy(() =>
  import("./WorkspaceApp").then((module) => ({
    default: module.WorkspaceApp,
  })),
);
const UiFixtures = lazy(() =>
  import("./UiFixtures").then((module) => ({ default: module.UiFixtures })),
);
const ReviewerWorkspace = lazy(() =>
  import("./reviews/ReviewerWorkspace").then((module) => ({
    default: module.ReviewerWorkspace,
  })),
);
const ReviewWorkspaceRoute = lazy(() =>
  import("./reviews/ReviewWorkspaceRoute").then((module) => ({
    default: module.ReviewWorkspaceRoute,
  })),
);
const SpeakerPortal = lazy(() =>
  import("./portal/SpeakerPortal").then((module) => ({
    default: module.SpeakerPortal,
  })),
);
const OrganizerTaskFixture = lazy(() =>
  import("./tasks/TaskCompletionWorkspace").then((module) => ({
    default: module.OrganizerTaskReviewWorkspace,
  })),
);
const ProductionOrganizerTaskPage = lazy(() =>
  import("./tasks/ProductionTaskCompletionWorkspace").then((module) => ({
    default: module.ProductionOrganizerTaskPage,
  })),
);
const PublicSchedule = lazy(() =>
  import("./public/PublicSchedule").then((module) => ({
    default: module.PublicSchedule,
  })),
);
const PublicSpeakers = lazy(() =>
  import("./public/PublicSpeakers").then((module) => ({
    default: module.PublicSpeakers,
  })),
);
const PublicCfpFlow = lazy(() =>
  import("./cfp/PublicCfpFlow").then((module) => ({
    default: module.PublicCfpFlow,
  })),
);
const AuthScreen = lazy(() =>
  import("./auth/AuthScreen").then((module) => ({
    default: module.AuthScreen,
  })),
);

export function App() {
  let route;
  const organizerTaskRoute =
    /^\/app\/([^/]+)\/people\/[^/]+\/tasks\/([^/]+)\/?$/.exec(
      window.location.pathname,
    );
  const reviewWorkspaceEvent = reviewWorkspaceEventKey(
    window.location.pathname,
  );

  if (window.location.pathname.startsWith("/auth/")) {
    route = <AuthScreen />;
  } else if (window.location.pathname === "/fixtures/ui") {
    route = <UiFixtures />;
  } else if (window.location.pathname === "/fixtures/decisions") {
    route = <WorkspaceApp />;
  } else if (window.location.pathname === "/fixtures/public-schedule/empty") {
    route = <PublicSchedule fixtureState="empty" />;
  } else if (window.location.pathname === "/fixtures/public-schedule/error") {
    route = <PublicSchedule fixtureState="error" />;
  } else if (window.location.pathname.startsWith("/fixtures/portal-task/")) {
    route = (
      <SpeakerPortal
        fixtureTaskState={
          window.location.pathname.endsWith("/failed") ? "failed" : "default"
        }
        fixtureView="task"
      />
    );
  } else if (window.location.pathname.startsWith("/fixtures/organizer-task/")) {
    route = <OrganizerTaskFixture />;
  } else if (window.location.pathname.startsWith("/fixtures/agenda/")) {
    const fixtureState = window.location.pathname.split("/").at(-1);
    route =
      fixtureState === "empty" ||
      fixtureState === "placement-failed" ||
      fixtureState === "published" ||
      fixtureState === "ready" ||
      fixtureState === "ready-readonly" ? (
        <WorkspaceApp agendaFixtureState={fixtureState} />
      ) : (
        <WorkspaceApp />
      );
  } else if (window.location.pathname.startsWith("/fixtures/portal/")) {
    const fixtureState = window.location.pathname.split("/").at(-1);
    route =
      fixtureState === "empty" ||
      fixtureState === "expired" ||
      fixtureState === "permission" ||
      fixtureState === "redeemed" ||
      fixtureState === "revoked" ? (
        <SpeakerPortal fixtureState={fixtureState} />
      ) : fixtureState === "profile" ? (
        <SpeakerPortal fixtureView="profile" />
      ) : (
        <SpeakerPortal fixtureView="home" />
      );
  } else if (window.location.pathname.startsWith("/fixtures/readiness/")) {
    const fixtureState = window.location.pathname.split("/").at(-1);
    route =
      fixtureState === "lag" || fixtureState === "partial" ? (
        <WorkspaceApp readinessFixtureState={fixtureState} />
      ) : (
        <WorkspaceApp />
      );
  } else if (window.location.pathname.startsWith("/fixtures/submissions/")) {
    const fixtureState = window.location.pathname.split("/")[3];
    route =
      fixtureState === "empty" ||
      fixtureState === "empty-filter" ||
      fixtureState === "interactive" ||
      fixtureState === "partial" ||
      fixtureState === "permission" ||
      fixtureState === "stale" ? (
        <WorkspaceApp submissionFixtureState={fixtureState} />
      ) : (
        <WorkspaceApp />
      );
  } else if (window.location.pathname.startsWith("/fixtures/public-cfp/")) {
    const fixtureState = window.location.pathname.split("/").at(-1);
    route =
      fixtureState === "closed" ||
      fixtureState === "failed" ||
      fixtureState === "interactive" ||
      fixtureState === "limit" ||
      fixtureState === "offline" ||
      fixtureState === "resume" ? (
        <PublicCfpFlow fixtureState={fixtureState} />
      ) : (
        <PublicCfpFlow fixtureState="interactive" />
      );
  } else if (
    window.location.pathname.startsWith("/fixtures/public-speakers/")
  ) {
    const fixtureState = window.location.pathname.split("/").at(-1);
    route =
      fixtureState === "empty" ||
      fixtureState === "error" ||
      fixtureState === "interactive" ||
      fixtureState === "missing-profile" ||
      fixtureState === "profile" ? (
        <PublicSpeakers fixtureState={fixtureState} />
      ) : (
        <PublicSpeakers fixtureState="empty" />
      );
  } else if (window.location.pathname.startsWith("/fixtures/reviewer/")) {
    const fixtureState = window.location.pathname.split("/").at(-1);
    route =
      fixtureState === "expired" ||
      fixtureState === "offline" ||
      fixtureState === "permission" ||
      fixtureState === "submitted" ? (
        <ReviewerWorkspace fixtureState={fixtureState} />
      ) : (
        <ReviewerWorkspace fixtureState="default" />
      );
  } else if (window.location.pathname.startsWith("/review/")) {
    route = <ReviewerWorkspace />;
  } else if (reviewWorkspaceEvent) {
    route = <ReviewWorkspaceRoute eventKey={reviewWorkspaceEvent} />;
  } else if (organizerTaskRoute?.[1] && organizerTaskRoute[2]) {
    route = (
      <ProductionOrganizerTaskPage
        assignmentId={organizerTaskRoute[2]}
        eventKey={organizerTaskRoute[1]}
      />
    );
  } else if (window.location.pathname.startsWith("/portal/")) {
    route = <SpeakerPortal />;
  } else if (window.location.pathname === "/") {
    route = <PublicSchedule />;
  } else if (/^\/e\/[^/]+\/cfp\/?$/.test(window.location.pathname)) {
    route = <PublicCfpFlow />;
  } else if (
    /^\/e\/[^/]+\/speakers(?:\/[^/]+)?\/?$/.test(window.location.pathname)
  ) {
    route = <PublicSpeakers />;
  } else if (window.location.pathname.startsWith("/e/")) {
    route = <PublicSchedule />;
  } else {
    route = <WorkspaceApp />;
  }

  return (
    <Suspense
      fallback={
        <main className="route-loading" role="status">
          <span aria-hidden="true" />
          Loading OpenSession…
        </main>
      }
    >
      {route}
    </Suspense>
  );
}
