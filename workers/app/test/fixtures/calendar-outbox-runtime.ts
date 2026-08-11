import type {
  CalendarChangeIntent,
  CalendarInvitationIntent,
} from "@sessionbox-killer/contracts";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  D1CalendarIntentOutbox,
  type CalendarInvitationOutboxContext,
} from "../../src/calendar/outbox.js";

interface FixtureEnvironment {
  DB: D1Database;
}

export default class CalendarOutboxRuntime extends WorkerEntrypoint<FixtureEnvironment> {
  enqueueChange(input: CalendarChangeIntent) {
    return new D1CalendarIntentOutbox(this.env.DB).enqueueChange(input);
  }

  enqueueInvitation(
    intent: CalendarInvitationIntent,
    context: CalendarInvitationOutboxContext,
  ) {
    return new D1CalendarIntentOutbox(this.env.DB).enqueueInvitation(
      intent,
      context,
    );
  }
}
