import { describe, expect, it, vi } from "vitest";

import {
  preparePrivateUpload,
  type PrivateUploadFinalizeError,
} from "./privateUploadClient";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("private upload client", () => {
  it("keeps checksum, CSRF, progress, and opaque finalize receipts contract-shaped", async () => {
    const checksum = "a".repeat(64);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            file: {
              id: "file_headshot_ready",
              lineage_id: "file_headshot_ready",
              status: "pending",
              version: 1,
            },
            upload: {
              expires_at: "2026-08-10T18:05:00.000Z",
              headers: {
                "Content-Type": "image/png",
                "X-Content-SHA256": checksum,
                "X-Upload-Token": "opaque-upload-capability",
              },
              method: "PUT",
              url: "/api/uploads/file_headshot_ready/content",
            },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        json({
          byte_size: 12,
          checksum_sha256: checksum,
          content_type: "image/png",
          detected_content_type: "image/png",
          id: "file_headshot_ready",
          status: "ready",
          version: 1,
        }),
      );
    const transport = vi
      .fn()
      .mockImplementation(
        (
          _url: string,
          _headers: Readonly<Record<string, string>>,
          _file: File,
          onProgress: (progress: number) => void,
        ) => {
          onProgress(50);
          return Promise.resolve();
        },
      );
    const progress = vi.fn();
    const file = new File(["valid png"], "headshot.png", {
      type: "image/png",
    });

    await expect(
      preparePrivateUpload(
        {
          eventId: "event_summit",
          file,
          organizationId: "organization_one",
          ownerContactId: "contact_speaker",
          purpose: "headshot",
        },
        progress,
        fetcher,
        () => "csrf-upload-token",
        transport,
      ),
    ).resolves.toEqual({ fileId: "file_headshot_ready", version: 1 });
    const intentRequest = JSON.parse(
      String(fetcher.mock.calls[0]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(intentRequest).toMatchObject({
      event_id: "event_summit",
      organization_id: "organization_one",
      owner_contact_id: "contact_speaker",
      purpose: "headshot",
    });
    expect(intentRequest.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      "X-CSRF-Token": "csrf-upload-token",
    });
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      "X-CSRF-Token": "csrf-upload-token",
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(50);
    expect(progress).toHaveBeenLastCalledWith(100);
  });

  it("preserves the finalized file ID when processing must be retried", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          {
            file: {
              id: "file_slides_pending",
              lineage_id: "file_slides_pending",
              status: "pending",
              version: 1,
            },
            upload: {
              expires_at: "2026-08-10T18:05:00.000Z",
              headers: {
                "Content-Type": "application/pdf",
                "X-Content-SHA256": "a".repeat(64),
                "X-Upload-Token": "upload-token",
              },
              method: "PUT",
              url: "/api/uploads/file_slides_pending/content",
            },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        json(
          {
            error: {
              code: "file_not_uploaded",
              message: "Processing is not finished.",
            },
          },
          409,
        ),
      );
    const transport = vi.fn().mockResolvedValue(undefined);
    const file = new File(["%PDF-1.7"], "slides.pdf", {
      type: "application/pdf",
    });

    await expect(
      preparePrivateUpload(
        {
          eventId: "event_summit",
          file,
          organizationId: "organization_one",
          ownerContactId: "contact_speaker",
          purpose: "slides",
        },
        () => undefined,
        fetcher,
        () => "csrf-task-token",
        transport,
      ),
    ).rejects.toMatchObject({
      code: "file_not_uploaded",
      fileId: "file_slides_pending",
    } satisfies Partial<PrivateUploadFinalizeError>);
    expect(transport).toHaveBeenCalledOnce();
  });
});
