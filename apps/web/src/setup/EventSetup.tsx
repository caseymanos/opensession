import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  Layers3,
  MapPin,
  MessageSquareReply,
  Palette,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";

import {
  Button,
  Dialog,
  ErrorSummary,
  LiveRegion,
  StatusPill,
  TextField,
  ToastRegion,
  type ToastMessage,
} from "@sessionbox-killer/ui";

import {
  createCloneConfigurationRequest,
  emptyEventSetup,
  formatEventDeadline,
  getSetupChecklist,
  seedEventSetup,
  timezoneOptions,
  validateEventSetup,
  type EventSetupDraft,
  type SetupChecklistCategory,
  type SetupErrors,
} from "./setupModel";

import "./event-setup.css";

const checklistCategoryCopy: Record<
  SetupChecklistCategory,
  { description: string; label: string }
> = {
  blocking: {
    description: "Required before the CFP can open.",
    label: "Blocking",
  },
  recommended: {
    description: "High-value polish for applicants and organizers.",
    label: "Recommended",
  },
  stretch: {
    description: "Useful when the program grows more complex.",
    label: "Stretch",
  },
};

function cloneDraft(source: EventSetupDraft) {
  return structuredClone(source);
}

function createId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function numberValue(value: string): number | "" {
  return value === "" ? "" : Number(value);
}

function OrderedRowActions({
  index,
  label,
  length,
  onMove,
  onRemove,
}: {
  index: number;
  label: string;
  length: number;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="setup-row-actions">
      <button
        aria-label={`Move ${label} up`}
        disabled={index === 0}
        onClick={() => {
          onMove(-1);
        }}
        type="button"
      >
        <ArrowUp aria-hidden="true" size={15} />
      </button>
      <button
        aria-label={`Move ${label} down`}
        disabled={index === length - 1}
        onClick={() => {
          onMove(1);
        }}
        type="button"
      >
        <ArrowDown aria-hidden="true" size={15} />
      </button>
      <button aria-label={`Remove ${label}`} onClick={onRemove} type="button">
        <Trash2 aria-hidden="true" size={15} />
      </button>
    </div>
  );
}

function SectionHeading({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: typeof Layers3;
  title: string;
}) {
  return (
    <header className="setup-section-heading">
      <span className="setup-section-icon" aria-hidden="true">
        <Icon size={19} strokeWidth={1.8} />
      </span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </header>
  );
}

export function EventSetup() {
  const isNewFixture =
    new URLSearchParams(window.location.search).get("state") === "new";
  const [draft, setDraft] = useState<EventSetupDraft>(() =>
    cloneDraft(isNewFixture ? emptyEventSetup : seedEventSetup),
  );
  const [errors, setErrors] = useState<SetupErrors>({});
  const [saved, setSaved] = useState(true);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState("AI Engineer Summit — Europe");
  const [cloneSlug, setCloneSlug] = useState("ai-engineer-summit-europe");
  const [cloneErrors, setCloneErrors] = useState<SetupErrors>({});
  const [clonedFrom, setClonedFrom] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const checklist = useMemo(() => getSetupChecklist(draft), [draft]);
  const blocking = checklist.filter((item) => item.category === "blocking");
  const completeBlocking = blocking.filter((item) => item.complete).length;
  const blockerCount = blocking.length - completeBlocking;
  const deadline = formatEventDeadline(draft.cfpClosesAt, draft.timezone);

  function changeDraft(update: (current: EventSetupDraft) => EventSetupDraft) {
    setDraft(update);
    setSaved(false);
    setErrors({});
  }

  function setField<Key extends keyof EventSetupDraft>(
    key: Key,
    value: EventSetupDraft[Key],
  ) {
    changeDraft((current) => ({ ...current, [key]: value }));
  }

  function moveItem<Key extends "formats" | "rooms" | "tracks">(
    key: Key,
    index: number,
    direction: -1 | 1,
  ) {
    changeDraft((current) => {
      const items = [...current[key]];
      const target = index + direction;
      if (target < 0 || target >= items.length) {
        return current;
      }
      const item = items[index];
      if (!item) {
        return current;
      }
      items.splice(index, 1);
      items.splice(target, 0, item);
      return { ...current, [key]: items } as EventSetupDraft;
    });
  }

  function saveSetup() {
    const nextErrors = validateEventSetup(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setAnnouncement(
        `${Object.keys(nextErrors).length} setup problems need attention.`,
      );
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(".setup-error-wrap")?.focus();
      });
      return;
    }

    setSaved(true);
    setAnnouncement("Event setup saved.");
    setToasts([
      {
        id: "setup-saved",
        message:
          "All blocking settings are valid. You can continue building the CFP.",
        title: "Event setup saved",
        tone: "success",
      },
    ]);
  }

  function confirmClone() {
    const identityErrors = validateEventSetup({
      ...draft,
      name: cloneName,
      slug: cloneSlug,
    });
    const nextErrors: SetupErrors = {};
    if (identityErrors["event-name"]) {
      nextErrors["clone-name"] = identityErrors["event-name"];
    }
    if (identityErrors["event-slug"]) {
      nextErrors["clone-slug"] = identityErrors["event-slug"];
    }
    setCloneErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    const sourceName = draft.name || "Untitled event";
    const request = createCloneConfigurationRequest(draft, {
      name: cloneName,
      slug: cloneSlug,
    });
    const nextId = (prefix: string, index: number) =>
      `${prefix}-clone-${index + 1}`;

    setDraft({
      ...request.configuration,
      eventId: "evt_clone_preview",
      formats: request.configuration.formats.map((format, index) => ({
        ...format,
        id: nextId("format", index),
      })),
      rooms: request.configuration.rooms.map((room, index) => ({
        ...room,
        id: nextId("room", index),
      })),
      tracks: request.configuration.tracks.map((track, index) => ({
        ...track,
        id: nextId("track", index),
      })),
    });
    setClonedFrom(sourceName);
    setSaved(false);
    setErrors({});
    setCloneOpen(false);
    setAnnouncement(
      `Configuration cloned from ${sourceName}. Operational data was excluded.`,
    );
    setToasts([
      {
        id: "setup-cloned",
        message:
          "Tracks, rooms, formats, branding, dates, and CFP rules were copied. Review dates before saving.",
        title: "Configuration-only draft created",
        tone: "success",
      },
    ]);
  }

  const errorSummary = Object.entries(errors).map(([fieldId, message]) => ({
    fieldId,
    message,
  }));

  return (
    <div className="event-setup-page">
      <LiveRegion message={announcement} />
      <header className="event-setup-hero">
        <div>
          <p className="overline">Configure · Event setup</p>
          <div className="event-setup-title-line">
            <h1>{draft.name || "New event"}</h1>
            <StatusPill tone={blockerCount === 0 ? "success" : "warning"}>
              {blockerCount === 0
                ? "Ready"
                : `${blockerCount} blocker${blockerCount === 1 ? "" : "s"}`}
            </StatusPill>
          </div>
          <p>
            Define the public identity, program structure, and submission rules
            every downstream workflow will share.
          </p>
        </div>
        <div className="event-setup-actions">
          <span
            className={
              saved ? "setup-save-state" : "setup-save-state is-unsaved"
            }
          >
            <i aria-hidden="true" /> {saved ? "Saved" : "Unsaved changes"}
          </span>
          <Button
            onClick={() => {
              setCloneName(`${draft.name || "Untitled event"} copy`);
              setCloneSlug(
                draft.slug ? `${draft.slug}-copy` : "untitled-event-copy",
              );
              setCloneErrors({});
              setCloneOpen(true);
            }}
            variant="secondary"
          >
            <Copy aria-hidden="true" size={16} /> Clone event
          </Button>
          <Button onClick={saveSetup}>
            <Save aria-hidden="true" size={16} /> Save setup
          </Button>
        </div>
      </header>

      {clonedFrom ? (
        <section className="setup-clone-notice" aria-label="Clone status">
          <Copy aria-hidden="true" size={18} />
          <div>
            <strong>Configuration-only draft</strong>
            <span>
              Copied from {clonedFrom}. Submissions, users, secrets, and
              external mappings were not included.
            </span>
          </div>
        </section>
      ) : null}

      <div className="event-setup-layout">
        <aside
          className="setup-checklist"
          id="setup-checklist"
          aria-labelledby="setup-checklist-title"
        >
          <div className="setup-checklist-summary">
            <span className="setup-readiness-ring" aria-hidden="true">
              {completeBlocking}/{blocking.length}
            </span>
            <div>
              <p className="overline">Launch readiness</p>
              <h2 id="setup-checklist-title">
                {blockerCount === 0 ? "Ready to open" : "Setup checklist"}
              </h2>
              <p>
                {blockerCount === 0
                  ? "Every blocking prerequisite is valid."
                  : `${blockerCount} blocking ${blockerCount === 1 ? "item needs" : "items need"} attention.`}
              </p>
            </div>
          </div>

          <div
            className="setup-progress"
            aria-label="Blocking setup completion"
            aria-valuemax={blocking.length}
            aria-valuemin={0}
            aria-valuenow={completeBlocking}
            role="progressbar"
          >
            <span
              style={{
                width: `${(completeBlocking / blocking.length) * 100}%`,
              }}
            />
          </div>

          {(["blocking", "recommended", "stretch"] as const).map((category) => {
            const copy = checklistCategoryCopy[category];
            return (
              <section className="setup-checklist-group" key={category}>
                <header>
                  <h3>{copy.label}</h3>
                  <p>{copy.description}</p>
                </header>
                <ul>
                  {checklist
                    .filter((item) => item.category === category)
                    .map((item) => (
                      <li key={item.id}>
                        <a href={item.href}>
                          {item.complete ? (
                            <CheckCircle2
                              className="is-complete"
                              aria-hidden="true"
                              size={18}
                            />
                          ) : (
                            <Circle aria-hidden="true" size={18} />
                          )}
                          <span>
                            <strong>{item.label}</strong>
                            <small>{item.detail}</small>
                          </span>
                        </a>
                      </li>
                    ))}
                </ul>
              </section>
            );
          })}
        </aside>

        <div className="setup-form-column" aria-label="Event settings form">
          {errorSummary.length > 0 ? (
            <div className="setup-error-wrap" tabIndex={-1}>
              <ErrorSummary
                errors={errorSummary}
                title={`${errorSummary.length} setup ${errorSummary.length === 1 ? "problem" : "problems"} need attention`}
              />
            </div>
          ) : null}

          <section className="setup-section" id="event-details">
            <SectionHeading
              description="Dates and deadlines are interpreted in the event timezone—not the organizer's device timezone."
              icon={MapPin}
              title="Event details"
            />
            <div className="setup-field-grid">
              <TextField
                error={errors["event-name"]}
                id="event-name"
                label="Event name"
                onChange={(event) => {
                  setField("name", event.target.value);
                }}
                required
                value={draft.name}
              />
              <TextField
                description="Used in public URLs. Lowercase letters, numbers, and hyphens only."
                error={errors["event-slug"]}
                id="event-slug"
                label="Public slug"
                onChange={(event) => {
                  setField("slug", event.target.value.toLocaleLowerCase());
                }}
                required
                value={draft.slug}
              />
              <TextField
                description="Choose an IANA name such as America/Los_Angeles."
                error={errors["event-timezone"]}
                id="event-timezone"
                label="Event timezone"
                list="event-timezones"
                onChange={(event) => {
                  setField("timezone", event.target.value);
                }}
                required
                value={draft.timezone}
              />
              <datalist id="event-timezones">
                {timezoneOptions.map((timezone) => (
                  <option key={timezone} value={timezone} />
                ))}
              </datalist>
              <TextField
                error={errors["event-start"]}
                id="event-start"
                label="Starts"
                onChange={(event) => {
                  setField("startsAt", event.target.value);
                }}
                required
                type="datetime-local"
                value={draft.startsAt}
              />
              <TextField
                error={errors["event-end"]}
                id="event-end"
                label="Ends"
                onChange={(event) => {
                  setField("endsAt", event.target.value);
                }}
                required
                type="datetime-local"
                value={draft.endsAt}
              />
              <TextField
                className="setup-field-span"
                description="Physical venue, city, or online location."
                id="event-venue"
                label="Venue"
                onChange={(event) => {
                  setField("venue", event.target.value);
                }}
                value={draft.venue}
              />
            </div>
          </section>

          <section className="setup-section" id="brand-settings">
            <SectionHeading
              description="A restrained public identity shared by the CFP, portal, and published program."
              icon={Palette}
              title="Public brand"
            />
            <div className="setup-brand-grid">
              <TextField
                id="brand-name"
                label="Public brand name"
                onChange={(event) => {
                  setField("brandName", event.target.value);
                }}
                value={draft.brandName}
              />
              <TextField
                id="brand-color"
                label="Accent color"
                onChange={(event) => {
                  setField("brandColor", event.target.value);
                }}
                pattern="#[0-9a-fA-F]{6}"
                value={draft.brandColor}
              />
              <div className="setup-brand-preview" aria-label="Brand preview">
                <span style={{ backgroundColor: draft.brandColor }} />
                <div>
                  <small>Public preview</small>
                  <strong>{draft.brandName || "Your event"}</strong>
                </div>
              </div>
            </div>
          </section>

          <section className="setup-section" id="program-structure">
            <SectionHeading
              description="Order here becomes the default order in routing, scheduling, and public filters."
              icon={Layers3}
              title="Program structure"
            />

            <div className="setup-collection" id="tracks-settings">
              <div className="setup-collection-heading">
                <div>
                  <h3>Tracks</h3>
                  <p>Topics applicants choose and attendees filter by.</p>
                </div>
                <Button
                  onClick={() => {
                    changeDraft((current) => ({
                      ...current,
                      tracks: [
                        ...current.tracks,
                        {
                          color: "#487a80",
                          id: createId("track"),
                          name: "",
                        },
                      ],
                    }));
                  }}
                  variant="secondary"
                >
                  <Plus aria-hidden="true" size={15} /> Add track
                </Button>
              </div>
              {errors["tracks-list"] ? (
                <p className="setup-collection-error" id="tracks-list">
                  {errors["tracks-list"]}
                </p>
              ) : null}
              <div className="setup-rows">
                {draft.tracks.map((track, index) => (
                  <div className="setup-row setup-track-row" key={track.id}>
                    <span className="setup-order" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <label className="setup-color-field">
                      <span>Color</span>
                      <input
                        aria-label={`${track.name || `Track ${index + 1}`} color`}
                        onChange={(event) => {
                          const value = event.target.value;
                          changeDraft((current) => ({
                            ...current,
                            tracks: current.tracks.map((item) =>
                              item.id === track.id
                                ? { ...item, color: value }
                                : item,
                            ),
                          }));
                        }}
                        type="color"
                        value={track.color}
                      />
                    </label>
                    <TextField
                      error={errors[`track-${track.id}-name`]}
                      id={`track-${track.id}-name`}
                      label="Track name"
                      onChange={(event) => {
                        const value = event.target.value;
                        changeDraft((current) => ({
                          ...current,
                          tracks: current.tracks.map((item) =>
                            item.id === track.id
                              ? { ...item, name: value }
                              : item,
                          ),
                        }));
                      }}
                      value={track.name}
                    />
                    <OrderedRowActions
                      index={index}
                      label={track.name || `track ${index + 1}`}
                      length={draft.tracks.length}
                      onMove={(direction) => {
                        moveItem("tracks", index, direction);
                      }}
                      onRemove={() => {
                        changeDraft((current) => ({
                          ...current,
                          tracks: current.tracks.filter(
                            (item) => item.id !== track.id,
                          ),
                        }));
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="setup-collection" id="rooms-settings">
              <div className="setup-collection-heading">
                <div>
                  <h3>Rooms</h3>
                  <p>Physical or virtual spaces with planning capacity.</p>
                </div>
                <Button
                  onClick={() => {
                    changeDraft((current) => ({
                      ...current,
                      rooms: [
                        ...current.rooms,
                        { capacity: "", id: createId("room"), name: "" },
                      ],
                    }));
                  }}
                  variant="secondary"
                >
                  <Plus aria-hidden="true" size={15} /> Add room
                </Button>
              </div>
              {errors["rooms-list"] ? (
                <p className="setup-collection-error" id="rooms-list">
                  {errors["rooms-list"]}
                </p>
              ) : null}
              <div className="setup-rows">
                {draft.rooms.map((room, index) => (
                  <div className="setup-row" key={room.id}>
                    <span className="setup-order" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <TextField
                      error={errors[`room-${room.id}-name`]}
                      id={`room-${room.id}-name`}
                      label="Room name"
                      onChange={(event) => {
                        const value = event.target.value;
                        changeDraft((current) => ({
                          ...current,
                          rooms: current.rooms.map((item) =>
                            item.id === room.id
                              ? { ...item, name: value }
                              : item,
                          ),
                        }));
                      }}
                      value={room.name}
                    />
                    <TextField
                      error={errors[`room-${room.id}-capacity`]}
                      id={`room-${room.id}-capacity`}
                      inputMode="numeric"
                      label="Capacity"
                      min={1}
                      onChange={(event) => {
                        const value = numberValue(event.target.value);
                        changeDraft((current) => ({
                          ...current,
                          rooms: current.rooms.map((item) =>
                            item.id === room.id
                              ? { ...item, capacity: value }
                              : item,
                          ),
                        }));
                      }}
                      step={1}
                      type="number"
                      value={room.capacity}
                    />
                    <OrderedRowActions
                      index={index}
                      label={room.name || `room ${index + 1}`}
                      length={draft.rooms.length}
                      onMove={(direction) => {
                        moveItem("rooms", index, direction);
                      }}
                      onRemove={() => {
                        changeDraft((current) => ({
                          ...current,
                          rooms: current.rooms.filter(
                            (item) => item.id !== room.id,
                          ),
                        }));
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="setup-collection" id="formats-settings">
              <div className="setup-collection-heading">
                <div>
                  <h3>Formats</h3>
                  <p>Session shapes and their default scheduling duration.</p>
                </div>
                <Button
                  onClick={() => {
                    changeDraft((current) => ({
                      ...current,
                      formats: [
                        ...current.formats,
                        {
                          durationMinutes: current.defaultDurationMinutes,
                          id: createId("format"),
                          name: "",
                        },
                      ],
                    }));
                  }}
                  variant="secondary"
                >
                  <Plus aria-hidden="true" size={15} /> Add format
                </Button>
              </div>
              {errors["formats-list"] ? (
                <p className="setup-collection-error" id="formats-list">
                  {errors["formats-list"]}
                </p>
              ) : null}
              <div className="setup-rows">
                {draft.formats.map((format, index) => (
                  <div className="setup-row" key={format.id}>
                    <span className="setup-order" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <TextField
                      error={errors[`format-${format.id}-name`]}
                      id={`format-${format.id}-name`}
                      label="Format name"
                      onChange={(event) => {
                        const value = event.target.value;
                        changeDraft((current) => ({
                          ...current,
                          formats: current.formats.map((item) =>
                            item.id === format.id
                              ? { ...item, name: value }
                              : item,
                          ),
                        }));
                      }}
                      value={format.name}
                    />
                    <TextField
                      description="5-minute increments"
                      error={errors[`format-${format.id}-duration`]}
                      id={`format-${format.id}-duration`}
                      inputMode="numeric"
                      label="Duration (minutes)"
                      min={5}
                      onChange={(event) => {
                        const value = numberValue(event.target.value);
                        changeDraft((current) => ({
                          ...current,
                          formats: current.formats.map((item) =>
                            item.id === format.id
                              ? { ...item, durationMinutes: value }
                              : item,
                          ),
                        }));
                      }}
                      step={5}
                      type="number"
                      value={format.durationMinutes}
                    />
                    <OrderedRowActions
                      index={index}
                      label={format.name || `format ${index + 1}`}
                      length={draft.formats.length}
                      onMove={(direction) => {
                        moveItem("formats", index, direction);
                      }}
                      onRemove={() => {
                        changeDraft((current) => ({
                          ...current,
                          formats: current.formats.filter(
                            (item) => item.id !== format.id,
                          ),
                        }));
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="setup-section" id="cfp-settings">
            <SectionHeading
              description="The event timezone controls the deadline applicants see everywhere."
              icon={Sparkles}
              title="CFP settings"
            />
            <div className="setup-field-grid">
              <TextField
                error={errors["cfp-opens"]}
                id="cfp-opens"
                label="CFP opens"
                onChange={(event) => {
                  setField("cfpOpensAt", event.target.value);
                }}
                required
                type="datetime-local"
                value={draft.cfpOpensAt}
              />
              <TextField
                error={errors["cfp-closes"]}
                id="cfp-closes"
                label="CFP closes"
                onChange={(event) => {
                  setField("cfpClosesAt", event.target.value);
                }}
                required
                type="datetime-local"
                value={draft.cfpClosesAt}
              />
              <TextField
                description="5–480 minutes, in 5-minute increments."
                error={errors["default-duration"]}
                id="default-duration"
                label="Default session duration"
                min={5}
                onChange={(event) => {
                  setField(
                    "defaultDurationMinutes",
                    numberValue(event.target.value),
                  );
                }}
                required
                step={5}
                type="number"
                value={draft.defaultDurationMinutes}
              />
              <TextField
                description="Maximum proposals one applicant can submit."
                error={errors["submission-limit"]}
                id="submission-limit"
                label="Submission limit"
                max={20}
                min={1}
                onChange={(event) => {
                  setField("submissionLimit", numberValue(event.target.value));
                }}
                required
                step={1}
                type="number"
                value={draft.submissionLimit}
              />
            </div>
            <div className="setup-timezone-preview" role="status">
              <Check aria-hidden="true" size={17} />
              <span>
                <strong>Applicant-facing close</strong>
                {deadline ?? "Add a valid CFP close and event timezone."}
              </span>
            </div>
          </section>

          <section className="setup-section" id="reply-settings">
            <SectionHeading
              description="Application receipts and organizer messages use this monitored inbox."
              icon={MessageSquareReply}
              title="Reply handling"
            />
            <TextField
              description="Applicants will see this address in email reply headers."
              error={errors["reply-to"]}
              id="reply-to"
              label="Reply-to email"
              onChange={(event) => {
                setField("replyTo", event.target.value);
              }}
              required
              type="email"
              value={draft.replyTo}
            />
          </section>
        </div>
      </div>

      <Dialog
        description="Create a new event draft from this event's reusable configuration."
        onClose={() => {
          setCloneOpen(false);
        }}
        open={cloneOpen}
        title="Clone event configuration"
      >
        <div className="setup-clone-dialog">
          <TextField
            error={cloneErrors["clone-name"]}
            id="clone-name"
            label="New event name"
            onChange={(event) => {
              setCloneName(event.target.value);
            }}
            required
            value={cloneName}
          />
          <TextField
            error={cloneErrors["clone-slug"]}
            id="clone-slug"
            label="New public slug"
            onChange={(event) => {
              setCloneSlug(event.target.value.toLocaleLowerCase());
            }}
            required
            value={cloneSlug}
          />
          <div className="setup-clone-columns">
            <section>
              <h3>Copied</h3>
              <ul>
                <li>Brand and venue</li>
                <li>Timezone, dates, and CFP rules</li>
                <li>Ordered tracks, rooms, and formats</li>
              </ul>
            </section>
            <section>
              <h3>Never copied</h3>
              <ul>
                <li>Submissions or participants</li>
                <li>Users, roles, or invitations</li>
                <li>Secrets or external mappings</li>
              </ul>
            </section>
          </div>
          <p className="setup-clone-guidance">
            Dates are configuration too. Review them before saving the new
            event.
          </p>
          <div className="setup-dialog-actions">
            <Button
              onClick={() => {
                setCloneOpen(false);
              }}
              variant="secondary"
            >
              Cancel
            </Button>
            <Button onClick={confirmClone}>
              <Copy aria-hidden="true" size={15} /> Create clone draft
            </Button>
          </div>
        </div>
      </Dialog>

      <ToastRegion
        messages={toasts}
        onDismiss={(id) => {
          setToasts((current) => current.filter((toast) => toast.id !== id));
        }}
      />
    </div>
  );
}
