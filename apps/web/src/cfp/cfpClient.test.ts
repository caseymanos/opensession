import { afterEach, describe, expect, it, vi } from "vitest";

import { publishCfpForm, readCfpForm } from "./cfpClient";

const formResponse = {
  diagnostics: [],
  event: {
    cfpClosesAt: "2099-01-01T00:00:00.000Z",
    id: "event_cfp",
    name: "CFP Event",
    slug: "cfp-event",
    timezone: "UTC",
  },
  form: {
    editAfterClose: false,
    fields: [
      {
        helpText: "",
        id: "field_title",
        key: "title",
        label: "Title",
        options: [],
        order: 1,
        required: true,
        rules: [],
        type: "short_text",
        validation: {},
      },
    ],
    id: "form_cfp_v2",
    name: "Call for proposals",
    publishedAt: null,
    sourceVersion: 3,
    status: "draft",
    submissionLimit: null,
    version: 2,
    welcomeContent: "Welcome",
  },
  publicUrl: "/e/cfp-event/cfp",
  publishedVersion: 1,
  publishable: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CFP form client", () => {
  it("parses authoritative reads without exposing response metadata", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(formResponse));
    await expect(readCfpForm(fetcher, "cfp-event")).resolves.toEqual(
      formResponse,
    );
    expect(fetcher).toHaveBeenCalledWith("/api/events/cfp-event/cfp/form", {
      credentials: "same-origin",
    });
  });

  it("binds publish idempotency and optimistic concurrency to one command", async () => {
    vi.stubGlobal("document", {
      cookie: "__Host-opensession-csrf=csrf-token-for-cfp-form-test",
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        outcome: "applied",
        result: {
          ...formResponse,
          form: {
            ...formResponse.form,
            publishedAt: "2026-08-10T12:00:00.000Z",
            sourceVersion: 4,
            status: "published",
          },
          publishedVersion: 2,
          publishable: false,
        },
      }),
    );
    await publishCfpForm(fetcher, "cfp-event", {
      commandId: "publish_cfp_v2",
      expectedFormId: "form_cfp_v2",
      expectedSourceVersion: 3,
    });
    const request = fetcher.mock.calls[0]?.[1];
    expect(request).toMatchObject({ method: "POST" });
    expect(new Headers(request?.headers)).toMatchObject({});
    expect(new Headers(request?.headers).get("Idempotency-Key")).toBe(
      "publish_cfp_v2",
    );
    expect(new Headers(request?.headers).get("If-Match")).toBe(
      '"cfp-form:form_cfp_v2:3"',
    );
    expect(new Headers(request?.headers).get("X-CSRF-Token")).toBe(
      "csrf-token-for-cfp-form-test",
    );
  });

  it("returns precise validation diagnostics from rejected mutations", async () => {
    vi.stubGlobal("document", {
      cookie: "__Host-opensession-csrf=csrf-token-for-cfp-form-test",
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            code: "cfp_form_validation",
            diagnostics: [
              {
                code: "missing_source",
                fieldId: "field_title",
                fieldKey: "title",
                message: "The condition references a missing field.",
                path: "fields.field_title.rules.rule_title",
                ruleId: "rule_title",
              },
            ],
            message: "Resolve the CFP form diagnostics before publishing.",
          },
        },
        { status: 422 },
      ),
    );
    await expect(
      publishCfpForm(fetcher, "cfp-event", {
        commandId: "publish_invalid_cfp_v2",
        expectedFormId: "form_cfp_v2",
        expectedSourceVersion: 3,
      }),
    ).rejects.toMatchObject({
      code: "cfp_form_validation",
      diagnostics: [
        expect.objectContaining({
          fieldId: "field_title",
          ruleId: "rule_title",
        }),
      ],
      status: 422,
    });
  });
});
