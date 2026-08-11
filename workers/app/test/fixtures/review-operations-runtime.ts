import { WorkerEntrypoint } from "cloudflare:workers";

import { app } from "../../src/index.js";
import { AcceptanceOrchestrationService } from "../../src/acceptance/service.js";
import { getBaseAuthority } from "../../src/authority/binding.js";
import { parseEmailDeliveryConfig } from "../../src/email/config.js";
import { AirtableReviewOperationsCommandService } from "../../src/reviews/service.js";
import type { RecordDecisionCommand } from "@sessionbox-killer/contracts";

export { BaseAuthority } from "../../src/authority/base-authority.js";

export default class ReviewOperationsRuntime extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }

  synchronize(organizationIds: readonly string[]) {
    return getBaseAuthority(this.env).synchronize(organizationIds);
  }

  async acceptWithInjectedFailure(
    command: RecordDecisionCommand,
    failAfterStep?: string,
  ) {
    const authority = getBaseAuthority(this.env);
    const result = await new AirtableReviewOperationsCommandService({
      actorId: "user_organizer",
      authority,
      database: this.env.DB,
      eventId: "event_alpha",
      organizationId: "org_alpha",
      requestId: "request_acceptance_fixture",
    }).execute(command);
    await new AcceptanceOrchestrationService({
      actor: {
        email: "organizer@example.test",
        id: "user_organizer",
        name: "Owen Organizer",
      },
      authority,
      database: this.env.DB,
      emailConfig: parseEmailDeliveryConfig(
        this.env.EMAIL_DELIVERY_CONFIG,
        this.env.APP_ENV,
      ),
      emailQueue: this.env.EMAIL_QUEUE,
      ...(failAfterStep ? { failAfterStep } : {}),
      requestId: "request_acceptance_fixture",
      requestUrl:
        "https://organizer.opensession.test/api/events/event_alpha/decisions",
    }).execute("event_alpha", "org_alpha", command);
    return result;
  }
}
