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
  StatePanel,
  ToastRegion,
  type ToastMessage,
} from "@sessionbox-killer/ui";
import type {
  SpeakerProfileResponse,
  SpeakerProfileSaveCommand,
} from "@sessionbox-killer/contracts";

import {
  finalizePrivateUpload,
  preparePrivateUpload,
  PrivateUploadApiError,
  PrivateUploadFinalizeError,
} from "../uploads/privateUploadClient";
import type { SpeakerProfileView } from "./portalModel";
import {
  SpeakerProfileEditor,
  type ProfileAuditItem,
  type ProfileHeadshotState,
  type ProfileNotice,
  type ProfileSaveState,
} from "./SpeakerProfileEditor";
import { validateProfile, type ProfileField } from "./speakerProfileModel";
import {
  readSpeakerProfile,
  saveSpeakerProfile,
  SpeakerProfileApiError,
} from "./speakerProfileClient";

interface FrozenSaveIntent {
  readonly command: SpeakerProfileSaveCommand;
}

type Runtime =
  | { profile: null; state: "error" | "loading" }
  | { profile: SpeakerProfileResponse; state: "ready" };

function profileView(response: SpeakerProfileResponse): SpeakerProfileView {
  const headshot = response.headshot;
  return {
    bio: response.fields.bio,
    blueskyUrl: response.fields.bluesky_url,
    company: response.fields.company,
    displayName: response.fields.display_name,
    headshotAlt: response.fields.headshot_alt,
    headshotFileName: headshot?.file_name ?? "",
    headshotUrl: headshot
      ? `${headshot.preview_url}${headshot.preview_url.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(headshot.version))}`
      : "",
    linkedinUrl: response.fields.linkedin_url,
    pronouns: response.fields.pronouns,
    title: response.fields.title,
    websiteUrl: response.fields.website_url,
  };
}

function commandFields(profile: SpeakerProfileView) {
  return {
    bio: profile.bio,
    bluesky_url: profile.blueskyUrl,
    company: profile.company,
    display_name: profile.displayName,
    headshot_alt: profile.headshotAlt,
    linkedin_url: profile.linkedinUrl,
    pronouns: profile.pronouns,
    title: profile.title,
    website_url: profile.websiteUrl,
  };
}

function auditItems(response: SpeakerProfileResponse): ProfileAuditItem[] {
  const formatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return response.audit.map((entry, index) => ({
    id: `${entry.at}-${entry.action}-${index}`,
    label: `${entry.summary} · ${entry.actor === "speaker" ? "You" : entry.actor === "organizer" ? "Organizer" : "System"} · ${formatter.format(new Date(entry.at))}`,
  }));
}

function savedLabel(value: string | null): string {
  if (!value) return "Not saved yet";
  return `Saved ${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))}`;
}

function headshotRequirements(response: SpeakerProfileResponse): string {
  const maxMegabytes = response.policy.max_bytes / 1024 / 1024;
  const maxLabel = Number.isInteger(maxMegabytes)
    ? String(maxMegabytes)
    : maxMegabytes.toFixed(1);
  return `JPG, PNG, or WebP · at least ${response.policy.min_width} × ${response.policy.min_height} px · up to ${maxLabel} MB.`;
}

function commandId(): string {
  return crypto.randomUUID();
}

function unknownOutcome(error: unknown): boolean {
  if (!(error instanceof SpeakerProfileApiError)) return true;
  if (error.code === "profile_outcome_unknown") return true;
  if (error.code === "invalid_profile_response") return true;
  if (error.status >= 500 || error.status === 0) {
    return error.code !== "missing_csrf";
  }
  return false;
}

export function ProductionSpeakerProfileWorkspace({
  eventName,
  eventSlug,
}: {
  eventName: string;
  eventSlug: string;
}) {
  const [runtime, setRuntime] = useState<Runtime>({
    profile: null,
    state: "loading",
  });
  const [profile, setProfile] = useState<SpeakerProfileView | null>(null);
  const [savedProfile, setSavedProfile] = useState<SpeakerProfileView | null>(
    null,
  );
  const [autosave, setAutosave] = useState(true);
  const [autosavePaused, setAutosavePaused] = useState(false);
  const [saveState, setSaveState] = useState<ProfileSaveState>("saved");
  const [lastSaved, setLastSaved] = useState("Loading saved profile");
  const [headshotState, setHeadshotState] =
    useState<ProfileHeadshotState>("ready");
  const [headshotError, setHeadshotError] = useState("");
  const [headshotProgress, setHeadshotProgress] = useState<
    number | undefined
  >();
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingFinalizeFileId, setPendingFinalizeFileId] = useState<
    string | null
  >(null);
  const [finalizedFileId, setFinalizedFileId] = useState<string | null>(null);
  const [removeHeadshot, setRemoveHeadshot] = useState(false);
  const [saveIntent, setSaveIntent] = useState<FrozenSaveIntent | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [notice, setNotice] = useState<ProfileNotice | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const localObjectUrl = useRef("");
  const autosaveTimer = useRef<number | undefined>(undefined);
  const saveRef = useRef<(source: "autosave" | "manual") => Promise<void>>(
    async () => undefined,
  );

  const hasHeadshot = Boolean(profile?.headshotUrl) && !removeHeadshot;
  const errors = useMemo(
    () => (profile ? validateProfile(profile, hasHeadshot) : {}),
    [hasHeadshot, profile],
  );
  const dirty = Boolean(
    profile &&
    savedProfile &&
    (JSON.stringify(profile) !== JSON.stringify(savedProfile) ||
      pendingFile ||
      removeHeadshot),
  );
  const locked = saveBusy || saveIntent !== null || saveState === "conflict";

  function announce(title: string, message: string, tone?: "error") {
    setAnnouncement(message);
    setToasts((current) => [
      ...current,
      {
        id: `${Date.now()}-${title}`,
        message,
        title,
        ...(tone ? { tone } : {}),
      },
    ]);
  }

  function clearLocalObjectUrl() {
    if (localObjectUrl.current) {
      URL.revokeObjectURL(localObjectUrl.current);
      localObjectUrl.current = "";
    }
  }

  function applyServerProfile(response: SpeakerProfileResponse) {
    clearLocalObjectUrl();
    const next = profileView(response);
    setRuntime({ profile: response, state: "ready" });
    setProfile(next);
    setSavedProfile(next);
    setPendingFile(null);
    setPendingFinalizeFileId(null);
    setFinalizedFileId(null);
    setRemoveHeadshot(false);
    setHeadshotError("");
    setHeadshotProgress(undefined);
    setHeadshotState("ready");
    setLastSaved(savedLabel(response.updated_at));
    setAutosavePaused(false);
  }

  async function loadProfile() {
    setRuntime({ profile: null, state: "loading" });
    setNotice(null);
    try {
      const response = await readSpeakerProfile(eventSlug);
      applyServerProfile(response);
      setSaveState("saved");
    } catch (error) {
      setRuntime({ profile: null, state: "error" });
      setAnnouncement(
        error instanceof Error
          ? error.message
          : "The speaker profile could not be loaded.",
      );
    }
  }

  useEffect(() => {
    let active = true;
    void readSpeakerProfile(eventSlug)
      .then((response) => {
        if (!active) return;
        const next = profileView(response);
        setRuntime({ profile: response, state: "ready" });
        setProfile(next);
        setSavedProfile(next);
        setLastSaved(savedLabel(response.updated_at));
        setSaveState("saved");
        setAutosavePaused(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRuntime({ profile: null, state: "error" });
        setAnnouncement(
          error instanceof Error
            ? error.message
            : "The speaker profile could not be loaded.",
        );
      });
    return () => {
      active = false;
      if (localObjectUrl.current) {
        URL.revokeObjectURL(localObjectUrl.current);
        localObjectUrl.current = "";
      }
    };
  }, [eventSlug]);

  useEffect(() => {
    window.clearTimeout(autosaveTimer.current);
    if (
      !autosave ||
      autosavePaused ||
      !dirty ||
      locked ||
      headshotState !== "ready" ||
      Object.keys(errors).length > 0 ||
      headshotError
    ) {
      return;
    }
    autosaveTimer.current = window.setTimeout(() => {
      void saveRef.current("autosave");
    }, 900);
    return () => window.clearTimeout(autosaveTimer.current);
  }, [
    autosave,
    autosavePaused,
    dirty,
    errors,
    headshotError,
    headshotState,
    locked,
    profile,
  ]);

  function updateField(field: ProfileField, value: string) {
    setProfile((current) =>
      current ? { ...current, [field]: value } : current,
    );
    setSaveState("unsaved");
    setAutosavePaused(false);
    setNotice(null);
  }

  function handleHeadshot(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    const server = runtime.profile;
    if (!file || !server) return;
    if (
      !server.policy.accepted_content_types.some(
        (contentType) => contentType === file.type,
      )
    ) {
      setHeadshotError("Choose a JPG, PNG, or WebP image.");
      announce(
        "Headshot not accepted",
        "Choose a JPG, PNG, or WebP image.",
        "error",
      );
      return;
    }
    if (file.size > server.policy.max_bytes) {
      setHeadshotError(
        `Choose an image smaller than ${Math.round(server.policy.max_bytes / 1024 / 1024)} MB.`,
      );
      announce(
        "Headshot is too large",
        "Choose a smaller image and try again.",
        "error",
      );
      return;
    }
    setHeadshotError("");
    setHeadshotState("processing");
    const candidateUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (
        image.naturalWidth < server.policy.min_width ||
        image.naturalHeight < server.policy.min_height
      ) {
        URL.revokeObjectURL(candidateUrl);
        setHeadshotState("ready");
        setHeadshotError(
          `Choose an image at least ${server.policy.min_width} × ${server.policy.min_height} pixels.`,
        );
        announce(
          "Headshot is too small",
          "Choose a larger image and try again.",
          "error",
        );
        return;
      }
      clearLocalObjectUrl();
      localObjectUrl.current = candidateUrl;
      setPendingFile(file);
      setPendingFinalizeFileId(null);
      setFinalizedFileId(null);
      setRemoveHeadshot(false);
      setProfile((current) =>
        current
          ? {
              ...current,
              headshotFileName: file.name,
              headshotUrl: candidateUrl,
            }
          : current,
      );
      setHeadshotState("ready");
      setSaveState("unsaved");
      setAutosavePaused(false);
      setAnnouncement("Headshot checked and ready for private upload.");
    };
    image.onerror = () => {
      URL.revokeObjectURL(candidateUrl);
      setHeadshotState("ready");
      setHeadshotError("Choose an image file that can be processed.");
      announce(
        "Headshot could not be processed",
        "Choose a valid JPG, PNG, or WebP image.",
        "error",
      );
    };
    image.src = candidateUrl;
  }

  function removeCurrentHeadshot() {
    clearLocalObjectUrl();
    setPendingFile(null);
    setPendingFinalizeFileId(null);
    setFinalizedFileId(null);
    setRemoveHeadshot(true);
    setProfile((current) =>
      current ? { ...current, headshotFileName: "", headshotUrl: "" } : current,
    );
    setSaveState("unsaved");
    setAutosavePaused(false);
    setNotice(null);
  }

  function discardChanges() {
    const server = runtime.profile;
    if (!server) return;
    applyServerProfile(server);
    setSaveIntent(null);
    setNotice(null);
    setSaveState("saved");
    announce(
      "Draft restored",
      "Unsaved profile changes were replaced with the last saved version.",
    );
  }

  async function refreshLatestPreservingDraft() {
    const draft = profile;
    setSaveBusy(true);
    try {
      const response = await readSpeakerProfile(eventSlug);
      setRuntime({ profile: response, state: "ready" });
      setSavedProfile(profileView(response));
      if (draft) setProfile(draft);
      setLastSaved(savedLabel(response.updated_at));
      setSaveState("unsaved");
      setNotice({
        message:
          "The latest saved version is loaded underneath your preserved draft. Review every field, then save again.",
        title: "Latest version loaded",
        tone: "info",
      });
    } catch (error) {
      announce(
        "Profile refresh failed",
        error instanceof Error ? error.message : "Refresh and try again.",
        "error",
      );
    } finally {
      setSaveBusy(false);
    }
  }

  async function executeIntent(intent: FrozenSaveIntent) {
    setSaveBusy(true);
    setSaveIntent(intent);
    setSaveState("saving");
    setNotice(null);
    try {
      const result = await saveSpeakerProfile(eventSlug, intent.command);
      applyServerProfile(result.profile);
      if (result.projection === "repair_pending") {
        setSaveIntent(intent);
        setSaveState("syncing");
        setNotice({
          action: (
            <Button onClick={() => void executeIntent(intent)}>
              Check synchronization
            </Button>
          ),
          message:
            "Your profile is committed, but the read model is still catching up. Keep this page open and check again before making another change.",
          title: "Saved, finishing synchronization",
          tone: "warning",
        });
      } else {
        setSaveIntent(null);
        setSaveState("saved");
        announce(
          result.outcome === "replayed" ? "Save recovered" : "Profile saved",
          result.outcome === "replayed"
            ? "The original save was recovered without creating a second update."
            : "Your reusable profile is saved. Publication remains controlled by organizers.",
        );
      }
    } catch (error) {
      if (unknownOutcome(error)) {
        setSaveIntent(intent);
        setSaveState("recovery");
        setNotice({
          action: (
            <Button onClick={() => void executeIntent(intent)}>
              Retry exact save
            </Button>
          ),
          message:
            "The service may have applied this save. Retrying sends the identical command so it can be safely replayed without a second update.",
          title: "We could not confirm the save",
          tone: "warning",
        });
      } else {
        setSaveIntent(null);
        setAutosavePaused(true);
        const apiError = error instanceof SpeakerProfileApiError ? error : null;
        if (apiError?.code === "profile_version_conflict") {
          setSaveState("conflict");
          setNotice({
            action: (
              <Button onClick={() => void refreshLatestPreservingDraft()}>
                Load latest version
              </Button>
            ),
            message:
              "Another saved update won the version check. Your draft is still here; load the latest version before choosing what to save.",
            title: "This profile changed elsewhere",
            tone: "warning",
          });
        } else {
          setSaveState("unsaved");
          setNotice({
            message:
              error instanceof Error
                ? error.message
                : "Review the profile and try again.",
            title: "Profile was not saved",
            tone: "error",
          });
        }
      }
    } finally {
      setSaveBusy(false);
      setHeadshotProgress(undefined);
      setHeadshotState("ready");
    }
  }

  async function save(source: "autosave" | "manual") {
    const server = runtime.profile;
    const snapshot = profile;
    if (!server || !snapshot || saveBusy || saveIntent) return;
    if (Object.keys(errors).length || headshotError) {
      const firstError = Object.keys(errors)[0];
      if (firstError) document.getElementById(firstError)?.focus();
      announce(
        "Fix profile details",
        "Resolve the highlighted fields before saving this profile.",
        "error",
      );
      return;
    }
    window.clearTimeout(autosaveTimer.current);
    if (source === "manual") setAutosavePaused(false);
    setSaveBusy(true);
    setSaveState("saving");
    setNotice(null);
    let headshotFileId: string | null | undefined = removeHeadshot
      ? null
      : undefined;
    try {
      if (pendingFile) {
        setHeadshotState("uploading");
        setHeadshotProgress(0);
        if (finalizedFileId) {
          headshotFileId = finalizedFileId;
        } else {
          const prepared = pendingFinalizeFileId
            ? await finalizePrivateUpload(pendingFinalizeFileId)
            : await preparePrivateUpload(
                {
                  eventId: server.upload_context.event_id,
                  file: pendingFile,
                  organizationId: server.upload_context.organization_id,
                  ownerContactId: server.upload_context.owner_contact_id,
                  purpose: "headshot",
                  ...(server.upload_context.replacement_file_id
                    ? {
                        replacesFileId:
                          server.upload_context.replacement_file_id,
                      }
                    : {}),
                },
                setHeadshotProgress,
              );
          headshotFileId = prepared.fileId;
          setPendingFinalizeFileId(null);
          setFinalizedFileId(prepared.fileId);
        }
      }
      const intent: FrozenSaveIntent = {
        command: {
          command_id: commandId(),
          expected_version: server.version,
          fields: commandFields(snapshot),
          ...(headshotFileId === undefined
            ? {}
            : { headshot_file_id: headshotFileId }),
          reuse_organization: true,
        },
      };
      await executeIntent(intent);
    } catch (error) {
      if (error instanceof PrivateUploadFinalizeError) {
        setPendingFinalizeFileId(error.fileId);
        setAutosavePaused(true);
        setNotice({
          action: (
            <Button onClick={() => void saveRef.current("manual")}>
              Retry processing
            </Button>
          ),
          message:
            "The private upload arrived, but image processing did not finish. Retry processing without uploading the file again.",
          title: "Headshot processing paused",
          tone: "warning",
        });
      } else {
        setAutosavePaused(true);
        const message =
          error instanceof PrivateUploadApiError || error instanceof Error
            ? error.message
            : "The headshot could not be uploaded.";
        setNotice({
          message,
          title: "Headshot was not uploaded",
          tone: "error",
        });
      }
      setSaveState("unsaved");
      setSaveBusy(false);
      setHeadshotProgress(undefined);
      setHeadshotState("ready");
    }
  }
  saveRef.current = save;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save("manual");
  }

  if (runtime.state === "error") {
    return (
      <main className="portal-main speaker-profile-main">
        <StatePanel
          action={<Button onClick={() => void loadProfile()}>Try again</Button>}
          description={
            announcement ||
            "The profile service could not be reached. Your public profile was not changed."
          }
          state="error"
          title="We couldn’t load your profile"
        />
      </main>
    );
  }

  if (runtime.state === "loading" || !profile || !savedProfile) {
    return (
      <main className="portal-main speaker-profile-main">
        <StatePanel
          description="Loading your organization-level profile and private headshot policy."
          state="loading"
          title="Preparing your reusable profile"
        />
      </main>
    );
  }

  if (!runtime.profile) return null;
  const serverProfile = runtime.profile;

  return (
    <>
      <SpeakerProfileEditor
        auditEntries={auditItems(serverProfile)}
        autosave={autosave}
        dirty={dirty}
        errors={errors}
        eventName={eventName}
        headshotError={headshotError}
        headshotProgress={headshotProgress}
        headshotRequirements={headshotRequirements(serverProfile)}
        headshotState={headshotState}
        lastSaved={lastSaved}
        locked={locked}
        notice={notice}
        onAutosaveChange={setAutosave}
        onDiscard={discardChanges}
        onFieldChange={updateField}
        onHeadshot={handleHeadshot}
        onRemoveHeadshot={removeCurrentHeadshot}
        onSubmit={handleSubmit}
        profile={profile}
        publicationState={serverProfile.publication_state}
        saveState={saveState}
      />
      <LiveRegion message={announcement} />
      <ToastRegion
        messages={toasts}
        onDismiss={(id) =>
          setToasts((current) => current.filter((toast) => toast.id !== id))
        }
      />
    </>
  );
}
