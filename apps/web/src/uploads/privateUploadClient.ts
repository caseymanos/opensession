import {
  uploadFinalizeResponseSchema,
  uploadIntentRequestSchema,
  uploadIntentResponseSchema,
  type UploadContentType,
  type UploadPurpose,
} from "@sessionbox-killer/contracts";

import { readCsrfToken } from "../auth/authClient";

type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class PrivateUploadApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "PrivateUploadApiError";
    this.code = code;
    this.status = status;
  }
}

export class PrivateUploadFinalizeError extends PrivateUploadApiError {
  readonly fileId: string;

  constructor(fileId: string, cause: PrivateUploadApiError) {
    super(cause.code, cause.message, cause.status);
    this.name = "PrivateUploadFinalizeError";
    this.fileId = fileId;
  }
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseError(response: Response, body: unknown) {
  const candidate =
    body && typeof body === "object" && "error" in body
      ? (body.error as Record<string, unknown> | null)
      : null;
  return new PrivateUploadApiError(
    typeof candidate?.code === "string"
      ? candidate.code
      : "invalid_upload_response",
    typeof candidate?.message === "string"
      ? candidate.message
      : "The upload service returned an invalid response.",
    response.status,
  );
}

function csrfToken(reader: () => string | null): string {
  const token = reader();
  if (!token) {
    throw new PrivateUploadApiError(
      "missing_csrf",
      "Refresh the page before uploading a file.",
      0,
    );
  }
  return token;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function fileChecksum(file: File): Promise<string> {
  return bytesToHex(
    await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
  );
}

export interface PrivateUploadInput {
  readonly eventId: string;
  readonly file: File;
  readonly organizationId: string;
  readonly ownerContactId: string;
  readonly purpose: UploadPurpose;
  readonly replacesFileId?: string;
}

export type UploadTransport = (
  url: string,
  headers: Readonly<Record<string, string>>,
  file: File,
  onProgress: (progress: number) => void,
) => Promise<void>;

function browserUpload(
  url: string,
  headers: Readonly<Record<string, string>>,
  file: File,
  onProgress: (progress: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.withCredentials = true;
    Object.entries(headers).forEach(([name, value]) =>
      request.setRequestHeader(name, value),
    );
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else {
        reject(
          new PrivateUploadApiError(
            "upload_failed",
            "The file upload did not finish. Try again.",
            request.status,
          ),
        );
      }
    });
    request.addEventListener("error", () =>
      reject(
        new PrivateUploadApiError(
          "upload_failed",
          "The file upload did not finish. Check your connection and try again.",
          0,
        ),
      ),
    );
    request.addEventListener("abort", () =>
      reject(
        new PrivateUploadApiError(
          "upload_failed",
          "The file upload was canceled before it finished.",
          0,
        ),
      ),
    );
    request.send(file);
  });
}

export interface PreparedPrivateUpload {
  readonly fileId: string;
  readonly version: number;
}

export async function finalizePrivateUpload(
  fileId: string,
  fetcher: Fetch = window.fetch.bind(window),
  csrfReader: () => string | null = () => readCsrfToken(document.cookie),
): Promise<PreparedPrivateUpload> {
  return finalizePrivateUploadRequest(fileId, fetcher, csrfReader, false);
}

async function finalizePrivateUploadRequest(
  fileId: string,
  fetcher: Fetch,
  csrfReader: () => string | null,
  retryCsrf: boolean,
): Promise<PreparedPrivateUpload> {
  const response = await fetcher(
    `/api/uploads/${encodeURIComponent(fileId)}/finalize`,
    {
      body: "{}",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken(csrfReader),
      },
      method: "POST",
    },
  );
  const body = await json(response);
  if (!response.ok) {
    const error = responseError(response, body);
    if (!retryCsrf && error.code === "invalid_csrf") {
      return finalizePrivateUploadRequest(fileId, fetcher, csrfReader, true);
    }
    throw error;
  }
  const finalized = uploadFinalizeResponseSchema.safeParse(body);
  if (!finalized.success) throw responseError(response, body);
  return { fileId: finalized.data.id, version: finalized.data.version };
}

export async function preparePrivateUpload(
  input: PrivateUploadInput,
  onProgress: (progress: number) => void,
  fetcher: Fetch = window.fetch.bind(window),
  csrfReader: () => string | null = () => readCsrfToken(document.cookie),
  upload: UploadTransport = browserUpload,
): Promise<PreparedPrivateUpload> {
  const checksum = await fileChecksum(input.file);
  const request = uploadIntentRequestSchema.parse({
    byte_size: input.file.size,
    checksum_sha256: checksum,
    content_type: input.file.type as UploadContentType,
    event_id: input.eventId,
    filename: input.file.name,
    organization_id: input.organizationId,
    owner_contact_id: input.ownerContactId,
    purpose: input.purpose,
    ...(input.replacesFileId ? { replaces_file_id: input.replacesFileId } : {}),
  });
  return preparePrivateUploadRequest(
    input,
    request,
    onProgress,
    fetcher,
    csrfReader,
    upload,
    false,
  );
}

async function preparePrivateUploadRequest(
  input: PrivateUploadInput,
  request: ReturnType<typeof uploadIntentRequestSchema.parse>,
  onProgress: (progress: number) => void,
  fetcher: Fetch,
  csrfReader: () => string | null,
  upload: UploadTransport,
  retryCsrf: boolean,
): Promise<PreparedPrivateUpload> {
  const intentResponse = await fetcher("/api/uploads/intents", {
    body: JSON.stringify(request),
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken(csrfReader),
    },
    method: "POST",
  });
  const intentBody = await json(intentResponse);
  if (!intentResponse.ok) {
    const error = responseError(intentResponse, intentBody);
    if (!retryCsrf && error.code === "invalid_csrf") {
      return preparePrivateUploadRequest(
        input,
        request,
        onProgress,
        fetcher,
        csrfReader,
        upload,
        true,
      );
    }
    throw error;
  }
  const intent = uploadIntentResponseSchema.safeParse(intentBody);
  if (!intent.success) throw responseError(intentResponse, intentBody);
  await upload(
    intent.data.upload.url,
    intent.data.upload.headers,
    input.file,
    onProgress,
  );
  onProgress(100);
  try {
    return await finalizePrivateUpload(
      intent.data.file.id,
      fetcher,
      csrfReader,
    );
  } catch (error) {
    throw new PrivateUploadFinalizeError(
      intent.data.file.id,
      error instanceof PrivateUploadApiError
        ? error
        : new PrivateUploadApiError(
            "finalize_failed",
            "The file arrived, but processing did not finish.",
            0,
          ),
    );
  }
}
