export type AppEnvironment = "local" | "preview" | "production";

export function isAppEnvironment(value: unknown): value is AppEnvironment {
  return value === "local" || value === "preview" || value === "production";
}

export function shouldShowEnvironmentBanner({
  environment,
  isDemoEvent,
}: {
  environment: AppEnvironment;
  isDemoEvent: boolean;
}) {
  return environment !== "production" || isDemoEvent;
}

export function shouldShowDemoReset({
  isDemoEvent,
  onReset,
}: {
  isDemoEvent: boolean;
  onReset: (() => void) | undefined;
}) {
  return isDemoEvent && Boolean(onReset);
}
