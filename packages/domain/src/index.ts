export const environments = ["local", "preview", "production"] as const;

export type Environment = (typeof environments)[number];

export type EntityId<T extends string> = string & { readonly __entity: T };

export interface EventSummary {
  id: EntityId<"event">;
  name: string;
  slug: string;
  timezone: string;
}

export function isEnvironment(value: string): value is Environment {
  return environments.some((environment) => environment === value);
}

export * from "./cfp-rules";
export * from "./schedule";
