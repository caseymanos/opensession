import type {
  CampaignConfirmRequest,
  CampaignPreviewResponse,
  CampaignWorkspace,
} from "@sessionbox-killer/email";
import { describe, expect, it, vi } from "vitest";

import { CampaignApiError, createCampaignPort } from "./campaignClient";
import { campaignEventKey } from "./campaignRoute";

const hash = "a".repeat(64);
const workspace: CampaignWorkspace = {
  campaigns: [],
  deliveryMode: "allowlist",
  event: { id: "event_demo", name: "Demo", slug: "demo-event" },
  templates: [
    {
      audience: "speaker",
      id: "template_demo",
      internalName: "Speaker update",
      sender: { address: "updates@example.test", name: "OpenSession" },
      subject: "Hello {{recipient.first_name}}",
      version: 3,
    },
  ],
};
const preview: CampaignPreviewResponse = {
  audience: {
    excludedByReason: [{ count: 1, reason: "manual" }],
    excludedCount: 1,
    includedCount: 1,
    samples: [
      {
        contactId: "contact_demo",
        displayName: "Demo Speaker",
        email: "speaker@example.test",
      },
    ],
    totalCandidates: 2,
  },
  createdAt: "2026-08-10T20:00:00.000Z",
  expiresAt: "2026-08-10T20:15:00.000Z",
  filter: {
    portalStates: ["active"],
    readiness: "all",
    roles: ["speaker"],
  },
  previewId: `campaign_preview_${hash}`,
  schedule: { mode: "now" },
  sender: { address: "updates@example.test", name: "OpenSession" },
  template: {
    audience: "speaker",
    id: "template_demo",
    internalName: "Speaker update",
    subject: "Hello {{recipient.first_name}}",
    version: 3,
  },
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("campaign HTTP client", () => {
  it("parses only campaign workspace routes", () => {
    expect(campaignEventKey("/app/demo-event/communications")).toBe(
      "demo-event",
    );
    expect(campaignEventKey("/fixtures/campaigns/default")).toBe(
      "ai-engineer-summit",
    );
    expect(
      campaignEventKey("/app/demo-event/communications/templates"),
    ).toBeNull();
    expect(campaignEventKey("/app/%2Fetc/communications")).toBeNull();
  });

  it("validates workspace and exact preview contracts", async () => {
    const fetcher = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(response(workspace))
      .mockResolvedValueOnce(response(preview));
    const port = createCampaignPort("demo-event", fetcher, () => "csrf");

    await expect(port.read()).resolves.toEqual(workspace);
    await expect(
      port.preview({
        filter: preview.filter,
        schedule: preview.schedule,
        templateId: preview.template.id,
      }),
    ).resolves.toEqual(preview);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });

  it("requires CSRF before confirmation and sends no recipient content", async () => {
    const fetcher = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      response({
        campaignId: "campaign_demo",
        messages: { alreadyQueued: 0, queued: 1, suppressed: 0, total: 1 },
        projection: "durable",
        replayed: false,
        scheduledAt: preview.createdAt,
      }),
    );
    const request: CampaignConfirmRequest = {
      commandId: "campaign_command_demo",
      filter: preview.filter,
      previewCreatedAt: preview.createdAt,
      previewId: preview.previewId,
      schedule: preview.schedule,
      templateId: preview.template.id,
    };
    const blocked = createCampaignPort("demo-event", fetcher, () => null);
    const error = await blocked.confirm(request).catch((cause) => cause);
    expect(error).toBeInstanceOf(CampaignApiError);
    expect(fetcher).not.toHaveBeenCalled();

    const port = createCampaignPort("demo-event", fetcher, () => "csrf");
    await expect(port.confirm(request)).resolves.toMatchObject({
      campaignId: "campaign_demo",
    });
    const serialized = String(fetcher.mock.calls[0]?.[1]?.body);
    expect(serialized).not.toContain("speaker@example.test");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      "X-CSRF-Token": "csrf",
    });
  });
});
