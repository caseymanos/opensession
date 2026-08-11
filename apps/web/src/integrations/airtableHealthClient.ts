import {
  airtableIntegrationHealthSchema,
  airtableReconcileResponseSchema,
  publicApiProblemSchema,
  type AirtableIntegrationHealth,
  type AirtableReconcilePlan,
  type AirtableReconcileResponse,
} from "@sessionbox-killer/contracts";

import { readCsrfToken } from "../auth/authClient";

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AirtableHealthPort {
  apply(
    plan: AirtableReconcilePlan,
    confirmation: string,
  ): Promise<AirtableReconcileResponse>;
  dryRun(): Promise<AirtableReconcilePlan>;
  health(): Promise<AirtableIntegrationHealth>;
}

export class AirtableHealthClientError extends Error {
  readonly code: string;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(options: {
    code: string;
    message: string;
    requestId?: string | undefined;
    status: number;
  }) {
    super(options.message);
    this.name = "AirtableHealthClientError";
    this.code = options.code;
    this.requestId = options.requestId;
    this.status = options.status;
  }
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function failure(
  response: Response,
  value: unknown,
): AirtableHealthClientError {
  const problem = publicApiProblemSchema.safeParse(value);
  return new AirtableHealthClientError({
    code: problem.success ? problem.data.code : "invalid_airtable_response",
    message: problem.success
      ? problem.data.detail
      : "The Airtable integration returned an invalid response.",
    requestId: problem.success ? problem.data.request_id : undefined,
    status: response.status,
  });
}

function clientFailure(message: string): AirtableHealthClientError {
  return new AirtableHealthClientError({
    code: "missing_csrf",
    message,
    status: 0,
  });
}

export function createAirtableHealthPort(
  eventKey: string,
  fetcher: Fetch = window.fetch.bind(window),
  csrfReader: () => string | null = () => readCsrfToken(document.cookie),
): AirtableHealthPort {
  const baseUrl = `/api/events/${encodeURIComponent(eventKey)}/integrations/airtable`;
  const idempotencyByPlan = new Map<string, string>();

  async function mutate(
    body: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const csrf = csrfReader();
    if (!csrf) {
      throw clientFailure("Refresh the page before reconciling Airtable.");
    }
    const response = await fetcher(`${baseUrl}/reconcile`, {
      body: JSON.stringify(body),
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        "X-CSRF-Token": csrf,
      },
      method: "POST",
    });
    const value = await json(response);
    if (!response.ok) throw failure(response, value);
    return value;
  }

  return {
    async apply(plan, confirmation) {
      const idempotencyKey =
        idempotencyByPlan.get(plan.plan_id) ??
        `airtable-reconcile-${crypto.randomUUID()}`;
      idempotencyByPlan.set(plan.plan_id, idempotencyKey);
      const value = await mutate(
        {
          confirmation,
          mode: "apply",
          plan_id: plan.plan_id,
        },
        idempotencyKey,
      );
      const parsed = airtableReconcileResponseSchema.safeParse(value);
      if (!parsed.success || parsed.data.mode !== "apply") {
        throw new AirtableHealthClientError({
          code: "invalid_airtable_response",
          message: "The Airtable integration returned an invalid response.",
          status: 200,
        });
      }
      idempotencyByPlan.delete(plan.plan_id);
      return parsed.data;
    },
    async dryRun() {
      const value = await mutate({ mode: "dry_run" });
      const parsed = airtableReconcileResponseSchema.safeParse(value);
      if (!parsed.success || parsed.data.mode !== "dry_run") {
        throw new AirtableHealthClientError({
          code: "invalid_airtable_response",
          message: "The Airtable integration returned an invalid response.",
          status: 200,
        });
      }
      return parsed.data.plan;
    },
    async health() {
      const response = await fetcher(`${baseUrl}/health`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const value = await json(response);
      if (!response.ok) throw failure(response, value);
      const parsed = airtableIntegrationHealthSchema.safeParse(value);
      if (!parsed.success) throw failure(response, value);
      return parsed.data;
    },
  };
}
