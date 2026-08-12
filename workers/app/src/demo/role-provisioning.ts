import {
  demoRoleProvisioningPlanResponseSchema,
  demoRoleProvisioningResponseSchema,
  type DemoProvisionedRole,
  type DemoRoleProvisioningPlanResponse,
  type DemoRoleProvisioningRequest,
  type DemoRoleProvisioningResponse,
} from "@sessionbox-killer/contracts";
import {
  demoEventId,
  demoEventName,
  demoEventSlug,
  demoOrganizationId,
  demoRoleProvisioningConfirmation,
} from "@sessionbox-killer/domain";

import { fingerprint, sha256Hex } from "../auth/crypto.js";

export type DemoRoleProvisioningErrorCode =
  | "idempotency_conflict"
  | "identity_collision"
  | "invalid_confirmation"
  | "missing_fixture_identity"
  | "stale_fixture_fingerprint"
  | "transaction_failed";

export class DemoRoleProvisioningError extends Error {
  readonly code: DemoRoleProvisioningErrorCode;

  constructor(code: DemoRoleProvisioningErrorCode, message: string) {
    super(message);
    this.name = "DemoRoleProvisioningError";
    this.code = code;
  }
}

interface FixtureEntitySnapshot {
  readonly contactId: string;
  readonly contactSourceHash: string;
  readonly contactSourceVersion: number;
  readonly displayName: string;
  readonly eventContactId: string;
  readonly eventContactSourceHash: string;
  readonly eventContactSourceVersion: number;
  readonly role: "reviewer" | "speaker";
}

interface FixtureSnapshot {
  readonly eventSourceHash: string;
  readonly eventSourceVersion: number;
  readonly fingerprint: string;
  readonly reviewer: FixtureEntitySnapshot;
  readonly speaker: FixtureEntitySnapshot;
}

interface FixtureEventRow {
  authority_ready_at: string | null;
  is_demo: number;
  name: string;
  slug: string;
  source_content_hash: string;
  source_version: number;
  tenant_status: string;
}

interface FixtureIdentityRow {
  contact_id: string;
  contact_source_hash: string;
  contact_source_version: number;
  display_name: string;
  event_contact_id: string;
  event_contact_source_hash: string;
  event_contact_source_version: number;
  portal_state: string;
}

interface ProvisionedIdentity {
  readonly displayName: string;
  readonly email: string;
  readonly identityId: string;
  readonly role: DemoProvisionedRole;
}

interface IdempotencyRow {
  original_response_json: string | null;
  request_hash: string;
  status: string;
}

interface UserCollisionRow {
  display_name: string | null;
  email_normalized: string;
  id: string;
  status: string;
}

interface MembershipCollisionRow {
  contact_id: string | null;
  event_id: string;
  organization_id: string;
  revoked_at: string | null;
  role: string;
  user_id: string;
}

interface ContactBindingCollisionRow {
  contact_id: string;
  event_id: string;
  organization_id: string;
  relationship_role: string;
  revoked_at: string | null;
  user_id: string;
}

const operation = "demo.role-identities.provision";
const idempotencyLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
const organizerDisplayName = `${demoEventName} Organizer`;
const reviewerContactId = "contact_reviewer_01";
const reviewerEventContactId = "event_contact_reviewer_01";
const reviewerDisplayName = "Riley Reviewer";
const speakerContactId = "contact_speaker_01";
const speakerEventContactId = "event_contact_speaker_01";
const speakerDisplayName = "Ada Chen";
const orderedRoles = ["organizer", "reviewer", "speaker"] as const;

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

export class DemoRoleProvisioningService {
  readonly #database: D1Database;
  readonly #hashPepper: string;
  readonly #now: () => Date;

  constructor(options: {
    database: D1Database;
    hashPepper: string;
    now?: () => Date;
  }) {
    this.#database = options.database;
    this.#hashPepper = options.hashPepper;
    this.#now = options.now ?? (() => new Date());
  }

  async plan(): Promise<DemoRoleProvisioningPlanResponse> {
    const fixture = await this.#fixtureSnapshot();
    return demoRoleProvisioningPlanResponseSchema.parse({
      confirmation: demoRoleProvisioningConfirmation,
      event_id: demoEventId,
      fixture_fingerprint: fixture.fingerprint,
      identities: [
        { display_name: organizerDisplayName, role: "organizer" },
        { display_name: reviewerDisplayName, role: "reviewer" },
        { display_name: speakerDisplayName, role: "speaker" },
      ],
      organization_id: demoOrganizationId,
    });
  }

  async provision(input: {
    actorId: string;
    commandId: string;
    request: DemoRoleProvisioningRequest;
  }): Promise<DemoRoleProvisioningResponse> {
    const identities = await this.#identities(input.request);
    const requestHash = await fingerprint(
      canonicalJson({
        confirmation: input.request.confirmation,
        fixture_fingerprint: input.request.fixture_fingerprint,
        identities: identities.map(({ email, role }) => ({ email, role })),
      }),
      this.#hashPepper,
      "demo-role-provisioning-request",
    );
    const replay = await this.#replay(input.commandId, requestHash);
    if (replay) return replay;

    if (input.request.confirmation !== demoRoleProvisioningConfirmation) {
      throw new DemoRoleProvisioningError(
        "invalid_confirmation",
        "Demo role provisioning confirmation did not match the current plan.",
      );
    }
    const fixture = await this.#fixtureSnapshot();
    if (input.request.fixture_fingerprint !== fixture.fingerprint) {
      throw new DemoRoleProvisioningError(
        "stale_fixture_fingerprint",
        "The demo role provisioning plan is stale.",
      );
    }
    await this.#assertNoCollisions(identities);

    const now = this.#now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + idempotencyLifetimeMs,
    ).toISOString();
    const organizer = this.#identity(identities, "organizer");
    const reviewer = this.#identity(identities, "reviewer");
    const speaker = this.#identity(identities, "speaker");
    const commandDigest = await sha256Hex(
      `${demoOrganizationId}\u0000${demoEventId}\u0000${input.commandId}`,
    );
    const auditEventId = `aud_drp_${commandDigest.slice(0, 24)}`;
    const entityId = `drp_${commandDigest.slice(0, 24)}`;
    const membershipIds = await Promise.all(
      [organizer, reviewer].map(async ({ identityId, role }) => {
        const digest = await sha256Hex(
          `${demoOrganizationId}\u0000${demoEventId}\u0000${identityId}\u0000${role}`,
        );
        return `em_drp_${digest.slice(0, 24)}`;
      }),
    );
    const response = demoRoleProvisioningResponseSchema.parse({
      receipt: {
        audit_event_id: auditEventId,
        fixture_fingerprint: fixture.fingerprint,
        identities: identities.map(({ identityId, role }) => ({
          identity_id: identityId,
          role,
        })),
        outcome: "applied",
      },
    });

    const exactStateGuard = `
      EXISTS (
        SELECT 1 FROM p_events event
        JOIN tenant_registry tenant
          ON tenant.organization_id = event.organization_id
         AND tenant.status = 'active'
         AND tenant.authority_ready_at IS NOT NULL
        WHERE event.organization_id = ?1 AND event.id = ?2
          AND event.is_demo = 1 AND event.slug = ?3 AND event.name = ?4
          AND event.source_version = ?5 AND event.source_content_hash = ?6
          AND event.source_deleted_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM p_contacts contact
        JOIN p_event_contacts membership
          ON membership.organization_id = contact.organization_id
         AND membership.event_id = ?2
         AND membership.contact_id = contact.id
         AND membership.id = ?7
         AND membership.source_version = ?8
         AND membership.source_content_hash = ?9
         AND membership.portal_state IN ('invited', 'active')
         AND membership.source_deleted_at IS NULL
        WHERE contact.organization_id = ?1 AND contact.id = ?10
          AND contact.display_name = ?11
          AND contact.source_version = ?12
          AND contact.source_content_hash = ?13
          AND contact.source_deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM json_each(membership.roles_json)
            WHERE json_each.value = 'reviewer'
          )
      )
      AND EXISTS (
        SELECT 1 FROM p_contacts contact
        JOIN p_event_contacts membership
          ON membership.organization_id = contact.organization_id
         AND membership.event_id = ?2
         AND membership.contact_id = contact.id
         AND membership.id = ?14
         AND membership.source_version = ?15
         AND membership.source_content_hash = ?16
         AND membership.portal_state IN ('invited', 'active')
         AND membership.source_deleted_at IS NULL
        WHERE contact.organization_id = ?1 AND contact.id = ?17
          AND contact.display_name = ?18
          AND contact.source_version = ?19
          AND contact.source_content_hash = ?20
          AND contact.source_deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM json_each(membership.roles_json)
            WHERE json_each.value = 'speaker'
          )
      )
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = ?21 AND email_normalized = ?22 COLLATE NOCASE
          AND display_name = ?23 AND status = 'active'
      )
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = ?24 AND email_normalized = ?25 COLLATE NOCASE
          AND display_name = ?26 AND status = 'active'
      )
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = ?27 AND email_normalized = ?28 COLLATE NOCASE
          AND display_name = ?29 AND status = 'active'
      )
      AND EXISTS (
        SELECT 1 FROM event_memberships
        WHERE organization_id = ?1 AND event_id = ?2 AND user_id = ?21
          AND role = 'organizer' AND contact_id IS NULL AND revoked_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM event_memberships
        WHERE organization_id = ?1 AND event_id = ?2 AND user_id = ?24
          AND role = 'reviewer' AND contact_id = ?10 AND revoked_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM event_contact_identity_bindings
        WHERE organization_id = ?1 AND event_id = ?2 AND user_id = ?27
          AND contact_id = ?17 AND relationship_role = 'speaker'
          AND revoked_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM organization_memberships
        WHERE user_id IN (?21, ?24, ?27)
      )
      AND NOT EXISTS (
        SELECT 1 FROM event_memberships
        WHERE user_id IN (?21, ?24, ?27)
          AND NOT (
            organization_id = ?1 AND event_id = ?2 AND revoked_at IS NULL
            AND (
              (user_id = ?21 AND role = 'organizer' AND contact_id IS NULL)
              OR (user_id = ?24 AND role = 'reviewer' AND contact_id = ?10)
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM event_contact_identity_bindings
        WHERE user_id IN (?21, ?24, ?27)
          AND NOT (
            organization_id = ?1 AND event_id = ?2 AND user_id = ?27
            AND contact_id = ?17 AND relationship_role = 'speaker'
            AND revoked_at IS NULL
          )
      )
      AND EXISTS (
        SELECT 1 FROM organization_memberships owner_membership
        JOIN users owner_user ON owner_user.id = owner_membership.user_id
        WHERE owner_membership.organization_id = ?1
          AND owner_membership.user_id = ?31
          AND owner_membership.role = 'owner'
          AND owner_membership.revoked_at IS NULL
          AND owner_user.status = 'active'
      )`;
    const guardBindings = [
      demoOrganizationId,
      demoEventId,
      demoEventSlug,
      demoEventName,
      fixture.eventSourceVersion,
      fixture.eventSourceHash,
      fixture.reviewer.eventContactId,
      fixture.reviewer.eventContactSourceVersion,
      fixture.reviewer.eventContactSourceHash,
      fixture.reviewer.contactId,
      fixture.reviewer.displayName,
      fixture.reviewer.contactSourceVersion,
      fixture.reviewer.contactSourceHash,
      fixture.speaker.eventContactId,
      fixture.speaker.eventContactSourceVersion,
      fixture.speaker.eventContactSourceHash,
      fixture.speaker.contactId,
      fixture.speaker.displayName,
      fixture.speaker.contactSourceVersion,
      fixture.speaker.contactSourceHash,
      organizer.identityId,
      organizer.email,
      organizer.displayName,
      reviewer.identityId,
      reviewer.email,
      reviewer.displayName,
      speaker.identityId,
      speaker.email,
      speaker.displayName,
    ] as const;

    try {
      await this.#database.batch([
        this.#database
          .prepare(
            `INSERT OR IGNORE INTO users (
               id, email_normalized, display_name, status, created_at, updated_at
             ) VALUES
               (?1, ?2, ?3, 'active', ?10, ?10),
               (?4, ?5, ?6, 'active', ?10, ?10),
               (?7, ?8, ?9, 'active', ?10, ?10)`,
          )
          .bind(
            organizer.identityId,
            organizer.email,
            organizer.displayName,
            reviewer.identityId,
            reviewer.email,
            reviewer.displayName,
            speaker.identityId,
            speaker.email,
            speaker.displayName,
            nowIso,
          ),
        this.#database
          .prepare(
            `INSERT OR IGNORE INTO event_memberships (
               id, organization_id, event_id, user_id, contact_id, role,
               created_at, updated_at
             ) VALUES
               (?1, ?3, ?4, ?5, NULL, 'organizer', ?8, ?8),
               (?2, ?3, ?4, ?6, ?7, 'reviewer', ?8, ?8)`,
          )
          .bind(
            membershipIds[0],
            membershipIds[1],
            demoOrganizationId,
            demoEventId,
            organizer.identityId,
            reviewer.identityId,
            reviewerContactId,
            nowIso,
          ),
        this.#database
          .prepare(
            `INSERT OR IGNORE INTO event_contact_identity_bindings (
               organization_id, event_id, user_id, contact_id,
               relationship_role, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'speaker', ?5, ?5)`,
          )
          .bind(
            demoOrganizationId,
            demoEventId,
            speaker.identityId,
            speakerContactId,
            nowIso,
          ),
        this.#database
          .prepare(
            `INSERT INTO audit_events (
               id, organization_id, event_id, actor_type, actor_id, action,
               entity_type, entity_id, request_id, command_id,
               redaction_version, safe_diff_json, metadata_json, created_at
             ) VALUES (
               ?30, ?1, ?2, 'user',
               CASE WHEN ${exactStateGuard} THEN ?31 ELSE NULL END,
               'demo.role-identities.provisioned',
               'demo_role_identity_provisioning', ?32, ?33, ?33, 1,
               ?34, ?35, ?36
             )`,
          )
          .bind(
            ...guardBindings,
            auditEventId,
            input.actorId,
            entityId,
            input.commandId,
            canonicalJson({
              bound_count: 3,
              roles: orderedRoles,
              state: "active",
            }),
            canonicalJson({
              fixture_fingerprint: fixture.fingerprint,
              version: 1,
            }),
            nowIso,
          ),
        this.#database
          .prepare(
            `INSERT INTO idempotency_keys (
               tenant_key, operation, command_id, request_hash, status,
               entity_type, entity_id, original_response_status,
               original_response_json, created_at, updated_at, expires_at
             ) VALUES (
               ?1, ?2, ?3, ?4, 'committed',
               'demo_role_identity_provisioning', ?5, 200, ?6, ?7, ?7, ?8
             )`,
          )
          .bind(
            demoOrganizationId,
            operation,
            input.commandId,
            requestHash,
            entityId,
            canonicalJson(response),
            nowIso,
            expiresAt,
          ),
      ]);
    } catch {
      const racedReplay = await this.#replay(input.commandId, requestHash);
      if (racedReplay) return racedReplay;
      const currentFixture = await this.#fixtureSnapshot();
      if (currentFixture.fingerprint !== fixture.fingerprint) {
        throw new DemoRoleProvisioningError(
          "stale_fixture_fingerprint",
          "The demo role provisioning plan changed during the transaction.",
        );
      }
      try {
        await this.#assertNoCollisions(identities);
      } catch (error) {
        if (error instanceof DemoRoleProvisioningError) throw error;
      }
      throw new DemoRoleProvisioningError(
        "transaction_failed",
        "Demo role identities were not provisioned.",
      );
    }
    return response;
  }

  async #fixtureSnapshot(): Promise<FixtureSnapshot> {
    const [eventResult, reviewerResult, speakerResult] =
      await this.#database.batch<FixtureEventRow | FixtureIdentityRow>([
        this.#database
          .prepare(
            `SELECT event.name, event.slug, event.is_demo,
                    event.source_version, event.source_content_hash,
                    tenant.status AS tenant_status,
                    tenant.authority_ready_at
             FROM p_events event
             JOIN tenant_registry tenant
               ON tenant.organization_id = event.organization_id
             WHERE event.organization_id = ?1 AND event.id = ?2
               AND event.source_deleted_at IS NULL
             LIMIT 1`,
          )
          .bind(demoOrganizationId, demoEventId),
        this.#fixtureIdentityStatement(
          reviewerContactId,
          reviewerEventContactId,
          reviewerDisplayName,
          "reviewer",
        ),
        this.#fixtureIdentityStatement(
          speakerContactId,
          speakerEventContactId,
          speakerDisplayName,
          "speaker",
        ),
      ]);
    const event = eventResult?.results[0] as FixtureEventRow | undefined;
    const reviewer = reviewerResult?.results[0] as
      FixtureIdentityRow | undefined;
    const speaker = speakerResult?.results[0] as FixtureIdentityRow | undefined;
    if (
      !event ||
      event.tenant_status !== "active" ||
      event.authority_ready_at === null ||
      event.is_demo !== 1 ||
      event.name !== demoEventName ||
      event.slug !== demoEventSlug ||
      !reviewer ||
      !speaker
    ) {
      throw new DemoRoleProvisioningError(
        "missing_fixture_identity",
        "The exact demo event role fixtures are unavailable.",
      );
    }
    const reviewerSnapshot = this.#fixtureEntitySnapshot(reviewer, "reviewer");
    const speakerSnapshot = this.#fixtureEntitySnapshot(speaker, "speaker");
    const snapshot = {
      event: {
        id: demoEventId,
        name: event.name,
        organizationId: demoOrganizationId,
        slug: event.slug,
        sourceHash: event.source_content_hash,
        sourceVersion: event.source_version,
      },
      reviewer: reviewerSnapshot,
      speaker: speakerSnapshot,
      version: 1,
    };
    return {
      eventSourceHash: event.source_content_hash,
      eventSourceVersion: event.source_version,
      fingerprint: await sha256Hex(canonicalJson(snapshot)),
      reviewer: reviewerSnapshot,
      speaker: speakerSnapshot,
    };
  }

  #fixtureIdentityStatement(
    contactId: string,
    eventContactId: string,
    displayName: string,
    role: "reviewer" | "speaker",
  ): D1PreparedStatement {
    return this.#database
      .prepare(
        `SELECT contact.id AS contact_id, contact.display_name,
                contact.source_version AS contact_source_version,
                contact.source_content_hash AS contact_source_hash,
                membership.id AS event_contact_id,
                membership.portal_state,
                membership.source_version AS event_contact_source_version,
                membership.source_content_hash AS event_contact_source_hash
         FROM p_contacts contact
         JOIN p_event_contacts membership
           ON membership.organization_id = contact.organization_id
          AND membership.event_id = ?2
          AND membership.contact_id = contact.id
          AND membership.id = ?4
          AND membership.source_deleted_at IS NULL
         WHERE contact.organization_id = ?1 AND contact.id = ?3
           AND contact.display_name = ?5
           AND contact.source_deleted_at IS NULL
           AND membership.portal_state IN ('invited', 'active')
           AND EXISTS (
             SELECT 1 FROM json_each(membership.roles_json)
             WHERE json_each.value = ?6
           )
         LIMIT 1`,
      )
      .bind(
        demoOrganizationId,
        demoEventId,
        contactId,
        eventContactId,
        displayName,
        role,
      );
  }

  #fixtureEntitySnapshot(
    row: FixtureIdentityRow,
    role: "reviewer" | "speaker",
  ): FixtureEntitySnapshot {
    return {
      contactId: row.contact_id,
      contactSourceHash: row.contact_source_hash,
      contactSourceVersion: row.contact_source_version,
      displayName: row.display_name,
      eventContactId: row.event_contact_id,
      eventContactSourceHash: row.event_contact_source_hash,
      eventContactSourceVersion: row.event_contact_source_version,
      role,
    };
  }

  async #identities(
    request: DemoRoleProvisioningRequest,
  ): Promise<readonly ProvisionedIdentity[]> {
    const byRole = new Map(
      request.identities.map((identity) => [identity.role, identity]),
    );
    return Promise.all(
      orderedRoles.map(async (role) => {
        const identity = byRole.get(role);
        if (!identity) {
          throw new DemoRoleProvisioningError(
            "identity_collision",
            "The exact demo role set is required.",
          );
        }
        const email = identity.email.toLowerCase();
        const digest = await fingerprint(
          `${role}\u0000${email}`,
          this.#hashPepper,
          "demo-role-identity",
        );
        return {
          displayName:
            role === "organizer"
              ? organizerDisplayName
              : role === "reviewer"
                ? reviewerDisplayName
                : speakerDisplayName,
          email,
          identityId: `usr_drp_${digest.slice(0, 24)}`,
          role,
        };
      }),
    );
  }

  #identity(
    identities: readonly ProvisionedIdentity[],
    role: DemoProvisionedRole,
  ): ProvisionedIdentity {
    const identity = identities.find((candidate) => candidate.role === role);
    if (!identity) {
      throw new DemoRoleProvisioningError(
        "identity_collision",
        "The exact demo role set is required.",
      );
    }
    return identity;
  }

  async #assertNoCollisions(
    identities: readonly ProvisionedIdentity[],
  ): Promise<void> {
    const organizer = this.#identity(identities, "organizer");
    const reviewer = this.#identity(identities, "reviewer");
    const speaker = this.#identity(identities, "speaker");
    const collisionResults = await this.#database.batch<
      | UserCollisionRow
      | { user_id: string }
      | MembershipCollisionRow
      | ContactBindingCollisionRow
    >([
      this.#database
        .prepare(
          `SELECT id, email_normalized, display_name, status FROM users
             WHERE email_normalized IN (?1, ?2, ?3) COLLATE NOCASE
                OR id IN (?4, ?5, ?6)`,
        )
        .bind(
          organizer.email,
          reviewer.email,
          speaker.email,
          organizer.identityId,
          reviewer.identityId,
          speaker.identityId,
        ),
      this.#database
        .prepare(
          `SELECT user_id FROM organization_memberships
             WHERE user_id IN (?1, ?2, ?3)`,
        )
        .bind(organizer.identityId, reviewer.identityId, speaker.identityId),
      this.#database
        .prepare(
          `SELECT organization_id, event_id, user_id, contact_id, role,
                    revoked_at
             FROM event_memberships
             WHERE user_id IN (?1, ?2, ?3)
                OR (organization_id = ?4 AND event_id = ?5 AND contact_id = ?6)`,
        )
        .bind(
          organizer.identityId,
          reviewer.identityId,
          speaker.identityId,
          demoOrganizationId,
          demoEventId,
          reviewerContactId,
        ),
      this.#database
        .prepare(
          `SELECT organization_id, event_id, user_id, contact_id,
                    relationship_role, revoked_at
             FROM event_contact_identity_bindings
             WHERE user_id IN (?1, ?2, ?3)
                OR (organization_id = ?4 AND event_id = ?5 AND contact_id = ?6)`,
        )
        .bind(
          organizer.identityId,
          reviewer.identityId,
          speaker.identityId,
          demoOrganizationId,
          demoEventId,
          speakerContactId,
        ),
    ]);
    const users = collisionResults[0];
    const organizationMemberships = collisionResults[1];
    const eventMemberships = collisionResults[2];
    const contactBindings = collisionResults[3];
    if (
      !users ||
      !organizationMemberships ||
      !eventMemberships ||
      !contactBindings
    ) {
      throw new DemoRoleProvisioningError(
        "transaction_failed",
        "Demo role identity collision checks were incomplete.",
      );
    }
    const expectedUsers = new Map(
      identities.map((identity) => [identity.identityId, identity]),
    );
    if (
      users.results.some((candidate) => {
        const row = candidate as UserCollisionRow;
        const expected = expectedUsers.get(row.id);
        return (
          !expected ||
          row.email_normalized.toLowerCase() !== expected.email ||
          row.display_name !== expected.displayName ||
          row.status !== "active"
        );
      }) ||
      organizationMemberships.results.length > 0
    ) {
      throw new DemoRoleProvisioningError(
        "identity_collision",
        "A demo role alias conflicts with an existing identity.",
      );
    }
    if (
      eventMemberships.results.some((candidate) => {
        const row = candidate as MembershipCollisionRow;
        return !(
          row.organization_id === demoOrganizationId &&
          row.event_id === demoEventId &&
          row.revoked_at === null &&
          ((row.user_id === organizer.identityId &&
            row.role === "organizer" &&
            row.contact_id === null) ||
            (row.user_id === reviewer.identityId &&
              row.role === "reviewer" &&
              row.contact_id === reviewerContactId))
        );
      }) ||
      contactBindings.results.some((candidate) => {
        const row = candidate as ContactBindingCollisionRow;
        return !(
          row.organization_id === demoOrganizationId &&
          row.event_id === demoEventId &&
          row.user_id === speaker.identityId &&
          row.contact_id === speakerContactId &&
          row.relationship_role === "speaker" &&
          row.revoked_at === null
        );
      })
    ) {
      throw new DemoRoleProvisioningError(
        "identity_collision",
        "A demo role alias conflicts with an existing event relationship.",
      );
    }
  }

  async #replay(
    commandId: string,
    requestHash: string,
  ): Promise<DemoRoleProvisioningResponse | null> {
    const row = await this.#database
      .prepare(
        `SELECT request_hash, status, original_response_json
         FROM idempotency_keys
         WHERE tenant_key = ?1 AND operation = ?2 AND command_id = ?3
         LIMIT 1`,
      )
      .bind(demoOrganizationId, operation, commandId)
      .first<IdempotencyRow>();
    if (!row) return null;
    if (
      row.request_hash !== requestHash ||
      row.status !== "committed" ||
      !row.original_response_json
    ) {
      throw new DemoRoleProvisioningError(
        "idempotency_conflict",
        "The demo role provisioning key conflicts with durable state.",
      );
    }
    const stored = demoRoleProvisioningResponseSchema.parse(
      JSON.parse(row.original_response_json) as unknown,
    );
    return {
      receipt: { ...stored.receipt, outcome: "replayed" },
    };
  }
}
