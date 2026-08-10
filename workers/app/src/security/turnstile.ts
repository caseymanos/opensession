import type { TurnstileAction } from "@sessionbox-killer/contracts";

const siteverifyEndpoint =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const productionEnvironment = "production";

interface SiteverifyResponse {
  action?: string;
  hostname?: string;
  success?: boolean;
}

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
  constructor() {
    super("The security check could not be verified.");
    this.name = "TurnstileVerificationError";
  }
}

function parseResponse(value: unknown): SiteverifyResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const response = value as Record<string, unknown>;
  return {
    ...(typeof response.action === "string" ? { action: response.action } : {}),
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
      throw new TurnstileVerificationError();
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
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new TurnstileVerificationError();
    }

    let payload: SiteverifyResponse | null;
    try {
      payload = parseResponse(await response.json());
    } catch {
      throw new TurnstileVerificationError();
    }
    const hostname = payload?.hostname?.toLowerCase();
    if (
      !response.ok ||
      payload?.success !== true ||
      payload.action !== expectedAction ||
      !hostname ||
      !this.#hostnames.has(hostname)
    ) {
      throw new TurnstileVerificationError();
    }

    return { action: expectedAction, hostname };
  }
}
