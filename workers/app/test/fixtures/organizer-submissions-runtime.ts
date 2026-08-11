import { WorkerEntrypoint } from "cloudflare:workers";

import { app } from "../../src/index.js";
import { getBaseAuthority } from "../../src/authority/binding.js";

export { BaseAuthority } from "../../src/authority/base-authority.js";

export default class OrganizerSubmissionsRuntime extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  recoverPending(): Promise<number> {
    return getBaseAuthority(this.env).recoverPending();
  }

  synchronize(organizationIds: readonly string[]) {
    return getBaseAuthority(this.env).synchronize(organizationIds);
  }
}
