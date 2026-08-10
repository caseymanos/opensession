import type { TurnstileAction } from "@sessionbox-killer/contracts";

const siteverifyEndpoint =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const productionEnvironment = "production";

interface SiteverifyResponse {
  action?: string;
  errorCode?: SiteverifyErrorCode | "unknown";
  hostname?: string;
  success?: boolean;
}

const siteverifyErrorCodes = new Set([
  "bad-request",
  "internal-error",
  "invalid-input-response",
  "invalid-input-secret",
  "missing-input-response",
  "missing-input-secret",
  "timeout-or-duplicate",
] as const);

type SiteverifyErrorCode =
  typeof siteverifyErrorCodes extends Set<infer Code> ? Code : never;

export type TurnstileFailureCode =
  | "input.invalid"
  | "siteverify.action-mismatch"
  | "siteverify.hostname-mismatch"
  | "siteverify.http-error"
  | "siteverify.invalid-response"
  | "siteverify.network-error"
  | "siteverify.rejected"
  | "siteverify.unknown"
  | `siteverify.${SiteverifyErrorCode}`;

export interface TurnstileVerification {
  action: TurnstileAction;
  hostname: string;
}

interface TurnstileVerifierOptions {
  environment: Env["APP_ENV"];
  fetcher?: typeof fetch;
  hostnames: string;
  secret: string;
}

export class TurnstileVerificationError extends Error {
  readonly failureCode: TurnstileFailureCode;

  constructor(failureCode: TurnstileFailureCode = "input.invalid") {
    super("The security check could not be verified.");
    this.name = "TurnstileVerificationError";
    this.failureCode = failureCode;
  }
}

function siteverifyErrorCode(
  value: unknown,
): SiteverifyErrorCode | "unknown" | undefined {
  if (!Array.isArray(value)) return undefined;
  const known = value.find(
    (code): code is SiteverifyErrorCode =>
      typeof code === "string" &&
      siteverifyErrorCodes.has(code as SiteverifyErrorCode),
  );
  return known ?? (value.length > 0 ? "unknown" : undefined);
}

function parseResponse(value: unknown): SiteverifyResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const response = value as Record<string, unknown>;
  const errorCode = siteverifyErrorCode(response["error-codes"]);
  return {
    ...(typeof response.action === "string" ? { action: response.action } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(typeof response.hostname === "string"
      ? { hostname: response.hostname }
      : {}),
    ...(typeof response.success === "boolean"
      ? { success: response.success }
      : {}),
  };
}

export function turnstileHostnames(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(",")
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function validTurnstileConfiguration(environment: Env): boolean {
  const hostnames = turnstileHostnames(environment.TURNSTILE_HOSTNAMES);
  return (
    Boolean(environment.TURNSTILE_SECRET) &&
    Boolean(environment.TURNSTILE_SITE_KEY) &&
    !environment.TURNSTILE_SITE_KEY.startsWith("CONFIGURE_") &&
    hostnames.size > 0 &&
    (environment.APP_ENV !== productionEnvironment ||
      (!hostnames.has("localhost") && !hostnames.has("127.0.0.1")))
  );
}

export class TurnstileVerifier {
  readonly #environment: Env["APP_ENV"];
  readonly #fetcher: typeof fetch;
  readonly #hostnames: ReadonlySet<string>;
  readonly #secret: string;

  constructor(options: TurnstileVerifierOptions) {
    this.#environment = options.environment;
    this.#fetcher = options.fetcher ?? fetch;
    this.#hostnames = turnstileHostnames(options.hostnames);
    this.#secret = options.secret;
  }

  async verify(
    token: string,
    expectedAction: TurnstileAction,
    remoteIp: string | null,
  ): Promise<TurnstileVerification> {
    if (
      !this.#secret ||
      token.length < 1 ||
      token.length > 2_048 ||
      this.#hostnames.size === 0 ||
      (this.#environment === productionEnvironment &&
        (this.#hostnames.has("localhost") || this.#hostnames.has("127.0.0.1")))
    ) {
      throw new TurnstileVerificationError("input.invalid");
    }

    const body = new URLSearchParams({
      idempotency_key: crypto.randomUUID(),
      response: token,
      secret: this.#secret,
    });
    if (remoteIp) {
      body.set("remoteip", remoteIp);
    }

    let response: Response;
    try {
      response = await this.#fetcher(siteverifyEndpoint, {
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new TurnstileVerificationError("siteverify.network-error");
    }

    let payload: SiteverifyResponse | null;
    try {
      payload = parseResponse(await response.json());
    } catch {
      throw new TurnstileVerificationError("siteverify.invalid-response");
    }
    const hostname = payload?.hostname?.toLowerCase();
    if (!response.ok) {
      throw new TurnstileVerificationError("siteverify.http-error");
    }
    if (payload?.success !== true) {
      throw new TurnstileVerificationError(
        payload?.errorCode
          ? `siteverify.${payload.errorCode}`
          : "siteverify.rejected",
      );
    }
    if (payload.action !== expectedAction) {
      throw new TurnstileVerificationError("siteverify.action-mismatch");
    }
    if (!hostname || !this.#hostnames.has(hostname)) {
      throw new TurnstileVerificationError("siteverify.hostname-mismatch");
    }

    return { action: expectedAction, hostname };
  }
}
