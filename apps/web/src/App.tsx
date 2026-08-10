import { lazy, Suspense } from "react";

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
const SpeakerPortal = lazy(() =>
  import("./portal/SpeakerPortal").then((module) => ({
    default: module.SpeakerPortal,
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

  if (window.location.pathname.startsWith("/auth/")) {
    route = <AuthScreen />;
  } else if (window.location.pathname === "/fixtures/ui") {
    route = <UiFixtures />;
  } else if (window.location.pathname === "/fixtures/public-schedule/empty") {
    route = <PublicSchedule fixtureState="empty" />;
  } else if (window.location.pathname === "/fixtures/public-schedule/error") {
    route = <PublicSchedule fixtureState="error" />;
  } else if (window.location.pathname === "/fixtures/portal-task/failed") {
    route = <SpeakerPortal fixtureTaskState="failed" />;
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
      ) : (
        <SpeakerPortal />
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
    const fixtureState = window.location.pathname.split("/").at(-1);
    route =
      fixtureState === "empty" ||
      fixtureState === "empty-filter" ||
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
        <ReviewerWorkspace />
      );
  } else if (window.location.pathname.startsWith("/review/")) {
    route = <ReviewerWorkspace />;
  } else if (window.location.pathname.startsWith("/portal/")) {
    route = <SpeakerPortal />;
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
