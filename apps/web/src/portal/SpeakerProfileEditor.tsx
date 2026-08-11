import {
  Building2,
  Check,
  CircleAlert,
  Cloud,
  FileImage,
  History,
  ImageUp,
  LayoutPanelTop,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Maximize2,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import {
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  Button,
  StatusPill,
  SwitchField,
  TextAreaField,
  TextField,
} from "@sessionbox-killer/ui";
import type { SpeakerProfilePublicationState } from "@sessionbox-killer/contracts";

import type { SpeakerProfileView } from "./portalModel";
import type { ProfileErrors, ProfileField } from "./speakerProfileModel";

import "./speaker-profile.css";

export type ProfileHeadshotState = "processing" | "ready" | "uploading";
export type ProfileSaveState =
  "conflict" | "recovery" | "saved" | "saving" | "syncing" | "unsaved";

export interface ProfileAuditItem {
  readonly id: string;
  readonly label: string;
}

export interface ProfileNotice {
  readonly action?: ReactNode;
  readonly message: string;
  readonly title: string;
  readonly tone: "error" | "info" | "warning";
}

function isHttpUrl(value: string) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isPreviewableSocial(label: string, value: string) {
  if (!value || !isHttpUrl(value)) return false;
  if (label !== "LinkedIn") return true;
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
}

function profileInitials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "SP"
  );
}

function ProfilePortrait({ profile }: { profile: SpeakerProfileView }) {
  return profile.headshotUrl ? (
    <img
      alt={profile.headshotAlt || `Portrait of ${profile.displayName}`}
      src={profile.headshotUrl}
    />
  ) : (
    <span
      aria-label={`Initials for ${profile.displayName || "speaker"}`}
      role="img"
    >
      {profileInitials(profile.displayName)}
    </span>
  );
}

function previewStatus(
  publicationState: SpeakerProfilePublicationState,
  dirty: boolean,
) {
  if (publicationState === "published" && !dirty) {
    return {
      label: "Published",
      note: "This is the profile attendees can currently see in the public program.",
      tone: "success" as const,
    };
  }
  if (publicationState === "published") {
    return {
      label: "Unpublished changes",
      note: "Attendees still see the last published version until an organizer publishes these changes.",
      tone: "warning" as const,
    };
  }
  if (publicationState === "approved") {
    return {
      label: "Approved, not published",
      note: "An organizer approved this profile, but it is not visible in the public program yet.",
      tone: "warning" as const,
    };
  }
  return {
    label: "Unpublished draft",
    note: "Only you and organizers can see this draft until an organizer publishes it.",
    tone: "warning" as const,
  };
}

function PublicPreview({
  dirty,
  eventName,
  profile,
  publicationState,
}: {
  dirty: boolean;
  eventName: string;
  profile: SpeakerProfileView;
  publicationState: SpeakerProfilePublicationState;
}) {
  const [mode, setMode] = useState<"card" | "profile">("card");
  const status = previewStatus(publicationState, dirty);
  const socialCandidates: [string, string][] = [
    ["LinkedIn", profile.linkedinUrl],
    ["Bluesky", profile.blueskyUrl],
    ["Website", profile.websiteUrl],
  ];
  const socialLinks = socialCandidates.filter(([label, value]) =>
    isPreviewableSocial(label, value),
  );

  return (
    <aside className="speaker-profile-preview" aria-labelledby="preview-title">
      <div className="profile-preview-heading">
        <div>
          <p className="overline">Attendee preview</p>
          <h2 id="preview-title">Public profile</h2>
        </div>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
      </div>
      <p className="profile-preview-note">{status.note}</p>
      <div className="profile-preview-switch" aria-label="Preview format">
        <button
          aria-pressed={mode === "card"}
          className={mode === "card" ? "is-active" : ""}
          onClick={() => setMode("card")}
          type="button"
        >
          <LayoutPanelTop aria-hidden="true" size={15} /> Card
        </button>
        <button
          aria-pressed={mode === "profile"}
          className={mode === "profile" ? "is-active" : ""}
          onClick={() => setMode("profile")}
          type="button"
        >
          <Maximize2 aria-hidden="true" size={15} /> Full profile
        </button>
      </div>
      <div className={`public-speaker-preview is-${mode}`}>
        <div className="public-speaker-portrait">
          <ProfilePortrait profile={profile} />
          <span>{eventName}</span>
        </div>
        <div className="public-speaker-copy">
          <span className="public-speaker-track">Speaker</span>
          <h3>{profile.displayName || "Speaker name"}</h3>
          {profile.pronouns ? <small>{profile.pronouns}</small> : null}
          <p className="public-speaker-role">
            {profile.title || "Role"}
            {profile.company ? ` · ${profile.company}` : ""}
          </p>
          {mode === "profile" ? (
            <>
              <p className="public-speaker-bio">
                {profile.bio || "Your public biography will appear here."}
              </p>
              {socialLinks.length ? (
                <nav aria-label="Speaker links">
                  {socialLinks.map(([label, url]) => (
                    <a href={url} key={label} rel="noreferrer" target="_blank">
                      {label} <Link2 aria-hidden="true" size={12} />
                    </a>
                  ))}
                </nav>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      <section className="profile-reuse-boundary">
        <LockKeyhole aria-hidden="true" size={19} />
        <div>
          <strong>Reusable identity, event-private operations</strong>
          <p>
            Name, bio, headshot, and links can be reused across your
            organization. Sessions, tasks, deadlines, and readiness stay inside
            this event and never enter the public profile.
          </p>
        </div>
      </section>
    </aside>
  );
}

const saveStatusCopy: Record<
  ProfileSaveState,
  { detail: string; title: string }
> = {
  conflict: {
    detail: "Your draft is preserved",
    title: "Review the latest version",
  },
  recovery: {
    detail: "Retry this exact save or refresh",
    title: "Save outcome unknown",
  },
  saved: {
    detail: "Saved to your reusable profile",
    title: "All changes saved",
  },
  saving: { detail: "Keeping this profile reusable", title: "Saving changes" },
  syncing: {
    detail: "Your change is committed",
    title: "Finishing synchronization",
  },
  unsaved: { detail: "Waiting for a valid save", title: "Unsaved changes" },
};

function SaveStatus({
  lastSaved,
  state,
}: {
  lastSaved: string;
  state: ProfileSaveState;
}) {
  const copy = saveStatusCopy[state];
  const active = state === "saving" || state === "syncing";
  return (
    <div className={`profile-save-status is-${state}`} role="status">
      {active ? (
        <LoaderCircle aria-hidden="true" className="is-spinning" size={16} />
      ) : state === "saved" ? (
        <Cloud aria-hidden="true" size={16} />
      ) : (
        <CircleAlert aria-hidden="true" size={16} />
      )}
      <span>
        <strong>{copy.title}</strong>
        <small>{state === "saved" ? lastSaved : copy.detail}</small>
      </span>
    </div>
  );
}

export function SpeakerProfileEditor({
  auditEntries,
  autosave,
  dirty,
  errors,
  eventName,
  headshotError,
  headshotProgress,
  headshotRequirements,
  headshotState,
  lastSaved,
  locked,
  notice,
  onAutosaveChange,
  onDiscard,
  onFieldChange,
  onHeadshot,
  onRemoveHeadshot,
  onSubmit,
  profile,
  publicationState,
  saveState,
}: {
  auditEntries: readonly ProfileAuditItem[];
  autosave: boolean;
  dirty: boolean;
  errors: ProfileErrors;
  eventName: string;
  headshotError: string;
  headshotProgress?: number | undefined;
  headshotRequirements: string;
  headshotState: ProfileHeadshotState;
  lastSaved: string;
  locked: boolean;
  notice?: ProfileNotice | null | undefined;
  onAutosaveChange: (checked: boolean) => void;
  onDiscard: () => void;
  onFieldChange: (field: ProfileField, value: string) => void;
  onHeadshot: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveHeadshot: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  profile: SpeakerProfileView;
  publicationState: SpeakerProfilePublicationState;
  saveState: ProfileSaveState;
}) {
  const hasErrors = Object.keys(errors).length > 0 || Boolean(headshotError);
  const headshotBusy = headshotState !== "ready";
  return (
    <main className="portal-main speaker-profile-main">
      <header className="speaker-profile-hero">
        <div>
          <p className="overline">Reusable speaker identity</p>
          <h1>Shape how the audience meets you.</h1>
          <p>
            Keep one polished profile for your organization, then preview
            exactly how it appears in this event’s public program.
          </p>
        </div>
        <SaveStatus lastSaved={lastSaved} state={saveState} />
      </header>

      {notice ? (
        <section
          className={`profile-runtime-notice is-${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <div>
            <strong>{notice.title}</strong>
            <p>{notice.message}</p>
          </div>
          {notice.action ? (
            <div className="profile-runtime-actions">{notice.action}</div>
          ) : null}
        </section>
      ) : null}

      <div className="speaker-profile-layout">
        <form
          aria-busy={locked || headshotBusy}
          className="speaker-profile-form"
          noValidate
          onSubmit={onSubmit}
        >
          <section aria-labelledby="identity-title" className="profile-section">
            <header>
              <span>
                <UserRound aria-hidden="true" size={18} />
              </span>
              <div>
                <h2 id="identity-title">Public identity</h2>
                <p>These details can follow you to another event.</p>
              </div>
            </header>
            <div className="profile-field-grid">
              <TextField
                disabled={locked}
                error={errors.displayName}
                id="displayName"
                label="Display name"
                maxLength={160}
                onChange={(event) =>
                  onFieldChange("displayName", event.target.value)
                }
                required
                value={profile.displayName}
              />
              <TextField
                disabled={locked}
                error={errors.pronouns}
                id="pronouns"
                label="Pronouns"
                maxLength={80}
                onChange={(event) =>
                  onFieldChange("pronouns", event.target.value)
                }
                placeholder="e.g. she/her"
                value={profile.pronouns}
              />
              <TextField
                disabled={locked}
                error={errors.title}
                id="title"
                label="Role or title"
                maxLength={160}
                onChange={(event) => onFieldChange("title", event.target.value)}
                required
                value={profile.title}
              />
              <TextField
                disabled={locked}
                error={errors.company}
                id="company"
                label="Company or organization"
                maxLength={160}
                onChange={(event) =>
                  onFieldChange("company", event.target.value)
                }
                required
                value={profile.company}
              />
            </div>
            <div className="profile-bio-field">
              <TextAreaField
                description={`${profile.bio.length}/400 characters`}
                disabled={locked}
                id="bio"
                label="Public biography"
                maxLength={400}
                onChange={(event) => onFieldChange("bio", event.target.value)}
                required
                rows={5}
                value={profile.bio}
                {...(errors.bio ? { error: errors.bio } : {})}
              />
            </div>
          </section>

          <section aria-labelledby="headshot-title" className="profile-section">
            <header>
              <span>
                <FileImage aria-hidden="true" size={18} />
              </span>
              <div>
                <h2 id="headshot-title">Headshot</h2>
                <p>Private until processing succeeds and you save.</p>
              </div>
            </header>
            <div className="profile-headshot-editor">
              <div className="profile-headshot-image">
                <ProfilePortrait profile={profile} />
              </div>
              <div className="profile-headshot-copy">
                <div>
                  <strong>
                    {profile.headshotFileName || "No headshot selected"}
                  </strong>
                  <StatusPill tone={headshotBusy ? "preview" : "success"}>
                    {headshotState === "uploading"
                      ? "Uploading"
                      : headshotState === "processing"
                        ? "Processing"
                        : profile.headshotUrl
                          ? "Ready"
                          : "Optional"}
                  </StatusPill>
                </div>
                <p>{headshotRequirements}</p>
                {headshotProgress !== undefined &&
                headshotState === "uploading" ? (
                  <div className="profile-upload-progress">
                    <progress
                      aria-label="Headshot upload progress"
                      max={100}
                      value={headshotProgress}
                    />
                    <span>{headshotProgress}%</span>
                  </div>
                ) : null}
                <div className="profile-headshot-actions">
                  <label
                    aria-disabled={locked || headshotBusy}
                    className="profile-file-button"
                    htmlFor="headshot-file"
                  >
                    <ImageUp aria-hidden="true" size={15} />{" "}
                    {profile.headshotUrl
                      ? "Replace headshot"
                      : "Choose headshot"}
                  </label>
                  {profile.headshotUrl ? (
                    <Button
                      disabled={locked || headshotBusy}
                      onClick={onRemoveHeadshot}
                      variant="secondary"
                    >
                      <Trash2 aria-hidden="true" size={14} /> Remove
                    </Button>
                  ) : null}
                </div>
                <input
                  accept="image/jpeg,image/png,image/webp"
                  disabled={locked || headshotBusy}
                  id="headshot-file"
                  onChange={onHeadshot}
                  type="file"
                />
                {headshotError ? (
                  <p className="profile-headshot-error" role="alert">
                    {headshotError}
                  </p>
                ) : null}
              </div>
            </div>
            <TextField
              description="Describe the person, not the image style. Your display name remains separate."
              disabled={locked}
              error={errors.headshotAlt}
              id="headshotAlt"
              label="Headshot alt text"
              maxLength={200}
              onChange={(event) =>
                onFieldChange("headshotAlt", event.target.value)
              }
              required={Boolean(profile.headshotUrl)}
              value={profile.headshotAlt}
            />
          </section>

          <section aria-labelledby="links-title" className="profile-section">
            <header>
              <span>
                <Link2 aria-hidden="true" size={18} />
              </span>
              <div>
                <h2 id="links-title">Public links</h2>
                <p>Only complete, validated URLs appear in the preview.</p>
              </div>
            </header>
            <div className="profile-links-grid">
              <TextField
                disabled={locked}
                error={errors.linkedinUrl}
                id="linkedinUrl"
                label="LinkedIn URL"
                maxLength={2048}
                onChange={(event) =>
                  onFieldChange("linkedinUrl", event.target.value)
                }
                placeholder="https://linkedin.com/in/…"
                type="url"
                value={profile.linkedinUrl}
              />
              <TextField
                disabled={locked}
                error={errors.blueskyUrl}
                id="blueskyUrl"
                label="Bluesky URL"
                maxLength={2048}
                onChange={(event) =>
                  onFieldChange("blueskyUrl", event.target.value)
                }
                placeholder="https://bsky.app/profile/…"
                type="url"
                value={profile.blueskyUrl}
              />
              <TextField
                disabled={locked}
                error={errors.websiteUrl}
                id="websiteUrl"
                label="Website URL"
                maxLength={2048}
                onChange={(event) =>
                  onFieldChange("websiteUrl", event.target.value)
                }
                placeholder="https://example.com"
                type="url"
                value={profile.websiteUrl}
              />
            </div>
          </section>

          <section className="profile-save-panel" aria-label="Save profile">
            <SwitchField
              checked={autosave}
              description="Valid changes save after a short pause."
              disabled={locked}
              label="Autosave profile"
              onChange={onAutosaveChange}
            />
            <div>
              <Button
                aria-label="Discard unsaved profile changes"
                disabled={!dirty || locked}
                onClick={onDiscard}
                variant="secondary"
              >
                <RotateCcw aria-hidden="true" size={15} /> Discard
              </Button>
              <Button
                disabled={!dirty || hasErrors || locked || headshotBusy}
                type="submit"
              >
                <Check aria-hidden="true" size={15} /> Save now
              </Button>
            </div>
          </section>
        </form>

        <div className="speaker-profile-sidebar">
          <PublicPreview
            dirty={dirty}
            eventName={eventName}
            profile={profile}
            publicationState={publicationState}
          />
          <section className="profile-audit" aria-labelledby="audit-title">
            <header>
              <History aria-hidden="true" size={18} />
              <div>
                <h2 id="audit-title">Saved change record</h2>
                <p>Visible to event organizers.</p>
              </div>
            </header>
            {auditEntries.length ? (
              <ol>
                {auditEntries.slice(0, 3).map((entry) => (
                  <li key={entry.id}>
                    <ShieldCheck aria-hidden="true" size={15} /> {entry.label}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="profile-audit-empty">
                Saved changes will appear here.
              </p>
            )}
            <div className="profile-audit-scope">
              <Building2 aria-hidden="true" size={16} />
              Profile fields are organization-wide. {eventName} readiness
              remains event-only.
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
