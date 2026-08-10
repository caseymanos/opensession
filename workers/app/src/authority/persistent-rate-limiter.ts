import { AirtableRateLimiter } from "@sessionbox-killer/data/airtable/internal";

interface GateRow extends Record<string, SqlStorageValue> {
  next_request_at_ms: number;
  paused_until_ms: number;
}

export class PersistentAirtableRateLimiter extends AirtableRateLimiter {
  private readonly now: () => number;
  private slotQueue: Promise<void> = Promise.resolve();
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly storage: DurableObjectStorage;

  constructor(
    storage: DurableObjectStorage,
    options: {
      now?: () => number;
      requestsPerSecond?: number;
      sleep?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {
    super({ requestsPerSecond: options.requestsPerSecond ?? 5 });
    this.storage = storage;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  override async schedule<T>(operation: () => Promise<T>): Promise<T> {
    const slot = this.slotQueue.then(() => this.waitForStartSlot());
    this.slotQueue = slot.catch(() => undefined);
    await slot;
    return operation();
  }

  override async pause(milliseconds: number): Promise<void> {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error("Pause duration must be a non-negative number.");
    }
    const pausedUntil = this.now() + milliseconds;
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "UPDATE gate_state SET paused_until_ms = MAX(paused_until_ms, ?) WHERE singleton = 1",
        pausedUntil,
      );
    });
    if (milliseconds > 0) {
      await this.sleep(milliseconds);
    }
  }

  private async waitForStartSlot(): Promise<void> {
    for (;;) {
      const wait = this.storage.transactionSync(() => {
        const now = this.now();
        const gate = this.storage.sql
          .exec<GateRow>(
            "SELECT next_request_at_ms, paused_until_ms FROM gate_state WHERE singleton = 1",
          )
          .one();
        const availableAt = Math.max(
          now,
          gate.next_request_at_ms,
          gate.paused_until_ms,
        );
        if (availableAt > now) {
          return availableAt - now;
        }
        this.storage.sql.exec(
          "UPDATE gate_state SET next_request_at_ms = ? WHERE singleton = 1",
          now + this.intervalMilliseconds,
        );
        return 0;
      });
      if (wait === 0) {
        return;
      }
      await this.sleep(wait);
    }
  }
}
