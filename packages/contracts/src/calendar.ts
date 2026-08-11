import { z } from "zod";

const identifierSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const opaqueIdentifierSchema = z.string().trim().min(1).max(256);
const utcInstantSchema = z.iso
  .datetime()
  .refine((value) => value.endsWith("Z"), {
    message: "Timestamp must use UTC (Z).",
  });
function containsUnsupportedControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    ) {
      return true;
    }
  }
  return false;
}

const safeTextSchema = z
  .string()
  .refine((value) => !containsUnsupportedControl(value), {
    message: "Text contains an unsupported control character.",
  });

export const calendarActorSchema = z.discriminatedUnion("type", [
  z.object({ id: z.null(), type: z.literal("system") }).strict(),
  z
    .object({
      id: opaqueIdentifierSchema,
      type: z.enum(["user", "api_key", "portal"]),
    })
    .strict(),
]);

export const calendarPlacementSchema = z
  .object({
    endAt: utcInstantSchema,
    roomId: identifierSchema,
    startAt: utcInstantSchema,
  })
  .strict()
  .refine(
    (placement) => Date.parse(placement.startAt) < Date.parse(placement.endAt),
    {
      message: "Calendar placement must end after it starts.",
    },
  );

export const calendarChangeIntentSchema = z
  .object({
    actor: calendarActorSchema,
    changeType: z.enum(["rescheduled", "canceled", "unassigned"]),
    commandId: opaqueIdentifierSchema,
    eventId: identifierSchema,
    kind: z.literal("calendar.change"),
    occurredAt: utcInstantSchema,
    organizationId: identifierSchema,
    previousPlacement: calendarPlacementSchema,
    requestId: opaqueIdentifierSchema,
    sessionId: identifierSchema,
    sourcePublicationVersion: z.int().positive(),
    version: z.literal(1),
  })
  .strict();

export const calendarPartySchema = z
  .object({
    email: z.email().trim().max(320),
    name: safeTextSchema.trim().min(1).max(160),
  })
  .strict();

export const calendarTimeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      endAt: utcInstantSchema,
      kind: z.literal("date_time"),
      startAt: utcInstantSchema,
    })
    .strict()
    .refine((time) => Date.parse(time.startAt) < Date.parse(time.endAt), {
      message: "Calendar event must end after it starts.",
    }),
  z
    .object({
      endDateExclusive: z.iso.date(),
      kind: z.literal("date"),
      startDate: z.iso.date(),
    })
    .strict()
    .refine((time) => time.startDate < time.endDateExclusive, {
      message: "All-day event end date must be exclusive and after its start.",
    }),
]);

export const calendarInvitationSnapshotSchema = z
  .object({
    attendee: calendarPartySchema,
    description: safeTextSchema.max(24_000),
    dtstamp: utcInstantSchema,
    eventId: identifierSchema,
    humanTime: safeTextSchema.trim().min(1).max(500),
    location: safeTextSchema.trim().min(1).max(500),
    method: z.enum(["REQUEST", "CANCEL"]),
    organizationId: identifierSchema,
    organizer: calendarPartySchema,
    publicUrl: z
      .url()
      .max(2_048)
      .refine(
        (value) => value.startsWith("https://") || value.startsWith("http://"),
        {
          message: "Calendar public URL must use HTTP or HTTPS.",
        },
      )
      .nullable(),
    roomId: identifierSchema,
    sequence: z.int().nonnegative(),
    seriesId: z.string().regex(/^cal_[0-9a-f]{48}$/),
    sessionId: identifierSchema,
    sourcePublicationVersion: z.int().nonnegative(),
    sourceScheduleVersion: z.int().nonnegative(),
    status: z.enum(["CONFIRMED", "CANCELLED"]),
    summary: safeTextSchema.trim().min(1).max(300),
    time: calendarTimeSchema,
    timezone: safeTextSchema.trim().min(1).max(120),
    uid: z
      .string()
      .min(3)
      .max(255)
      .refine((value) => !/[\r\n]/u.test(value), {
        message: "Calendar UID must fit on one logical line.",
      }),
    version: z.literal(1),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const isCancellation = snapshot.method === "CANCEL";
    if (isCancellation !== (snapshot.status === "CANCELLED")) {
      context.addIssue({
        code: "custom",
        message: "METHOD:CANCEL and STATUS:CANCELLED must be used together.",
        path: ["status"],
      });
    }
    if (isCancellation && snapshot.sequence === 0) {
      context.addIssue({
        code: "custom",
        message: "A cancellation must advance an existing invitation sequence.",
        path: ["sequence"],
      });
    }
  });

export const calendarAttachmentSchema = z
  .object({
    content: z.string().min(1).max(500_000),
    contentType: z
      .string()
      .regex(/^text\/calendar; charset=utf-8; method=(?:REQUEST|CANCEL)$/),
    filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.ics$/),
    method: z.enum(["REQUEST", "CANCEL"]),
  })
  .strict();

export const calendarInvitationIntentSchema = z
  .object({
    attachment: calendarAttachmentSchema,
    idempotencyKey: z
      .string()
      .regex(/^calendar-invitation:v1:cal_[0-9a-f]{48}:[0-9]+:[0-9a-f]{64}$/),
    snapshot: calendarInvitationSnapshotSchema,
    snapshotHash: z.string().regex(/^[0-9a-f]{64}$/),
    version: z.literal(1),
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      intent.attachment.method !== intent.snapshot.method ||
      !intent.attachment.contentType.endsWith(
        `method=${intent.snapshot.method}`,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Calendar attachment method must match its snapshot.",
        path: ["attachment", "method"],
      });
    }
  });

export const calendarInvitationRequestedSchema = z
  .object({
    eventId: identifierSchema,
    intent: calendarInvitationIntentSchema,
    kind: z.literal("calendar.invitation.requested"),
    organizationId: identifierSchema,
    sessionId: identifierSchema,
    version: z.literal(1),
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.organizationId !== payload.intent.snapshot.organizationId ||
      payload.eventId !== payload.intent.snapshot.eventId ||
      payload.sessionId !== payload.intent.snapshot.sessionId
    ) {
      context.addIssue({
        code: "custom",
        message: "Invitation routing must match its immutable snapshot.",
        path: ["intent"],
      });
    }
  });

export const calendarInvitationHandoffContextSchema = z
  .object({
    actor: calendarActorSchema,
    commandId: opaqueIdentifierSchema,
    occurredAt: utcInstantSchema,
    organizationId: identifierSchema,
    requestId: opaqueIdentifierSchema,
  })
  .strict();

export type CalendarActor = z.infer<typeof calendarActorSchema>;
export type CalendarAttachment = z.infer<typeof calendarAttachmentSchema>;
export type CalendarChangeIntent = z.infer<typeof calendarChangeIntentSchema>;
export type CalendarInvitationIntent = z.infer<
  typeof calendarInvitationIntentSchema
>;
export type CalendarInvitationHandoffContext = z.infer<
  typeof calendarInvitationHandoffContextSchema
>;
export type CalendarInvitationRequested = z.infer<
  typeof calendarInvitationRequestedSchema
>;
export type CalendarInvitationSnapshot = z.infer<
  typeof calendarInvitationSnapshotSchema
>;
export type CalendarParty = z.infer<typeof calendarPartySchema>;
export type CalendarPlacement = z.infer<typeof calendarPlacementSchema>;
export type CalendarTime = z.infer<typeof calendarTimeSchema>;
