import { describe, expect, it } from "vitest";

import { AirtableRateLimiter } from "./rate-limiter.js";
import type { AirtableClock } from "./types.js";

class FakeClock implements AirtableClock {
  current = 0;
  sleeps: number[] = [];

  now() {
    return this.current;
  }

  async sleep(milliseconds: number) {
    this.sleeps.push(milliseconds);
    this.current += milliseconds;
  }
}

describe("AirtableRateLimiter", () => {
  it("spaces concurrent request starts to five per second", async () => {
    const clock = new FakeClock();
    const limiter = new AirtableRateLimiter({ clock });
    const starts: number[] = [];

    await Promise.all(
      [1, 2, 3].map((value) =>
        limiter.schedule(async () => {
          starts.push(clock.now());
          return value;
        }),
      ),
    );

    expect(starts).toEqual([0, 200, 400]);
    expect(clock.sleeps).toEqual([200, 200]);
  });

  it("does not advance the queue when the configured rate is invalid", () => {
    expect(() => new AirtableRateLimiter({ requestsPerSecond: 0 })).toThrow(
      "greater than zero",
    );
  });

  it("extends queued waits when Airtable imposes a global cooldown", async () => {
    const clock = new FakeClock();
    const limiter = new AirtableRateLimiter({ clock });
    const starts: number[] = [];

    await limiter.schedule(async () => starts.push(clock.now()));
    await limiter.pause(30_000);
    await limiter.schedule(async () => starts.push(clock.now()));

    expect(starts).toEqual([0, 30_000]);
  });
});
