import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fingerprint, sha256Hex } from "../src/auth/crypto";
import { UploadService } from "../src/uploads/service";

const pepper = "test-auth-pepper-with-at-least-32-characters";
const timestamp = "2026-08-09T06:00:00.000Z";
const future = "2027-08-09T06:00:00.000Z";
const sourceHash = "a".repeat(64);
const featureFlags = {
  ai: false,
  embeds: false,
  email: false,
  integrations: false,
  webhooks: false,
  writes: true,
};
const server = createTestHarness({
  workers: [
    {
      configPath: "workers/app/wrangler.jsonc",
      secrets: { AUTH_HASH_PEPPER: pepper },
      vars: { FEATURE_FLAGS: featureFlags },
    },
  ],
});

interface UploadIntentBody {
  file: {
    id: string;
    lineage_id: string;
    status: "pending";
    version: number;
  };
  upload: {
    expires_at: string;
    headers: Record<string, string>;
    method: "PUT";
    url: string;
  };
}

let origin = "";
let owner: { cookie: string; csrf: string };
let otherOwner: { cookie: string; csrf: string };
let speaker: { cookie: string; csrf: string };
let viewer: { cookie: string; csrf: string };

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function storedZip(entries: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const directoryParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry);
    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    localParts.push(local);

    const directory = new Uint8Array(46 + name.byteLength);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014b50, true);
    directoryView.setUint16(4, 20, true);
    directoryView.setUint16(6, 20, true);
    directoryView.setUint16(28, name.byteLength, true);
    directoryView.setUint32(42, localOffset, true);
    directory.set(name, 46);
    directoryParts.push(directory);
    localOffset += local.byteLength;
  }

  const directorySize = directoryParts.reduce(
    (size, part) => size + part.byteLength,
    0,
  );
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, directorySize, true);
  eocdView.setUint32(16, localOffset, true);

  const output = new Uint8Array(localOffset + directorySize + eocd.byteLength);
  let outputOffset = 0;
  for (const part of [...localParts, ...directoryParts, eocd]) {
    output.set(part, outputOffset);
    outputOffset += part.byteLength;
  }
  return output;
}

async function seedSession(
  userId: string,
  label: string,
): Promise<{ cookie: string; csrf: string }> {
  const environment = await server.getWorker<Env>().getEnv();
  const rawToken = `upload-session-${label}-${"s".repeat(32)}`;
  const csrf = `upload-csrf-${label}-${"c".repeat(32)}`;
  await environment.DB.batch([
    environment.DB.prepare(
      `INSERT INTO auth_sessions
        (id, user_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?4)`,
    ).bind(
      `upload_auth_${label}`,
      userId,
      await sha256Hex(rawToken),
      timestamp,
      future,
    ),
    environment.DB.prepare(
      `INSERT INTO auth_session_secrets
        (session_id, csrf_token_hash, created_at)
       VALUES (?1, ?2, ?3)`,
    ).bind(`upload_auth_${label}`, await sha256Hex(csrf), timestamp),
  ]);
  return {
    cookie: `__Host-opensession-session=${rawToken}`,
    csrf,
  };
}

function mutationHeaders(authentication: {
  cookie: string;
  csrf: string;
}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: authentication.cookie,
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": authentication.csrf,
  };
}

async function createIntent(
  authentication: { cookie: string; csrf: string },
  bytes: Uint8Array,
  overrides: Partial<{
    byte_size: number;
    checksum_sha256: string;
    content_type:
      | "application/pdf"
      | "image/png"
      | "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    event_id: string;
    filename: string;
    organization_id: string;
    owner_contact_id: string;
    purpose: "headshot" | "resource" | "slides" | "submission_attachment";
    replaces_file_id: string;
  }> = {},
): Promise<{
  body: UploadIntentBody;
  response: Awaited<ReturnType<typeof server.fetch>>;
}> {
  const response = await server.fetch("/api/uploads/intents", {
    body: JSON.stringify({
      byte_size: bytes.byteLength,
      checksum_sha256: await sha256BytesHex(bytes),
      content_type: "application/pdf",
      event_id: "evt_one",
      filename: "conference-deck.pdf",
      organization_id: "org_one",
      purpose: "resource",
      ...overrides,
    }),
    headers: mutationHeaders(authentication),
    method: "POST",
  });
  const body = (await response.json()) as UploadIntentBody;
  return { body, response };
}

async function putUpload(
  intent: UploadIntentBody,
  bytes: Uint8Array,
  overrides: Record<string, string> = {},
) {
  return server.fetch(intent.upload.url, {
    body: bytes,
    headers: {
      ...intent.upload.headers,
      "Content-Length": String(bytes.byteLength),
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      ...overrides,
    },
    method: "PUT",
  });
}

async function finalizeUpload(
  authentication: { cookie: string; csrf: string },
  fileId: string,
) {
  return server.fetch(`/api/uploads/${fileId}/finalize`, {
    body: "{}",
    headers: mutationHeaders(authentication),
    method: "POST",
  });
}

beforeAll(async () => {
  const listening = await server.listen();
  origin = listening.url.origin;
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  const environment = await worker.getEnv();
  const seedSql = `
    INSERT INTO tenant_registry
      (organization_id, base_key, source_record_id, created_at, updated_at)
    VALUES
      ('org_one', 'base_one', 'rec_org_upload_one', ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('org_two', 'base_two', 'rec_org_upload_two', ${sqlString(timestamp)}, ${sqlString(timestamp)});

    INSERT INTO users
      (id, email_normalized, display_name, created_at, updated_at)
    VALUES
      ('upload_owner', 'upload-owner@example.test', 'Upload Owner', ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('upload_other', 'upload-other@example.test', 'Other Owner', ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('upload_speaker', 'upload-speaker@example.test', 'Upload Speaker', ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('upload_viewer', 'upload-viewer@example.test', 'Upload Viewer', ${sqlString(timestamp)}, ${sqlString(timestamp)});

    INSERT INTO p_events
      (id, organization_id, name, slug, timezone, status, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('evt_one', 'org_one', 'Upload Event One', 'upload-event-one', 'UTC', 'draft',
       'rec_evt_upload_one', 1, ${sqlString(sourceHash)}, ${sqlString(timestamp)}),
      ('evt_quota', 'org_one', 'Upload Quota Event', 'upload-quota-event', 'UTC', 'draft',
       'rec_evt_upload_quota', 1, ${sqlString(sourceHash)}, ${sqlString(timestamp)}),
      ('evt_two', 'org_two', 'Upload Event Two', 'upload-event-two', 'UTC', 'draft',
       'rec_evt_upload_two', 1, ${sqlString(sourceHash)}, ${sqlString(timestamp)});

    INSERT INTO organization_memberships
      (id, organization_id, user_id, role, created_at, updated_at)
    VALUES
      ('upload_membership_owner', 'org_one', 'upload_owner', 'owner', ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('upload_membership_other', 'org_two', 'upload_other', 'owner', ${sqlString(timestamp)}, ${sqlString(timestamp)}),
      ('upload_membership_viewer', 'org_one', 'upload_viewer', 'viewer', ${sqlString(timestamp)}, ${sqlString(timestamp)});

    INSERT INTO p_contacts
      (id, organization_id, email_normalized, display_name, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('upload_contact_speaker', 'org_one', 'upload-speaker@example.test',
       'Upload Speaker', 'rec_upload_contact_speaker', 1,
       ${sqlString(sourceHash)}, ${sqlString(timestamp)});

    INSERT INTO p_event_contacts
      (id, organization_id, event_id, contact_id, roles_json, portal_state,
       source_record_id, source_version, source_content_hash, projected_at)
    VALUES
      ('upload_event_contact_speaker', 'org_one', 'evt_one',
       'upload_contact_speaker', '["speaker"]', 'active',
       'rec_upload_event_contact_speaker', 1, ${sqlString(sourceHash)},
       ${sqlString(timestamp)});

    UPDATE tenant_registry
    SET authority_ready_at = ${sqlString(timestamp)}
    WHERE organization_id IN ('org_one', 'org_two');
  `;
  await environment.DB.exec(
    seedSql
      .split(";")
      .map((statement) => statement.replaceAll(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((statement) => `${statement};`)
      .join("\n"),
  );
  [owner, otherOwner, speaker, viewer] = await Promise.all([
    seedSession("upload_owner", "owner"),
    seedSession("upload_other", "other"),
    seedSession("upload_speaker", "speaker"),
    seedSession("upload_viewer", "viewer"),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("private R2 upload runtime", () => {
  it("authorizes, stores, finalizes, and safely streams a private file", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nOpenSession evidence");
    const { body: intent, response: intentResponse } = await createIntent(
      owner,
      bytes,
    );
    expect(intentResponse.status).toBe(201);
    expect(intent.upload.url).toMatch(/^\/api\/uploads\/[\w-]+\/content$/);
    expect(intent.upload.url).not.toContain(
      intent.upload.headers["X-Upload-Token"],
    );

    const withoutCapability = await server.fetch(intent.upload.url, {
      body: bytes,
      headers: {
        "Content-Length": String(bytes.byteLength),
        "Content-Type": "application/pdf",
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        "X-Content-SHA256": await sha256BytesHex(bytes),
      },
      method: "PUT",
    });
    expect(withoutCapability.status).toBe(400);

    const crossOrigin = await server.fetch(intent.upload.url, {
      body: bytes,
      headers: {
        ...intent.upload.headers,
        "Content-Length": String(bytes.byteLength),
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      },
      method: "PUT",
    });
    expect(crossOrigin.status).toBe(400);

    const stored = await putUpload(intent, bytes);
    expect(stored.status).toBe(201);
    const [finalized, repeatedFinalize] = await Promise.all([
      finalizeUpload(owner, intent.file.id),
      finalizeUpload(owner, intent.file.id),
    ]);
    expect([finalized.status, repeatedFinalize.status]).toEqual([200, 200]);
    const replayedFinalize = await finalizeUpload(owner, intent.file.id);
    expect(replayedFinalize.status).toBe(200);
    await expect(replayedFinalize.json()).resolves.toMatchObject({
      byte_size: bytes.byteLength,
      checksum_sha256: await sha256BytesHex(bytes),
      content_type: "application/pdf",
      detected_content_type: "application/pdf",
      id: intent.file.id,
      status: "ready",
      version: 1,
    });

    const download = await server.fetch(`/api/uploads/${intent.file.id}`, {
      headers: { Cookie: owner.cookie },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain(
      "attachment;",
    );
    expect(download.headers.get("content-security-policy")).toBe("sandbox");
    expect(download.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);

    const environment = await server.getWorker<Env>().getEnv();
    const state = await environment.DB.prepare(
      `SELECT file.status, file.detected_mime_type, intent.status AS intent_status
       FROM file_objects file
       JOIN file_upload_intents intent ON intent.file_object_id = file.id
       WHERE file.id = ?1`,
    )
      .bind(intent.file.id)
      .first<{
        detected_mime_type: string;
        intent_status: string;
        status: string;
      }>();
    expect(state).toEqual({
      detected_mime_type: "application/pdf",
      intent_status: "finalized",
      status: "ready",
    });
    expect((await server.fetch("/api/uploads")).status).toBe(404);
  });

  it("rejects anonymous, cross-event, and unrelated viewer access", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nprivate");
    const anonymous = await server.fetch("/api/uploads/intents", {
      body: JSON.stringify({
        byte_size: bytes.byteLength,
        checksum_sha256: await sha256BytesHex(bytes),
        content_type: "application/pdf",
        event_id: "evt_one",
        filename: "private.pdf",
        organization_id: "org_one",
        purpose: "resource",
      }),
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
      },
      method: "POST",
    });
    expect(anonymous.status).toBe(401);

    const crossEvent = await createIntent(owner, bytes, {
      event_id: "evt_two",
      organization_id: "org_two",
    });
    expect(crossEvent.response.status).toBe(403);

    const { body: intent } = await createIntent(owner, bytes);
    expect((await putUpload(intent, bytes)).status).toBe(201);
    expect((await finalizeUpload(owner, intent.file.id)).status).toBe(200);
    expect(
      (
        await server.fetch(`/api/uploads/${intent.file.id}`, {
          headers: { Cookie: otherOwner.cookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await server.fetch(`/api/uploads/${intent.file.id}`, {
          headers: { Cookie: viewer.cookie },
        })
      ).status,
    ).toBe(403);
  });

  it("derives speaker ownership and rejects another contact", async () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ]);
    const own = await createIntent(speaker, bytes, {
      content_type: "image/png",
      filename: "speaker.png",
      purpose: "headshot",
    });
    expect(own.response.status).toBe(201);
    expect((await putUpload(own.body, bytes)).status).toBe(201);
    expect((await finalizeUpload(speaker, own.body.file.id)).status).toBe(200);

    const impersonation = await createIntent(speaker, bytes, {
      content_type: "image/png",
      filename: "speaker.png",
      owner_contact_id: "another_contact",
      purpose: "headshot",
    });
    expect(impersonation.response.status).toBe(403);
  });

  it("quarantines SVG or HTML bytes disguised as an allowed file", async () => {
    const bytes = new TextEncoder().encode(
      "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    );
    const { body: intent } = await createIntent(owner, bytes);
    expect((await putUpload(intent, bytes)).status).toBe(201);
    const finalized = await finalizeUpload(owner, intent.file.id);
    expect(finalized.status).toBe(422);
    await expect(finalized.json()).resolves.toMatchObject({
      error: { code: "mime_mismatch" },
    });

    const environment = await server.getWorker<Env>().getEnv();
    const state = await environment.DB.prepare(
      `SELECT status, last_error_code, object_key
       FROM file_objects WHERE id = ?1`,
    )
      .bind(intent.file.id)
      .first<{
        last_error_code: string;
        object_key: string;
        status: string;
      }>();
    expect(state).toMatchObject({
      last_error_code: "mime_mismatch",
      status: "quarantined",
    });
    expect(
      await environment.UPLOADS.head(state?.object_key ?? "missing"),
    ).toBeNull();
    expect(
      (
        await server.fetch(`/api/uploads/${intent.file.id}`, {
          headers: { Cookie: owner.cookie },
        })
      ).status,
    ).toBe(404);
  });

  it("requires a bounded OOXML structure for declared PPTX files", async () => {
    const arbitraryZip = storedZip(["payload.txt"]);
    const rejected = await createIntent(owner, arbitraryZip, {
      content_type:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      filename: "spoofed.pptx",
      owner_contact_id: "upload_contact_speaker",
      purpose: "slides",
    });
    expect(rejected.response.status).toBe(201);
    expect((await putUpload(rejected.body, arbitraryZip)).status).toBe(201);
    expect((await finalizeUpload(owner, rejected.body.file.id)).status).toBe(
      422,
    );

    const pptx = storedZip([
      "[Content_Types].xml",
      "_rels/.rels",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
    ]);
    const accepted = await createIntent(owner, pptx, {
      content_type:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      filename: "conference.pptx",
      owner_contact_id: "upload_contact_speaker",
      purpose: "slides",
    });
    expect(accepted.response.status).toBe(201);
    expect((await putUpload(accepted.body, pptx)).status).toBe(201);
    const finalized = await finalizeUpload(owner, accepted.body.file.id);
    expect(finalized.status).toBe(200);
    await expect(finalized.json()).resolves.toMatchObject({
      detected_content_type: "application/zip",
    });
  });

  it("rejects traversal filenames, executable types, and oversized intents", async () => {
    const checksum = "a".repeat(64);
    for (const payload of [
      {
        byte_size: 128,
        checksum_sha256: checksum,
        content_type: "text/html",
        event_id: "evt_one",
        filename: "page.html",
        organization_id: "org_one",
        purpose: "resource",
      },
      {
        byte_size: 128,
        checksum_sha256: checksum,
        content_type: "application/pdf",
        event_id: "evt_one",
        filename: "../../private.pdf",
        organization_id: "org_one",
        purpose: "resource",
      },
    ]) {
      const response = await server.fetch("/api/uploads/intents", {
        body: JSON.stringify(payload),
        headers: mutationHeaders(owner),
        method: "POST",
      });
      expect(response.status).toBe(400);
    }

    const oversized = await createIntent(owner, new Uint8Array([1]), {
      byte_size: 9 * 1024 * 1024,
      checksum_sha256: checksum,
      content_type: "image/png",
      filename: "huge.png",
      owner_contact_id: "upload_contact_speaker",
      purpose: "headshot",
    });
    expect(oversized.response.status).toBe(400);
    expect(oversized.body).toMatchObject({
      error: { code: "file_too_large" },
    });
  });

  it("enforces exact upload length, checksum capability, and one-time PUT", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\none winner");
    const badLength = await createIntent(owner, bytes);
    const environment = await server.getWorker<Env>().getEnv();
    await expect(
      new UploadService({
        bucket: environment.UPLOADS,
        database: environment.DB,
      }).store(
        badLength.body.file.id,
        badLength.body.upload.headers["X-Upload-Token"] ?? null,
        new Headers({
          ...badLength.body.upload.headers,
          "Content-Length": String(bytes.byteLength + 1),
        }),
        new Response(bytes).body,
      ),
    ).rejects.toMatchObject({ code: "invalid_upload" });

    const checksumIntent = await createIntent(owner, bytes);
    const tampered = Uint8Array.from(bytes);
    const lastIndex = tampered.length - 1;
    tampered[lastIndex] = (tampered[lastIndex] ?? 0) ^ 1;
    expect((await putUpload(checksumIntent.body, tampered)).status).toBe(422);
    expect((await putUpload(checksumIntent.body, bytes)).status).toBe(201);
    expect(
      (await finalizeUpload(owner, checksumIntent.body.file.id)).status,
    ).toBe(200);

    const boundedIntent = await createIntent(owner, bytes);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await putUpload(boundedIntent.body, tampered)).status).toBe(422);
    }
    expect((await putUpload(boundedIntent.body, tampered)).status).toBe(410);
    const rejectedState = await environment.DB.prepare(
      `SELECT file.status, intent.status AS intent_status, intent.attempts
       FROM file_objects file
       JOIN file_upload_intents intent ON intent.file_object_id = file.id
       WHERE file.id = ?1`,
    )
      .bind(boundedIntent.body.file.id)
      .first<{ attempts: number; intent_status: string; status: string }>();
    expect(rejectedState).toEqual({
      attempts: 3,
      intent_status: "failed",
      status: "deleted",
    });

    const intent = (await createIntent(owner, bytes)).body;
    const [first, second] = await Promise.all([
      putUpload(intent, bytes),
      putUpload(intent, bytes),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect((await finalizeUpload(owner, intent.file.id)).status).toBe(200);
    expect((await putUpload(intent, bytes)).status).toBe(410);
  });

  it("reserves event quota before issuing an upload capability", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    await environment.DB.prepare(
      `INSERT INTO file_objects
        (id, organization_id, event_id, uploaded_by_user_id, object_key,
         display_filename, declared_mime_type, detected_mime_type, byte_size,
         checksum_sha256, status, created_at, finalized_at, purpose,
         lineage_id, version_number, r2_version, r2_etag, updated_at)
       VALUES
        ('quota_reserved', 'org_one', 'evt_quota', 'upload_owner',
         'organizations/org_one/events/evt_quota/files/reserved', 'reserved.pdf',
         'application/pdf', 'application/pdf', ?1, ?2, 'ready', ?3, ?3,
         'resource', 'quota_reserved', 1, 'quota-version', 'quota-etag', ?3)`,
    )
      .bind(1024 * 1024 * 1024, "b".repeat(64), timestamp)
      .run();

    try {
      const bytes = new TextEncoder().encode("%PDF-1.7\nquota");
      const result = await createIntent(owner, bytes, {
        event_id: "evt_quota",
      });
      expect(result.response.status).toBe(409);
      expect(result.body).toMatchObject({
        error: { code: "quota_exceeded" },
      });
      const pending = await environment.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM file_objects
         WHERE event_id = 'evt_quota' AND status = 'pending'`,
      ).first<{ count: number }>();
      expect(pending?.count).toBe(0);
    } finally {
      await environment.DB.prepare(
        "DELETE FROM file_objects WHERE id = 'quota_reserved'",
      ).run();
    }
  });

  it("retains immutable replacement lineage and version metadata", async () => {
    const firstBytes = new TextEncoder().encode("%PDF-1.7\nversion one");
    const first = (await createIntent(owner, firstBytes)).body;
    expect((await putUpload(first, firstBytes)).status).toBe(201);
    expect((await finalizeUpload(owner, first.file.id)).status).toBe(200);

    const secondBytes = new TextEncoder().encode("%PDF-1.7\nversion two");
    const replacements = await Promise.all([
      createIntent(owner, secondBytes, { replaces_file_id: first.file.id }),
      createIntent(owner, secondBytes, { replaces_file_id: first.file.id }),
    ]);
    expect(replacements.map(({ response }) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const second = replacements.find(
      ({ response }) => response.status === 201,
    )?.body;
    expect(second).toBeTruthy();
    if (!second) {
      throw new Error("Expected one replacement intent to win.");
    }
    expect(second.file.lineage_id).toBe(first.file.lineage_id);
    expect(second.file.version).toBe(2);
    expect((await putUpload(second, secondBytes)).status).toBe(201);
    expect((await finalizeUpload(owner, second.file.id)).status).toBe(200);
    expect(
      (
        await server.fetch(`/api/uploads/${first.file.id}`, {
          headers: { Cookie: owner.cookie },
        })
      ).status,
    ).toBe(404);
    const currentSecond = await server.fetch(`/api/uploads/${second.file.id}`, {
      headers: { Cookie: owner.cookie },
    });
    expect(currentSecond.status).toBe(200);
    expect(new Uint8Array(await currentSecond.arrayBuffer())).toEqual(
      secondBytes,
    );

    const invalidBytes = new TextEncoder().encode("<svg>not slides</svg>");
    const failed = (
      await createIntent(owner, invalidBytes, {
        replaces_file_id: second.file.id,
      })
    ).body;
    expect(failed.file.version).toBe(3);
    expect((await putUpload(failed, invalidBytes)).status).toBe(201);
    expect((await finalizeUpload(owner, failed.file.id)).status).toBe(422);
    const currentAfterFailed = await server.fetch(
      `/api/uploads/${second.file.id}`,
      { headers: { Cookie: owner.cookie } },
    );
    expect(currentAfterFailed.status).toBe(200);
    expect(new Uint8Array(await currentAfterFailed.arrayBuffer())).toEqual(
      secondBytes,
    );

    const fourthBytes = new TextEncoder().encode("%PDF-1.7\nversion four");
    const fourth = (
      await createIntent(owner, fourthBytes, {
        replaces_file_id: second.file.id,
      })
    ).body;
    expect(fourth.file.version).toBe(4);
    expect((await putUpload(fourth, fourthBytes)).status).toBe(201);
    expect((await finalizeUpload(owner, fourth.file.id)).status).toBe(200);
    expect(
      (
        await server.fetch(`/api/uploads/${second.file.id}`, {
          headers: { Cookie: owner.cookie },
        })
      ).status,
    ).toBe(404);
    const currentFourth = await server.fetch(`/api/uploads/${fourth.file.id}`, {
      headers: { Cookie: owner.cookie },
    });
    expect(currentFourth.status).toBe(200);
    expect(new Uint8Array(await currentFourth.arrayBuffer())).toEqual(
      fourthBytes,
    );

    const environment = await server.getWorker<Env>().getEnv();
    const versions = await environment.DB.prepare(
      `SELECT id, lineage_id, version_number, replaces_file_id
       FROM file_objects WHERE lineage_id = ?1 ORDER BY version_number`,
    )
      .bind(first.file.lineage_id)
      .all<{
        id: string;
        lineage_id: string;
        replaces_file_id: string | null;
        version_number: number;
      }>();
    expect(versions.results).toEqual([
      {
        id: first.file.id,
        lineage_id: first.file.lineage_id,
        replaces_file_id: null,
        version_number: 1,
      },
      {
        id: second.file.id,
        lineage_id: first.file.lineage_id,
        replaces_file_id: first.file.id,
        version_number: 2,
      },
      {
        id: failed.file.id,
        lineage_id: first.file.lineage_id,
        replaces_file_id: second.file.id,
        version_number: 3,
      },
      {
        id: fourth.file.id,
        lineage_id: first.file.lineage_id,
        replaces_file_id: second.file.id,
        version_number: 4,
      },
    ]);
  });

  it("removes an R2 object that completes after D1 cleanup wins", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nlate completion");
    const intent = (await createIntent(owner, bytes)).body;
    const environment = await server.getWorker<Env>().getEnv();
    let objectKey = "";
    const deletedKeys: string[] = [];
    const racingBucket = {
      delete: async (key: string | string[]) => {
        deletedKeys.push(...(typeof key === "string" ? [key] : key));
      },
      put: async (...arguments_: Parameters<R2Bucket["put"]>) => {
        objectKey = arguments_[0];
        await environment.DB.batch([
          environment.DB.prepare(
            `UPDATE file_upload_intents
             SET status = 'expired', lease_id = NULL, lease_expires_at = NULL
             WHERE file_object_id = ?1`,
          ).bind(intent.file.id),
          environment.DB.prepare(
            `UPDATE file_objects
             SET status = 'deleted', deleted_at = ?1
             WHERE id = ?2`,
          ).bind(timestamp, intent.file.id),
        ]);
        return {
          checksums: {
            toJSON: () => ({
              sha256: intent.upload.headers["X-Content-SHA256"],
            }),
          },
          customMetadata: {
            eventId: "evt_one",
            fileId: intent.file.id,
            organizationId: "org_one",
            purpose: "resource",
          },
          etag: "late-etag",
          httpEtag: '"late-etag"',
          httpMetadata: { contentType: "application/pdf" },
          key: objectKey,
          size: bytes.byteLength,
          storageClass: "Standard",
          uploaded: new Date(),
          version: "late-version",
          writeHttpMetadata: () => undefined,
        } as R2Object;
      },
    } as unknown as R2Bucket;

    await expect(
      new UploadService({
        bucket: racingBucket,
        database: environment.DB,
      }).store(
        intent.file.id,
        intent.upload.headers["X-Upload-Token"] ?? null,
        new Headers({
          ...intent.upload.headers,
          "Content-Length": String(bytes.byteLength),
        }),
        new Response(bytes).body,
      ),
    ).rejects.toThrow("Upload state changed");
    expect(objectKey).not.toBe("");
    expect(deletedKeys).toEqual([objectKey]);
  });

  it("perpetually reconciles terminal keys after a canceled late PUT", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\ncrash window");
    const intent = (await createIntent(owner, bytes)).body;
    expect((await putUpload(intent, bytes)).status).toBe(201);
    const environment = await server.getWorker<Env>().getEnv();
    const file = await environment.DB.prepare(
      "SELECT object_key FROM file_objects WHERE id = ?1",
    )
      .bind(intent.file.id)
      .first<{ object_key: string }>();
    expect(file).toBeTruthy();
    await environment.DB.batch([
      environment.DB.prepare(
        `UPDATE file_upload_intents
         SET status = 'expired', last_cleanup_at = '2020-01-01T00:00:00.000Z'
         WHERE file_object_id = ?1`,
      ).bind(intent.file.id),
      environment.DB.prepare(
        `UPDATE file_objects
         SET status = 'deleted', deleted_at = ?1
         WHERE id = ?2`,
      ).bind(timestamp, intent.file.id),
    ]);
    expect(
      await environment.UPLOADS.head(file?.object_key ?? "missing"),
    ).toBeTruthy();

    await server.getWorker<Env>().scheduled({
      cron: "17 * * * *",
      scheduledTime: new Date(),
    });
    expect(
      await environment.UPLOADS.head(file?.object_key ?? "missing"),
    ).toBeNull();
    const reconciled = await environment.DB.prepare(
      "SELECT last_cleanup_at FROM file_upload_intents WHERE file_object_id = ?1",
    )
      .bind(intent.file.id)
      .first<{ last_cleanup_at: string }>();
    expect(Date.parse(reconciled?.last_cleanup_at ?? "")).toBeGreaterThan(
      Date.parse("2020-01-01T00:00:00.000Z"),
    );
  });

  it("reclaims expired uploaded orphans and records terminal state", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\norphan");
    const intent = (await createIntent(owner, bytes)).body;
    expect((await putUpload(intent, bytes)).status).toBe(201);
    const environment = await server.getWorker<Env>().getEnv();
    const row = await environment.DB.prepare(
      `SELECT file.object_key, intent.id AS intent_id
       FROM file_objects file
       JOIN file_upload_intents intent ON intent.file_object_id = file.id
       WHERE file.id = ?1`,
    )
      .bind(intent.file.id)
      .first<{ intent_id: string; object_key: string }>();
    expect(row).toBeTruthy();
    await environment.DB.prepare(
      `UPDATE file_upload_intents
       SET cleanup_after = '2020-01-01T00:00:00.000Z'
       WHERE file_object_id = ?1`,
    )
      .bind(intent.file.id)
      .run();
    await environment.DB.prepare(
      "UPDATE file_objects SET byte_size = ?1 WHERE id = ?2",
    )
      .bind(1024 * 1024 * 1024, intent.file.id)
      .run();
    const blocked = await createIntent(
      owner,
      new TextEncoder().encode("%PDF-1.7\nstill reserved"),
    );
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toMatchObject({
      error: { code: "quota_exceeded" },
    });

    server.clearLogs();
    await server.getWorker<Env>().scheduled({
      cron: "17 * * * *",
      scheduledTime: new Date(),
    });
    expect(
      await environment.UPLOADS.head(row?.object_key ?? "missing"),
    ).toBeNull();
    const state = await environment.DB.prepare(
      `SELECT file.status, intent.status AS intent_status
       FROM file_objects file
       JOIN file_upload_intents intent ON intent.file_object_id = file.id
       WHERE file.id = ?1`,
    )
      .bind(intent.file.id)
      .first<{ intent_status: string; status: string }>();
    expect(state).toEqual({ intent_status: "expired", status: "deleted" });
    const logs = JSON.stringify(server.getLogs());
    expect(logs).toContain("upload.cleanup.completed");
    expect(logs).not.toContain(row?.object_key ?? "missing");
    const recovered = await createIntent(
      owner,
      new TextEncoder().encode("%PDF-1.7\nquota recovered"),
    );
    expect(recovered.response.status).toBe(201);
  });

  it("returns Retry-After when an upload identity is rate limited", async () => {
    const environment = await server.getWorker<Env>().getEnv();
    const now = Math.floor(Date.now() / 1_000);
    await environment.DB.prepare(
      `INSERT INTO abuse_rate_limits
        (scope, key_hash, window_started_at, request_count, blocked_until, updated_at)
       VALUES ('upload_intent:identity', ?1, ?2, 31, ?3, ?4)`,
    )
      .bind(
        await fingerprint("upload_viewer", pepper, "upload_intent:identity"),
        now,
        now + 600,
        new Date().toISOString(),
      )
      .run();

    const limited = await createIntent(
      viewer,
      new TextEncoder().encode("%PDF-1.7\nrate limited"),
    );
    expect(limited.response.status).toBe(429);
    expect(Number(limited.response.headers.get("Retry-After"))).toBeGreaterThan(
      0,
    );
    expect(limited.body).toMatchObject({ error: { code: "rate_limited" } });
  });
});
