import type { EntityId, EventSummary } from "@sessionbox-killer/domain";

export interface EventRepository {
  findById(id: EntityId<"event">): Promise<EventSummary | null>;
  findBySlug(slug: string): Promise<EventSummary | null>;
}

export interface UnitOfWork {
  run<T>(operation: () => Promise<T>): Promise<T>;
}
