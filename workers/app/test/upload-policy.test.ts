import { describe, expect, it } from "vitest";

import { uploadIntentRequestSchema } from "@sessionbox-killer/contracts";

import {
  detectedTypeMatchesDeclaration,
  detectUploadContentType,
  safeAttachmentDisposition,
  uploadPolicyError,
} from "../src/uploads/policy";

describe("private upload policy", () => {
  it.each([
    [new Uint8Array([0xff, 0xd8, 0xff, 0x00]), "image/jpeg"],
    [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "image/png",
    ],
    [
      new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      ]),
      "image/webp",
    ],
    [new TextEncoder().encode("%PDF-1.7"), "application/pdf"],
    [new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "application/zip"],
  ] as const)("detects bounded magic bytes", (bytes, expected) => {
    expect(detectUploadContentType(bytes)).toBe(expected);
  });

  it("rejects executable markup and MIME or extension spoofing", () => {
    expect(
      detectUploadContentType(new TextEncoder().encode("<svg></svg>")),
    ).toBe(null);
    expect(detectedTypeMatchesDeclaration("image/png", "application/zip")).toBe(
      false,
    );
    expect(
      uploadPolicyError({
        byte_size: 512,
        content_type: "image/png",
        filename: "avatar.pdf",
        purpose: "headshot",
      }),
    ).toBe("invalid_file_extension");
    expect(
      uploadPolicyError({
        byte_size: 9 * 1024 * 1024,
        content_type: "image/png",
        filename: "avatar.png",
        purpose: "headshot",
      }),
    ).toBe("file_too_large");
  });

  it("encodes Unicode filenames without allowing header injection", () => {
    expect(safeAttachmentDisposition('Démo "deck".pdf')).toBe(
      "attachment; filename=\"D_mo _deck_.pdf\"; filename*=UTF-8''D%C3%A9mo%20%22deck%22.pdf",
    );
    expect(safeAttachmentDisposition("report\u202Efdp.exe.pdf")).not.toContain(
      "\u202E",
    );
    expect(() => safeAttachmentDisposition("\uD800.pdf")).not.toThrow();
    for (const filename of ["report\u202Efdp.exe.pdf", "\uD800.pdf"]) {
      expect(
        uploadIntentRequestSchema.safeParse({
          byte_size: 8,
          checksum_sha256: "a".repeat(64),
          content_type: "application/pdf",
          event_id: "evt_one",
          filename,
          organization_id: "org_one",
          purpose: "resource",
        }).success,
      ).toBe(false);
    }
  });
});
