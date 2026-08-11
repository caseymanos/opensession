import type { SpeakerProfileView } from "./portalModel";

export type ProfileField = Exclude<
  keyof SpeakerProfileView,
  "headshotFileName" | "headshotUrl"
>;
export type ProfileErrors = Partial<Record<ProfileField, string>>;

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

export function validateProfile(
  profile: SpeakerProfileView,
  hasHeadshot: boolean,
): ProfileErrors {
  const errors: ProfileErrors = {};
  const required: [ProfileField, string][] = [
    ["displayName", "Add the name attendees should see."],
    ["title", "Add a public role or title."],
    ["company", "Add a company or organization."],
    ["bio", "Add a short public biography."],
  ];
  for (const [field, message] of required) {
    if (!profile[field].trim()) errors[field] = message;
  }
  if (profile.displayName.length > 160) {
    errors.displayName = "Keep the display name to 160 characters or fewer.";
  }
  if (profile.pronouns.length > 80) {
    errors.pronouns = "Keep pronouns to 80 characters or fewer.";
  }
  if (profile.title.length > 160) {
    errors.title = "Keep the title to 160 characters or fewer.";
  }
  if (profile.company.length > 160) {
    errors.company = "Keep the organization to 160 characters or fewer.";
  }
  if (profile.bio.length > 400) {
    errors.bio = "Keep the biography to 400 characters or fewer.";
  }
  if (profile.headshotAlt.length > 200) {
    errors.headshotAlt =
      "Keep the headshot description to 200 characters or fewer.";
  } else if (hasHeadshot && !profile.headshotAlt.trim()) {
    errors.headshotAlt = "Describe the headshot for people who cannot see it.";
  }
  if (!isHttpUrl(profile.linkedinUrl)) {
    errors.linkedinUrl = "Enter a complete http:// or https:// URL.";
  } else if (profile.linkedinUrl) {
    const hostname = new URL(profile.linkedinUrl).hostname.toLowerCase();
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
