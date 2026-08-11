import {
  cfpFormEntityTag,
  cfpFormDiagnosticSchema,
  organizerCfpFormMutationResponseSchema,
  organizerCfpFormReadResponseSchema,
  type CfpFormDiagnostic,
  type OrganizerCfpFormCloseRequest,
  type OrganizerCfpFormMutationResponse,
  type OrganizerCfpFormPublishRequest,
  type OrganizerCfpFormReadResponse,
  type OrganizerCfpFormSaveRequest,
} from "@sessionbox-killer/contracts";

import { readCsrfToken } from "../auth/authClient";

export class CfpFormApiError extends Error {
  readonly code: string;
  readonly diagnostics: readonly CfpFormDiagnostic[];
  readonly status: number;

  constructor(
    status: number,
    code: string,
    message: string,
    diagnostics: readonly CfpFormDiagnostic[] = [],
  ) {
    super(message);
    this.name = "CfpFormApiError";
    this.code = code;
    this.diagnostics = diagnostics;
    this.status = status;
  }
}

type Fetcher = typeof window.fetch;

function path(eventKey: string, suffix = ""): string {
  return `/api/events/${encodeURIComponent(eventKey)}/cfp/form${suffix}`;
}

async function apiError(response: Response): Promise<CfpFormApiError> {
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return new CfpFormApiError(
      response.status,
      "cfp_form_request_failed",
      "The CFP form request could not be completed.",
    );
  }
  const error = payload.error;
  if (!error || typeof error !== "object") {
    return new CfpFormApiError(
      response.status,
      "cfp_form_request_failed",
      "The CFP form request could not be completed.",
    );
  }
  const record = error as Record<string, unknown>;
  const diagnostics = Array.isArray(record.diagnostics)
    ? record.diagnostics
        .map((diagnostic) => {
          const result = cfpFormDiagnosticSchema.safeParse(diagnostic);
          return result.success ? result.data : null;
        })
        .filter(
          (diagnostic): diagnostic is CfpFormDiagnostic => diagnostic !== null,
        )
    : [];
  return new CfpFormApiError(
    response.status,
    typeof record.code === "string" ? record.code : "cfp_form_request_failed",
    typeof record.message === "string"
      ? record.message
      : "The CFP form request could not be completed.",
    diagnostics,
  );
}

export async function readCfpForm(
  fetcher: Fetcher,
  eventKey: string,
  signal?: AbortSignal,
): Promise<OrganizerCfpFormReadResponse> {
  const response = await fetcher(path(eventKey), {
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await apiError(response);
  return organizerCfpFormReadResponseSchema.parse(await response.json());
}

async function mutateCfpForm(
  fetcher: Fetcher,
  eventKey: string,
  request:
    | OrganizerCfpFormCloseRequest
    | OrganizerCfpFormPublishRequest
    | OrganizerCfpFormSaveRequest,
  suffix: "" | "/close" | "/publish",
  method: "POST" | "PUT",
): Promise<OrganizerCfpFormMutationResponse> {
  const csrf = readCsrfToken(document.cookie);
  if (!csrf) {
    throw new CfpFormApiError(
      403,
      "invalid_csrf",
      "Refresh this page before changing the CFP form.",
    );
  }
  const response = await fetcher(path(eventKey, suffix), {
    body: JSON.stringify(request),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": request.commandId,
      "If-Match": cfpFormEntityTag({
        id: request.expectedFormId,
        sourceVersion: request.expectedSourceVersion,
      }),
      "X-CSRF-Token": csrf,
    },
    method,
  });
  if (!response.ok) throw await apiError(response);
  return organizerCfpFormMutationResponseSchema.parse(await response.json());
}

export function saveCfpForm(
  fetcher: Fetcher,
  eventKey: string,
  request: OrganizerCfpFormSaveRequest,
): Promise<OrganizerCfpFormMutationResponse> {
  return mutateCfpForm(fetcher, eventKey, request, "", "PUT");
}

export function publishCfpForm(
  fetcher: Fetcher,
  eventKey: string,
  request: OrganizerCfpFormPublishRequest,
): Promise<OrganizerCfpFormMutationResponse> {
  return mutateCfpForm(fetcher, eventKey, request, "/publish", "POST");
}

export function closeCfpForm(
  fetcher: Fetcher,
  eventKey: string,
  request: OrganizerCfpFormCloseRequest,
): Promise<OrganizerCfpFormMutationResponse> {
  return mutateCfpForm(fetcher, eventKey, request, "/close", "POST");
}
