import {
  emailTemplateCommandResponseSchema,
  emailTemplateCommandSchema,
  emailTemplatePreviewRequestSchema,
  emailTemplatePreviewResponseSchema,
  emailTemplateWorkspaceSchema,
  type EmailTemplateCommand,
  type EmailTemplateCommandResponse,
  type EmailTemplatePreviewRequest,
  type EmailTemplatePreviewResponse,
  type EmailTemplateWorkspace,
} from "@sessionbox-killer/email";

import { readCsrfToken } from "../auth/authClient";

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface StandardErrorBody {
  error?: { code?: unknown; message?: unknown };
  request_id?: unknown;
}

export interface EmailTemplatePort {
  execute(
    command: EmailTemplateCommand,
  ): Promise<Extract<EmailTemplateCommandResponse, { ok: true }>["result"]>;
  preview(
    request: EmailTemplatePreviewRequest,
  ): Promise<EmailTemplatePreviewResponse>;
  read(): Promise<EmailTemplateWorkspace>;
}

function standardError(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const candidate = body as StandardErrorBody;
  if (
    !candidate.error ||
    typeof candidate.error.code !== "string" ||
    typeof candidate.error.message !== "string"
  ) {
    return null;
  }
  return {
    code: candidate.error.code,
    message: candidate.error.message,
    requestId:
      typeof candidate.request_id === "string"
        ? candidate.request_id
        : undefined,
  };
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class EmailTemplateApiError extends Error {
  readonly code: string;
  readonly commandError:
    Extract<EmailTemplateCommandResponse, { ok: false }>["error"] | undefined;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(options: {
    code: string;
    commandError?:
      Extract<EmailTemplateCommandResponse, { ok: false }>["error"] | undefined;
    message: string;
    requestId?: string | undefined;
    status: number;
  }) {
    super(options.message);
    this.name = "EmailTemplateApiError";
    this.code = options.code;
    this.commandError = options.commandError;
    this.requestId = options.requestId;
    this.status = options.status;
  }
}

function responseError(response: Response, body: unknown) {
  const parsed = standardError(body);
  return new EmailTemplateApiError({
    code: parsed?.code ?? "invalid_email_template_response",
    message:
      parsed?.message ??
      "The email-template service returned an invalid response.",
    requestId: parsed?.requestId,
    status: response.status,
  });
}

export function createEmailTemplatePort(
  eventKey: string,
  fetcher: Fetch = window.fetch.bind(window),
  csrfReader: () => string | null = () => readCsrfToken(document.cookie),
): EmailTemplatePort {
  const baseUrl = `/api/events/${encodeURIComponent(eventKey)}/email-templates`;

  async function sendCommand(
    command: EmailTemplateCommand,
    retryCsrf: boolean,
  ) {
    const csrf = csrfReader();
    if (!csrf) {
      throw new EmailTemplateApiError({
        code: "missing_csrf",
        message: "Refresh the page before saving a template version.",
        status: 0,
      });
    }
    const response = await fetcher(`${baseUrl}/commands`, {
      body: JSON.stringify(emailTemplateCommandSchema.parse(command)),
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      method: "POST",
    });
    const body = await json(response);
    const parsed = emailTemplateCommandResponseSchema.safeParse(body);
    if (parsed.success) {
      if (parsed.data.ok) return parsed.data.result;
      throw new EmailTemplateApiError({
        code: parsed.data.error.code,
        commandError: parsed.data.error,
        message: parsed.data.error.message,
        status: response.status,
      });
    }
    const error = responseError(response, body);
    if (!retryCsrf && error.code === "invalid_csrf") {
      return sendCommand(command, true);
    }
    throw error;
  }

  return {
    execute(command) {
      return sendCommand(command, false);
    },
    async preview(request) {
      const response = await fetcher(`${baseUrl}/preview`, {
        body: JSON.stringify(emailTemplatePreviewRequestSchema.parse(request)),
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const body = await json(response);
      const parsed = emailTemplatePreviewResponseSchema.safeParse(body);
      if (parsed.success) return parsed.data;
      throw responseError(response, body);
    },
    async read() {
      const response = await fetcher(baseUrl, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const body = await json(response);
      if (!response.ok) throw responseError(response, body);
      const parsed = emailTemplateWorkspaceSchema.safeParse(body);
      if (!parsed.success) throw responseError(response, body);
      return parsed.data;
    },
  };
}
