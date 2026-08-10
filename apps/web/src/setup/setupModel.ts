export type SetupChecklistCategory = "blocking" | "recommended" | "stretch";

export interface TrackSetup {
  color: string;
  id: string;
  name: string;
}

export interface RoomSetup {
  capacity: number | "";
  id: string;
  name: string;
}

export interface FormatSetup {
  durationMinutes: number | "";
  id: string;
  name: string;
}

export interface EventSetupDraft {
  brandColor: string;
  brandName: string;
  cfpClosesAt: string;
  cfpOpensAt: string;
  defaultDurationMinutes: number | "";
  endsAt: string;
  eventId: string;
  formats: FormatSetup[];
  name: string;
  replyTo: string;
  rooms: RoomSetup[];
  slug: string;
  startsAt: string;
  submissionLimit: number | "";
  timezone: string;
  tracks: TrackSetup[];
  venue: string;
}

export interface SetupChecklistItem {
  category: SetupChecklistCategory;
  complete: boolean;
  detail: string;
  href: string;
  id: string;
  label: string;
}

export interface CloneConfigurationRequest {
  configuration: Omit<
    EventSetupDraft,
    "eventId" | "formats" | "rooms" | "tracks"
  > & {
    formats: Omit<FormatSetup, "id">[];
    rooms: Omit<RoomSetup, "id">[];
    tracks: Omit<TrackSetup, "id">[];
  };
  sourceEventId: string;
}

export type SetupErrors = Record<string, string>;

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export const timezoneOptions = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
] as const;

export const seedEventSetup: EventSetupDraft = {
  brandColor: "#b7e767",
  brandName: "AI Engineer Summit",
  cfpClosesAt: "2026-08-12T23:59",
  cfpOpensAt: "2026-07-06T09:00",
  defaultDurationMinutes: 30,
  endsAt: "2026-08-19T17:30",
  eventId: "evt_ai_engineer_summit",
  formats: [
    { durationMinutes: 30, id: "format-talk", name: "Talk" },
    { durationMinutes: 60, id: "format-workshop", name: "Workshop" },
    { durationMinutes: 45, id: "format-panel", name: "Panel" },
  ],
  name: "AI Engineer Summit",
  replyTo: "program@ai.engineer",
  rooms: [
    { capacity: 280, id: "room-cowell", name: "Cowell Theater" },
    { capacity: 120, id: "room-gallery", name: "Gallery 308" },
    { capacity: 80, id: "room-firehouse", name: "Firehouse" },
  ],
  slug: "ai-engineer-summit",
  startsAt: "2026-08-18T09:00",
  submissionLimit: 3,
  timezone: "America/Los_Angeles",
  tracks: [
    { color: "#487a80", id: "track-ai", name: "AI Engineering" },
    { color: "#b47f23", id: "track-evaluation", name: "Evaluation" },
    {
      color: "#8d5b45",
      id: "track-infrastructure",
      name: "Infrastructure",
    },
    { color: "#6e795b", id: "track-product", name: "Product" },
  ],
  venue: "Fort Mason Center · San Francisco",
};

export const emptyEventSetup: EventSetupDraft = {
  brandColor: "#b7e767",
  brandName: "",
  cfpClosesAt: "",
  cfpOpensAt: "",
  defaultDurationMinutes: "",
  endsAt: "",
  eventId: "evt_new",
  formats: [{ durationMinutes: "", id: "format-new", name: "" }],
  name: "",
  replyTo: "",
  rooms: [{ capacity: "", id: "room-new", name: "" }],
  slug: "",
  startsAt: "",
  submissionLimit: "",
  timezone: "",
  tracks: [{ color: "#487a80", id: "track-new", name: "" }],
  venue: "",
};

function isValidIanaTimezone(value: string) {
  if (!value) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function parseLocalDateTime(value: string) {
  const match = localDateTimePattern.exec(value);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute] = match;
  const parts = {
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    month: Number(month),
    year: Number(year),
  };
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute),
  );

  if (
    date.getUTCFullYear() !== parts.year ||
    date.getUTCMonth() !== parts.month - 1 ||
    date.getUTCDate() !== parts.day ||
    parts.hour > 23 ||
    parts.minute > 59
  ) {
    return null;
  }

  return parts;
}

function validDuration(value: number | "") {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 5 &&
    value <= 480 &&
    value % 5 === 0
  );
}

function duplicateNames(items: { name: string }[]) {
  const names = items
    .map((item) => item.name.trim().toLocaleLowerCase())
    .filter(Boolean);
  return names.length !== new Set(names).size;
}

export function validateEventSetup(draft: EventSetupDraft): SetupErrors {
  const errors: SetupErrors = {};

  if (!draft.name.trim()) {
    errors["event-name"] = "Enter an event name.";
  }
  if (!slugPattern.test(draft.slug)) {
    errors["event-slug"] =
      "Use lowercase letters, numbers, and single hyphens for the slug.";
  }
  if (!isValidIanaTimezone(draft.timezone)) {
    errors["event-timezone"] = "Choose a valid IANA timezone.";
  }

  const startsAt = parseLocalDateTime(draft.startsAt);
  const endsAt = parseLocalDateTime(draft.endsAt);
  if (!startsAt) {
    errors["event-start"] = "Enter the event start date and time.";
  }
  if (!endsAt) {
    errors["event-end"] = "Enter the event end date and time.";
  } else if (startsAt && draft.endsAt <= draft.startsAt) {
    errors["event-end"] = "Event end must be after event start.";
  }

  const cfpOpensAt = parseLocalDateTime(draft.cfpOpensAt);
  const cfpClosesAt = parseLocalDateTime(draft.cfpClosesAt);
  if (!cfpOpensAt) {
    errors["cfp-opens"] = "Enter when the CFP opens.";
  }
  if (!cfpClosesAt) {
    errors["cfp-closes"] = "Enter when the CFP closes.";
  } else if (cfpOpensAt && draft.cfpClosesAt <= draft.cfpOpensAt) {
    errors["cfp-closes"] = "CFP close must be after CFP open.";
  } else if (startsAt && draft.cfpClosesAt >= draft.startsAt) {
    errors["cfp-closes"] = "CFP must close before the event begins.";
  }

  if (!validDuration(draft.defaultDurationMinutes)) {
    errors["default-duration"] =
      "Default duration must be 5–480 minutes in 5-minute increments.";
  }
  if (
    typeof draft.submissionLimit !== "number" ||
    !Number.isInteger(draft.submissionLimit) ||
    draft.submissionLimit < 1 ||
    draft.submissionLimit > 20
  ) {
    errors["submission-limit"] =
      "Submission limit must be a whole number from 1 to 20.";
  }
  if (!emailPattern.test(draft.replyTo.trim())) {
    errors["reply-to"] = "Enter a valid reply-to email address.";
  }

  draft.tracks.forEach((track) => {
    if (!track.name.trim()) {
      errors[`track-${track.id}-name`] = "Enter a track name.";
    }
  });
  if (draft.tracks.length === 0) {
    errors["tracks-list"] = "Add at least one track.";
  } else if (duplicateNames(draft.tracks)) {
    errors["tracks-list"] = "Track names must be unique.";
  }

  draft.rooms.forEach((room) => {
    if (!room.name.trim()) {
      errors[`room-${room.id}-name`] = "Enter a room name.";
    }
    if (
      typeof room.capacity !== "number" ||
      !Number.isInteger(room.capacity) ||
      room.capacity < 1
    ) {
      errors[`room-${room.id}-capacity`] =
        "Capacity must be a positive whole number.";
    }
  });
  if (draft.rooms.length === 0) {
    errors["rooms-list"] = "Add at least one room.";
  } else if (duplicateNames(draft.rooms)) {
    errors["rooms-list"] = "Room names must be unique.";
  }

  draft.formats.forEach((format) => {
    if (!format.name.trim()) {
      errors[`format-${format.id}-name`] = "Enter a format name.";
    }
    if (!validDuration(format.durationMinutes)) {
      errors[`format-${format.id}-duration`] =
        "Duration must be 5–480 minutes in 5-minute increments.";
    }
  });
  if (draft.formats.length === 0) {
    errors["formats-list"] = "Add at least one format.";
  } else if (duplicateNames(draft.formats)) {
    errors["formats-list"] = "Format names must be unique.";
  }

  return errors;
}

function hasAnyError(errors: SetupErrors, prefixes: string[]) {
  return Object.keys(errors).some((key) =>
    prefixes.some((prefix) => key.startsWith(prefix)),
  );
}

export function getSetupChecklist(
  draft: EventSetupDraft,
): SetupChecklistItem[] {
  const errors = validateEventSetup(draft);
  const eventIdentityReady = !hasAnyError(errors, ["event-"]);
  const cfpWindowReady = !hasAnyError(errors, ["cfp-"]);
  const programReady = !hasAnyError(errors, [
    "track-",
    "tracks-",
    "room-",
    "rooms-",
    "format-",
    "formats-",
  ]);
  const submissionRulesReady =
    !errors["default-duration"] && !errors["submission-limit"];
  const replyToReady = !errors["reply-to"];
  const venueReady = Boolean(draft.venue.trim());
  const brandReady =
    Boolean(draft.brandName.trim()) && /^#[0-9a-f]{6}$/i.test(draft.brandColor);
  const capacitiesReady =
    draft.rooms.length > 0 &&
    draft.rooms.every(
      (room) => typeof room.capacity === "number" && room.capacity > 0,
    );

  return [
    {
      category: "blocking",
      complete: eventIdentityReady,
      detail: eventIdentityReady
        ? "Identity, timezone, and event window are valid."
        : "Add a valid name, slug, timezone, start, and end.",
      href: "#event-details",
      id: "check-event",
      label: "Event details",
    },
    {
      category: "blocking",
      complete: cfpWindowReady,
      detail: cfpWindowReady
        ? "The CFP opens and closes before the event."
        : "Set an opening time and a later closing time before the event starts.",
      href: "#cfp-settings",
      id: "check-cfp-window",
      label: "CFP window",
    },
    {
      category: "blocking",
      complete: programReady,
      detail: programReady
        ? `${draft.tracks.length} tracks, ${draft.rooms.length} rooms, and ${draft.formats.length} formats are ready.`
        : "Add at least one uniquely named track, room with capacity, and valid format.",
      href: "#program-structure",
      id: "check-program",
      label: "Program structure",
    },
    {
      category: "blocking",
      complete: submissionRulesReady,
      detail: submissionRulesReady
        ? `Applicants may submit up to ${draft.submissionLimit} proposals; default sessions run ${draft.defaultDurationMinutes} minutes.`
        : "Set a 5-minute-aligned default duration and a submission limit from 1 to 20.",
      href: "#cfp-settings",
      id: "check-submission-rules",
      label: "Submission rules",
    },
    {
      category: "blocking",
      complete: replyToReady,
      detail: replyToReady
        ? `Replies go to ${draft.replyTo}.`
        : "Add the monitored inbox applicants should reply to.",
      href: "#reply-settings",
      id: "check-reply-to",
      label: "Reply-to inbox",
    },
    {
      category: "recommended",
      complete: venueReady,
      detail: venueReady
        ? draft.venue
        : "Add a venue or online location so public pages set expectations.",
      href: "#event-details",
      id: "check-venue",
      label: "Venue",
    },
    {
      category: "recommended",
      complete: brandReady,
      detail: brandReady
        ? "Event name and accent color are set."
        : "Add a public brand name and six-digit accent color.",
      href: "#brand-settings",
      id: "check-brand",
      label: "Public brand",
    },
    {
      category: "recommended",
      complete: capacitiesReady,
      detail: capacitiesReady
        ? "Every room has a planning capacity."
        : "Add a positive capacity to every room for conflict-aware planning.",
      href: "#rooms-settings",
      id: "check-capacities",
      label: "Room capacities",
    },
    {
      category: "stretch",
      complete: draft.tracks.length > 1,
      detail:
        draft.tracks.length > 1
          ? "Multiple tracks support routing and public filtering."
          : "Add another track when the program needs routing or filters.",
      href: "#tracks-settings",
      id: "check-track-routing",
      label: "Track routing",
    },
    {
      category: "stretch",
      complete: draft.formats.length > 1,
      detail:
        draft.formats.length > 1
          ? "Applicants can choose from multiple session formats."
          : "Add another format when talks, workshops, or panels differ.",
      href: "#formats-settings",
      id: "check-format-mix",
      label: "Format mix",
    },
  ];
}

export function formatEventDeadline(value: string, timezone: string) {
  const parts = parseLocalDateTime(value);
  if (!parts || !isValidIanaTimezone(timezone)) {
    return null;
  }

  const month = new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(parts.year, parts.month - 1, 1)));
  const hour = parts.hour % 12 || 12;
  const period = parts.hour >= 12 ? "PM" : "AM";
  const timeZoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "short",
  })
    .formatToParts(
      new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)),
    )
    .find((part) => part.type === "timeZoneName")?.value;

  return `${month} ${parts.day}, ${parts.year} at ${hour}:${String(parts.minute).padStart(2, "0")} ${period} ${timeZoneName ?? timezone} · ${timezone}`;
}

export function createCloneConfigurationRequest(
  source: EventSetupDraft,
  identity: { name: string; slug: string },
): CloneConfigurationRequest {
  return {
    configuration: {
      brandColor: source.brandColor,
      brandName: source.brandName,
      cfpClosesAt: source.cfpClosesAt,
      cfpOpensAt: source.cfpOpensAt,
      defaultDurationMinutes: source.defaultDurationMinutes,
      endsAt: source.endsAt,
      formats: source.formats.map(({ durationMinutes, name }) => ({
        durationMinutes,
        name,
      })),
      name: identity.name.trim(),
      replyTo: source.replyTo,
      rooms: source.rooms.map(({ capacity, name }) => ({ capacity, name })),
      slug: identity.slug.trim(),
      startsAt: source.startsAt,
      submissionLimit: source.submissionLimit,
      timezone: source.timezone,
      tracks: source.tracks.map(({ color, name }) => ({ color, name })),
      venue: source.venue,
    },
    sourceEventId: source.eventId,
  };
}
