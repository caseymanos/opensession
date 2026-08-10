import {
  createSeedEmailTemplates,
  emailTemplateDraft,
  emailTemplateVersionId,
  type EmailTemplateWorkspace,
} from "@sessionbox-killer/email";
import { describe, expect, it, vi } from "vitest";

import {
  createEmailTemplatePort,
  EmailTemplateApiError,
} from "./emailTemplateClient";
import { emailTemplateEventKey } from "./emailTemplateRoute";

const template = createSeedEmailTemplates({
  createdAt: "2026-08-10T20:00:00.000Z",
  eventId: "event_ai_engineer_summit",
  replyTo: "program@example.test",
  sender: { address: "updates@example.test", name: "OpenSession" },
})[0];
if (!template) throw new Error("Missing email template test seed.");

const workspace: EmailTemplateWorkspace = {
  event: {
    id: "event_ai_engineer_summit",
    name: "AI Engineer Summit",
    slug: "ai-engineer-summit",
  },
  mergeFields: [{ name: "event.name", type: "text" }],
  recipients: [
    {
      email: "mina@example.test",
      id: "contact_mina_okafor",
      name: "Mina Okafor",
      roles: ["speaker"],
    },
  ],
  templates: [{ sourceVersion: 7, template }],
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("email-template HTTP client", () => {
  it("parses canonical and fixture routes without accepting unsafe keys", () => {
    expect(
      emailTemplateEventKey("/app/ai-engineer-summit/communications"),
    ).toBe("ai-engineer-summit");
    expect(emailTemplateEventKey("/fixtures/email-templates/default")).toBe(
      "ai-engineer-summit",
    );
    expect(emailTemplateEventKey("/app/%2Fetc/communications")).toBeNull();
    expect(emailTemplateEventKey("/app/x/communications")).toBeNull();
    expect(emailTemplateEventKey("/app/event/other")).toBeNull();
  });

  it("validates the complete workspace contract", async () => {
    const fetcher = vi.fn(async () => response(workspace));
    const port = createEmailTemplatePort(
      "ai-engineer-summit",
      fetcher,
      () => "csrf",
    );

    await expect(port.read()).resolves.toEqual(workspace);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/events/ai-engineer-summit/email-templates",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("sends strict preview contracts and preserves exact validation issues", async () => {
    const fetcher = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      response(
        {
          issues: [
            {
              code: "unknown_field",
              location: "subject",
              message: "Unknown merge field recipient.nickname.",
              offset: 8,
            },
          ],
          ok: false,
          resolvedFields: [],
          source: { kind: "seed" },
        },
        422,
      ),
    );
    const port = createEmailTemplatePort("event_id", fetcher, () => "csrf");

    await expect(
      port.preview({
        baseTemplateId: template.id,
        source: { kind: "seed" },
        template: emailTemplateDraft(template),
      }),
    ).resolves.toMatchObject({
      issues: [{ code: "unknown_field", location: "subject", offset: 8 }],
      ok: false,
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      baseTemplateId: template.id,
      source: { kind: "seed" },
    });
  });

  it("requires CSRF and validates an immutable command result", async () => {
    const fetcher = vi.fn(async () =>
      response({
        ok: true,
        result: {
          projection: "durable",
          record: {
            sourceVersion: 1,
            template: {
              ...template,
              id: emailTemplateVersionId(template.id, 2),
              version: 2,
            },
          },
          replayed: false,
        },
      }),
    );
    const port = createEmailTemplatePort("event_id", fetcher, () => "csrf");
    const result = await port.execute({
      baseTemplateId: template.id,
      commandId: "email_template_command",
      expectedSourceVersion: 7,
      template: emailTemplateDraft(template),
      type: "create_revision",
    });

    expect(result.record.template.id).toBe(
      emailTemplateVersionId(template.id, 2),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/events/event_id/email-templates/commands",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf" }),
        method: "POST",
      }),
    );
  });

  it("fails closed before mutation when the CSRF cookie is absent", async () => {
    const fetcher = vi.fn();
    const port = createEmailTemplatePort("event_id", fetcher, () => null);
    const error = await port
      .execute({
        baseTemplateId: template.id,
        commandId: "email_template_command",
        expectedSourceVersion: 7,
        source: { kind: "seed" },
        template: emailTemplateDraft(template),
        type: "activate_version",
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(EmailTemplateApiError);
    expect(error).toMatchObject({ code: "missing_csrf", status: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
