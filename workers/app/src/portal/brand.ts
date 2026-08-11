import {
  speakerPortalBrandSchema,
  type SpeakerPortalBrand,
} from "@sessionbox-killer/contracts/portal";

const defaultBrand: SpeakerPortalBrand = {
  accent: "#cde878",
  background: "#f5f2ea",
  ink: "#10201d",
};

export function safeSpeakerPortalBrand(value: string): SpeakerPortalBrand {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    return defaultBrand;
  }
  const parsed = speakerPortalBrandSchema.safeParse(candidate);
  if (!parsed.success) return defaultBrand;
  return {
    accent: parsed.data.accent.toLowerCase(),
    background: parsed.data.background.toLowerCase(),
    ink: parsed.data.ink.toLowerCase(),
  };
}
