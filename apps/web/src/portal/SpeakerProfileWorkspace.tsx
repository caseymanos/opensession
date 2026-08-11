import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import {
  LiveRegion,
  ToastRegion,
  type ToastMessage,
} from "@sessionbox-killer/ui";

import {
  SpeakerProfileEditor,
  type ProfileAuditItem,
  type ProfileHeadshotState,
  type ProfileSaveState,
} from "./SpeakerProfileEditor";
import { speakerProfileFixture, type SpeakerProfileView } from "./portalModel";
import { validateProfile, type ProfileField } from "./speakerProfileModel";

const acceptedHeadshotTypes = ["image/jpeg", "image/png", "image/webp"];
const maxHeadshotBytes = 8 * 1024 * 1024;

export function SpeakerProfileWorkspace() {
  const [profile, setProfile] = useState<SpeakerProfileView>(
    speakerProfileFixture,
  );
  const [savedProfile, setSavedProfile] = useState<SpeakerProfileView>(
    speakerProfileFixture,
  );
  const [autosave, setAutosave] = useState(true);
  const [saveState, setSaveState] = useState<ProfileSaveState>("saved");
  const [lastSaved, setLastSaved] = useState("Saved Aug 9 at 3:42 PM");
  const [headshotState, setHeadshotState] =
    useState<ProfileHeadshotState>("ready");
  const [headshotError, setHeadshotError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [auditEntries, setAuditEntries] = useState<ProfileAuditItem[]>([
    {
      id: "fixture-profile-saved",
      label: "Profile saved · Mina Okafor · Aug 9 at 3:42 PM",
    },
  ]);
  const autosaveTimer = useRef<number | undefined>(undefined);
  const commitTimer = useRef<number | undefined>(undefined);
  const objectUrl = useRef("");

  const errors = useMemo(
    () => validateProfile(profile, Boolean(profile.headshotUrl)),
    [profile],
  );
  const hasErrors = Object.keys(errors).length > 0 || Boolean(headshotError);
  const dirty = JSON.stringify(profile) !== JSON.stringify(savedProfile);

  useEffect(() => {
    window.clearTimeout(autosaveTimer.current);
    window.clearTimeout(commitTimer.current);
    if (!dirty || !autosave || hasErrors || headshotState === "processing")
      return;
    const snapshot = profile;
    autosaveTimer.current = window.setTimeout(() => {
      setSaveState("saving");
      commitTimer.current = window.setTimeout(() => {
        setSavedProfile(snapshot);
        setSaveState("saved");
        setLastSaved("Saved just now");
        setAuditEntries((current) => [
          {
            id: `fixture-autosave-${Date.now()}`,
            label: "Profile autosaved · Mina Okafor · Just now",
          },
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

  function updateField(field: ProfileField, value: string) {
    setSaveState("unsaved");
    setProfile((current) => ({ ...current, [field]: value }));
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
        {
          id: `fixture-${source}-${Date.now()}`,
          label: `Profile ${source === "manual" ? "saved" : "autosaved"} · Mina Okafor · Just now`,
        },
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

  function removeHeadshot() {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = "";
    }
    setProfile((current) => ({
      ...current,
      headshotFileName: "",
      headshotUrl: "",
    }));
    setSaveState("unsaved");
  }

  function discardChanges() {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = "";
    }
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
    <>
      <SpeakerProfileEditor
        auditEntries={auditEntries}
        autosave={autosave}
        dirty={dirty}
        errors={errors}
        eventName="AI Engineer Summit"
        headshotError={headshotError}
        headshotRequirements="JPG, PNG, or WebP · at least 1200 × 1200 px · up to 8 MB."
        headshotState={headshotState}
        lastSaved={lastSaved}
        locked={saveState === "saving"}
        onAutosaveChange={setAutosave}
        onDiscard={discardChanges}
        onFieldChange={updateField}
        onHeadshot={handleHeadshot}
        onRemoveHeadshot={removeHeadshot}
        onSubmit={handleSubmit}
        profile={profile}
        publicationState="draft"
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
