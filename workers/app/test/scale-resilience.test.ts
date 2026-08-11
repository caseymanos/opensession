import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import type { PublicApiPaginationQuery } from "@sessionbox-killer/contracts/public-api";
import { createTestHarness } from "wrangler";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { D1OrganizerSubmissionRepository } from "../src/organizer-submissions/repository";
import type { AuthenticatedApiKey } from "../src/public-api/key-service";
import { PublicApiRepository } from "../src/public-api/repository";
import { ReadinessDashboardService } from "../src/readiness/service";
import type * as PublicApiRuntime from "./fixtures/public-api-runtime";

const counts = {
  contacts: 1_000,
  roomsByTracks: 100,
  sessions: 250,
  submissions: 500,
  tasks: 5_000,
} as const;
const event = {
  eventId: "evt_scale",
  eventRecordId: "rec_evt_scale",
  organizationId: "org_scale",
  slug: "production-like-scale",
  timezone: "America/Los_Angeles",
} as const;
const hash = "a".repeat(64);
const timestamp = "2026-08-11T18:00:00.000Z";
const commonReadBudgetMilliseconds = 500;
const readinessBudgetMilliseconds = 750;
const sampleCount = 20;
const server = createTestHarness({
  workers: [
    {
      configPath: "workers/app/test/fixtures/public-api-runtime.wrangler.jsonc",
    },
  ],
});
const runtime = server.getWorker<Env, typeof PublicApiRuntime>(
  "opensession-public-api-runtime",
);
const apiKey: AuthenticatedApiKey = {
  eventId: event.eventId,
  id: "key_scale",
  name: "Scale acceptance",
  organizationId: event.organizationId,
  prefix: "osk_scale",
  scopes: [
    "events:read",
    "sessions:read",
    "speakers:read",
    "submissions:read",
    "tasks:read",
  ],
};
const page: PublicApiPaginationQuery = { cursor: undefined, limit: 100 };

let database: D1Database;

function buildSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function percentile(
  values: readonly number[],
  percentileValue: number,
): number {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * percentileValue) - 1);
  return Math.round((ordered[index] ?? 0) * 100) / 100;
}

async function samples(operation: () => Promise<unknown>): Promise<number[]> {
  await operation();
  const durations: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = performance.now();
    await operation();
    durations.push(performance.now() - startedAt);
  }
  return durations;
}

interface ViteManifestEntry {
  file?: string;
  imports?: string[];
}

function bundleSize(entryKeys: readonly string[]): number {
  const distribution = resolve(process.cwd(), "apps/web/dist");
  const manifest = JSON.parse(
    readFileSync(resolve(distribution, ".vite/manifest.json"), "utf8"),
  ) as Record<string, ViteManifestEntry>;
  const visited = new Set<string>();
  const files = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    const entry = manifest[key];
    if (!entry) throw new Error(`Bundle manifest entry is missing: ${key}`);
    if (entry.file?.endsWith(".js")) files.add(entry.file);
    for (const imported of entry.imports ?? []) visit(imported);
  };
  for (const key of entryKeys) visit(key);
  return [...files].reduce(
    (total, file) =>
      total + gzipSync(readFileSync(resolve(distribution, file))).byteLength,
    0,
  );
}

async function seed(): Promise<void> {
  const sql = `
    INSERT INTO tenant_registry (
      organization_id, base_key, source_record_id, status,
      created_at, updated_at, authority_ready_at
    ) VALUES (
      '${event.organizationId}', 'local:appScale', 'rec_org_scale', 'active',
      '${timestamp}', '${timestamp}', '${timestamp}'
    );

    INSERT INTO p_events (
      id, organization_id, name, slug, timezone, status, published_version,
      source_record_id, source_version, source_content_hash, projected_at,
      schedule_days_json, schedule_snap_minutes, schedule_version
    ) VALUES (
      '${event.eventId}', '${event.organizationId}', 'Scale acceptance',
      '${event.slug}', '${event.timezone}', 'published', 1,
      '${event.eventRecordId}', 1, '${hash}', '${timestamp}',
      '["2026-10-14"]', 15, 1
    );

    INSERT INTO p_forms (
      id, organization_id, event_id, name, status, version, source_record_id,
      source_version, source_content_hash, projected_at
    ) VALUES (
      'form_scale', '${event.organizationId}', '${event.eventId}', 'CFP',
      'published', 1, 'rec_form_scale', 1, '${hash}', '${timestamp}'
    );

    WITH RECURSIVE counter(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 10
    )
    INSERT INTO p_tracks (
      id, organization_id, event_id, name, sort_order, source_record_id,
      source_version, source_content_hash, projected_at
    ) SELECT
      'track_' || printf('%02d', value), '${event.organizationId}',
      '${event.eventId}', 'Track ' || value, value,
      'rec_track_' || printf('%02d', value), 1, '${hash}', '${timestamp}'
    FROM counter;

    WITH RECURSIVE counter(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 10
    )
    INSERT INTO p_rooms (
      id, organization_id, event_id, name, capacity, sort_order,
      source_record_id, source_version, source_content_hash, projected_at
    ) SELECT
      'room_' || printf('%02d', value), '${event.organizationId}',
      '${event.eventId}', 'Room ' || value, 300, value,
      'rec_room_' || printf('%02d', value), 1, '${hash}', '${timestamp}'
    FROM counter;

    INSERT INTO p_formats (
      id, organization_id, event_id, name, default_duration_minutes,
      sort_order, source_record_id, source_version, source_content_hash,
      projected_at
    ) VALUES (
      'format_scale', '${event.organizationId}', '${event.eventId}', 'Talk',
      30, 1, 'rec_format_scale', 1, '${hash}', '${timestamp}'
    );

    WITH RECURSIVE counter(value) AS (
      SELECT 1 UNION ALL
      SELECT value + 1 FROM counter WHERE value < ${counts.contacts}
    )
    INSERT INTO p_contacts (
      id, organization_id, email_normalized, display_name, title, company,
      source_record_id, source_version, source_content_hash, projected_at
    ) SELECT
      'contact_' || printf('%04d', value), '${event.organizationId}',
      'speaker_' || printf('%04d', value) || '@example.test',
      'Speaker ' || printf('%04d', value), 'Engineer', 'Scale Labs',
      'rec_contact_' || printf('%04d', value), 1, '${hash}', '${timestamp}'
    FROM counter;

    INSERT INTO p_event_contacts (
      id, organization_id, event_id, contact_id, roles_json, portal_state,
      required_total, required_complete, overdue_count, speaker_ready,
      source_record_id, source_version, source_content_hash, projected_at
    ) SELECT
      'membership_' || substr(id, 9), organization_id, '${event.eventId}', id,
      '["speaker"]', 'active', 5, 0, 5, 0,
      'rec_membership_' || substr(id, 9), 1, '${hash}', '${timestamp}'
    FROM p_contacts WHERE organization_id = '${event.organizationId}';

    WITH RECURSIVE counter(value) AS (
      SELECT 1 UNION ALL
      SELECT value + 1 FROM counter WHERE value < ${counts.submissions}
    )
    INSERT INTO p_submissions (
      id, organization_id, event_id, form_id, form_version, friendly_id,
      submitter_contact_id, title, track_id, status, submitted_at, updated_at,
      source_record_id, source_version, source_content_hash, projected_at
    ) SELECT
      'submission_' || printf('%04d', value), '${event.organizationId}',
      '${event.eventId}', 'form_scale', 1, 'SUB-' || printf('%04d', value),
      'contact_' || printf('%04d', value), 'Submission ' || value,
      'track_' || printf('%02d', ((value - 1) % 10) + 1),
      CASE WHEN value % 2 = 0 THEN 'submitted' ELSE 'in_review' END,
      '${timestamp}', printf('2026-08-11T18:%02d:%02d.000Z',
        (value / 60) % 60, value % 60),
      'rec_submission_' || printf('%04d', value), 1, '${hash}', '${timestamp}'
    FROM counter;

    WITH RECURSIVE counter(value) AS (
      SELECT 1 UNION ALL
      SELECT value + 1 FROM counter WHERE value < ${counts.sessions}
    )
    INSERT INTO p_sessions (
      id, organization_id, event_id, friendly_id, title, status, track_id,
      format_id, duration_minutes, is_public, updated_at, source_record_id,
      source_version, source_content_hash, projected_at
    ) SELECT
      'session_' || printf('%04d', value), '${event.organizationId}',
      '${event.eventId}', 'SES-' || printf('%04d', value),
      'Session ' || value, 'scheduled',
      'track_' || printf('%02d', ((value - 1) % 10) + 1), 'format_scale',
      30, 1, '${timestamp}', 'rec_session_' || printf('%04d', value),
      1, '${hash}', '${timestamp}'
    FROM counter;

    INSERT INTO p_session_participants (
      id, organization_id, event_id, session_id, contact_id, role, sort_order,
      confirmed_state, source_record_id, source_version, source_content_hash,
      projected_at
    ) SELECT
      'participant_' || substr(id, 9), organization_id, event_id, id,
      'contact_' || substr(id, 9), 'speaker', 1, 'confirmed',
      'rec_participant_' || substr(id, 9), 1, '${hash}', '${timestamp}'
    FROM p_sessions WHERE event_id = '${event.eventId}';

    INSERT INTO p_schedule_slots (
      id, organization_id, event_id, session_id, room_id, starts_at, ends_at,
      version, published_version, source_record_id, source_version,
      source_content_hash, projected_at
    ) SELECT
      'slot_' || substr(id, 9), organization_id, event_id, id,
      'room_' || printf('%02d', ((CAST(substr(id, 9) AS INTEGER) - 1) % 10) + 1),
      printf('2026-10-14T%02d:%02d:00.000Z',
        8 + ((CAST(substr(id, 9) AS INTEGER) - 1) / 20) % 12,
        ((CAST(substr(id, 9) AS INTEGER) - 1) % 2) * 30),
      printf('2026-10-14T%02d:%02d:00.000Z',
        8 + ((CAST(substr(id, 9) AS INTEGER) - 1) / 20) % 12 +
          (((CAST(substr(id, 9) AS INTEGER) - 1) % 2) * 30 + 30) / 60,
        (((CAST(substr(id, 9) AS INTEGER) - 1) % 2) * 30 + 30) % 60),
      1, 1, 'rec_slot_' || substr(id, 9), 1, '${hash}', '${timestamp}'
    FROM p_sessions WHERE event_id = '${event.eventId}';

    WITH RECURSIVE counter(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 5
    )
    INSERT INTO p_task_definitions (
      id, organization_id, event_id, name, type, required_default,
      approval_required, source_record_id, source_version, source_content_hash,
      projected_at
    ) SELECT
      'definition_' || printf('%02d', value), '${event.organizationId}',
      '${event.eventId}', 'Task ' || value, 'ack', 1, 0,
      'rec_definition_' || printf('%02d', value), 1, '${hash}', '${timestamp}'
    FROM counter;

    INSERT INTO p_task_assignments (
      id, organization_id, event_id, definition_id, contact_id, due_at,
      required, status, updated_at, source_record_id, source_version,
      source_content_hash, projected_at
    ) SELECT
      'assignment_' || substr(contact.id, 9) || '_' || substr(definition.id, 12),
      contact.organization_id, '${event.eventId}', definition.id, contact.id,
      '2026-10-01T18:00:00.000Z', 1, 'not_started', '${timestamp}',
      'rec_assignment_' || substr(contact.id, 9) || '_' || substr(definition.id, 12),
      1, '${hash}', '${timestamp}'
    FROM p_contacts AS contact CROSS JOIN p_task_definitions AS definition
    WHERE contact.organization_id = '${event.organizationId}'
      AND definition.event_id = '${event.eventId}';

    INSERT INTO projection_watermarks (
      organization_id, provider, base_key, table_key, updated_at
    ) SELECT '${event.organizationId}', 'airtable', 'local:appScale', value,
             '${timestamp}'
      FROM json_each('["contacts","event_contacts","reviews","review_scores",\
        "submissions","tracks","criteria","submission_answers",\
        "submission_notes","submission_participants","sessions",\
        "session_participants","task_definitions","task_assignments",\
        "schedule_slots"]');
  `;
  const statements = sql
    .split(";")
    .map((statement) => statement.replaceAll(/\s+/gu, " ").trim())
    .filter(Boolean)
    .map((statement) => database.prepare(statement));
  await database.batch(statements);
}

async function plan(sql: string): Promise<string> {
  const result = await database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{
    detail: string;
  }>();
  return result.results.map(({ detail }) => detail).join("\n");
}

beforeAll(async () => {
  await server.listen();
  await runtime.applyD1Migrations("DB");
  database = (await runtime.getEnv()).DB;
  await seed();
}, 60_000);

const skipScaleResilience = process.env.CI_COVERAGE_SHARD === "1";
const scaleResilienceTitle =
  "RAL-80 production-like scale and budget acceptance";

describe.skipIf(skipScaleResilience)(scaleResilienceTitle, () => {
  it("re-enters the workflow after a durable wait with bounded retry policy", async () => {
    vi.doMock("cloudflare:workers", () => ({
      WorkflowEntrypoint: class {
        readonly mocked = true;
      },
    }));
    const { TaskReminderWorkflow } =
      await import("../src/lifecycle/task-reminder-workflow");
    const evaluations: {
      name: string;
      retries: { backoff: string; delay: string; limit: number };
    }[] = [];
    const sleeps: { at: string; name: string }[] = [];
    const outcomes = [
      { nextWakeAt: "2026-10-01T18:00:00.000Z" },
      { nextWakeAt: null },
    ];
    const step = {
      async do(
        name: string,
        options: {
          retries: { backoff: string; delay: string; limit: number };
        },
      ) {
        evaluations.push({ name, retries: options.retries });
        return outcomes.shift() ?? { nextWakeAt: null };
      },
      async sleepUntil(name: string, at: Date) {
        sleeps.push({ at: at.toISOString(), name });
      },
    } as unknown as Parameters<typeof TaskReminderWorkflow.prototype.run>[1];
    const result = await TaskReminderWorkflow.prototype.run.call(
      { env: {} } as unknown as InstanceType<typeof TaskReminderWorkflow>,
      {
        payload: { workflow_id: "workflow_scale_resume" },
      } as Parameters<typeof TaskReminderWorkflow.prototype.run>[0],
      step,
    );
    vi.doUnmock("cloudflare:workers");

    expect(result).toEqual({ processed: true });
    expect(evaluations).toEqual([
      {
        name: "evaluate-current-assignments-0",
        retries: { backoff: "exponential", delay: "10 seconds", limit: 5 },
      },
      {
        name: "evaluate-current-assignments-1",
        retries: { backoff: "exponential", delay: "10 seconds", limit: 5 },
      },
    ]);
    expect(sleeps).toEqual([
      {
        at: "2026-10-01T18:00:00.000Z",
        name: "wait-for-current-due-0",
      },
    ]);
  });

  it("holds exact seed cardinalities, warm read budgets, bundles, and index plans", async () => {
    const cardinalities = await database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM p_submissions WHERE event_id = ?1) submissions,
           (SELECT COUNT(*) FROM p_contacts WHERE organization_id = ?2) contacts,
           (SELECT COUNT(*) FROM p_sessions WHERE event_id = ?1) sessions,
           (SELECT COUNT(*) FROM p_rooms WHERE event_id = ?1) *
             (SELECT COUNT(*) FROM p_tracks WHERE event_id = ?1) "roomsByTracks",
           (SELECT COUNT(*) FROM p_task_assignments WHERE event_id = ?1) tasks`,
      )
      .bind(event.eventId, event.organizationId)
      .first<typeof counts>();
    expect(cardinalities).toEqual(counts);

    const organizer = new D1OrganizerSubmissionRepository(database);
    const api = new PublicApiRepository(database, "p".repeat(32));
    const readiness = new ReadinessDashboardService(
      database,
      () => new Date("2026-08-12T18:00:00.000Z"),
    );
    const operations = {
      apiSessions: () => api.listSessions(apiKey, event.eventId, page),
      apiSpeakers: () => api.listSpeakers(apiKey, event.eventId, page),
      apiSubmissions: () => api.listSubmissions(apiKey, event.eventId, page),
      apiTasks: () => api.listTasks(apiKey, event.eventId, page),
      organizer: () =>
        organizer.list(
          { eventId: event.eventId, organizationId: event.organizationId },
          { pageSize: 50, status: "submitted" },
        ),
      readiness: () =>
        readiness.read(event, {
          due: "all",
          page: 1,
          page_size: 25,
          portal: "all",
          q: "",
          readiness: "all",
          task: "all",
          track: "all",
        }),
    };
    const latencyEntries: [string, number][] = [];
    for (const [name, operation] of Object.entries(operations)) {
      latencyEntries.push([name, percentile(await samples(operation), 0.95)]);
    }
    const latencies = Object.fromEntries(latencyEntries) as Record<
      keyof typeof operations,
      number
    >;
    for (const name of [
      "apiSessions",
      "apiSpeakers",
      "apiSubmissions",
      "apiTasks",
      "organizer",
    ] as const) {
      expect(latencies[name], `${name} p95`).toBeLessThanOrEqual(
        commonReadBudgetMilliseconds,
      );
    }
    expect(latencies.readiness, "readiness p95").toBeLessThanOrEqual(
      readinessBudgetMilliseconds,
    );

    const plans = {
      organizer: await plan(`
        SELECT id FROM p_submissions
        WHERE organization_id = '${event.organizationId}'
          AND event_id = '${event.eventId}' AND status = 'submitted'
          AND source_deleted_at IS NULL
        ORDER BY updated_at DESC, id DESC LIMIT 51
      `),
      submissions: await plan(`
        SELECT id FROM p_submissions
        WHERE organization_id = '${event.organizationId}'
          AND event_id = '${event.eventId}' AND source_deleted_at IS NULL
        ORDER BY updated_at DESC, id DESC LIMIT 101
      `),
      tasks: await plan(`
        SELECT id FROM p_task_assignments
        WHERE organization_id = '${event.organizationId}'
          AND event_id = '${event.eventId}' AND source_deleted_at IS NULL
        ORDER BY updated_at DESC, id DESC LIMIT 101
      `),
    };
    expect(plans.organizer).toContain("idx_p_submissions_status_activity");
    expect(plans.submissions).toContain("idx_p_submissions_activity");
    expect(plans.tasks).toContain("ux_p_task_assignment_scope");

    const bundles = {
      organizerGzipBytes: bundleSize(["index.html", "src/WorkspaceApp.tsx"]),
      publicGzipBytes: bundleSize([
        "index.html",
        "src/public/PublicSchedule.tsx",
        "src/public/PublicSpeakers.tsx",
      ]),
    };
    expect(bundles.publicGzipBytes).toBeLessThanOrEqual(170 * 1_024);
    expect(bundles.organizerGzipBytes).toBeLessThanOrEqual(300 * 1_024);

    const receipt = {
      artifact: "ral-80-scale-resilience",
      budgets: {
        commonReadP95Milliseconds: commonReadBudgetMilliseconds,
        organizerGzipBytes: 300 * 1_024,
        publicGzipBytes: 170 * 1_024,
        readinessP95Milliseconds: readinessBudgetMilliseconds,
      },
      build: buildSha(),
      bundles,
      conditions: {
        database: "full migration chain on workerd local D1",
        samples: sampleCount,
        seed: cardinalities,
        warmupRequests: 1,
      },
      latenciesP95Milliseconds: latencies,
      queryPlans: plans,
      url: "http://opensession-public-api-runtime.local",
    };
    const receiptDirectory = resolve("coverage");
    mkdirSync(receiptDirectory, { recursive: true });
    writeFileSync(
      resolve(receiptDirectory, "ral-80-scale-resilience.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    console.info(JSON.stringify(receipt));
  }, 60_000);
});
