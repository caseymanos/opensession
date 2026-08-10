import type { EmailMessage } from "@sessionbox-killer/email";
import { Resend } from "resend";

export interface EmailProviderSendInput {
  readonly idempotencyKey: string;
  readonly message: EmailMessage;
  readonly tags: Readonly<Record<string, string>>;
}

export type EmailProviderSendResult =
  | { readonly outcome: "sent"; readonly providerMessageId: string }
  | { readonly errorCode: string; readonly outcome: "failed" | "retry" };

export interface EmailDeliveryProvider {
  send(input: EmailProviderSendInput): Promise<EmailProviderSendResult>;
}

const retryableErrors = new Set([
  "application_error",
  "concurrent_idempotent_requests",
  "internal_server_error",
  "rate_limit_exceeded",
]);

function safeErrorCode(value: string): string {
  return /^[A-Za-z][A-Za-z0-9._-]{0,79}$/.test(value)
    ? value
    : "provider_error";
}

export class ResendEmailDeliveryProvider implements EmailDeliveryProvider {
  readonly #client: Resend;

  constructor(apiKey: string, client = new Resend(apiKey)) {
    if (!apiKey.startsWith("re_") || apiKey.length < 12) {
      throw new TypeError("RESEND_API_KEY is not configured.");
    }
    this.#client = client;
  }

  async send(input: EmailProviderSendInput): Promise<EmailProviderSendResult> {
    try {
      const result = await this.#client.emails.send(
        {
          from: input.message.from,
          html: input.message.html,
          replyTo: input.message.replyTo,
          subject: input.message.subject,
          tags: Object.entries(input.tags).map(([name, value]) => ({
            name,
            value,
          })),
          text: input.message.text,
          to: [...input.message.to],
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (result.error) {
        return {
          errorCode: safeErrorCode(result.error.name),
          outcome:
            retryableErrors.has(result.error.name) ||
            (result.error.statusCode !== null && result.error.statusCode >= 500)
              ? "retry"
              : "failed",
        };
      }
      return { outcome: "sent", providerMessageId: result.data.id };
    } catch {
      return { errorCode: "provider_unreachable", outcome: "retry" };
    }
  }
}
