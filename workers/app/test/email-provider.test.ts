import type { EmailMessage } from "@sessionbox-killer/email";
import type { Resend } from "resend";
import { describe, expect, it } from "vitest";

import {
  ResendEmailDeliveryProvider,
  type EmailProviderSendInput,
} from "../src/email/provider";

const message: EmailMessage = {
  from: "OpenSession <auth@example.test>",
  html: "<p>Hello</p>",
  replyTo: "hello@example.test",
  subject: "Welcome",
  text: "Hello",
  to: ["speaker@example.test"],
};

const input: EmailProviderSendInput = {
  idempotencyKey: "email:delivery:fixture",
  message,
  tags: { event: "event_fixture", kind: "magic_link" },
};

function fakeResend(send: Resend["emails"]["send"]): Resend {
  return { emails: { send } } as unknown as Resend;
}

type ResendResponse = Awaited<ReturnType<Resend["emails"]["send"]>>;

function successResponse(id: string): ResendResponse {
  return { data: { id }, error: null, headers: null };
}

function errorResponse(
  name: string,
  statusCode: number | null,
): ResendResponse {
  return {
    data: null,
    error: {
      message: "recipient@example.test and private provider details",
      name,
      statusCode,
    },
    headers: null,
  } as ResendResponse;
}

describe("Resend email delivery provider contract", () => {
  it("sends the redacted message shape with stable tags and idempotency", async () => {
    let request:
      | {
          message: unknown;
          options: unknown;
        }
      | undefined;
    const provider = new ResendEmailDeliveryProvider(
      "re_fixture_key_123",
      fakeResend(async (sentMessage, options) => {
        request = { message: sentMessage, options };
        return successResponse("resend_fixture_message");
      }),
    );

    await expect(provider.send(input)).resolves.toEqual({
      outcome: "sent",
      providerMessageId: "resend_fixture_message",
    });
    expect(request).toEqual({
      message: {
        from: message.from,
        html: message.html,
        replyTo: message.replyTo,
        subject: message.subject,
        tags: [
          { name: "event", value: "event_fixture" },
          { name: "kind", value: "magic_link" },
        ],
        text: message.text,
        to: [...message.to],
      },
      options: { idempotencyKey: input.idempotencyKey },
    });
  });

  it.each([
    ["rate_limit_exceeded", null, "retry"],
    ["internal_server_error", 400, "retry"],
    ["provider_rejected", 400, "failed"],
    ["provider error with unsafe chars", 400, "failed"],
  ] as const)(
    "classifies provider error %s without leaking its message",
    async (name, statusCode, outcome) => {
      const provider = new ResendEmailDeliveryProvider(
        "re_fixture_key_123",
        fakeResend(async () => errorResponse(name, statusCode)),
      );

      await expect(provider.send(input)).resolves.toEqual({
        errorCode:
          name === "provider error with unsafe chars" ? "provider_error" : name,
        outcome,
      });
    },
  );

  it("retries an unreachable provider and rejects invalid credentials locally", async () => {
    const provider = new ResendEmailDeliveryProvider(
      "re_fixture_key_123",
      fakeResend(async () => {
        throw new Error("private network details");
      }),
    );

    await expect(provider.send(input)).resolves.toEqual({
      errorCode: "provider_unreachable",
      outcome: "retry",
    });
    expect(
      () => new ResendEmailDeliveryProvider("fixture_key_without_prefix"),
    ).toThrow("RESEND_API_KEY is not configured.");
  });
});
