export type EmailDeliveryMode = "allowlist" | "live" | "sink";

export interface EmailDeliveryConfig {
  readonly allowlist: readonly string[];
  readonly authFrom: string;
  readonly authReplyTo: string;
  readonly mode: EmailDeliveryMode;
}

const emailPattern =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const friendlyAddressPattern =
  /^(?:[^\r\n<>]{1,80} )?<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63})>$/;

function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 320 && emailPattern.test(normalized)
    ? normalized
    : null;
}

function validFrom(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 400) return false;
  return normalizeEmail(value) !== null || friendlyAddressPattern.test(value);
}

export function parseEmailDeliveryConfig(
  value: unknown,
  environment: Env["APP_ENV"],
): EmailDeliveryConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("EMAIL_DELIVERY_CONFIG must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.mode !== "allowlist" &&
    candidate.mode !== "live" &&
    candidate.mode !== "sink"
  ) {
    throw new TypeError("Email delivery mode is invalid.");
  }
  if (environment === "local" && candidate.mode !== "sink") {
    throw new TypeError("Local email delivery must use sink mode.");
  }
  if (environment === "preview" && candidate.mode !== "allowlist") {
    throw new TypeError("Preview email delivery must use allowlist mode.");
  }
  if (!validFrom(candidate.authFrom)) {
    throw new TypeError("Magic-link sender is invalid.");
  }
  if (
    typeof candidate.authReplyTo !== "string" ||
    normalizeEmail(candidate.authReplyTo) === null
  ) {
    throw new TypeError("Magic-link reply-to is invalid.");
  }
  if (!Array.isArray(candidate.allowlist)) {
    throw new TypeError("Email allowlist must be an array.");
  }
  const allowlist = candidate.allowlist.map((entry) => {
    if (typeof entry !== "string") {
      throw new TypeError("Email allowlist entries must be addresses.");
    }
    const normalized = normalizeEmail(entry);
    if (!normalized) {
      throw new TypeError("Email allowlist contains an invalid address.");
    }
    return normalized;
  });
  return {
    allowlist: [...new Set(allowlist)].sort(),
    authFrom: candidate.authFrom,
    authReplyTo: candidate.authReplyTo,
    mode: candidate.mode,
  };
}

export function isAllowlisted(
  config: EmailDeliveryConfig,
  address: string,
): boolean {
  return config.mode !== "allowlist"
    ? true
    : config.allowlist.includes(address.trim().toLowerCase());
}
