import type { AgendaCoordinator } from "./coordinator.js";

export function getAgendaCoordinator(
  env: Pick<Env, "AGENDA_COORDINATOR">,
  eventId: string,
): DurableObjectStub<AgendaCoordinator> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(eventId)) {
    throw new Error("Agenda coordinator event ID is invalid.");
  }
  return env.AGENDA_COORDINATOR.getByName(eventId);
}
