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
  UserRound,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import {
  Button,
  LiveRegion,
  StatusPill,
  SwitchField,
  TextAreaField,
  TextField,
  ToastRegion,
  type ToastMessage,
} from "@sessionbox-killer/ui";

import { speakerProfileFixture, type SpeakerProfileView } from "./portalModel";

import "./speaker-profile.css";

type ProfileField = Exclude<
  keyof SpeakerProfileView,
  "headshotFileName" | "headshotUrl"
>;
type PreviewMode = "card" | "profile";
type SaveState = "saved" | "saving" | "unsaved";
type HeadshotState = "processing" | "ready";

const acceptedHeadshotTypes = ["image/jpeg", "image/png", "image/webp"];
const maxHeadshotBytes = 8 * 1024 * 1024;

function isHttpUrl(value: string) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isPreviewableSocial(label: string, value: string) {
  if (!value || !isHttpUrl(value)) return false;
  if (label !== "LinkedIn") return true;
  const hostname = new URL(value).hostname;
  return hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
}

function validateProfile(profile: SpeakerProfileView) {
  const errors: Partial<Record<ProfileField, string>> = {};

  if (!profile.displayName.trim()) {
    errors.displayName = "Add the name attendees should see.";
  }
  if (!profile.title.trim()) {
    errors.title = "Add a public role or title.";
  }
  if (!profile.company.trim()) {
    errors.company = "Add a company or organization.";
  }
  if (!profile.bio.trim()) {
    errors.bio = "Add a short public biography.";
  } else if (profile.bio.length > 400) {
    errors.bio = "Keep the biography to 400 characters or fewer.";
  }
  if (!profile.headshotAlt.trim()) {
    errors.headshotAlt = "Describe the headshot for people who cannot see it.";
  }
  if (!isHttpUrl(profile.linkedinUrl)) {
    errors.linkedinUrl = "Enter a complete http:// or https:// URL.";
  } else if (profile.linkedinUrl) {
    const hostname = new URL(profile.linkedinUrl).hostname;
    if (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com")) {
      errors.linkedinUrl = "Use a linkedin.com profile URL.";
    }
  }
  if (!isHttpUrl(profile.blueskyUrl)) {
    errors.blueskyUrl = "Enter a complete http:// or https:// URL.";
  }
  if (!isHttpUrl(profile.websiteUrl)) {
    errors.websiteUrl = "Enter a complete http:// or https:// URL.";
  }

  return errors;
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
    <img alt={profile.headshotAlt} src={profile.headshotUrl} />
  ) : (
    <span aria-label={profile.headshotAlt} role="img">
      {profileInitials(profile.displayName)}
    </span>
  );
}

function PublicPreview({
  mode,
  onModeChange,
  profile,
}: {
  mode: PreviewMode;
  onModeChange: (mode: PreviewMode) => void;
  profile: SpeakerProfileView;
}) {
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
        <StatusPill tone="warning">Unpublished draft</StatusPill>
      </div>

      <p className="profile-preview-note">
        Only you and organizers can see these changes until the public program
        is published again.
      </p>

      <div className="profile-preview-switch" aria-label="Preview format">
        <button
          aria-pressed={mode === "card"}
          className={mode === "card" ? "is-active" : ""}
          onClick={() => onModeChange("card")}
          type="button"
        >
          <LayoutPanelTop aria-hidden="true" size={15} /> Card
        </button>
        <button
          aria-pressed={mode === "profile"}
          className={mode === "profile" ? "is-active" : ""}
          onClick={() => onModeChange("profile")}
          type="button"
        >
          <Maximize2 aria-hidden="true" size={15} /> Full profile
        </button>
      </div>

      <div className={`public-speaker-preview is-${mode}`}>
        <div className="public-speaker-portrait">
          <ProfilePortrait profile={profile} />
          <span>AI Engineer Summit</span>
        </div>
        <div className="public-speaker-copy">
          <span className="public-speaker-track">AI Engineering</span>
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

function SaveStatus({
  lastSaved,
  state,
}: {
  lastSaved: string;
  state: SaveState;
}) {
  return (
    <div className={`profile-save-status is-${state}`} role="status">
      {state === "saving" ? (
        <LoaderCircle aria-hidden="true" className="is-spinning" size={16} />
      ) : state === "saved" ? (
        <Cloud aria-hidden="true" size={16} />
      ) : (
        <CircleAlert aria-hidden="true" size={16} />
      )}
      <span>
        <strong>
          {state === "saving"
            ? "Saving changes"
            : state === "saved"
              ? "All changes saved"
              : "Unsaved changes"}
        </strong>
        <small>
          {state === "saved"
            ? lastSaved
            : state === "saving"
              ? "Keeping this profile reusable"
              : "Waiting for a valid save"}
        </small>
      </span>
    </div>
  );
}

export function SpeakerProfileWorkspace() {
  const [profile, setProfile] = useState<SpeakerProfileView>(
    speakerProfileFixture,
  );
  const [savedProfile, setSavedProfile] = useState<SpeakerProfileView>(
    speakerProfileFixture,
  );
  const [autosave, setAutosave] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [lastSaved, setLastSaved] = useState("Saved Aug 9 at 3:42 PM");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("card");
  const [headshotState, setHeadshotState] = useState<HeadshotState>("ready");
  const [headshotError, setHeadshotError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [auditEntries, setAuditEntries] = useState([
    "Profile saved · Mina Okafor · Aug 9 at 3:42 PM",
  ]);
  const autosaveTimer = useRef<number | undefined>(undefined);
  const commitTimer = useRef<number | undefined>(undefined);
  const objectUrl = useRef("");

  const errors = useMemo(() => validateProfile(profile), [profile]);
  const hasErrors = Object.keys(errors).length > 0 || Boolean(headshotError);
  const dirty = JSON.stringify(profile) !== JSON.stringify(savedProfile);

  useEffect(() => {
    window.clearTimeout(autosaveTimer.current);
    window.clearTimeout(commitTimer.current);

    if (!dirty) return;
    if (!autosave || hasErrors || headshotState === "processing") return;

    const snapshot = profile;
    autosaveTimer.current = window.setTimeout(() => {
      setSaveState("saving");
      commitTimer.current = window.setTimeout(() => {
        setSavedProfile(snapshot);
        setSaveState("saved");
        setLastSaved("Saved just now");
        setAuditEntries((current) => [
          "Profile autosaved · Mina Okafor · Just now",
          ...current,
        ]);
        setAnnouncement("Profile changes autosaved.");
      }, 250);
    }, 700);

    return () => {
      window.clearTimeout(autosaveTimer.current);
      window.clearTimeout(commitTimer.current);
    };
  }, [autosave, dirty, hasErrors, headshotState, profile]);

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  function updateField(field: ProfileField, value: string) {
    setSaveState("unsaved");
    setProfile((current) => ({ ...current, [field]: value }));
  }

  function announce(title: string, message: string, tone?: "error") {
    setAnnouncement(message);
    const toast: ToastMessage = {
      id: `${Date.now()}-${title}`,
      message,
      title,
      ...(tone ? { tone } : {}),
    };
    setToasts((current) => [...current, toast]);
  }

  function commitProfile(source: "manual" | "autosave") {
    window.clearTimeout(autosaveTimer.current);
    window.clearTimeout(commitTimer.current);
    setSaveState("saving");
    const snapshot = profile;
    commitTimer.current = window.setTimeout(() => {
      setSavedProfile(snapshot);
      setSaveState("saved");
      setLastSaved("Saved just now");
      setAuditEntries((current) => [
        `Profile ${source === "manual" ? "saved" : "autosaved"} · Mina Okafor · Just now`,
        ...current,
      ]);
      announce(
        "Profile saved",
        "Your reusable profile is saved. The attendee preview remains unpublished.",
      );
    }, 250);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (hasErrors || headshotState === "processing") {
      const firstError = Object.keys(errors)[0];
      if (firstError) document.getElementById(firstError)?.focus();
      announce(
        "Fix profile details",
        "Resolve the highlighted fields before saving this profile.",
        "error",
      );
      return;
    }
    commitProfile("manual");
  }

  function handleHeadshot(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!acceptedHeadshotTypes.includes(file.type)) {
      setHeadshotError("Choose a JPG, PNG, or WebP image.");
      announce(
        "Headshot not accepted",
        "Choose a JPG, PNG, or WebP image.",
        "error",
      );
      return;
    }
    if (file.size > maxHeadshotBytes) {
      setHeadshotError("Choose an image smaller than 8 MB.");
      announce(
        "Headshot is too large",
        "Choose an image smaller than 8 MB.",
        "error",
      );
      return;
    }

    setHeadshotError("");
    setHeadshotState("processing");
    const candidateUrl = URL.createObjectURL(file);
    const candidateImage = new Image();

    candidateImage.onload = () => {
      if (
        candidateImage.naturalWidth < 1200 ||
        candidateImage.naturalHeight < 1200
      ) {
        URL.revokeObjectURL(candidateUrl);
        setHeadshotState("ready");
        setHeadshotError("Choose an image at least 1200 × 1200 pixels.");
        announce(
          "Headshot is too small",
          "Choose an image at least 1200 × 1200 pixels.",
          "error",
        );
        return;
      }

      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = candidateUrl;
      setSaveState("unsaved");
      setProfile((current) => ({
        ...current,
        headshotFileName: file.name,
        headshotUrl: candidateUrl,
      }));
      window.setTimeout(() => {
        setHeadshotState("ready");
        setAnnouncement("Headshot processed and ready to save.");
      }, 450);
    };
    candidateImage.onerror = () => {
      URL.revokeObjectURL(candidateUrl);
      setHeadshotState("ready");
      setHeadshotError("Choose an image file that can be processed.");
      announce(
        "Headshot could not be processed",
        "Choose a valid JPG, PNG, or WebP image.",
        "error",
      );
    };
    candidateImage.src = candidateUrl;
  }

  function discardChanges() {
    setProfile(savedProfile);
    setHeadshotError("");
    setHeadshotState("ready");
    setSaveState("saved");
    announce(
      "Draft restored",
      "Unsaved profile changes were replaced with the last saved version.",
    );
  }

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

      <div className="speaker-profile-layout">
        <form
          className="speaker-profile-form"
          noValidate
          onSubmit={handleSubmit}
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
                error={errors.displayName}
                id="displayName"
                label="Display name"
                onChange={(event) =>
                  updateField("displayName", event.target.value)
                }
                required
                value={profile.displayName}
              />
              <TextField
                id="pronouns"
                label="Pronouns"
                onChange={(event) =>
                  updateField("pronouns", event.target.value)
                }
                placeholder="e.g. she/her"
                value={profile.pronouns}
              />
              <TextField
                error={errors.title}
                id="title"
                label="Role or title"
                onChange={(event) => updateField("title", event.target.value)}
                required
                value={profile.title}
              />
              <TextField
                error={errors.company}
                id="company"
                label="Company or organization"
                onChange={(event) => updateField("company", event.target.value)}
                required
                value={profile.company}
              />
            </div>
            <div className="profile-bio-field">
              <TextAreaField
                description={`${profile.bio.length}/400 characters`}
                id="bio"
                label="Public biography"
                onChange={(event) => updateField("bio", event.target.value)}
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
                  <strong>{profile.headshotFileName}</strong>
                  <StatusPill
                    tone={
                      headshotState === "processing" ? "preview" : "success"
                    }
                  >
                    {headshotState === "processing" ? "Processing" : "Ready"}
                  </StatusPill>
                </div>
                <p>Square JPG, PNG, or WebP · at least 1200 px · up to 8 MB.</p>
                <label className="profile-file-button" htmlFor="headshot-file">
                  <ImageUp aria-hidden="true" size={15} /> Replace headshot
                </label>
                <input
                  accept="image/jpeg,image/png,image/webp"
                  id="headshot-file"
                  onChange={handleHeadshot}
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
              error={errors.headshotAlt}
              id="headshotAlt"
              label="Headshot alt text"
              onChange={(event) =>
                updateField("headshotAlt", event.target.value)
              }
              required
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
                error={errors.linkedinUrl}
                id="linkedinUrl"
                label="LinkedIn URL"
                onChange={(event) =>
                  updateField("linkedinUrl", event.target.value)
                }
                placeholder="https://linkedin.com/in/…"
                type="url"
                value={profile.linkedinUrl}
              />
              <TextField
                error={errors.blueskyUrl}
                id="blueskyUrl"
                label="Bluesky URL"
                onChange={(event) =>
                  updateField("blueskyUrl", event.target.value)
                }
                placeholder="https://bsky.app/profile/…"
                type="url"
                value={profile.blueskyUrl}
              />
              <TextField
                error={errors.websiteUrl}
                id="websiteUrl"
                label="Website URL"
                onChange={(event) =>
                  updateField("websiteUrl", event.target.value)
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
              label="Autosave profile"
              onChange={setAutosave}
            />
            <div>
              <Button
                aria-label="Discard unsaved profile changes"
                disabled={!dirty || saveState === "saving"}
                onClick={discardChanges}
                variant="secondary"
              >
                <RotateCcw aria-hidden="true" size={15} /> Discard
              </Button>
              <Button
                disabled={
                  !dirty ||
                  hasErrors ||
                  saveState === "saving" ||
                  headshotState === "processing"
                }
                type="submit"
              >
                <Check aria-hidden="true" size={15} /> Save now
              </Button>
            </div>
          </section>
        </form>

        <div className="speaker-profile-sidebar">
          <PublicPreview
            mode={previewMode}
            onModeChange={setPreviewMode}
            profile={profile}
          />

          <section className="profile-audit" aria-labelledby="audit-title">
            <header>
              <History aria-hidden="true" size={18} />
              <div>
                <h2 id="audit-title">Saved change record</h2>
                <p>Visible to event organizers.</p>
              </div>
            </header>
            <ol>
              {auditEntries.slice(0, 3).map((entry, index) => (
                <li key={`${entry}-${index}`}>
                  <ShieldCheck aria-hidden="true" size={15} /> {entry}
                </li>
              ))}
            </ol>
            <div className="profile-audit-scope">
              <Building2 aria-hidden="true" size={16} />
              Profile fields are organization-wide. AI Engineer Summit readiness
              remains event-only.
            </div>
          </section>
        </div>
      </div>

      <LiveRegion message={announcement} />
      <ToastRegion
        messages={toasts}
        onDismiss={(id) =>
          setToasts((current) => current.filter((toast) => toast.id !== id))
        }
      />
    </main>
  );
}
