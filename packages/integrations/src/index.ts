export interface ExportPlan<TRecord> {
  creates: readonly TRecord[];
  updates: readonly TRecord[];
  unchanged: number;
}

export interface EventPlatformExporter<TRecord> {
  plan(eventId: string): Promise<ExportPlan<TRecord>>;
  apply(plan: ExportPlan<TRecord>, idempotencyKey: string): Promise<void>;
}
