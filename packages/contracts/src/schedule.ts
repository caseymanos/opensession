import {
  assertValidScheduleSnapshot,
  isIanaTimezone,
  participantConflictRoles,
  participantReadinessStates,
  scheduleHardConflictCodes,
  scheduleValidationReasons,
  sessionLifecycleStates,
  type CancelSessionCommand,
  type EventScheduleDay,
  type EventSchedulingConfig,
  type PlaceSessionCommand,
  type PublishScheduleCommand,
  type RescheduleSessionCommand,
  type ScheduleCommand,
  type ScheduleConflictEntity,
  type ScheduleConflictInterval,
  type ScheduleConflictPolicy,
  type ScheduleConflictReport,
  type ScheduleCommandResult,
  type ScheduleHardConflict,
  type ScheduleFormat,
  type ScheduleParticipant,
  type ScheduleParticipantReadiness,
  type ScheduleRoom,
  type ScheduleSessionReference,
  type ScheduleSession,
  type ScheduleSlot,
  type ScheduleSnapshot,
  type ScheduleSoftWarning,
  type ScheduleTrack,
  type UnassignSessionCommand,
} from "@sessionbox-killer/domain";
export {
  ScheduleHardConflictError,
  ScheduleIdempotencyConflictError,
  ScheduleValidationError,
  ScheduleVersionConflictError,
} from "@sessionbox-killer/domain";
import { z } from "zod";

const scheduleIdentifierSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const utcInstantSchema = z.iso
  .datetime()
  .refine((value) => value.endsWith("Z"), {
    message: "Timestamp must use UTC (Z).",
  });

export const participantConflictRoleSchema = z.enum(participantConflictRoles);
export const participantReadinessStateSchema = z.enum(
  participantReadinessStates,
);
export const sessionLifecycleStateSchema = z.enum(sessionLifecycleStates);

export const scheduleParticipantReadinessSchema = z
  .object({
    missingRequiredTaskCount: z.int().nonnegative(),
    state: participantReadinessStateSchema,
  })
  .strict()
  .superRefine((readiness, context) => {
    if (
      (readiness.state === "missing_required_tasks") !==
      readiness.missingRequiredTaskCount > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Participant readiness state and missing count disagree.",
      });
    }
  }) satisfies z.ZodType<ScheduleParticipantReadiness>;

export const eventScheduleDaySchema = z
  .object({
    businessEnd: localTimeSchema,
    businessStart: localTimeSchema,
    date: z.iso.date(),
  })
  .strict() satisfies z.ZodType<EventScheduleDay>;

export const eventSchedulingConfigSchema = z
  .object({
    days: z.array(eventScheduleDaySchema).min(1).max(14),
    eventId: scheduleIdentifierSchema,
    publicationVersion: z.int().nonnegative(),
    slug: scheduleIdentifierSchema,
    snapMinutes: z.int().min(5).max(60),
    timezone: z.string().min(1).max(120).refine(isIanaTimezone, {
      message: "Timezone must be a valid IANA timezone.",
    }),
    version: z.int().nonnegative(),
  })
  .strict() satisfies z.ZodType<EventSchedulingConfig>;

export const scheduleRoomSchema = z
  .object({
    capacity: z.int().positive(),
    id: scheduleIdentifierSchema,
    name: z.string().trim().min(1).max(160),
    order: z.int().nonnegative(),
  })
  .strict() satisfies z.ZodType<ScheduleRoom>;

export const scheduleTrackSchema = z
  .object({
    id: scheduleIdentifierSchema,
    name: z.string().trim().min(1).max(160),
    order: z.int().nonnegative(),
  })
  .strict() satisfies z.ZodType<ScheduleTrack>;

export const scheduleFormatSchema = z
  .object({
    defaultDurationMinutes: z
      .int()
      .positive()
      .max(24 * 60),
    id: scheduleIdentifierSchema,
    name: z.string().trim().min(1).max(80),
    order: z.int().nonnegative(),
  })
  .strict() satisfies z.ZodType<ScheduleFormat>;

export const scheduleParticipantSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    personId: scheduleIdentifierSchema,
    readiness: scheduleParticipantReadinessSchema.optional(),
    role: participantConflictRoleSchema,
  })
  .strict() satisfies z.ZodType<ScheduleParticipant>;

export const scheduleSlotSchema = z
  .object({
    endAt: utcInstantSchema,
    overrideReason: z.string().trim().min(8).max(500).nullable().optional(),
    publicationVersion: z.int().nonnegative(),
    roomId: scheduleIdentifierSchema,
    startAt: utcInstantSchema,
    version: z.int().positive(),
  })
  .strict() satisfies z.ZodType<ScheduleSlot>;

export const scheduleSessionSchema = z
  .object({
    abstract: z.string().max(12_000),
    durationMinutes: z
      .int()
      .positive()
      .max(24 * 60),
    expectedAttendance: z.int().nonnegative().nullable().optional(),
    formatId: scheduleIdentifierSchema,
    id: scheduleIdentifierSchema,
    participants: z.array(scheduleParticipantSchema).max(32),
    slot: scheduleSlotSchema.nullable(),
    state: sessionLifecycleStateSchema,
    title: z.string().trim().min(1).max(300),
    trackId: scheduleIdentifierSchema,
  })
  .strict() satisfies z.ZodType<ScheduleSession>;

export const scheduleSnapshotSchema = z
  .object({
    event: eventSchedulingConfigSchema,
    formats: z.array(scheduleFormatSchema).min(1).max(64),
    rooms: z.array(scheduleRoomSchema).min(1).max(64),
    sessions: z.array(scheduleSessionSchema).max(2_000),
    tracks: z.array(scheduleTrackSchema).min(1).max(64),
  })
  .strict()
  .superRefine((snapshot, context) => {
    try {
      assertValidScheduleSnapshot(snapshot);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error
            ? error.message
            : "Schedule snapshot is invalid.",
      });
    }
  }) satisfies z.ZodType<ScheduleSnapshot>;

const scheduleCommandBaseSchema = z.object({
  commandId: scheduleIdentifierSchema,
  eventId: scheduleIdentifierSchema,
  expectedVersion: z.int().nonnegative(),
});

export const placeSessionCommandSchema = scheduleCommandBaseSchema
  .extend({
    durationMinutes: z
      .int()
      .positive()
      .max(24 * 60),
    overrideReason: z.string().trim().min(8).max(500).optional(),
    roomId: scheduleIdentifierSchema,
    sessionId: scheduleIdentifierSchema,
    startAt: utcInstantSchema,
    type: z.literal("place_session"),
  })
  .strict() satisfies z.ZodType<PlaceSessionCommand>;

export const rescheduleSessionCommandSchema = scheduleCommandBaseSchema
  .extend({
    durationMinutes: z
      .int()
      .positive()
      .max(24 * 60),
    overrideReason: z.string().trim().min(8).max(500).optional(),
    roomId: scheduleIdentifierSchema,
    sessionId: scheduleIdentifierSchema,
    startAt: utcInstantSchema,
    type: z.literal("reschedule_session"),
  })
  .strict() satisfies z.ZodType<RescheduleSessionCommand>;

export const unassignSessionCommandSchema = scheduleCommandBaseSchema
  .extend({
    sessionId: scheduleIdentifierSchema,
    type: z.literal("unassign_session"),
  })
  .strict() satisfies z.ZodType<UnassignSessionCommand>;

export const cancelSessionCommandSchema = scheduleCommandBaseSchema
  .extend({
    sessionId: scheduleIdentifierSchema,
    type: z.literal("cancel_session"),
  })
  .strict() satisfies z.ZodType<CancelSessionCommand>;

export const publishScheduleCommandSchema = scheduleCommandBaseSchema
  .extend({ type: z.literal("publish_schedule") })
  .strict() satisfies z.ZodType<PublishScheduleCommand>;

export const scheduleCommandSchema = z.discriminatedUnion("type", [
  placeSessionCommandSchema,
  rescheduleSessionCommandSchema,
  unassignSessionCommandSchema,
  cancelSessionCommandSchema,
  publishScheduleCommandSchema,
]) satisfies z.ZodType<ScheduleCommand>;

export const scheduleValidationErrorSchema = z
  .object({
    code: z.literal("schedule_validation_error"),
    field: z.string().min(1).max(240),
    message: z.string().min(1).max(1_000),
    reason: z.enum(scheduleValidationReasons),
  })
  .strict();

export const scheduleVersionConflictErrorSchema = z
  .object({
    actualVersion: z.int().nonnegative(),
    code: z.literal("schedule_version_conflict"),
    expectedVersion: z.int().nonnegative(),
    message: z.string().min(1).max(1_000),
  })
  .strict();

export const scheduleIdempotencyConflictErrorSchema = z
  .object({
    code: z.literal("schedule_idempotency_conflict"),
    commandId: scheduleIdentifierSchema,
    message: z.string().min(1).max(1_000),
  })
  .strict();

export const scheduleConflictEntitySchema = z
  .object({
    id: scheduleIdentifierSchema,
    name: z.string().trim().min(1).max(300),
    type: z.enum(["participant", "room"]),
  })
  .strict() satisfies z.ZodType<ScheduleConflictEntity>;

export const scheduleSessionReferenceSchema = z
  .object({
    id: scheduleIdentifierSchema,
    title: z.string().trim().min(1).max(300),
  })
  .strict() satisfies z.ZodType<ScheduleSessionReference>;

export const scheduleConflictIntervalSchema = z
  .object({ endAt: utcInstantSchema, startAt: utcInstantSchema })
  .strict()
  .refine(
    (interval) => Date.parse(interval.startAt) < Date.parse(interval.endAt),
    { message: "Conflict overlap must have positive duration." },
  ) satisfies z.ZodType<ScheduleConflictInterval>;

const resolutionHrefSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => value.startsWith("/app/") && !value.startsWith("//"), {
    message: "Resolution link must be an application-relative path.",
  });

export const scheduleHardConflictSchema = z
  .object({
    code: z.enum(scheduleHardConflictCodes),
    entity: scheduleConflictEntitySchema,
    eventId: scheduleIdentifierSchema,
    overlap: scheduleConflictIntervalSchema,
    overrideAllowed: z.literal(false),
    resolutionHref: resolutionHrefSchema,
    sessionA: scheduleSessionReferenceSchema,
    sessionB: scheduleSessionReferenceSchema,
  })
  .strict() satisfies z.ZodType<ScheduleHardConflict>;

const scheduleWarningOverrideSchema = z
  .object({
    allowed: z.literal(true),
    reason: z.string().trim().min(8).max(500).nullable(),
    sessionId: scheduleIdentifierSchema.nullable(),
  })
  .strict()
  .superRefine((override, context) => {
    if ((override.reason === null) !== (override.sessionId === null)) {
      context.addIssue({
        code: "custom",
        message:
          "Warning override reason and session must be present together.",
      });
    }
  });

const scheduleWarningBase = {
  entity: scheduleConflictEntitySchema,
  eventId: scheduleIdentifierSchema,
  override: scheduleWarningOverrideSchema,
  resolutionHref: resolutionHrefSchema,
} as const;

export const scheduleCapacityWarningSchema = z
  .object({
    ...scheduleWarningBase,
    capacity: z.int().positive(),
    code: z.literal("capacity_exceeded"),
    expectedAttendance: z.int().nonnegative(),
    session: scheduleSessionReferenceSchema,
  })
  .strict();

export const scheduleTransitionWarningSchema = z
  .object({
    ...scheduleWarningBase,
    availableMinutes: z.number().nonnegative(),
    code: z.literal("transition_buffer"),
    requiredMinutes: z.int().positive(),
    sessionA: scheduleSessionReferenceSchema,
    sessionB: scheduleSessionReferenceSchema,
  })
  .strict();

export const scheduleReadinessWarningSchema = z
  .object({
    ...scheduleWarningBase,
    code: z.literal("missing_readiness"),
    missingRequiredTaskCount: z.int().nonnegative(),
    readinessState: z.enum(["missing_required_tasks", "not_configured"]),
    session: scheduleSessionReferenceSchema,
  })
  .strict();

export const scheduleSoftWarningSchema = z.discriminatedUnion("code", [
  scheduleCapacityWarningSchema,
  scheduleTransitionWarningSchema,
  scheduleReadinessWarningSchema,
]) satisfies z.ZodType<ScheduleSoftWarning>;

export const scheduleConflictPolicySchema = z
  .object({
    transitionBufferMinutes: z
      .int()
      .min(0)
      .max(24 * 60),
  })
  .strict() satisfies z.ZodType<ScheduleConflictPolicy>;

export const scheduleConflictReportSchema = z
  .object({
    eventId: scheduleIdentifierSchema,
    hardConflicts: z.array(scheduleHardConflictSchema),
    policy: scheduleConflictPolicySchema,
    softWarnings: z.array(scheduleSoftWarningSchema),
  })
  .strict() satisfies z.ZodType<ScheduleConflictReport>;

export const scheduleHardConflictErrorSchema = z
  .object({
    code: z.literal("schedule_hard_conflict"),
    conflicts: z.array(scheduleHardConflictSchema).min(1),
    message: z.string().min(1).max(1_000),
  })
  .strict();

export const scheduleCommandErrorSchema = z.discriminatedUnion("code", [
  scheduleValidationErrorSchema,
  scheduleVersionConflictErrorSchema,
  scheduleIdempotencyConflictErrorSchema,
  scheduleHardConflictErrorSchema,
]);

export const scheduleCommandResultSchema = z
  .object({
    analysis: scheduleConflictReportSchema,
    changedSessionIds: z.array(scheduleIdentifierSchema),
    commandId: scheduleIdentifierSchema,
    replayed: z.boolean(),
    snapshot: scheduleSnapshotSchema,
  })
  .strict() satisfies z.ZodType<ScheduleCommandResult>;

export const scheduleCommandResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({ ok: z.literal(true), result: scheduleCommandResultSchema })
    .strict(),
  z
    .object({ ok: z.literal(false), error: scheduleCommandErrorSchema })
    .strict(),
]);

export type ScheduleCommandError = z.infer<typeof scheduleCommandErrorSchema>;
export type ScheduleCommandResponse = z.infer<
  typeof scheduleCommandResponseSchema
>;

export type {
  EventScheduleDay,
  EventSchedulingConfig,
  ParticipantConflictRole,
  ParticipantReadinessState,
  ScheduleCommand,
  ScheduleCommandPort,
  ScheduleCommandResult,
  ScheduleConflictEntity,
  ScheduleConflictInterval,
  ScheduleConflictPolicy,
  ScheduleConflictReport,
  ScheduleFormat,
  ScheduleHardConflict,
  ScheduleParticipant,
  ScheduleParticipantReadiness,
  ScheduleRoom,
  ScheduleSession,
  ScheduleSessionReference,
  ScheduleSlot,
  ScheduleSnapshot,
  ScheduleSoftWarning,
  ScheduleTrack,
  SessionLifecycleState,
} from "@sessionbox-killer/domain";
