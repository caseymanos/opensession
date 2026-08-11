import {
  campaignConfirmRequestSchema,
  campaignConfirmResponseSchema,
  campaignDeliveryLogSchema,
  campaignPreviewRequestSchema,
  campaignPreviewResponseSchema,
  campaignReplayRequestSchema,
  campaignReplayResponseSchema,
  campaignWorkspaceSchema,
  type CampaignConfirmRequest,
  type CampaignConfirmResponse,
  type CampaignDeliveryLog,
  type CampaignPreviewRequest,
  type CampaignPreviewResponse,
  type CampaignReplayRequest,
  type CampaignReplayResponse,
  type CampaignWorkspace,
} from "@sessionbox-killer/email";

import { readCsrfToken } from "../auth/authClient";

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CampaignPort {
  confirm(request: CampaignConfirmRequest): Promise<CampaignConfirmResponse>;
  delivery(campaignId: string): Promise<CampaignDeliveryLog>;
  preview(request: CampaignPreviewRequest): Promise<CampaignPreviewResponse>;
  read(): Promise<CampaignWorkspace>;
  replay(
    campaignId: string,
    request: CampaignReplayRequest,
  ): Promise<CampaignReplayResponse>;
}

interface StandardErrorBody {
  error?: { code?: unknown; message?: unknown };
  request_id?: unknown;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class CampaignApiError extends Error {
  readonly code: string;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(options: {
    code: string;
    message: string;
    requestId?: string;
    status: number;
  }) {
    super(options.message);
    this.name = "CampaignApiError";
    this.code = options.code;
    this.requestId = options.requestId;
    this.status = options.status;
  }
}

function responseError(response: Response, body: unknown) {
  const candidate =
    body && typeof body === "object" ? (body as StandardErrorBody) : undefined;
  return new CampaignApiError({
    code:
      typeof candidate?.error?.code === "string"
        ? candidate.error.code
        : "invalid_campaign_response",
    message:
      typeof candidate?.error?.message === "string"
        ? candidate.error.message
        : "The campaign service returned an invalid response.",
    ...(typeof candidate?.request_id === "string"
      ? { requestId: candidate.request_id }
      : {}),
    status: response.status,
  });
}

export function createCampaignPort(
  eventKey: string,
  fetcher: Fetch = window.fetch.bind(window),
  csrfReader: () => string | null = () => readCsrfToken(document.cookie),
): CampaignPort {
  const baseUrl = `/api/events/${encodeURIComponent(eventKey)}/campaigns`;

  async function mutation(
    path: string,
    body: unknown,
  ): Promise<{ body: unknown; response: Response }> {
    const csrf = csrfReader();
    if (!csrf) {
      throw new CampaignApiError({
        code: "missing_csrf",
        message: "Refresh the page before confirming or replaying a campaign.",
        status: 0,
      });
    }
    const response = await fetcher(`${baseUrl}${path}`, {
      body: JSON.stringify(body),
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      method: "POST",
    });
    return { body: await json(response), response };
  }

  return {
    async confirm(request) {
      const result = await mutation(
        "/confirm",
        campaignConfirmRequestSchema.parse(request),
      );
      const parsed = campaignConfirmResponseSchema.safeParse(result.body);
      if (!result.response.ok || !parsed.success) {
        throw responseError(result.response, result.body);
      }
      return parsed.data;
    },
    async delivery(campaignId) {
      const response = await fetcher(
        `${baseUrl}/${encodeURIComponent(campaignId)}/delivery`,
        { credentials: "same-origin", headers: { Accept: "application/json" } },
      );
      const body = await json(response);
      const parsed = campaignDeliveryLogSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw responseError(response, body);
      return parsed.data;
    },
    async preview(request) {
      const response = await fetcher(`${baseUrl}/preview`, {
        body: JSON.stringify(campaignPreviewRequestSchema.parse(request)),
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const body = await json(response);
      const parsed = campaignPreviewResponseSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw responseError(response, body);
      return parsed.data;
    },
    async read() {
      const response = await fetcher(baseUrl, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const body = await json(response);
      const parsed = campaignWorkspaceSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw responseError(response, body);
      return parsed.data;
    },
    async replay(campaignId, request) {
      const result = await mutation(
        `/${encodeURIComponent(campaignId)}/replay`,
        campaignReplayRequestSchema.parse(request),
      );
      const parsed = campaignReplayResponseSchema.safeParse(result.body);
      if (!result.response.ok || !parsed.success) {
        throw responseError(result.response, result.body);
      }
      return parsed.data;
    },
  };
}
