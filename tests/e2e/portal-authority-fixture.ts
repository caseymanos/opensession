import { AuthService } from "../../workers/app/src/auth/service";

export const portalAuthorityInvitationEndpoint =
  "/__e2e/portal-authority-invitation";
export const portalAuthoritySlug = "authority-e2e";
export const portalAuthorityForeignSlug = "authority-foreign";

const hash = "b".repeat(64);
const projectedAt = "2026-08-10T16:00:00.000Z";

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function seedPortalAuthorityBrowserProof(
  database: D1Database,
): Promise<void> {
  const seedSql = `
    INSERT INTO tenant_registry
      (organization_id, base_key, source_record_id, created_at, updated_at,
       authority_ready_at)
    VALUES
      ('org_portal_e2e', 'base_portal_e2e', 'rec_org_portal_e2e',
       ${sqlString(projectedAt)}, ${sqlString(projectedAt)}, ${sqlString(projectedAt)}),
      ('org_portal_foreign', 'base_portal_foreign', 'rec_org_portal_foreign',
       ${sqlString(projectedAt)}, ${sqlString(projectedAt)}, ${sqlString(projectedAt)});

    INSERT INTO p_events
      (id, organization_id, name, slug, timezone, starts_at, ends_at, venue,
       status, brand_json, source_record_id, source_version,
       source_content_hash, projected_at)
    VALUES
      ('evt_portal_e2e', 'org_portal_e2e', 'Authority Browser Summit',
       '${portalAuthoritySlug}', 'America/Los_Angeles',
       '2026-08-18T16:00:00.000Z', '2026-08-20T23:00:00.000Z',
       'Pier 27', 'published',
       '{"accent":"#cde878","background":"#f5f2ea","ink":"#10201d"}',
       'rec_evt_portal_e2e', 1, ${sqlString(hash)}, ${sqlString(projectedAt)}),
      ('evt_portal_foreign', 'org_portal_foreign', 'Foreign Authority Event',
       '${portalAuthorityForeignSlug}', 'UTC', '2026-09-01T09:00:00.000Z',
       '2026-09-02T17:00:00.000Z', NULL, 'published', '{}',
       'rec_evt_portal_foreign', 1, ${sqlString(hash)}, ${sqlString(projectedAt)});

    INSERT INTO p_contacts
      (id, organization_id, email_normalized, display_name, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('contact_portal_e2e', 'org_portal_e2e', 'browser-speaker@example.test',
       'Browser Speaker', 'rec_contact_portal_e2e', 1, ${sqlString(hash)},
       ${sqlString(projectedAt)});

    INSERT INTO p_event_contacts
      (id, organization_id, event_id, contact_id, roles_json, portal_state,
       source_record_id, source_version, source_content_hash, projected_at)
    VALUES
      ('event_contact_portal_e2e', 'org_portal_e2e', 'evt_portal_e2e',
       'contact_portal_e2e', '["speaker"]', 'invited',
       'rec_event_contact_portal_e2e', 1, ${sqlString(hash)},
       ${sqlString(projectedAt)});

    INSERT INTO p_tracks
      (id, organization_id, event_id, name, sort_order, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('track_portal_e2e', 'org_portal_e2e', 'evt_portal_e2e', 'Architecture',
       1, 'rec_track_portal_e2e', 1, ${sqlString(hash)}, ${sqlString(projectedAt)});

    INSERT INTO p_formats
      (id, organization_id, event_id, name, default_duration_minutes,
       sort_order, source_record_id, source_version, source_content_hash,
       projected_at)
    VALUES
      ('format_portal_e2e', 'org_portal_e2e', 'evt_portal_e2e', 'Talk', 45, 1,
       'rec_format_portal_e2e', 1, ${sqlString(hash)}, ${sqlString(projectedAt)});

    INSERT INTO p_rooms
      (id, organization_id, event_id, name, capacity, sort_order,
       source_record_id, source_version, source_content_hash, projected_at)
    VALUES
      ('room_portal_e2e', 'org_portal_e2e', 'evt_portal_e2e', 'Main Hall', 400,
       1, 'rec_room_portal_e2e', 1, ${sqlString(hash)}, ${sqlString(projectedAt)});

    INSERT INTO p_sessions
      (id, organization_id, event_id, friendly_id, title, status, track_id,
       format_id, duration_minutes, updated_at, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('session_portal_e2e', 'org_portal_e2e', 'evt_portal_e2e', 'AUTH-101',
       'Real Authority in the Browser', 'scheduled', 'track_portal_e2e',
       'format_portal_e2e', 45, ${sqlString(projectedAt)},
       'rec_session_portal_e2e', 1, ${sqlString(hash)}, ${sqlString(projectedAt)});

    INSERT INTO p_session_participants
      (id, organization_id, event_id, session_id, contact_id, role, sort_order,
       confirmed_state, source_record_id, source_version, source_content_hash,
       projected_at)
    VALUES
      ('participant_portal_e2e', 'org_portal_e2e', 'evt_portal_e2e',
       'session_portal_e2e', 'contact_portal_e2e', 'speaker', 1, 'confirmed',
       'rec_participant_portal_e2e', 1, ${sqlString(hash)},
       ${sqlString(projectedAt)});

    INSERT INTO p_schedule_slots
      (id, organization_id, event_id, session_id, room_id, starts_at, ends_at,
       version, source_record_id, source_version, source_content_hash,
       projected_at)
    VALUES
      ('slot_portal_e2e', 'org_portal_e2e', 'evt_portal_e2e',
       'session_portal_e2e', 'room_portal_e2e', '2026-08-18T18:00:00.000Z',
       '2026-08-18T18:45:00.000Z', 1, 'rec_slot_portal_e2e', 1,
       ${sqlString(hash)}, ${sqlString(projectedAt)});

    INSERT INTO p_task_definitions
      (id, organization_id, event_id, name, type, description,
       required_default, approval_required, source_record_id, source_version,
       source_content_hash, projected_at)
    VALUES
      ('task_definition_portal_e2e', 'org_portal_e2e', 'evt_portal_e2e',
       'Confirm your biography', 'ack', 'Review the public biography.', 1, 0,
       'rec_task_definition_portal_e2e', 1, ${sqlString(hash)},
       ${sqlString(projectedAt)});

    INSERT INTO p_task_assignments
      (id, organization_id, event_id, definition_id, contact_id, session_id,
       due_at, required, status, completed_at, approved_at, response_json,
       file_object_ids_json, updated_at, source_record_id, source_version,
       source_content_hash, projected_at)
    VALUES
      ('task_portal_e2e', 'org_portal_e2e', 'evt_portal_e2e',
       'task_definition_portal_e2e', 'contact_portal_e2e', NULL,
       '2026-08-17T16:00:00.000Z', 1, 'not_started', NULL, NULL, '{}', '[]',
       ${sqlString(projectedAt)}, 'rec_task_portal_e2e', 1, ${sqlString(hash)},
       ${sqlString(projectedAt)});
  `;
  const statements = seedSql
    .split(";")
    .map((statement) => statement.replaceAll(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((statement) => `${statement};`)
    .join("\n");
  await database.exec(statements);
}

export async function issuePortalAuthorityBrowserProof(
  database: D1Database,
  origin: string,
  nonce: string,
): Promise<string> {
  const token = `portal-authority-browser-${nonce}-${crypto.randomUUID()}-${"a".repeat(32)}`;
  const invitation = new AuthService({
    database,
    emailEnabled: true,
    emailQueue: { send: async () => undefined } as unknown as Queue,
    hashPepper: "portal-browser-proof-pepper-with-at-least-32-characters",
    tokenFactory: () => token,
  });
  const result = await invitation.issuePortalInvitation(
    {
      commandId: `cmd_portal_browser_${nonce}`,
      email: "browser-speaker@example.test",
      eventId: "evt_portal_e2e",
      eventSlug: portalAuthoritySlug,
      organizationId: "org_portal_e2e",
    },
    { ipAddress: "127.0.0.1", userAgent: "Playwright authority proof" },
    origin,
    `req_portal_browser_${nonce}`,
  );
  if (result.outcome !== "queued") {
    throw new Error(`Portal browser invitation failed: ${result.outcome}`);
  }
  return token;
}
