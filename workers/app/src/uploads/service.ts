import type {
  UploadContentType,
  UploadIntentRequest,
  UploadPurpose,
} from "@sessionbox-killer/contracts";

import {
  hasEventPermission,
  loadEventAccess,
  type EventAccess,
} from "../auth/authorization";
import { createOpaqueToken, sha256Hex } from "../auth/crypto";
import type { AuthenticatedSession } from "../auth/service";
import {
  detectedTypeMatchesDeclaration,
  detectUploadContentType,
  purposeRequiresOwner,
  type DetectedUploadContentType,
  uploadPolicyError,
} from "./policy";
import type { D1QueryExecutor } from "../database.js";
import { isPptxArchive } from "./pptx";

const uploadCapabilityLifetimeMs = 5 * 60 * 1000;
const uploadCleanupGraceMs = 15 * 60 * 1000;
const uploadLeaseMs = 20 * 60 * 1000;
const eventQuotaBytes = 1024 * 1024 * 1024;
const activeIntentLimit = 5;
const maxUploadAttempts = 3;
const signatureSampleBytes = 4096;
const terminalReconciliationIntervalMs = 24 * 60 * 60 * 1000;

export type UploadErrorCode =
  | "file_not_found"
  | "file_not_uploaded"
  | "file_too_large"
  | "forbidden"
  | "invalid_file"
  | "invalid_file_extension"
  | "invalid_upload"
  | "mime_mismatch"
  | "quota_exceeded"
  | "replacement_conflict"
  | "unsupported_file_type"
  | "upload_expired"
  | "upload_in_progress"
  | "upload_rejected";

export class UploadError extends Error {
  readonly code: UploadErrorCode;

  constructor(code: UploadErrorCode, message: string) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

interface ReplacementRow {
  lineage_id: string | null;
  version_number: number;
}

interface UploadCapabilityRow {
  attempts: number;
  byte_size: number;
  checksum_sha256: string;
  cleanup_after: string;
  declared_mime_type: UploadContentType;
  event_id: string;
  expires_at: string;
  file_object_id: string;
  object_key: string;
  organization_id: string;
  purpose: UploadPurpose;
  status: "cleanup" | "issued" | "uploaded" | "uploading";
}

interface FileRow {
  byte_size: number;
  checksum_sha256: string;
  cleanup_after: string;
  declared_mime_type: UploadContentType;
  detected_mime_type: DetectedUploadContentType | null;
  display_filename: string;
  event_id: string;
  id: string;
  is_latest_ready_version: number;
  intent_status:
    | "cleanup"
    | "expired"
    | "failed"
    | "finalized"
    | "issued"
    | "uploaded"
    | "uploading";
  lease_expires_at: string | null;
  lineage_id: string;
  object_key: string;
  organization_id: string;
  owner_contact_id: string | null;
  purpose: UploadPurpose;
  r2_etag: string | null;
  r2_version: string | null;
  status: "deleted" | "pending" | "quarantined" | "ready";
  uploaded_by_user_id: string;
  version_number: number;
}

interface CleanupCandidate {
  file_object_id: string;
  intent_id: string;
  object_key: string;
}

export interface CreatedUploadIntent {
  readonly expiresAt: string;
  readonly fileId: string;
  readonly lineageId: string;
  readonly token: string;
  readonly version: number;
}

export interface StoredUpload {
  readonly etag: string;
  readonly fileId: string;
  readonly version: string;
}

export interface FinalizedUpload {
  readonly byteSize: number;
  readonly checksumSha256: string;
  readonly contentType: UploadContentType;
  readonly detectedContentType: DetectedUploadContentType;
  readonly id: string;
  readonly version: number;
}

export interface DownloadedUpload {
  readonly body: ReadableStream;
  readonly contentType: UploadContentType;
  readonly etag: string;
  readonly filename: string;
  readonly size: number;
}

export interface UploadServiceOptions {
  readonly bucket: R2Bucket;
  readonly database: D1QueryExecutor;
  readonly now?: () => Date;
  readonly tokenFactory?: () => string;
}

function isoAt(date: Date, deltaMs: number): string {
  return new Date(date.getTime() + deltaMs).toISOString();
}

function checksumToHex(checksum: string | undefined): string | null {
  if (!checksum) {
    return null;
  }
  if (/^[0-9a-f]{64}$/i.test(checksum)) {
    return checksum.toLowerCase();
  }
  try {
    const bytes = Uint8Array.from(atob(checksum), (character) =>
      character.charCodeAt(0),
    );
    return bytes.length === 32
      ? [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
      : null;
  } catch {
    return null;
  }
}

function metadataMatches(
  object: R2Object,
  row: UploadCapabilityRow | FileRow,
): boolean {
  const customMetadata = object.customMetadata;
  const fileId = "file_object_id" in row ? row.file_object_id : row.id;
  return (
    object.size === row.byte_size &&
    object.httpMetadata?.contentType === row.declared_mime_type &&
    customMetadata?.fileId === fileId &&
    customMetadata.organizationId === row.organization_id &&
    customMetadata.eventId === row.event_id &&
    customMetadata.purpose === row.purpose &&
    checksumToHex(object.checksums.toJSON().sha256) === row.checksum_sha256
  );
}

export class UploadService {
  readonly #bucket: R2Bucket;
  readonly #database: D1QueryExecutor;
  readonly #now: () => Date;
  readonly #tokenFactory: () => string;

  constructor(options: UploadServiceOptions) {
    this.#bucket = options.bucket;
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
    this.#tokenFactory = options.tokenFactory ?? (() => createOpaqueToken());
  }

  async createIntent(
    session: AuthenticatedSession,
    input: UploadIntentRequest,
  ): Promise<CreatedUploadIntent> {
    const policyError = uploadPolicyError(input);
    if (policyError) {
      throw new UploadError(policyError, "This file cannot be uploaded.");
    }

    const access = await loadEventAccess(
      this.#database,
      session.user,
      input.organization_id,
      input.event_id,
    );
    const ownerContactId = await this.#resolveOwner(input, access);
    const now = this.#now();
    const nowIso = now.toISOString();
    const fileId = crypto.randomUUID();
    const intentId = crypto.randomUUID();
    const token = this.#tokenFactory();
    const tokenHash = await sha256Hex(token);
    const replacement = input.replaces_file_id
      ? await this.#replacement(input, ownerContactId)
      : null;
    const lineageId =
      replacement?.lineage_id ?? input.replaces_file_id ?? fileId;
    const version = replacement ? replacement.version_number + 1 : 1;
    const objectKey = [
      "organizations",
      input.organization_id,
      "events",
      input.event_id,
      "files",
      lineageId,
      `v${version}`,
      fileId,
    ].join("/");
    const expiresAt = isoAt(now, uploadCapabilityLifetimeMs);
    const cleanupAfter = isoAt(now, uploadCleanupGraceMs);

    let inserted: D1Result[];
    try {
      inserted = await this.#database.batch([
        this.#database
          .prepare(
            `INSERT INTO file_objects
              (id, organization_id, event_id, owner_contact_id,
               uploaded_by_user_id, object_key, display_filename,
               declared_mime_type, byte_size, checksum_sha256, status,
               purpose, lineage_id, version_number, replaces_file_id,
               created_at, updated_at)
             SELECT
               ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending',
               ?11, ?12, ?13, ?14, ?15, ?15
             WHERE (
               SELECT COALESCE(SUM(existing.byte_size), 0)
               FROM file_objects existing
               WHERE existing.organization_id = ?2
                 AND existing.event_id = ?3
                 AND existing.status IN ('pending', 'ready')
             ) + ?9 <= ?16
               AND (
                 SELECT COUNT(*)
                 FROM file_objects active_file
                 WHERE active_file.uploaded_by_user_id = ?5
                   AND active_file.status = 'pending'
               ) < ?17`,
          )
          .bind(
            fileId,
            input.organization_id,
            input.event_id,
            ownerContactId,
            session.user.id,
            objectKey,
            input.filename.normalize("NFC"),
            input.content_type,
            input.byte_size,
            input.checksum_sha256,
            input.purpose,
            lineageId,
            version,
            input.replaces_file_id ?? null,
            nowIso,
            eventQuotaBytes,
            activeIntentLimit,
          ),
        this.#database
          .prepare(
            `INSERT INTO file_upload_intents
              (id, file_object_id, token_hash, status, expires_at,
               cleanup_after, created_at, updated_at)
             SELECT ?1, ?2, ?3, 'issued', ?4, ?5, ?6, ?6
             FROM file_objects WHERE id = ?2`,
          )
          .bind(intentId, fileId, tokenHash, expiresAt, cleanupAfter, nowIso),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("ux_file_objects_lineage_version") ||
          (error.message.includes("UNIQUE constraint failed") &&
            error.message.includes("file_objects.lineage_id") &&
            error.message.includes("file_objects.version_number")))
      ) {
        throw new UploadError(
          "replacement_conflict",
          "A newer file version already exists.",
        );
      }
      throw error;
    }

    if (inserted[0]?.meta.changes !== 1 || inserted[1]?.meta.changes !== 1) {
      throw new UploadError(
        "quota_exceeded",
        "The upload quota has been reached. Finalize or remove another upload and try again.",
      );
    }

    return { expiresAt, fileId, lineageId, token, version };
  }

  async store(
    fileId: string,
    token: string | null,
    headers: Headers,
    body: ReadableStream | null,
  ): Promise<StoredUpload> {
    if (!token || !body) {
      throw new UploadError("invalid_upload", "The upload is incomplete.");
    }
    const now = this.#now();
    const nowIso = now.toISOString();
    const tokenHash = await sha256Hex(token);
    const row = await this.#capability(fileId, tokenHash);
    if (!row || row.expires_at <= nowIso) {
      throw new UploadError("upload_expired", "The upload link has expired.");
    }
    if (row.attempts >= maxUploadAttempts) {
      throw new UploadError(
        "upload_rejected",
        "This upload capability has reached its retry limit.",
      );
    }

    const contentLength = headers.get("Content-Length") ?? "";
    const contentType = (headers.get("Content-Type") ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const checksum = headers.get("X-Content-SHA256") ?? "";
    if (
      !/^[1-9][0-9]*$/.test(contentLength) ||
      Number(contentLength) !== row.byte_size ||
      contentType !== row.declared_mime_type ||
      checksum !== row.checksum_sha256
    ) {
      throw new UploadError(
        "invalid_upload",
        "The upload headers do not match the authorized file.",
      );
    }

    const leaseId = crypto.randomUUID();
    const claimed = await this.#database
      .prepare(
        `UPDATE file_upload_intents
         SET status = 'uploading', lease_id = ?1, lease_expires_at = ?2,
             attempts = attempts + 1, updated_at = ?3
         WHERE file_object_id = ?4
           AND token_hash = ?5
           AND expires_at > ?3
           AND attempts < ?6
           AND (
             status = 'issued'
             OR (
               status = 'uploading'
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= ?3
             )
           )
         RETURNING attempts, id`,
      )
      .bind(
        leaseId,
        isoAt(now, uploadLeaseMs),
        nowIso,
        fileId,
        tokenHash,
        maxUploadAttempts,
      )
      .first<{ attempts: number; id: string }>();
    if (!claimed) {
      throw new UploadError(
        "upload_in_progress",
        "This upload has already been used or is still in progress.",
      );
    }

    let object: R2Object | null;
    try {
      object = await this.#bucket.put(row.object_key, body, {
        customMetadata: {
          checksumSha256: row.checksum_sha256,
          eventId: row.event_id,
          fileId: row.file_object_id,
          organizationId: row.organization_id,
          purpose: row.purpose,
        },
        httpMetadata: { contentType: row.declared_mime_type },
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: row.checksum_sha256,
      });
      if (!object) {
        const existing = await this.#bucket.head(row.object_key);
        object = existing && metadataMatches(existing, row) ? existing : null;
      }
    } catch {
      await this.#recordRejectedAttempt(row, claimed.attempts, leaseId, nowIso);
      throw new UploadError(
        "upload_rejected",
        "R2 rejected the file. Check its size and checksum, then try again.",
      );
    }

    if (!object || !metadataMatches(object, row)) {
      try {
        await this.#bucket.delete(row.object_key);
      } catch {
        throw new UploadError(
          "upload_rejected",
          "The invalid stored object is awaiting cleanup.",
        );
      }
      await this.#recordRejectedAttempt(row, claimed.attempts, leaseId, nowIso);
      throw new UploadError(
        "upload_rejected",
        "The stored object did not match the upload intent.",
      );
    }

    const completed = await this.#database
      .prepare(
        `UPDATE file_upload_intents
         SET status = 'uploaded', lease_id = NULL, lease_expires_at = NULL,
             uploaded_at = ?1, updated_at = ?1
         WHERE file_object_id = ?2
           AND status = 'uploading'
           AND lease_id = ?3`,
      )
      .bind(nowIso, fileId, leaseId)
      .run();
    if (completed.meta.changes !== 1) {
      try {
        await this.#bucket.delete(row.object_key);
      } catch {
        await this.#queueCleanup(
          row.file_object_id,
          "upload_completion_orphan",
          null,
          nowIso,
        );
      }
      throw new Error(
        "Upload state changed before R2 completion was recorded.",
      );
    }

    return { etag: object.httpEtag, fileId, version: object.version };
  }

  async finalize(
    session: AuthenticatedSession,
    fileId: string,
  ): Promise<FinalizedUpload> {
    let row = await this.#file(fileId);
    if (!row) {
      throw new UploadError("file_not_found", "The file does not exist.");
    }
    await this.#authorizeExisting(session, row, "write");

    if (row.status === "ready") {
      return this.#finalizedResult(row);
    }
    const nowIso = this.#now().toISOString();
    if (
      row.status !== "pending" ||
      row.cleanup_after <= nowIso ||
      row.intent_status !== "uploaded"
    ) {
      throw new UploadError(
        "file_not_uploaded",
        "Upload the file before finalizing it.",
      );
    }

    const object = await this.#bucket.head(row.object_key);
    if (!object || !metadataMatches(object, row)) {
      await this.#quarantine(
        row.id,
        row.object_key,
        "object_metadata_mismatch",
        null,
        nowIso,
      );
      throw new UploadError(
        "invalid_file",
        "The stored file did not match its upload intent.",
      );
    }

    const sample = await this.#bucket.get(row.object_key, {
      range: {
        length: Math.min(signatureSampleBytes, object.size),
        offset: 0,
      },
    });
    const detected = sample
      ? detectUploadContentType(new Uint8Array(await sample.arrayBuffer()))
      : null;
    const structureMatches =
      detectedTypeMatchesDeclaration(row.declared_mime_type, detected) &&
      (row.declared_mime_type !==
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
        (await isPptxArchive(this.#bucket, row.object_key, object.size)));
    if (!structureMatches) {
      await this.#quarantine(
        row.id,
        row.object_key,
        "mime_mismatch",
        detected,
        nowIso,
      );
      throw new UploadError(
        "mime_mismatch",
        "The file contents do not match the declared file type.",
      );
    }

    const finalized = await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE file_objects
           SET detected_mime_type = ?1, r2_version = ?2, r2_etag = ?3,
               status = 'ready', finalized_at = ?4, updated_at = ?4,
               last_error_code = NULL
           WHERE id = ?5
             AND status = 'pending'
             AND EXISTS (
               SELECT 1
               FROM file_upload_intents intent
               WHERE intent.file_object_id = ?5
                 AND intent.cleanup_after > ?4
                 AND intent.status = 'uploaded'
             )`,
        )
        .bind(detected, object.version, object.etag, nowIso, row.id),
      this.#database
        .prepare(
          `UPDATE file_upload_intents
           SET status = 'finalized', finalized_at = ?1, updated_at = ?1,
               lease_id = NULL, lease_expires_at = NULL
           WHERE file_object_id = ?2
             AND status = 'uploaded'
             AND cleanup_after > ?1
             AND EXISTS (
               SELECT 1
               FROM file_objects file
               WHERE file.id = ?2
                 AND file.status = 'ready'
                 AND file.detected_mime_type = ?3
                 AND file.r2_version = ?4
                 AND file.r2_etag = ?5
             )`,
        )
        .bind(nowIso, row.id, detected, object.version, object.etag),
    ]);
    if (finalized[0]?.meta.changes !== 1 || finalized[1]?.meta.changes !== 1) {
      const current = await this.#file(row.id);
      if (
        current?.status === "ready" &&
        current.intent_status === "finalized"
      ) {
        return this.#finalizedResult(current);
      }
      throw new UploadError(
        "file_not_uploaded",
        "The upload state changed before it could be finalized.",
      );
    }

    row = { ...row, detected_mime_type: detected, status: "ready" };
    return this.#finalizedResult(row);
  }

  async download(
    session: AuthenticatedSession,
    fileId: string,
  ): Promise<DownloadedUpload> {
    const row = await this.#file(fileId);
    if (
      !row ||
      row.status !== "ready" ||
      row.is_latest_ready_version !== 1 ||
      !row.r2_version ||
      !row.r2_etag
    ) {
      throw new UploadError("file_not_found", "The file does not exist.");
    }
    await this.#authorizeExisting(session, row, "read");

    const object = await this.#bucket.get(row.object_key);
    if (
      !object ||
      object.version !== row.r2_version ||
      object.etag !== row.r2_etag ||
      !metadataMatches(object, row)
    ) {
      if (object) {
        await object.body.cancel().catch(() => undefined);
      }
      const nowIso = this.#now().toISOString();
      await this.#quarantine(
        row.id,
        row.object_key,
        "stored_version_mismatch",
        row.detected_mime_type,
        nowIso,
      );
      throw new UploadError(
        "invalid_file",
        "The stored file version could not be verified.",
      );
    }
    if (!(await this.#isLatestReadyVersion(row.id))) {
      await object.body.cancel().catch(() => undefined);
      throw new UploadError("file_not_found", "The file does not exist.");
    }

    return {
      body: object.body,
      contentType: row.declared_mime_type,
      etag: object.httpEtag,
      filename: row.display_filename,
      size: object.size,
    };
  }

  async cleanupExpired(limit = 50): Promise<number> {
    const now = this.#now();
    const nowIso = now.toISOString();
    const candidates = await this.#database
      .prepare(
        `SELECT
           intent.id AS intent_id,
           intent.file_object_id,
           file.object_key
         FROM file_upload_intents intent
         JOIN file_objects file ON file.id = intent.file_object_id
         WHERE intent.status IN ('issued', 'uploading', 'uploaded', 'cleanup')
           AND intent.cleanup_after <= ?1
           AND (
             intent.lease_expires_at IS NULL OR intent.lease_expires_at <= ?1
           )
           AND file.status = 'pending'
         ORDER BY intent.cleanup_after, intent.id
         LIMIT ?2`,
      )
      .bind(nowIso, Math.max(1, Math.min(limit, 100)))
      .all<CleanupCandidate>();
    let cleaned = 0;

    for (const candidate of candidates.results) {
      const leaseId = crypto.randomUUID();
      const claimed = await this.#database
        .prepare(
          `UPDATE file_upload_intents
           SET status = 'cleanup', lease_id = ?1, lease_expires_at = ?2,
               updated_at = ?3
           WHERE id = ?4
             AND status IN ('issued', 'uploading', 'uploaded', 'cleanup')
             AND cleanup_after <= ?3
             AND (
               lease_expires_at IS NULL OR lease_expires_at <= ?3
             )`,
        )
        .bind(leaseId, isoAt(now, uploadLeaseMs), nowIso, candidate.intent_id)
        .run();
      if (claimed.meta.changes !== 1) {
        continue;
      }

      try {
        await this.#bucket.delete(candidate.object_key);
      } catch {
        continue;
      }

      const completed = await this.#database.batch([
        this.#database
          .prepare(
            `UPDATE file_upload_intents
             SET status = 'expired', lease_id = NULL, lease_expires_at = NULL,
                 last_cleanup_at = ?1, updated_at = ?1
             WHERE id = ?2
               AND status = 'cleanup'
               AND lease_id = ?3
               AND EXISTS (
                 SELECT 1
                 FROM file_objects file
                 WHERE file.id = file_upload_intents.file_object_id
                   AND file.status = 'pending'
               )`,
          )
          .bind(nowIso, candidate.intent_id, leaseId),
        this.#database
          .prepare(
            `UPDATE file_objects
             SET status = 'deleted', deleted_at = ?1, updated_at = ?1,
                 last_error_code = COALESCE(last_error_code, 'upload_expired')
             WHERE id = ?2
               AND status = 'pending'
               AND EXISTS (
                 SELECT 1
                 FROM file_upload_intents intent
                 WHERE intent.file_object_id = ?2
                   AND intent.status = 'expired'
                   AND intent.lease_id IS NULL
               )`,
          )
          .bind(nowIso, candidate.file_object_id),
      ]);
      if (
        completed[0]?.meta.changes === 1 &&
        completed[1]?.meta.changes === 1
      ) {
        cleaned += 1;
      }
    }

    return cleaned + (await this.#reconcileTerminalObjects(now, limit));
  }

  async #reconcileTerminalObjects(now: Date, limit: number): Promise<number> {
    const nowIso = now.toISOString();
    const cutoff = isoAt(now, -terminalReconciliationIntervalMs);
    const candidates = await this.#database
      .prepare(
        `SELECT
           intent.id AS intent_id,
           intent.file_object_id,
           file.object_key
         FROM file_upload_intents intent
         JOIN file_objects file ON file.id = intent.file_object_id
         WHERE intent.status IN ('expired', 'failed')
           AND file.status IN ('deleted', 'quarantined')
           AND (
             intent.last_cleanup_at IS NULL OR intent.last_cleanup_at <= ?1
           )
         ORDER BY COALESCE(intent.last_cleanup_at, ''), intent.id
         LIMIT ?2`,
      )
      .bind(cutoff, Math.max(1, Math.min(limit, 100)))
      .all<CleanupCandidate>();
    let reconciled = 0;

    for (const candidate of candidates.results) {
      try {
        await this.#bucket.delete(candidate.object_key);
      } catch {
        continue;
      }
      const recorded = await this.#database
        .prepare(
          `UPDATE file_upload_intents
           SET last_cleanup_at = ?1, updated_at = ?1
           WHERE id = ?2 AND status IN ('expired', 'failed')`,
        )
        .bind(nowIso, candidate.intent_id)
        .run();
      if (recorded.meta.changes === 1) {
        reconciled += 1;
      }
    }

    return reconciled;
  }

  async #resolveOwner(
    input: UploadIntentRequest,
    access: EventAccess,
  ): Promise<string | null> {
    const managesEvent = hasEventPermission(access, "event:manage");
    if (input.purpose === "resource" && !managesEvent) {
      throw new UploadError("forbidden", "You cannot upload this file.");
    }
    if (!managesEvent && !hasEventPermission(access, "portal:write:self")) {
      throw new UploadError("forbidden", "You cannot upload this file.");
    }

    const ownerContactId = managesEvent
      ? (input.owner_contact_id ?? null)
      : access.speakerContactId;
    if (
      !managesEvent &&
      input.owner_contact_id &&
      input.owner_contact_id !== access.speakerContactId
    ) {
      throw new UploadError("forbidden", "You cannot upload this file.");
    }
    if (purposeRequiresOwner(input.purpose) && !ownerContactId) {
      throw new UploadError(
        "invalid_upload",
        "This file purpose requires an event contact owner.",
      );
    }
    if (ownerContactId) {
      const contact = await this.#database
        .prepare(
          `SELECT 1 AS valid
           FROM p_event_contacts event_contact
           JOIN p_contacts contact
             ON contact.organization_id = event_contact.organization_id
            AND contact.id = event_contact.contact_id
            AND contact.source_deleted_at IS NULL
           WHERE event_contact.organization_id = ?1
             AND event_contact.event_id = ?2
             AND event_contact.contact_id = ?3
             AND event_contact.source_deleted_at IS NULL
           LIMIT 1`,
        )
        .bind(input.organization_id, input.event_id, ownerContactId)
        .first<{ valid: number }>();
      if (contact?.valid !== 1) {
        throw new UploadError("forbidden", "You cannot upload this file.");
      }
    }
    return ownerContactId;
  }

  async #replacement(
    input: UploadIntentRequest,
    ownerContactId: string | null,
  ): Promise<ReplacementRow> {
    const replacement = await this.#database
      .prepare(
        `SELECT
           COALESCE(predecessor.lineage_id, predecessor.id) AS lineage_id,
           (
             SELECT MAX(candidate.version_number)
             FROM file_objects candidate
             WHERE COALESCE(candidate.lineage_id, candidate.id) =
                   COALESCE(predecessor.lineage_id, predecessor.id)
           ) AS version_number
         FROM file_objects predecessor
         WHERE predecessor.id = ?1
           AND predecessor.organization_id = ?2
           AND predecessor.event_id = ?3
           AND predecessor.purpose = ?4
           AND predecessor.owner_contact_id IS ?5
           AND predecessor.status = 'ready'
           AND predecessor.version_number = (
             SELECT MAX(latest_ready.version_number)
             FROM file_objects latest_ready
             WHERE COALESCE(latest_ready.lineage_id, latest_ready.id) =
                   COALESCE(predecessor.lineage_id, predecessor.id)
               AND latest_ready.status = 'ready'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM file_objects active
             WHERE COALESCE(active.lineage_id, active.id) =
                   COALESCE(predecessor.lineage_id, predecessor.id)
               AND active.status = 'pending'
           )
         LIMIT 1`,
      )
      .bind(
        input.replaces_file_id,
        input.organization_id,
        input.event_id,
        input.purpose,
        ownerContactId,
      )
      .first<ReplacementRow>();
    if (!replacement) {
      throw new UploadError(
        "replacement_conflict",
        "The file being replaced is unavailable or outside this scope.",
      );
    }
    return replacement;
  }

  async #capability(
    fileId: string,
    tokenHash: string,
  ): Promise<UploadCapabilityRow | null> {
    return this.#database
      .prepare(
        `SELECT
           intent.attempts,
           file.byte_size,
           file.checksum_sha256,
           intent.cleanup_after,
           file.declared_mime_type,
           file.event_id,
           intent.expires_at,
           intent.file_object_id,
           file.object_key,
           file.organization_id,
           file.purpose,
           intent.status
         FROM file_upload_intents intent
         JOIN file_objects file ON file.id = intent.file_object_id
         WHERE intent.file_object_id = ?1
           AND intent.token_hash = ?2
           AND file.status = 'pending'
         LIMIT 1`,
      )
      .bind(fileId, tokenHash)
      .first<UploadCapabilityRow>();
  }

  async #releaseLease(
    fileId: string,
    leaseId: string,
    nowIso: string,
  ): Promise<void> {
    await this.#database
      .prepare(
        `UPDATE file_upload_intents
         SET status = 'issued', lease_id = NULL, lease_expires_at = NULL,
             updated_at = ?1
         WHERE file_object_id = ?2
           AND status = 'uploading'
           AND lease_id = ?3`,
      )
      .bind(nowIso, fileId, leaseId)
      .run();
  }

  async #recordRejectedAttempt(
    row: UploadCapabilityRow,
    attempt: number,
    leaseId: string,
    nowIso: string,
  ): Promise<void> {
    if (attempt < maxUploadAttempts) {
      await this.#releaseLease(row.file_object_id, leaseId, nowIso);
      return;
    }

    await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE file_upload_intents
           SET status = 'failed', lease_id = NULL, lease_expires_at = NULL,
               last_cleanup_at = ?1, updated_at = ?1
           WHERE file_object_id = ?2
             AND status = 'uploading'
             AND lease_id = ?3`,
        )
        .bind(nowIso, row.file_object_id, leaseId),
      this.#database
        .prepare(
          `UPDATE file_objects
           SET status = 'deleted', deleted_at = ?1, updated_at = ?1,
               last_error_code = 'upload_attempts_exhausted'
           WHERE id = ?2
             AND status = 'pending'
             AND EXISTS (
               SELECT 1
               FROM file_upload_intents intent
               WHERE intent.file_object_id = ?2
                 AND intent.status = 'failed'
             )`,
        )
        .bind(nowIso, row.file_object_id),
    ]);
  }

  async #queueCleanup(
    fileId: string,
    reason: string,
    detected: DetectedUploadContentType | null,
    nowIso: string,
  ): Promise<void> {
    await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE file_upload_intents
           SET status = 'cleanup', cleanup_after = ?1, lease_id = NULL,
               lease_expires_at = NULL, last_cleanup_at = NULL, updated_at = ?1
           WHERE file_object_id = ?2`,
        )
        .bind(nowIso, fileId),
      this.#database
        .prepare(
          `UPDATE file_objects
           SET status = 'pending', detected_mime_type = ?1,
               deleted_at = NULL, last_error_code = ?2, updated_at = ?3
           WHERE id = ?4
             AND status IN ('pending', 'ready', 'quarantined', 'deleted')
             AND EXISTS (
               SELECT 1
               FROM file_upload_intents intent
               WHERE intent.file_object_id = ?4
                 AND intent.status = 'cleanup'
             )`,
        )
        .bind(detected, reason, nowIso, fileId),
    ]);
  }

  async #file(fileId: string): Promise<FileRow | null> {
    return this.#database
      .prepare(
        `SELECT
           file.byte_size,
           file.checksum_sha256,
           intent.cleanup_after,
           file.declared_mime_type,
           file.detected_mime_type,
           file.display_filename,
           file.event_id,
           file.id,
           CASE WHEN NOT EXISTS (
             SELECT 1
             FROM file_objects newer
             WHERE COALESCE(newer.lineage_id, newer.id) =
                   COALESCE(file.lineage_id, file.id)
               AND newer.status = 'ready'
               AND newer.version_number > file.version_number
           ) THEN 1 ELSE 0 END AS is_latest_ready_version,
           intent.status AS intent_status,
           intent.lease_expires_at,
           file.lineage_id,
           file.object_key,
           file.organization_id,
           file.owner_contact_id,
           file.purpose,
           file.r2_etag,
           file.r2_version,
           file.status,
           file.uploaded_by_user_id,
           file.version_number
         FROM file_objects file
         JOIN file_upload_intents intent ON intent.file_object_id = file.id
         WHERE file.id = ?1
         LIMIT 1`,
      )
      .bind(fileId)
      .first<FileRow>();
  }

  async #isLatestReadyVersion(fileId: string): Promise<boolean> {
    const result = await this.#database
      .prepare(
        `SELECT 1 AS current
         FROM file_objects file
         WHERE file.id = ?1
           AND file.status = 'ready'
           AND NOT EXISTS (
             SELECT 1
             FROM file_objects newer
             WHERE COALESCE(newer.lineage_id, newer.id) =
                   COALESCE(file.lineage_id, file.id)
               AND newer.status = 'ready'
               AND newer.version_number > file.version_number
           )
         LIMIT 1`,
      )
      .bind(fileId)
      .first<{ current: number }>();
    return result?.current === 1;
  }

  async #authorizeExisting(
    session: AuthenticatedSession,
    row: FileRow,
    mode: "read" | "write",
  ): Promise<void> {
    const access = await loadEventAccess(
      this.#database,
      session.user,
      row.organization_id,
      row.event_id,
    );
    const managesEvent = hasEventPermission(access, "event:manage");
    const ownsFile =
      row.owner_contact_id !== null &&
      row.owner_contact_id === access.speakerContactId;
    const canReviewSubmission =
      mode === "read" &&
      row.purpose === "submission_attachment" &&
      hasEventPermission(access, "review:read");
    if (!managesEvent && !ownsFile && !canReviewSubmission) {
      throw new UploadError("forbidden", "You cannot access this file.");
    }
  }

  async #quarantine(
    fileId: string,
    objectKey: string,
    reason: string,
    detected: DetectedUploadContentType | null,
    nowIso: string,
  ): Promise<void> {
    try {
      await this.#bucket.delete(objectKey);
    } catch {
      await this.#queueCleanup(fileId, reason, detected, nowIso);
      return;
    }

    await this.#database.batch([
      this.#database
        .prepare(
          `UPDATE file_objects
           SET status = 'quarantined', detected_mime_type = ?1,
               last_error_code = ?2, updated_at = ?3
           WHERE id = ?4 AND status IN ('pending', 'ready')`,
        )
        .bind(detected, reason, nowIso, fileId),
      this.#database
        .prepare(
          `UPDATE file_upload_intents
           SET status = 'failed', lease_id = NULL, lease_expires_at = NULL,
               last_cleanup_at = ?1, updated_at = ?1
           WHERE file_object_id = ?2 AND status != 'expired'`,
        )
        .bind(nowIso, fileId),
    ]);
  }

  #finalizedResult(row: FileRow): FinalizedUpload {
    if (!row.detected_mime_type) {
      throw new Error("Ready upload is missing detected content type.");
    }
    return {
      byteSize: row.byte_size,
      checksumSha256: row.checksum_sha256,
      contentType: row.declared_mime_type,
      detectedContentType: row.detected_mime_type,
      id: row.id,
      version: row.version_number,
    };
  }
}
