import {
  assertValidScheduleSnapshot,
  isIanaTimezone,
  participantConflictRoles,
  scheduleValidationReasons,
  sessionLifecycleStates,
  type CancelSessionCommand,
  type EventScheduleDay,
  type EventSchedulingConfig,
  type PlaceSessionCommand,
  type PublishScheduleCommand,
  type RescheduleSessionCommand,
  type ScheduleCommand,
  type ScheduleCommandResult,
  type ScheduleFormat,
  type ScheduleParticipant,
  type ScheduleRoom,
  type ScheduleSession,
  type ScheduleSlot,
  type ScheduleSnapshot,
  type ScheduleTrack,
  type UnassignSessionCommand,
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
export const sessionLifecycleStateSchema = z.enum(sessionLifecycleStates);

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
    role: participantConflictRoleSchema,
  })
  .strict() satisfies z.ZodType<ScheduleParticipant>;

export const scheduleSlotSchema = z
  .object({
    endAt: utcInstantSchema,
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
    roomId: scheduleIdentifierSchema,
    sessionId: scheduleIdentifierSchema,
    startAt: utcInstantSchema,
    type: z.literal("place_session"),
  })
  .strict() satisfies z.ZodType<PlaceSessionCommand>;

export const rescheduleSessionCommandSchema = scheduleCommandBaseSchema
  .extend({
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

export const scheduleCommandErrorSchema = z.discriminatedUnion("code", [
  scheduleValidationErrorSchema,
  scheduleVersionConflictErrorSchema,
  scheduleIdempotencyConflictErrorSchema,
]);

export const scheduleCommandResultSchema = z
  .object({
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
  ScheduleCommand,
  ScheduleCommandPort,
  ScheduleCommandResult,
  ScheduleFormat,
  ScheduleParticipant,
  ScheduleRoom,
  ScheduleSession,
  ScheduleSlot,
  ScheduleSnapshot,
  ScheduleTrack,
  SessionLifecycleState,
} from "@sessionbox-killer/domain";
