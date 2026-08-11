import {
  publicApiEventListSchema,
  publicApiEventSchema,
  publicApiExportRunListSchema,
  publicApiExportRunSchema,
  publicApiScheduleSchema,
  publicApiSessionListSchema,
  publicApiSessionSchema,
  publicApiSpeakerListSchema,
  publicApiSpeakerSchema,
  publicApiSubmissionListSchema,
  publicApiSubmissionPatchSchema,
  publicApiSubmissionSchema,
  publicApiTaskListSchema,
  publicApiTaskSchema,
  type ApiKeyScope,
} from "@sessionbox-killer/contracts/public-api";
import type { z } from "zod";

export type PublicApiMethod = "get" | "patch";

export interface PublicApiOperation {
  readonly description: string;
  readonly eventScoped: boolean;
  readonly honoPath: string;
  readonly id: string;
  readonly method: PublicApiMethod;
  readonly openApiPath: string;
  readonly paginated: boolean;
  readonly requestSchema?: z.ZodType;
  readonly responseSchema: z.ZodType;
  readonly scope: ApiKeyScope;
  readonly summary: string;
  readonly tag:
    | "Events"
    | "Export runs"
    | "Schedule"
    | "Sessions"
    | "Speakers"
    | "Submissions"
    | "Tasks";
  readonly versioned: boolean;
}

export const publicApiOperations = [
  {
    description:
      "Lists events visible to the API key's organization or event scope.",
    eventScoped: false,
    honoPath: "/api/v1/events",
    id: "listEvents",
    method: "get",
    openApiPath: "/events",
    paginated: true,
    responseSchema: publicApiEventListSchema,
    scope: "events:read",
    summary: "List events",
    tag: "Events",
    versioned: false,
  },
  {
    description: "Returns one event in the authenticated organization.",
    eventScoped: true,
    honoPath: "/api/v1/events/:eventId",
    id: "getEvent",
    method: "get",
    openApiPath: "/events/{eventId}",
    paginated: false,
    responseSchema: publicApiEventSchema,
    scope: "events:read",
    summary: "Get an event",
    tag: "Events",
    versioned: true,
  },
  {
    description: "Lists submission projections for an event.",
    eventScoped: true,
    honoPath: "/api/v1/events/:eventId/submissions",
    id: "listSubmissions",
    method: "get",
    openApiPath: "/events/{eventId}/submissions",
    paginated: true,
    responseSchema: publicApiSubmissionListSchema,
    scope: "submissions:read",
    summary: "List submissions",
    tag: "Submissions",
    versioned: false,
  },
  {
    description: "Returns one submission projection for an event.",
    eventScoped: true,
    honoPath: "/api/v1/events/:eventId/submissions/:submissionId",
    id: "getSubmission",
    method: "get",
    openApiPath: "/events/{eventId}/submissions/{submissionId}",
    paginated: false,
    responseSchema: publicApiSubmissionSchema,
    scope: "submissions:read",
    summary: "Get a submission",
    tag: "Submissions",
    versioned: true,
  },
  {
    description:
      "Moves a submission through a supported organizer workflow transition.",
    eventScoped: true,
    honoPath: "/api/v1/events/:eventId/submissions/:submissionId",
    id: "updateSubmission",
    method: "patch",
    openApiPath: "/events/{eventId}/submissions/{submissionId}",
    paginated: false,
    requestSchema: publicApiSubmissionPatchSchema,
    responseSchema: publicApiSubmissionSchema,
    scope: "submissions:write",
    summary: "Update a submission",
    tag: "Submissions",
    versioned: true,
  },
  {
    description: "Lists session projections for an event.",
    eventScoped: true,
    honoPath: "/api/v1/events/:eventId/sessions",
    id: "listSessions",
    method: "get",
    openApiPath: "/events/{eventId}/sessions",
    paginated: true,
    responseSchema: publicApiSessionListSchema,
    scope: "sessions:read",
    summary: "List sessions",
    tag: "Sessions",
    versioned: false,
  },
  {
    description: "Returns one session projection for an event.",
    eventScoped: true,
    honoPath: "/api/v1/events/:eventId/sessions/:sessionId",
    id: "getSession",
    method: "get",
    openApiPath: "/events/{eventId}/sessions/{sessionId}",
    paginated: false,
    responseSchema: publicApiSessionSchema,
    scope: "sessions:read",
    summary: "Get a session",
    tag: "Sessions",
    versioned: true,
  },
  {
    description:
      "Lists speaker projections and readiness summaries for an event.",
    eventScoped: true,
    honoPath: "/api/v1/events/:eventId/speakers",
    id: "listSpeakers",
    method: "get",
    openApiPath: "/events/{eventId}/speakers",
    paginated: true,
    responseSchema: publicApiSpeakerListSchema,
    scope: "speakers:read",
    summary: "List speakers",
    tag: "Speakers",
    versioned: false,
  },
  {
    description:
      "Returns one speaker projection and readiness summary for an event.",
    eventScoped: true,
    honoPath: "/api/v1/events/:eventId/speakers/:speakerId",
    id: "getSpeaker",
    method: "get",
    openApiPath: "/events/{eventId}/speakers/{speakerId}",
    paginated: false,
    responseSchema: publicApiSpeakerSchema,
    scope: "speakers:read",
    summary: "Get a speaker",
    tag: "Speakers",
    versioned: false,
  },
  {
    description:
      "Lists canonical read-only task assignment projections for an event.",
    eventScoped: true,
    honoPath: "/api/v1/events/:eventId/tasks",
    id: "listTasks",
    method: "get",
    openApiPath: "/events/{eventId}/tasks",
    paginated: true,
    responseSchema: publicApiTaskListSchema,
    scope: "tasks:read",
    summary: "List tasks",
    tag: "Tasks",
    versioned: false,
  },
  {
    description: "Returns one canonical read-only task assignment projection.",
    eventScoped: true,
    honoPath: "/api/v1/events/:eventId/tasks/:taskId",
    id: "getTask",
    method: "get",
    openApiPath: "/events/{eventId}/tasks/{taskId}",
    paginated: false,
    responseSchema: publicApiTaskSchema,
    scope: "tasks:read",
    summary: "Get a task",
    tag: "Tasks",
    versioned: true,
  },
  {
    description:
      "Returns the currently published schedule projection for an event.",
    eventScoped: true,
    honoPath: "/api/v1/events/:eventId/schedule",
    id: "getPublishedSchedule",
    method: "get",
    openApiPath: "/events/{eventId}/schedule",
    paginated: false,
    responseSchema: publicApiScheduleSchema,
    scope: "schedule:read",
    summary: "Get the published schedule",
    tag: "Schedule",
    versioned: false,
  },
  {
    description:
      "Lists provider-neutral integration export-run status records for an event.",
    eventScoped: true,
    honoPath: "/api/v1/events/:eventId/export-runs",
    id: "listExportRuns",
    method: "get",
    openApiPath: "/events/{eventId}/export-runs",
    paginated: true,
    responseSchema: publicApiExportRunListSchema,
    scope: "integrations:read",
    summary: "List export runs",
    tag: "Export runs",
    versioned: false,
  },
  {
    description:
      "Returns one provider-neutral integration export-run status record.",
    eventScoped: true,
    honoPath: "/api/v1/events/:eventId/export-runs/:runId",
    id: "getExportRun",
    method: "get",
    openApiPath: "/events/{eventId}/export-runs/{runId}",
    paginated: false,
    responseSchema: publicApiExportRunSchema,
    scope: "integrations:read",
    summary: "Get an export run",
    tag: "Export runs",
    versioned: false,
  },
] as const satisfies readonly PublicApiOperation[];

export type PublicApiOperationId = (typeof publicApiOperations)[number]["id"];

export function publicApiOperation(
  id: PublicApiOperationId,
): PublicApiOperation {
  const operation = publicApiOperations.find(
    (candidate) => candidate.id === id,
  );
  if (!operation)
    throw new Error(`Public API operation ${id} is not registered.`);
  return operation;
}
