import type { BaseAuthority } from "./base-authority.js";
import type { BaseAuthorityEnvironment } from "./provider.js";

export interface AuthorityWorkerEnvironment extends BaseAuthorityEnvironment {
  BASE_AUTHORITY: DurableObjectNamespace<BaseAuthority>;
}

export function getBaseAuthority(
  env: AuthorityWorkerEnvironment,
): DurableObjectStub<BaseAuthority> {
  if (!/^app[A-Za-z0-9]{8,}$/.test(env.AIRTABLE_BASE_ID)) {
    throw new Error("AIRTABLE_BASE_ID is not configured.");
  }
  return env.BASE_AUTHORITY.getByName(`${env.APP_ENV}:${env.AIRTABLE_BASE_ID}`);
}
