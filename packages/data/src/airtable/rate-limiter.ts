import { systemClock, type AirtableClock } from "./types.js";

export class AirtableRateLimiter {
  readonly intervalMilliseconds: number;
  private readonly clock: AirtableClock;
  private nextRequestAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    options: {
      clock?: AirtableClock;
      requestsPerSecond?: number;
    } = {},
  ) {
    const requestsPerSecond = options.requestsPerSecond ?? 5;

    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
      throw new Error("requestsPerSecond must be greater than zero.");
    }

    this.clock = options.clock ?? systemClock;
    this.intervalMilliseconds = Math.ceil(1_000 / requestsPerSecond);
  }

  async schedule<T>(operation: () => Promise<T>): Promise<T> {
    const slot = this.queue.then(async () => {
      let wait = Math.max(0, this.nextRequestAt - this.clock.now());
      while (wait > 0) {
        await this.clock.sleep(wait);
        wait = Math.max(0, this.nextRequestAt - this.clock.now());
      }

      this.nextRequestAt = this.clock.now() + this.intervalMilliseconds;
    });

    this.queue = slot.catch(() => undefined);
    await slot;
    return operation();
  }

  async pause(milliseconds: number): Promise<void> {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error("Pause duration must be a non-negative number.");
    }

    this.nextRequestAt = Math.max(
      this.nextRequestAt,
      this.clock.now() + milliseconds,
    );
    if (milliseconds > 0) {
      await this.clock.sleep(milliseconds);
    }
  }
}
