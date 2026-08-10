import type {
  UploadContentType,
  UploadIntentRequest,
  UploadPurpose,
} from "@sessionbox-killer/contracts";

export type DetectedUploadContentType =
  | "application/pdf"
  | "application/zip"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

interface UploadPolicy {
  readonly contentTypes: readonly UploadContentType[];
  readonly maxBytes: number;
}

const mebibyte = 1024 * 1024;

const uploadPolicies: Record<UploadPurpose, UploadPolicy> = {
  headshot: {
    contentTypes: ["image/jpeg", "image/png", "image/webp"],
    maxBytes: 8 * mebibyte,
  },
  resource: {
    contentTypes: ["application/pdf"],
    maxBytes: 25 * mebibyte,
  },
  slides: {
    contentTypes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    maxBytes: 50 * mebibyte,
  },
  submission_attachment: {
    contentTypes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "image/jpeg",
      "image/png",
      "image/webp",
    ],
    maxBytes: 25 * mebibyte,
  },
  task_attachment: {
    contentTypes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "image/jpeg",
      "image/png",
      "image/webp",
    ],
    maxBytes: 25 * mebibyte,
  },
};

const extensions: Record<UploadContentType, readonly string[]> = {
  "application/pdf": ["pdf"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [
    "pptx",
  ],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
};

export function uploadPolicyError(
  input: Pick<
    UploadIntentRequest,
    "byte_size" | "content_type" | "filename" | "purpose"
  >,
):
  "file_too_large" | "invalid_file_extension" | "unsupported_file_type" | null {
  const policy = uploadPolicies[input.purpose];
  if (input.byte_size > policy.maxBytes) {
    return "file_too_large";
  }
  if (!policy.contentTypes.includes(input.content_type)) {
    return "unsupported_file_type";
  }

  const extension = input.filename.split(".").at(-1)?.toLowerCase();
  return extension && extensions[input.content_type].includes(extension)
    ? null
    : "invalid_file_extension";
}

function beginsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function detectUploadContentType(
  bytes: Uint8Array,
): DetectedUploadContentType | null {
  if (beginsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (beginsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (
    beginsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    beginsWith(bytes.slice(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  if (beginsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf";
  }
  if (
    beginsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    beginsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    beginsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "application/zip";
  }
  return null;
}

export function detectedTypeMatchesDeclaration(
  declared: UploadContentType,
  detected: DetectedUploadContentType | null,
): detected is DetectedUploadContentType {
  if (
    declared ===
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return detected === "application/zip";
  }
  return detected === declared;
}

export function safeAttachmentDisposition(filename: string): string {
  const normalized = filename
    .normalize("NFC")
    .toWellFormed()
    .replaceAll(/[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, "_");
  const fallback = normalized
    .replaceAll(/[^A-Za-z0-9._ -]/g, "_")
    .replaceAll('"', "_")
    .slice(0, 120);
  const encoded = encodeURIComponent(normalized).replaceAll(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback || "download"}"; filename*=UTF-8''${encoded}`;
}

export function purposeRequiresOwner(purpose: UploadPurpose): boolean {
  return purpose !== "resource";
}
