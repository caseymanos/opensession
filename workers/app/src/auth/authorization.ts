import type { D1QueryExecutor } from "../database.js";

export const eventPermissions = [
  "organization:manage",
  "event:read",
  "event:manage",
  "review:read",
  "review:submit",
  "session:read:any",
  "session:read:self",
  "portal:read:self",
  "portal:write:self",
] as const;

export type EventPermission = (typeof eventPermissions)[number];
export type OrganizationRole = "owner" | "organizer" | "viewer";
export type EventRole = "organizer" | "reviewer" | "viewer";

export interface EventAccess {
  readonly eventRole: EventRole | null;
  readonly organizationRole: OrganizationRole | null;
  readonly permissions: readonly EventPermission[];
  readonly speakerContactId: string | null;
}

interface EventAccessRow {
  event_role: string | null;
  organization_role: string | null;
  speaker_contact_id: string | null;
}

const organizationRolePermissions: Record<
  OrganizationRole,
  readonly EventPermission[]
> = {
  owner: [
    "organization:manage",
    "event:read",
    "event:manage",
    "review:read",
    "review:submit",
    "session:read:any",
  ],
  organizer: [
    "event:read",
    "event:manage",
    "review:read",
    "review:submit",
    "session:read:any",
  ],
  viewer: ["event:read", "session:read:any"],
};

const eventRolePermissions: Record<EventRole, readonly EventPermission[]> = {
  organizer: [
    "event:read",
    "event:manage",
    "review:read",
    "review:submit",
    "session:read:any",
  ],
  reviewer: ["event:read", "review:read", "review:submit", "session:read:any"],
  viewer: ["event:read", "session:read:any"],
};

function isOrganizationRole(value: string | null): value is OrganizationRole {
  return value === "owner" || value === "organizer" || value === "viewer";
}

function isEventRole(value: string | null): value is EventRole {
  return value === "organizer" || value === "reviewer" || value === "viewer";
}

export function permissionsForAccess(
  organizationRole: OrganizationRole | null,
  eventRole: EventRole | null,
  speakerContactId: string | null,
): readonly EventPermission[] {
  const permissions = new Set<EventPermission>();

  if (organizationRole) {
    for (const permission of organizationRolePermissions[organizationRole]) {
      permissions.add(permission);
    }
  }
  if (eventRole) {
    for (const permission of eventRolePermissions[eventRole]) {
      permissions.add(permission);
    }
  }
  if (speakerContactId) {
    permissions.add("session:read:self");
    permissions.add("portal:read:self");
    permissions.add("portal:write:self");
  }

  return eventPermissions.filter((permission) => permissions.has(permission));
}

export function hasEventPermission(
  access: EventAccess,
  permission: EventPermission,
): boolean {
  return access.permissions.includes(permission);
}

export async function loadEventAccess(
  database: D1QueryExecutor,
  user: { email: string; id: string },
  organizationId: string,
  eventId: string,
  options: { requireAuthorityReady?: boolean } = {},
): Promise<EventAccess> {
  const row = await database
    .prepare(
      `SELECT
        (
          SELECT om.role
          FROM organization_memberships om
          WHERE om.organization_id = ?1
            AND om.user_id = ?3
            AND om.revoked_at IS NULL
          LIMIT 1
        ) AS organization_role,
        (
          SELECT em.role
          FROM event_memberships em
          WHERE em.organization_id = ?1
            AND em.event_id = ?2
            AND em.user_id = ?3
            AND em.revoked_at IS NULL
          LIMIT 1
        ) AS event_role,
        (
          SELECT pec.contact_id
          FROM p_event_contacts pec
          JOIN p_contacts pc
            ON pc.organization_id = pec.organization_id
           AND pc.id = pec.contact_id
           AND pc.source_deleted_at IS NULL
          WHERE pec.organization_id = ?1
            AND pec.event_id = ?2
            AND (
              pc.email_normalized = ?4 COLLATE NOCASE
              OR EXISTS (
                SELECT 1 FROM event_contact_identity_bindings binding
                WHERE binding.organization_id = pec.organization_id
                  AND binding.event_id = pec.event_id
                  AND binding.contact_id = pec.contact_id
                  AND binding.user_id = ?3
                  AND binding.relationship_role = 'speaker'
                  AND binding.revoked_at IS NULL
              )
            )
            AND pec.portal_state IN ('invited', 'active')
            AND pec.source_deleted_at IS NULL
            AND EXISTS (
              SELECT 1
              FROM json_each(pec.roles_json)
              WHERE json_each.value = 'speaker'
            )
          LIMIT 1
        ) AS speaker_contact_id
      FROM p_events event_scope
      JOIN tenant_registry tenant_scope
        ON tenant_scope.organization_id = event_scope.organization_id
       AND tenant_scope.status = 'active'
       AND (?5 = 0 OR tenant_scope.authority_ready_at IS NOT NULL)
      WHERE event_scope.organization_id = ?1
        AND event_scope.id = ?2
        AND event_scope.source_deleted_at IS NULL
      LIMIT 1`,
    )
    .bind(
      organizationId,
      eventId,
      user.id,
      user.email,
      options.requireAuthorityReady === false ? 0 : 1,
    )
    .first<EventAccessRow>();

  const organizationRoleCandidate = row?.organization_role ?? null;
  const eventRoleCandidate = row?.event_role ?? null;
  const organizationRole: OrganizationRole | null = isOrganizationRole(
    organizationRoleCandidate,
  )
    ? organizationRoleCandidate
    : null;
  const eventRole: EventRole | null = isEventRole(eventRoleCandidate)
    ? eventRoleCandidate
    : null;
  const speakerContactId = row?.speaker_contact_id ?? null;

  return {
    eventRole,
    organizationRole,
    permissions: permissionsForAccess(
      organizationRole,
      eventRole,
      speakerContactId,
    ),
    speakerContactId,
  };
}

export async function canReadSession(
  database: D1QueryExecutor,
  access: EventAccess,
  organizationId: string,
  eventId: string,
  sessionId: string,
): Promise<boolean> {
  if (hasEventPermission(access, "session:read:any")) {
    const session = await database
      .prepare(
        `SELECT 1 AS allowed
         FROM p_sessions session_scope
         JOIN tenant_registry tenant_scope
           ON tenant_scope.organization_id = session_scope.organization_id
          AND tenant_scope.status = 'active'
          AND tenant_scope.authority_ready_at IS NOT NULL
         WHERE session_scope.organization_id = ?1
           AND session_scope.event_id = ?2
           AND session_scope.id = ?3
           AND session_scope.source_deleted_at IS NULL
         LIMIT 1`,
      )
      .bind(organizationId, eventId, sessionId)
      .first<{ allowed: number }>();
    return session?.allowed === 1;
  }

  if (!access.speakerContactId) {
    return false;
  }

  const relationship = await database
    .prepare(
      `SELECT 1 AS allowed
       FROM p_session_participants participant
       JOIN tenant_registry tenant_scope
         ON tenant_scope.organization_id = participant.organization_id
        AND tenant_scope.status = 'active'
        AND tenant_scope.authority_ready_at IS NOT NULL
       JOIN p_sessions session_scope
         ON session_scope.organization_id = participant.organization_id
        AND session_scope.event_id = participant.event_id
        AND session_scope.id = participant.session_id
        AND session_scope.source_deleted_at IS NULL
       WHERE participant.organization_id = ?1
         AND participant.event_id = ?2
         AND participant.session_id = ?3
         AND participant.contact_id = ?4
         AND participant.role IN ('speaker', 'moderator', 'chair')
         AND participant.confirmed_state != 'declined'
         AND participant.source_deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(organizationId, eventId, sessionId, access.speakerContactId)
    .first<{ allowed: number }>();

  return relationship?.allowed === 1;
}
