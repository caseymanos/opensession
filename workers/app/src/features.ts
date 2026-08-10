export const featureFlagNames = [
  "ai",
  "embeds",
  "email",
  "integrations",
  "webhooks",
  "writes",
] as const;

export type FeatureFlagName = (typeof featureFlagNames)[number];

export interface FeatureFlags {
  readonly ai: boolean;
  readonly embeds: boolean;
  readonly email: boolean;
  readonly integrations: boolean;
  readonly webhooks: boolean;
  readonly writes: boolean;
}

export interface FeatureFlagInspection {
  readonly flags: FeatureFlags;
  readonly valid: boolean;
}

const allDisabled: FeatureFlags = Object.freeze({
  ai: false,
  embeds: false,
  email: false,
  integrations: false,
  webhooks: false,
  writes: false,
});

export function inspectFeatureFlags(value: unknown): FeatureFlagInspection {
  if (
    !isRecord(value) ||
    !featureFlagNames.every((name) => typeof value[name] === "boolean")
  ) {
    return { flags: allDisabled, valid: false };
  }

  return {
    flags: {
      ai: value.ai === true,
      embeds: value.embeds === true,
      email: value.email === true,
      integrations: value.integrations === true,
      webhooks: value.webhooks === true,
      writes: value.writes === true,
    },
    valid: true,
  };
}

export function isFeatureEnabled(
  value: unknown,
  name: FeatureFlagName,
): boolean {
  return inspectFeatureFlags(value).flags[name];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
