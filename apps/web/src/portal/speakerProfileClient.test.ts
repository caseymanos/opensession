import { describe, expect, it, vi } from "vitest";

import type {
  SpeakerProfileResponse,
  SpeakerProfileSaveCommand,
} from "@sessionbox-killer/contracts";

import {
  readSpeakerProfile,
  saveSpeakerProfile,
  type SpeakerProfileApiError,
} from "./speakerProfileClient";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

const profile = {
  audit: [],
  fields: {
    bio: "Mina builds reliable systems.",
    bluesky_url: "",
    company: "Relay",
    display_name: "Mina Okafor",
    headshot_alt: "Portrait of Mina Okafor",
    linkedin_url: "https://www.linkedin.com/in/mina-okafor",
    pronouns: "she/her",
    title: "Principal engineer",
    website_url: "https://mina.example.com",
  },
  headshot: {
    alt: "Portrait of Mina Okafor",
    content_type: "image/png",
    file_name: "mina.png",
    id: "file_headshot_1",
    preview_url: "/api/portal/ai-engineer-summit/profile/headshot",
    status: "ready",
    version: 1,
  },
  policy: {
    accepted_content_types: ["image/jpeg", "image/png", "image/webp"],
    max_bytes: 8 * 1024 * 1024,
    min_height: 1200,
    min_width: 1200,
    scope: "organization",
  },
  publication_state: "draft",
  profile_id: "contact_mina",
  reuse_scope: "organization",
  updated_at: "2026-08-11T08:00:00.000Z",
  upload_context: {
    event_id: "event_summit",
    organization_id: "organization_one",
    owner_contact_id: "contact_mina",
    purpose: "headshot",
    replacement_file_id: "file_headshot_1",
  },
  version: 3,
} satisfies SpeakerProfileResponse;

const command = {
  command_id: "command_profile_1",
  expected_version: 3,
  fields: profile.fields,
  reuse_organization: true,
} satisfies SpeakerProfileSaveCommand;

describe("speaker profile client", () => {
  it("reads only a strict provider-neutral profile", async () => {
    const fetcher = vi.fn().mockResolvedValue(json(profile));
    await expect(
      readSpeakerProfile("ai-engineer-summit", fetcher),
    ).resolves.toEqual(profile);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/portal/ai-engineer-summit/profile",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    );

    fetcher.mockResolvedValueOnce(
      json({ ...profile, provider_id: "rec_private" }),
    );
    await expect(
      readSpeakerProfile("ai-engineer-summit", fetcher),
    ).rejects.toMatchObject({ code: "invalid_profile_response" });
  });

  it("retries a rotated CSRF token once without changing the command", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            error: { code: "invalid_csrf", message: "Refresh CSRF." },
            request_id: "request_1",
          },
          403,
        ),
      )
      .mockResolvedValueOnce(
        json({ ok: true, outcome: "applied", profile, projection: "durable" }),
      );
    const csrfReader = vi
      .fn()
      .mockReturnValueOnce("csrf-old")
      .mockReturnValueOnce("csrf-new");

    await expect(
      saveSpeakerProfile("ai-engineer-summit", command, fetcher, csrfReader),
    ).resolves.toMatchObject({ outcome: "applied", projection: "durable" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(command));
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(command));
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      "X-CSRF-Token": "csrf-old",
    });
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      "X-CSRF-Token": "csrf-new",
    });
  });

  it("treats a typed 202 as outcome unknown instead of success", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json(
        {
          error: {
            code: "profile_outcome_unknown",
            message: "Retry the same command.",
            retryable: true,
          },
          request_id: "request_unknown",
        },
        202,
      ),
    );

    await expect(
      saveSpeakerProfile("ai-engineer-summit", command, fetcher, () => "csrf"),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SpeakerProfileApiError>>({
        code: "profile_outcome_unknown",
        retryable: true,
        status: 202,
      }),
    );
  });
});
