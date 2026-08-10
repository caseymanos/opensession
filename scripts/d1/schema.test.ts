import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface D1Execution<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  meta: { duration: number };
  results: Row[];
  success: boolean;
}

const root = process.cwd();
const wrangler = resolve(root, "node_modules/.bin/wrangler");
const config = resolve(root, "workers/app/wrangler.jsonc");
const hash = "a".repeat(64);
const timestamp = "2026-08-08T00:00:00.000Z";
let persistence = "";

function execute(arguments_: readonly string[]): string {
  return execFileSync(wrangler, arguments_, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function queryAll<
  Row extends Record<string, unknown> = Record<string, unknown>,
>(sql: string): D1Execution<Row>[] {
  const output = execute([
    "d1",
    "execute",
    "DB",
    "--local",
    "--persist-to",
    persistence,
    "--command",
    sql,
    "--config",
    config,
    "--json",
  ]);

  return JSON.parse(output) as D1Execution<Row>[];
}

function query<Row extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
): D1Execution<Row> {
  const executions = queryAll<Row>(sql);
  const result = executions.at(-1);
  if (!result) {
    throw new Error("D1 returned no execution result.");
  }
  return result;
}

function expectSqlFailure(sql: string): void {
  expect(() => query(sql)).toThrow();
}

beforeAll(() => {
  persistence = mkdtempSync(join(tmpdir(), "opensession-d1-test-"));
  execute([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    persistence,
    "--config",
    config,
  ]);

  query(`
    INSERT INTO tenant_registry
      (organization_id, base_key, source_record_id, created_at, updated_at)
    VALUES
      ('org_one', 'base_preview', 'rec_org_one', '${timestamp}', '${timestamp}'),
      ('org_two', 'base_preview', 'rec_org_two', '${timestamp}', '${timestamp}');

    INSERT INTO users
      (id, email_normalized, display_name, created_at, updated_at)
    VALUES
      ('usr_one', 'owner@example.test', 'Owner', '${timestamp}', '${timestamp}');

    INSERT INTO p_events
      (id, organization_id, name, slug, timezone, status, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('evt_one', 'org_one', 'Event One', 'event-one', 'America/Los_Angeles', 'draft',
       'rec_evt_one', 1, '${hash}', '${timestamp}'),
      ('evt_two', 'org_two', 'Event Two', 'event-two', 'UTC', 'draft',
       'rec_evt_two', 1, '${hash}', '${timestamp}');

    INSERT INTO p_contacts
      (id, organization_id, email_normalized, display_name, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('contact_one', 'org_one', 'speaker@example.test', 'Speaker One',
       'rec_contact_one', 1, '${hash}', '${timestamp}'),
      ('contact_two', 'org_two', 'speaker@example.test', 'Speaker Two',
       'rec_contact_two', 1, '${hash}', '${timestamp}');

    INSERT INTO p_forms
      (id, organization_id, event_id, name, status, version, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('form_one', 'org_one', 'evt_one', 'CFP', 'published', 1,
       'rec_form_one', 1, '${hash}', '${timestamp}');

    INSERT INTO p_event_contacts
      (id, organization_id, event_id, contact_id, roles_json, portal_state,
       source_record_id, source_version, source_content_hash, projected_at)
    VALUES
      ('reviewer_one', 'org_one', 'evt_one', 'contact_one', '["reviewer"]', 'active',
       'rec_reviewer_one', 1, '${hash}', '${timestamp}');

    INSERT INTO p_rooms
      (id, organization_id, event_id, name, sort_order, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('room_one', 'org_one', 'evt_one', 'Main', 1,
       'rec_room_one', 1, '${hash}', '${timestamp}');

    INSERT INTO p_tracks
      (id, organization_id, event_id, name, sort_order, source_record_id,
       source_version, source_content_hash, projected_at)
    VALUES
      ('track_one', 'org_one', 'evt_one', 'AI', 1,
       'rec_track_one', 1, '${hash}', '${timestamp}');

    INSERT INTO p_formats
      (id, organization_id, event_id, name, default_duration_minutes, sort_order,
       source_record_id, source_version, source_content_hash, projected_at)
    VALUES
      ('format_one', 'org_one', 'evt_one', 'Talk', 30, 1,
       'rec_format_one', 1, '${hash}', '${timestamp}');

    INSERT INTO p_sessions
      (id, organization_id, event_id, friendly_id, title, status, track_id,
       format_id, duration_minutes, updated_at, source_record_id, source_version,
       source_content_hash, projected_at)
    VALUES
      ('session_one', 'org_one', 'evt_one', 'SES-001', 'Opening', 'scheduled',
       'track_one', 'format_one', 30, '${timestamp}', 'rec_session_one', 1,
       '${hash}', '${timestamp}');

    INSERT INTO p_session_participants
      (id, organization_id, event_id, session_id, contact_id, role, sort_order,
       confirmed_state, source_record_id, source_version, source_content_hash,
       projected_at)
    VALUES
      ('session_participant_one', 'org_one', 'evt_one', 'session_one',
       'contact_one', 'speaker', 1, 'confirmed', 'rec_session_participant_one',
       1, '${hash}', '${timestamp}');

    INSERT INTO p_schedule_slots
      (id, organization_id, event_id, session_id, room_id, starts_at, ends_at,
       version, source_record_id, source_version, source_content_hash, projected_at)
    VALUES
      ('slot_one', 'org_one', 'evt_one', 'session_one', 'room_one',
       '2026-08-09T01:00:00.000Z', '2026-08-09T01:30:00.000Z', 1,
       'rec_slot_one', 1, '${hash}', '${timestamp}');

    INSERT INTO p_task_definitions
      (id, organization_id, event_id, name, type, required_default,
       approval_required, source_record_id, source_version, source_content_hash,
       projected_at)
    VALUES
      ('task_definition_one', 'org_one', 'evt_one', 'Profile', 'form', 1, 0,
       'rec_task_definition_one', 1, '${hash}', '${timestamp}');

    WITH RECURSIVE counter(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM counter WHERE value < 500
    )
    INSERT INTO p_submissions
      (id, organization_id, event_id, form_id, form_version, friendly_id,
       submitter_contact_id, title, status, submitted_at, updated_at,
       source_record_id, source_version, source_content_hash, projected_at)
    SELECT
      'submission_' || printf('%04d', value), 'org_one', 'evt_one', 'form_one', 1,
      'SUB-' || printf('%04d', value), 'contact_one',
      'Submission ' || value, 'submitted', '${timestamp}', '${timestamp}',
      'rec_submission_' || printf('%04d', value), 1, '${hash}', '${timestamp}'
    FROM counter;

    INSERT INTO p_reviews
      (id, organization_id, event_id, submission_id, reviewer_id, status,
       conflict, updated_at, source_record_id, source_version,
       source_content_hash, projected_at)
    VALUES
      ('review_one', 'org_one', 'evt_one', 'submission_0001', 'reviewer_one',
       'assigned', 0, '${timestamp}', 'rec_review_one', 1, '${hash}', '${timestamp}');
  `);
});

afterAll(() => {
  if (persistence.startsWith(tmpdir())) {
    rmSync(persistence, { force: true, recursive: true });
  }
});

describe("D1 operational foundation", () => {
  it("keeps a preexisting active tenant fail-closed until reconciliation marks it ready", () => {
    const migrationPersistence = mkdtempSync(
      join(tmpdir(), "opensession-d1-readiness-migration-"),
    );
    const executeMigration = (arguments_: readonly string[]) =>
      execFileSync(wrangler, arguments_, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CI: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    try {
      for (const filename of [
        "0001_operational_foundation.sql",
        "0002_auth_security.sql",
        "0003_operational_observability.sql",
        "0003_private_uploads.sql",
        "0004_email_delivery.sql",
        "0005_auth_browser_binding.sql",
        "0006_authority_completion.sql",
        "0007_public_abuse_protection.sql",
      ]) {
        executeMigration([
          "d1",
          "execute",
          "DB",
          "--local",
          "--persist-to",
          migrationPersistence,
          "--file",
          resolve(root, "migrations", filename),
          "--config",
          config,
        ]);
      }
      executeMigration([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        migrationPersistence,
        "--command",
        `INSERT INTO tenant_registry (
           organization_id, base_key, source_record_id, status, created_at, updated_at
         ) VALUES (
           'org_preexisting', 'base_preview', 'rec_preexisting', 'active',
           '${timestamp}', '${timestamp}'
         )`,
        "--config",
        config,
      ]);
      executeMigration([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        migrationPersistence,
        "--file",
        resolve(root, "migrations", "0008_tenant_authority_readiness.sql"),
        "--config",
        config,
      ]);
      const output = executeMigration([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        migrationPersistence,
        "--command",
        `SELECT authority_ready_at, authority_roster_version
         FROM tenant_registry WHERE organization_id = 'org_preexisting'`,
        "--config",
        config,
        "--json",
      ]);
      const result = (JSON.parse(output) as D1Execution[]).at(-1);
      expect(result?.results).toEqual([
        { authority_ready_at: null, authority_roster_version: 1 },
      ]);
    } finally {
      rmSync(migrationPersistence, { force: true, recursive: true });
    }
  }, 60_000);

  it("upgrades cache invalidation and CFP state without breaking the previous Worker", () => {
    const migrationPersistence = mkdtempSync(
      join(tmpdir(), "opensession-d1-cache-migration-"),
    );
    const executeMigration = (arguments_: readonly string[]) =>
      execFileSync(wrangler, arguments_, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CI: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    try {
      for (const filename of [
        "0001_operational_foundation.sql",
        "0002_auth_security.sql",
        "0003_operational_observability.sql",
        "0003_private_uploads.sql",
        "0004_email_delivery.sql",
        "0005_auth_browser_binding.sql",
        "0006_authority_completion.sql",
        "0007_public_abuse_protection.sql",
        "0008_tenant_authority_readiness.sql",
        "0009_authority_cache_invalidation.sql",
      ]) {
        executeMigration([
          "d1",
          "execute",
          "DB",
          "--local",
          "--persist-to",
          migrationPersistence,
          "--file",
          resolve(root, "migrations", filename),
          "--config",
          config,
        ]);
      }
      executeMigration([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        migrationPersistence,
        "--command",
        `INSERT INTO tenant_registry (
           organization_id, base_key, source_record_id, status, created_at, updated_at
         ) VALUES (
           'org_cache_upgrade', 'base_preview', 'rec_cache_upgrade', 'active',
           '${timestamp}', '${timestamp}'
         );
         INSERT INTO p_events (
           id, organization_id, name, slug, timezone, status, source_record_id,
           source_version, source_content_hash, projected_at
         ) VALUES (
           'evt_cache_upgrade', 'org_cache_upgrade', 'Upgrade event',
           'upgrade-event', 'UTC', 'draft', 'rec_evt_cache_upgrade', 1,
           '${hash}', '${timestamp}'
         );
         INSERT INTO p_contacts (
           id, organization_id, email_normalized, display_name, source_record_id,
           source_version, source_content_hash, projected_at
         ) VALUES (
           'contact_cache_upgrade', 'org_cache_upgrade', 'speaker@example.test',
           'Speaker', 'rec_contact_cache_upgrade', 1, '${hash}', '${timestamp}'
         );
         INSERT INTO p_forms (
           id, organization_id, event_id, name, status, version,
           source_record_id, source_version, source_content_hash, projected_at
         ) VALUES (
           'form_cache_upgrade', 'org_cache_upgrade', 'evt_cache_upgrade', 'CFP',
           'published', 1, 'rec_form_cache_upgrade', 1, '${hash}', '${timestamp}'
         );
         INSERT INTO p_tracks (
           id, organization_id, event_id, name, sort_order, source_record_id,
           source_version, source_content_hash, projected_at
         ) VALUES (
           'track_cache_upgrade', 'org_cache_upgrade', 'evt_cache_upgrade', 'AI',
           1, 'rec_track_cache_upgrade', 1, '${hash}', '${timestamp}'
         );
         INSERT INTO p_submissions (
           id, organization_id, event_id, form_id, form_version, friendly_id,
           submitter_contact_id, title, track_id, status, updated_at,
           source_record_id, source_version, source_content_hash, projected_at
         ) VALUES (
           'submission_cache_upgrade', 'org_cache_upgrade', 'evt_cache_upgrade',
           'form_cache_upgrade', 1, 'SUB-UPGRADE', 'contact_cache_upgrade',
           'Upgrade submission', 'track_cache_upgrade', 'draft', '${timestamp}',
           'rec_submission_cache_upgrade', 1, '${hash}', '${timestamp}'
         );
         INSERT INTO authority_cache_invalidations (
           organization_id, event_id, status, attempt_count, created_at,
           updated_at, published_at
         ) VALUES (
           'org_cache_upgrade', 'evt_cache_upgrade', 'published', 1,
           '${timestamp}', '${timestamp}', '${timestamp}'
         );`,
        "--config",
        config,
      ]);
      executeMigration([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        migrationPersistence,
        "--file",
        resolve(root, "migrations", "0010_cache_invalidation_delivery.sql"),
        "--config",
        config,
      ]);
      executeMigration([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        migrationPersistence,
        "--file",
        resolve(root, "migrations", "0011_cfp_authoritative_routing.sql"),
        "--config",
        config,
      ]);
      executeMigration([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        migrationPersistence,
        "--file",
        resolve(root, "migrations", "0012_cfp_submission_reservations.sql"),
        "--config",
        config,
      ]);
      executeMigration([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        migrationPersistence,
        "--command",
        `INSERT INTO provider_messages (
           id, organization_id, event_id, campaign_id, contact_id, kind,
           provider, idempotency_key, recipient_hash, payload_hash,
           template_id, template_version, delivery_mode, status, created_at,
           updated_at
         ) VALUES
         (
           'msg_upgrade_queued', 'org_cache_upgrade', 'evt_cache_upgrade',
           'campaign_upgrade_queued', 'contact_cache_upgrade', 'campaign',
           'resend', 'msg_upgrade_queued', '${hash}', '${hash}',
           'template_submission_receipt', 1, 'sink', 'queued', '${timestamp}',
           '${timestamp}'
         ),
         (
           'msg_upgrade_sent', 'org_cache_upgrade', 'evt_cache_upgrade',
           'campaign_upgrade_sent', 'contact_cache_upgrade', 'campaign',
           'resend', 'msg_upgrade_sent', '${hash}', '${hash}',
           'template_submission_receipt', 1, 'sink', 'sent', '${timestamp}',
           '${timestamp}'
         );`,
        "--config",
        config,
      ]);
      executeMigration([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        migrationPersistence,
        "--file",
        resolve(root, "migrations", "0013_email_queue_handoff.sql"),
        "--config",
        config,
      ]);
      executeMigration([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        migrationPersistence,
        "--file",
        resolve(root, "migrations", "0014_schedule_domain.sql"),
        "--config",
        config,
      ]);
      const handoffOutput = executeMigration([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        migrationPersistence,
        "--command",
        `SELECT id, status, queue_handoff_lease_expires_at,
                queue_handed_off_at, queue_payload_json
         FROM provider_messages
         WHERE id IN ('msg_upgrade_queued', 'msg_upgrade_sent')
         ORDER BY id;
         SELECT name FROM pragma_index_list('provider_messages')
         WHERE name IN (
           'idx_provider_messages_cfp_receipt_identity',
           'idx_provider_messages_queue_handoff'
         ) ORDER BY name;`,
        "--config",
        config,
        "--json",
      ]);
      const handoffResults = JSON.parse(handoffOutput) as D1Execution[];
      expect(handoffResults.at(-2)?.results).toEqual([
        {
          id: "msg_upgrade_queued",
          queue_handed_off_at: null,
          queue_handoff_lease_expires_at: null,
          queue_payload_json: null,
          status: "queued",
        },
        {
          id: "msg_upgrade_sent",
          queue_handed_off_at: null,
          queue_handoff_lease_expires_at: null,
          queue_payload_json: null,
          status: "sent",
        },
      ]);
      expect(handoffResults.at(-1)?.results).toEqual([
        { name: "idx_provider_messages_cfp_receipt_identity" },
        { name: "idx_provider_messages_queue_handoff" },
      ]);
      const output = executeMigration([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        migrationPersistence,
        "--command",
        `INSERT INTO authority_cache_invalidations (
           organization_id, event_id, status, attempt_count, created_at, updated_at
         ) VALUES (
           'org_cache_upgrade', 'evt_cache_upgrade', 'pending', 0,
           '${timestamp}', '2026-08-09T00:00:00.000Z'
         )
         ON CONFLICT (organization_id, event_id) DO UPDATE SET
           status = 'pending', updated_at = excluded.updated_at,
           published_at = NULL, last_error_code = NULL;
         UPDATE authority_cache_invalidations
         SET status = 'published', published_at = '${timestamp}'
         WHERE organization_id = 'org_cache_upgrade'
           AND event_id = 'evt_cache_upgrade';
         SELECT status, invalidation_version, attempt_count, published_at,
                enqueued_at, processed_at
         FROM authority_cache_invalidations
         WHERE organization_id = 'org_cache_upgrade'
           AND event_id = 'evt_cache_upgrade';`,
        "--config",
        config,
        "--json",
      ]);
      const result = (JSON.parse(output) as D1Execution[]).at(-1);
      expect(result?.results).toEqual([
        {
          attempt_count: 1,
          enqueued_at: timestamp,
          invalidation_version: 2,
          processed_at: null,
          published_at: timestamp,
          status: "published",
        },
      ]);
      const cfpOutput = executeMigration([
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        migrationPersistence,
        "--command",
        `SELECT tracks.cfp_aliases_json, submissions.draft_json
         FROM p_tracks AS tracks
         JOIN p_submissions AS submissions
           ON submissions.organization_id = tracks.organization_id
          AND submissions.event_id = tracks.event_id
          AND submissions.track_id = tracks.id
         WHERE tracks.id = 'track_cache_upgrade';`,
        "--config",
        config,
        "--json",
      ]);
      const cfpResult = (JSON.parse(cfpOutput) as D1Execution[]).at(-1);
      expect(cfpResult?.results).toEqual([
        { cfp_aliases_json: "[]", draft_json: "{}" },
      ]);
    } finally {
      rmSync(migrationPersistence, { force: true, recursive: true });
    }
  }, 60_000);

  it("applies every required strict authority, delivery, audit, and projection table", () => {
    const requiredTables = [
      "airtable_webhooks",
      "authority_cache_invalidations",
      "authority_source_records",
      "authority_traces",
      "api_keys",
      "audit_events",
      "auth_sessions",
      "auth_session_secrets",
      "cfp_submission_reservations",
      "event_memberships",
      "email_delivery_attempts",
      "email_provider_events",
      "email_suppressions",
      "demo_snapshot_items",
      "demo_snapshot_runs",
      "external_mappings",
      "file_objects",
      "file_upload_intents",
      "idempotency_keys",
      "integration_runs",
      "magic_link_tokens",
      "magic_link_scopes",
      "magic_link_request_limits",
      "organization_memberships",
      "operational_events",
      "outbox_events",
      "p_contacts",
      "p_campaigns",
      "p_criteria",
      "p_event_contacts",
      "p_email_templates",
      "p_events",
      "p_form_fields",
      "p_form_rules",
      "p_formats",
      "p_forms",
      "p_external_mappings",
      "p_integrations",
      "p_messages",
      "p_organizations",
      "p_resources",
      "p_review_scores",
      "p_reviews",
      "p_rooms",
      "p_schedule_slots",
      "p_session_participants",
      "p_sessions",
      "p_submission_answers",
      "p_submission_participants",
      "p_submissions",
      "p_sync_runs",
      "p_task_assignments",
      "p_task_definitions",
      "p_tracks",
      "portal_grants",
      "projection_repairs",
      "projection_scan_runs",
      "projection_watermarks",
      "provider_messages",
      "schedule_command_receipts",
      "tenant_registry",
      "users",
      "webhook_deliveries",
      "webhook_delivery_attempts",
      "webhook_endpoints",
      "workflow_runs",
    ];
    const tables = query<{ name: string; strict: number }>(
      "PRAGMA table_list;",
    ).results.filter(
      ({ name }) => !name.startsWith("_cf_") && !name.startsWith("sqlite_"),
    );
    const tableNames = tables.map(({ name }) => name);

    expect(tableNames).toEqual(expect.arrayContaining(requiredTables));
    expect(
      tables
        .filter(({ name }) => requiredTables.includes(name))
        .every(({ strict }) => strict === 1),
    ).toBe(true);
    const eventColumns = query<{ name: string }>(
      "PRAGMA table_info(p_events);",
    ).results.map(({ name }) => name);
    expect(eventColumns).toEqual(
      expect.arrayContaining([
        "schedule_days_json",
        "schedule_snap_minutes",
        "schedule_version",
      ]),
    );
  });

  it("enforces canonical CFP routes and durable draft JSON", () => {
    query(`
      UPDATE p_tracks
      SET cfp_selection = 'AI Engineering',
          cfp_aliases_json = '["Track A"]',
          route_key = 'ai-engineering',
          submission_track = 'AI Engineering',
          default_reviewer_group_id = 'group-ai-engineering'
      WHERE id = 'track_one';

      UPDATE p_submissions
      SET draft_json = '{"step":"submission"}',
          default_reviewer_group_id = 'group-ai-engineering',
          track_id = 'track_one'
      WHERE id = 'submission_0001';
    `);

    expect(
      query<{
        cfp_aliases_json: string;
        default_reviewer_group_id: string;
        draft_json: string;
        route_key: string;
      }>(`
        SELECT tracks.cfp_aliases_json, tracks.route_key,
               submissions.default_reviewer_group_id, submissions.draft_json
        FROM p_tracks AS tracks
        JOIN p_submissions AS submissions
          ON submissions.organization_id = tracks.organization_id
         AND submissions.event_id = tracks.event_id
         AND submissions.track_id = tracks.id
        WHERE tracks.id = 'track_one' AND submissions.id = 'submission_0001';
      `).results,
    ).toEqual([
      {
        cfp_aliases_json: '["Track A"]',
        default_reviewer_group_id: "group-ai-engineering",
        draft_json: '{"step":"submission"}',
        route_key: "ai-engineering",
      },
    ]);

    expectSqlFailure(
      `UPDATE p_tracks SET cfp_aliases_json = '{}' WHERE id = 'track_one';`,
    );
    expectSqlFailure(
      `UPDATE p_submissions SET draft_json = '[]' WHERE id = 'submission_0001';`,
    );
    expectSqlFailure(`
      INSERT INTO p_tracks
        (id, organization_id, event_id, name, sort_order, cfp_selection,
         route_key, source_record_id, source_version, source_content_hash,
         projected_at)
      VALUES
        ('track_duplicate_selection', 'org_one', 'evt_one', 'Duplicate selection',
         2, 'ai engineering', 'different-route', 'rec_track_duplicate_selection',
         1, '${hash}', '${timestamp}');
    `);
    expectSqlFailure(`
      INSERT INTO p_tracks
        (id, organization_id, event_id, name, sort_order, cfp_selection,
         route_key, source_record_id, source_version, source_content_hash,
         projected_at)
      VALUES
        ('track_duplicate_route', 'org_one', 'evt_one', 'Duplicate route', 2,
         'Evaluation', 'AI-ENGINEERING', 'rec_track_duplicate_route', 1,
         '${hash}', '${timestamp}');
    `);
  });

  it("enforces tenant-scoped foreign keys, JSON shapes, hashes, and cursor state", () => {
    query(`
      INSERT INTO schedule_command_receipts
        (event_id, command_id, command_hash, state, operations_json,
         result_json, created_at, updated_at)
      VALUES
        ('evt_one', 'command_one', '${hash}', 'applying', '[]', '{}',
         '${timestamp}', '${timestamp}');
    `);
    expectSqlFailure(
      "UPDATE p_events SET schedule_snap_minutes = 7 WHERE id = 'evt_one';",
    );
    expectSqlFailure(
      "UPDATE p_events SET schedule_days_json = '{}' WHERE id = 'evt_one';",
    );
    expectSqlFailure(
      "UPDATE schedule_command_receipts SET operations_json = '{}' WHERE event_id = 'evt_one' AND command_id = 'command_one';",
    );
    expectSqlFailure(`
      INSERT INTO organization_memberships
        (id, organization_id, user_id, role, created_at, updated_at)
      VALUES
        ('membership_bad', 'org_missing', 'usr_one', 'owner', '${timestamp}', '${timestamp}');
    `);
    expectSqlFailure(`
      INSERT INTO p_event_contacts
        (id, organization_id, event_id, contact_id, roles_json, portal_state,
         source_record_id, source_version, source_content_hash, projected_at)
      VALUES
        ('cross_tenant', 'org_one', 'evt_one', 'contact_two', '["speaker"]',
         'active', 'rec_cross_tenant', 1, '${hash}', '${timestamp}');
    `);
    expectSqlFailure(`
      INSERT INTO outbox_events
        (id, organization_id, aggregate_type, aggregate_id, event_type,
         idempotency_key, payload_json, available_at, created_at, updated_at)
      VALUES
        ('outbox_bad_json', 'org_one', 'event', 'evt_one', 'event.updated',
         'bad-json', '[]', '${timestamp}', '${timestamp}', '${timestamp}');
    `);
    expectSqlFailure(`
      INSERT INTO auth_sessions
        (id, user_id, token_hash, created_at, expires_at, last_seen_at)
      VALUES
        ('session_bad_hash', 'usr_one', 'not-a-hash', '${timestamp}', '${timestamp}', '${timestamp}');
    `);
    expectSqlFailure(`
      INSERT INTO magic_link_tokens
        (id, email_normalized, user_id, purpose, token_hash, redirect_path,
         created_at, expires_at, delivery_state)
      VALUES
        ('link_bad_state', 'owner@example.test', 'usr_one', 'sign_in', '${hash}',
         '/', '${timestamp}', '${timestamp}', 'sent-ish');
    `);
    expectSqlFailure(`
      INSERT INTO provider_messages
        (id, organization_id, event_id, campaign_id, contact_id, kind, provider,
         idempotency_key, recipient_hash, template_id, template_version,
         delivery_mode, status, created_at, updated_at)
      VALUES
        ('email_${hash}', 'org_one', 'evt_one', 'campaign_bad', 'contact_one',
         'campaign', 'resend', 'email_${hash}', '${hash}', 'template_one', 1,
         'sink', 'queued', '${timestamp}', '${timestamp}');
    `);
    expectSqlFailure(`
      INSERT INTO airtable_webhooks
        (base_key, webhook_id, mac_secret_ciphertext, mac_secret_nonce,
         mac_secret_key_version, committed_cursor, in_flight_cursor,
         notification_url, expiration_time, status, created_at, updated_at)
      VALUES
        ('base_bad_cursor', 'webhook_bad_cursor', 'ciphertext', 'nonce', 1,
         10, 9, 'https://example.test/airtable', '${timestamp}', 'active',
         '${timestamp}', '${timestamp}');
    `);
  });

  it("deduplicates nullable repairs and event-level task assignments", () => {
    query(`
      INSERT INTO projection_repairs
        (id, repair_key, organization_id, provider, base_key, operation,
         provider_table_key, reason_code, available_at, created_at, updated_at)
      VALUES
        ('repair_one', 'repair:org_one:full', 'org_one', 'airtable',
         'base_preview', 'full_scan', 'events', 'scheduled_scan', '${timestamp}',
         '${timestamp}', '${timestamp}');

      INSERT INTO p_task_assignments
        (id, organization_id, event_id, definition_id, contact_id, required,
         status, updated_at, source_record_id, source_version,
         source_content_hash, projected_at)
      VALUES
        ('assignment_one', 'org_one', 'evt_one', 'task_definition_one',
         'contact_one', 1, 'not_started', '${timestamp}', 'rec_assignment_one',
         1, '${hash}', '${timestamp}');
    `);

    expectSqlFailure(`
      INSERT INTO projection_repairs
        (id, repair_key, organization_id, provider, base_key, operation,
         provider_table_key, reason_code, available_at, created_at, updated_at)
      VALUES
        ('repair_two', 'repair:org_one:full', 'org_one', 'airtable',
         'base_preview', 'full_scan', 'events', 'scheduled_scan', '${timestamp}',
         '${timestamp}', '${timestamp}');
    `);
    expectSqlFailure(`
      INSERT INTO p_task_assignments
        (id, organization_id, event_id, definition_id, contact_id, required,
         status, updated_at, source_record_id, source_version,
         source_content_hash, projected_at)
      VALUES
        ('assignment_two', 'org_one', 'evt_one', 'task_definition_one',
         'contact_one', 1, 'not_started', '${timestamp}', 'rec_assignment_two',
         1, '${hash}', '${timestamp}');
    `);
  });

  it("tracks cache invalidations through generation-safe delivery states", () => {
    query(`
      INSERT INTO authority_cache_invalidations (
        organization_id, event_id, status, invalidation_version,
        attempt_count, created_at, updated_at
      ) VALUES (
        'org_one', 'evt_one', 'pending', 1, 0, '${timestamp}', '${timestamp}'
      );

      UPDATE authority_cache_invalidations
      SET status = 'enqueued', attempt_count = 1, enqueued_at = '${timestamp}'
      WHERE organization_id = 'org_one' AND event_id = 'evt_one'
        AND invalidation_version = 1;

      UPDATE authority_cache_invalidations
      SET status = 'processed', processed_at = '${timestamp}'
      WHERE organization_id = 'org_one' AND event_id = 'evt_one'
        AND invalidation_version = 1;
    `);

    expect(
      query<{
        attempt_count: number;
        invalidation_version: number;
        status: string;
      }>(`
        SELECT status, invalidation_version, attempt_count
        FROM authority_cache_invalidations
        WHERE organization_id = 'org_one' AND event_id = 'evt_one';
      `).results,
    ).toEqual([
      { attempt_count: 1, invalidation_version: 1, status: "processed" },
    ]);
    expectSqlFailure(`
      UPDATE authority_cache_invalidations SET status = 'sent'
      WHERE organization_id = 'org_one' AND event_id = 'evt_one';
    `);
    expectSqlFailure(`
      UPDATE authority_cache_invalidations SET invalidation_version = 0
      WHERE organization_id = 'org_one' AND event_id = 'evt_one';
    `);
  });

  it("keeps audit events and webhook attempt evidence append-only", () => {
    query(`
      INSERT INTO audit_events
        (id, organization_id, event_id, actor_type, action, entity_type,
         entity_id, request_id, redaction_version, safe_diff_json, created_at)
      VALUES
        ('audit_one', 'org_one', 'evt_one', 'system', 'projection.repaired',
         'event', 'evt_one', 'request_one', 1, '{}', '${timestamp}');

      INSERT INTO outbox_events
        (id, organization_id, event_id, aggregate_type, aggregate_id, event_type,
         idempotency_key, payload_json, available_at, created_at, updated_at)
      VALUES
        ('outbox_one', 'org_one', 'evt_one', 'event', 'evt_one', 'event.updated',
         'outbox-one', '{}', '${timestamp}', '${timestamp}', '${timestamp}');

      INSERT INTO webhook_endpoints
        (id, organization_id, event_id, url, secret_ciphertext, secret_nonce,
         secret_key_version, event_types_json, created_by_user_id, created_at,
         updated_at)
      VALUES
        ('endpoint_one', 'org_one', 'evt_one', 'https://example.test/hooks',
         'ciphertext', 'nonce', 1, '["event.updated"]', 'usr_one', '${timestamp}',
         '${timestamp}');

      INSERT INTO webhook_deliveries
        (id, organization_id, endpoint_id, outbox_event_id, event_type,
         payload_json, payload_hash, status, available_at, created_at, updated_at)
      VALUES
        ('delivery_one', 'org_one', 'endpoint_one', 'outbox_one', 'event.updated',
         '{}', '${hash}', 'retry', '${timestamp}', '${timestamp}', '${timestamp}');

      INSERT INTO webhook_delivery_attempts
        (delivery_id, organization_id, attempt_number, request_id, started_at,
         finished_at, outcome, error_code)
      VALUES
        ('delivery_one', 'org_one', 1, 'request_delivery_one', '${timestamp}',
         '${timestamp}', 'retry', 'remote_503');

      INSERT INTO operational_events
        (dedupe_key, event_type, level, outcome, organization_id, event_id,
         request_id, occurred_at, expires_at)
      VALUES
        ('request:request_one:completed', 'request.completed', 'info', 'success',
         'org_one', 'evt_one', 'request_one', '${timestamp}',
         '2099-01-01T00:00:00.000Z');

      INSERT INTO provider_messages
        (id, organization_id, event_id, campaign_id, contact_id, kind, provider,
         provider_message_id, idempotency_key, recipient_hash, payload_hash,
         template_id, template_version, delivery_mode, status, attempt_count,
         created_at, updated_at, sent_at)
      VALUES
        ('email_${hash}', 'org_one', 'evt_one', 'campaign_one', 'contact_one',
         'campaign', 'resend', 'resend_one', 'email_${hash}', '${hash}', '${hash}',
         'template_one', 1, 'sink', 'sent', 1, '${timestamp}', '${timestamp}',
         '${timestamp}');

      INSERT INTO email_delivery_attempts
        (message_id, organization_id, attempt_number, delivery_mode, outcome,
         provider_message_id, started_at, finished_at)
      VALUES
        ('email_${hash}', 'org_one', 1, 'sink', 'sent', 'resend_one',
         '${timestamp}', '${timestamp}');

      INSERT INTO email_provider_events
        (provider_event_id, organization_id, message_id, provider_message_id,
         event_type, normalized_status, payload_hash, occurred_at, received_at)
      VALUES
        ('provider_event_one', 'org_one', 'email_${hash}', 'resend_one',
         'email.delivered', 'delivered', '${hash}', '${timestamp}', '${timestamp}');
    `);

    expectSqlFailure(
      "UPDATE audit_events SET action = 'tampered' WHERE id = 'audit_one';",
    );
    expectSqlFailure("DELETE FROM audit_events WHERE id = 'audit_one';");
    expectSqlFailure(
      "UPDATE webhook_delivery_attempts SET outcome = 'delivered' WHERE delivery_id = 'delivery_one' AND attempt_number = 1;",
    );
    expectSqlFailure(
      "DELETE FROM webhook_delivery_attempts WHERE delivery_id = 'delivery_one' AND attempt_number = 1;",
    );
    expectSqlFailure(
      "UPDATE operational_events SET outcome = 'failure' WHERE dedupe_key = 'request:request_one:completed';",
    );
    expectSqlFailure(
      "DELETE FROM operational_events WHERE dedupe_key = 'request:request_one:completed';",
    );
    expectSqlFailure(
      `UPDATE email_delivery_attempts SET outcome = 'failed' WHERE message_id = 'email_${hash}' AND attempt_number = 1;`,
    );
    expectSqlFailure(
      `DELETE FROM email_delivery_attempts WHERE message_id = 'email_${hash}' AND attempt_number = 1;`,
    );
    expectSqlFailure(
      "UPDATE email_provider_events SET normalized_status = 'failed' WHERE provider_event_id = 'provider_event_one';",
    );
    expectSqlFailure(
      "DELETE FROM email_provider_events WHERE provider_event_id = 'provider_event_one';",
    );
  });

  it("exposes bounded aggregate-safe operational metrics", () => {
    const metrics = query<{ metric: string; value: number }>(
      "SELECT metric, value FROM operational_metric_snapshot ORDER BY metric;",
    ).results;

    expect(metrics.map(({ metric }) => metric)).toEqual([
      "conflict.review.open.count",
      "email.failed.count",
      "export.failed.count",
      "operational.error.last_15_minutes.count",
      "projection.public.max_age_seconds",
      "queue.outbox.oldest_age_seconds",
      "queue.outbox.retry_count",
      "queue.projection_repair.oldest_age_seconds",
      "queue.projection_repair.retry_count",
      "queue.webhook.oldest_age_seconds",
      "queue.webhook.retry_count",
      "workflow.failed.count",
    ]);
    expect(metrics.every(({ value }) => Number.isFinite(value))).toBe(true);
  });

  it("retains tombstones while active read queries exclude them", () => {
    query(`
      INSERT INTO p_resources
        (id, organization_id, event_id, title, sanitized_html, status,
         source_record_id, source_version, source_content_hash, projected_at,
         source_deleted_at)
      VALUES
        ('resource_active', 'org_one', 'evt_one', 'Active', '<p>Active</p>',
         'published', 'rec_resource_active', 1, '${hash}', '${timestamp}', NULL),
        ('resource_deleted', 'org_one', 'evt_one', 'Deleted', '<p>Deleted</p>',
         'archived', 'rec_resource_deleted', 1, '${hash}', '${timestamp}', '${timestamp}');
    `);
    const active = query<{ id: string }>(`
      SELECT id
      FROM p_resources
      WHERE organization_id = 'org_one'
        AND event_id = 'evt_one'
        AND source_deleted_at IS NULL
      ORDER BY id;
    `).results;

    expect(active).toEqual([{ id: "resource_active" }]);
    expect(
      query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM p_resources WHERE source_deleted_at IS NOT NULL;",
      ).results,
    ).toEqual([{ count: 1 }]);
  });

  it("uses tenant-first indexes for representative queues, conflicts, and audit reads", () => {
    const plans = queryAll<{ detail: string }>(`
      EXPLAIN QUERY PLAN
      SELECT id FROM p_submissions
      WHERE organization_id = 'org_one' AND event_id = 'evt_one'
        AND status = 'submitted' AND source_deleted_at IS NULL
      ORDER BY submitted_at DESC, id DESC LIMIT 50;

      EXPLAIN QUERY PLAN
      SELECT id FROM p_reviews
      WHERE organization_id = 'org_one' AND event_id = 'evt_one'
        AND reviewer_id = 'reviewer_one' AND status = 'assigned'
        AND source_deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC LIMIT 50;

      EXPLAIN QUERY PLAN
      SELECT id FROM p_schedule_slots
      WHERE organization_id = 'org_one' AND event_id = 'evt_one'
        AND room_id = 'room_one' AND starts_at < '2026-08-09T02:00:00.000Z'
        AND ends_at > '2026-08-09T01:00:00.000Z'
        AND source_deleted_at IS NULL;

      EXPLAIN QUERY PLAN
      SELECT slots.id
      FROM p_session_participants AS participants
      JOIN p_schedule_slots AS slots
        ON slots.organization_id = participants.organization_id
       AND slots.event_id = participants.event_id
       AND slots.session_id = participants.session_id
      WHERE participants.organization_id = 'org_one'
        AND participants.event_id = 'evt_one'
        AND participants.contact_id = 'contact_one'
        AND participants.source_deleted_at IS NULL
        AND slots.starts_at < '2026-08-09T02:00:00.000Z'
        AND slots.ends_at > '2026-08-09T01:00:00.000Z'
        AND slots.source_deleted_at IS NULL;

      EXPLAIN QUERY PLAN
      SELECT id FROM p_task_assignments
      WHERE organization_id = 'org_one' AND event_id = 'evt_one'
        AND contact_id = 'contact_one' AND status = 'not_started'
        AND source_deleted_at IS NULL
      ORDER BY due_at, id LIMIT 50;

      EXPLAIN QUERY PLAN
      SELECT id FROM outbox_events
      WHERE status = 'pending' AND available_at <= '${timestamp}'
      ORDER BY available_at, created_at, id LIMIT 100;

      EXPLAIN QUERY PLAN
      SELECT id FROM projection_repairs
      WHERE status = 'pending' AND available_at <= '${timestamp}'
      ORDER BY available_at, created_at, id LIMIT 100;

      EXPLAIN QUERY PLAN
      SELECT event_id FROM authority_cache_invalidations
      WHERE status IN ('pending', 'published')
         OR (status = 'enqueued' AND updated_at <= '${timestamp}')
      ORDER BY updated_at, organization_id, event_id LIMIT 50;

      EXPLAIN QUERY PLAN
      SELECT id FROM audit_events
      WHERE organization_id = 'org_one' AND event_id = 'evt_one'
      ORDER BY created_at DESC, id DESC LIMIT 100;

      EXPLAIN QUERY PLAN
      SELECT provider_record_id FROM authority_source_records
      WHERE base_key = 'base_preview' AND provider_table_key = 'sessions'
        AND organization_id = 'org_one' AND source_deleted_at IS NULL
        AND COALESCE(last_seen_scan_id, '') <> 'scan_current';

      EXPLAIN QUERY PLAN
      SELECT id FROM p_email_templates
      WHERE organization_id = 'org_one' AND event_id = 'evt_one'
        AND status = 'active' AND source_deleted_at IS NULL
      ORDER BY name LIMIT 50;

      EXPLAIN QUERY PLAN
      SELECT phase, outcome FROM authority_traces
      WHERE organization_id = 'org_one' AND request_id = 'request_one'
      ORDER BY occurred_at;

      EXPLAIN QUERY PLAN
      SELECT item_key FROM demo_snapshot_items
      WHERE organization_id = 'org_one' AND reset_run_id = 'reset_one'
        AND state = 'pending' AND item_type = 'record_upsert'
      ORDER BY item_key;
    `);
    const details = plans.flatMap(({ results }) =>
      results.map(({ detail }) => detail),
    );
    const combined = details.join("\n");

    expect(combined).toContain("idx_p_submissions_status_time");
    expect(combined).toContain("idx_p_reviews_reviewer_queue");
    expect(combined).toContain("idx_p_schedule_room_time");
    expect(combined).toContain("idx_p_session_participants_contact");
    expect(combined).toContain("idx_p_task_assignments_contact");
    expect(combined).toContain("idx_outbox_drain");
    expect(combined).toContain("idx_projection_repairs_drain");
    expect(combined).toContain("authority_cache_invalidations_pending");
    expect(combined).toContain("idx_audit_event_time");
    expect(combined).toContain("authority_source_records_scan");
    expect(combined).toContain("p_email_templates_event_active");
    expect(combined).toContain("authority_traces_request");
    expect(combined).toContain("demo_snapshot_items_pending");
    expect(details.filter((detail) => detail.startsWith("SCAN "))).toEqual([]);
  });

  it("keeps an indexed 500-row submission queue inside its D1 query budget", () => {
    const execution = query<{ id: string }>(`
      SELECT id FROM p_submissions
      WHERE organization_id = 'org_one' AND event_id = 'evt_one'
        AND status = 'submitted' AND source_deleted_at IS NULL
      ORDER BY submitted_at DESC, id DESC LIMIT 50;
    `);

    expect(execution.results).toHaveLength(50);
    expect(execution.meta.duration).toBeLessThanOrEqual(10);
  });
});
