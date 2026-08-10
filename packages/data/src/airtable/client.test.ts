import { describe, expect, it } from "vitest";

import { AirtableClient } from "./client.js";
import {
  AirtableAmbiguousWriteError,
  AirtableError,
  AirtablePartialWriteError,
} from "./errors.js";
import type { AirtableClock, AirtableFetcher } from "./types.js";

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

function response(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });
}

function record(id: string) {
  return {
    createdTime: "2026-08-08T00:00:00.000Z",
    fields: { ID: id },
    id: `rec_${id}`,
  };
}

describe("AirtableClient", () => {
  it("paginates until Airtable stops returning an offset", async () => {
    const requests: URL[] = [];
    const replies = [
      response({ offset: "next/page", records: [record("one")] }),
      response({ records: [record("two")] }),
    ];
    const fetcher: AirtableFetcher = async (input) => {
      requests.push(new URL(input));
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected request");
      return reply;
    };
    const client = new AirtableClient({
      baseId: "appPreview",
      clock: new FakeClock(),
      fetcher,
      token: "pat-secret",
    });

    const records = await client.listRecords("tblEvents", {
      fields: ["ID", "Name"],
      pageSize: 100,
      sort: [{ direction: "desc", field: "Updated at" }],
    });

    expect(records.map(({ fields }) => fields.ID)).toEqual(["one", "two"]);
    expect(requests[1]?.searchParams.get("offset")).toBe("next/page");
    expect(requests[0]?.searchParams.getAll("fields[]")).toEqual([
      "ID",
      "Name",
    ]);
    expect(requests[0]?.searchParams.get("sort[0][field]")).toBe("Updated at");
  });

  it("honors Airtable's 30-second cooldown after a 429", async () => {
    const clock = new FakeClock();
    const replies = [
      response({ error: { type: "TOO_MANY_REQUESTS" } }, 429, {
        "Retry-After": "2",
      }),
      response({ records: [] }),
    ];
    const client = new AirtableClient({
      baseId: "appPreview",
      clock,
      fetcher: async () => {
        const reply = replies.shift();
        if (!reply) throw new Error("Unexpected request");
        return reply;
      },
      maximumAttempts: 2,
      random: () => 0,
      token: "pat-secret",
    });

    await expect(client.listRecords("tblEvents")).resolves.toEqual([]);
    expect(clock.sleeps).toContain(30_000);
  });

  it("retries network failures without exposing the thrown cause", async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const client = new AirtableClient({
      baseId: "appPreview",
      clock,
      fetcher: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("socket failed with pat-secret");
        }
        return response({ records: [] });
      },
      maximumAttempts: 2,
      random: () => 0,
      token: "pat-secret",
    });

    await expect(client.listRecords("tblEvents")).resolves.toEqual([]);
    expect(attempts).toBe(2);
    expect(clock.sleeps).toContain(250);
  });

  it("does not blindly retry an ambiguously failed write", async () => {
    let attempts = 0;
    const client = new AirtableClient({
      baseId: "appPreview",
      clock: new FakeClock(),
      fetcher: async () => {
        attempts += 1;
        throw new Error("connection closed after upload");
      },
      maximumAttempts: 4,
      token: "pat-secret",
    });

    const error = await client
      .upsertRecords("tblEvents", [{ fields: { ID: "evt_one" } }], ["ID"])
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(AirtableAmbiguousWriteError);
    expect(error).toMatchObject({
      code: "network_error",
      outcome: "unknown",
      retryable: false,
    });
    expect(attempts).toBe(1);
  });

  it("does not retry a write after an ambiguous server error", async () => {
    let attempts = 0;
    const client = new AirtableClient({
      baseId: "appPreview",
      clock: new FakeClock(),
      fetcher: async () => {
        attempts += 1;
        return response({ error: { type: "SERVER_ERROR" } }, 503);
      },
      maximumAttempts: 4,
      token: "pat-secret",
    });

    await expect(
      client.createField("tblEvents", {
        name: "Venue",
        type: "singleLineText",
      }),
    ).rejects.toMatchObject({
      code: "SERVER_ERROR",
      outcome: "unknown",
      retryable: false,
    });
    expect(attempts).toBe(1);
  });

  it("redacts provider messages and credentials from errors", async () => {
    const token = "pat-never-log-this";
    const client = new AirtableClient({
      baseId: "appPreview",
      clock: new FakeClock(),
      fetcher: async () =>
        response(
          {
            error: {
              message: `Rejected credential ${token}`,
              type: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND",
            },
          },
          403,
        ),
      token,
    });

    const error = await client.listRecords("tblEvents").catch((cause) => cause);

    expect(error).toBeInstanceOf(AirtableError);
    expect(String(error)).toContain("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND");
    expect(String(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(token);
  });

  it("batches upserts ten at a time and reports partial progress safely", async () => {
    const requestSizes: number[] = [];
    let requestNumber = 0;
    const client = new AirtableClient({
      baseId: "appPreview",
      clock: new FakeClock(),
      fetcher: async (_input, init) => {
        requestNumber += 1;
        const body = JSON.parse(String(init?.body)) as {
          records: { fields: { ID: string } }[];
        };
        requestSizes.push(body.records.length);

        if (requestNumber === 2) {
          return response({ error: { type: "INVALID_VALUE_FOR_COLUMN" } }, 422);
        }
        return response({
          records: body.records.map(({ fields }) => record(fields.ID)),
        });
      },
      token: "pat-secret",
    });
    const records = Array.from({ length: 12 }, (_, index) => ({
      fields: { ID: `entity_${index}` },
    }));

    const error = await client
      .upsertRecordsInBatches("tblEvents", records, ["ID"])
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(AirtablePartialWriteError);
    expect(error).toMatchObject({
      completedCount: 10,
      failedBatchIndex: 1,
      failedBatchOutcome: "rejected",
      providerCode: "INVALID_VALUE_FOR_COLUMN",
      totalCount: 12,
    });
    expect(requestSizes).toEqual([10, 2]);
    expect(String(error)).not.toContain("entity_10");
  });

  it("marks a malformed successful write response as outcome-unknown", async () => {
    const client = new AirtableClient({
      baseId: "appPreview",
      clock: new FakeClock(),
      fetcher: async () => response({ accepted: true }, 201),
      token: "pat-secret",
    });

    await expect(
      client.upsertRecords(
        "tblEvents",
        [{ fields: { ID: "evt_one" } }],
        ["ID"],
      ),
    ).rejects.toMatchObject({
      code: "invalid_success_response",
      outcome: "unknown",
      retryable: false,
      status: 201,
    });
  });

  it("applies a deadline and classifies read versus write timeouts", async () => {
    const timeoutSignal = AbortSignal.abort(
      new DOMException("Timed out", "TimeoutError"),
    );
    const seenTimeouts: number[] = [];
    const client = new AirtableClient({
      baseId: "appPreview",
      clock: new FakeClock(),
      createTimeoutSignal: (milliseconds) => {
        seenTimeouts.push(milliseconds);
        return timeoutSignal;
      },
      fetcher: async (_input, init) => {
        expect(init?.signal).toBe(timeoutSignal);
        throw timeoutSignal.reason;
      },
      maximumAttempts: 1,
      requestTimeoutMilliseconds: 2_500,
      token: "pat-secret",
    });

    await expect(client.listRecords("tblEvents")).rejects.toMatchObject({
      code: "network_error",
      retryable: true,
    });
    await expect(
      client.upsertRecords(
        "tblEvents",
        [{ fields: { ID: "evt_one" } }],
        ["ID"],
      ),
    ).rejects.toMatchObject({
      code: "network_error",
      outcome: "unknown",
      retryable: false,
    });
    expect(seenTimeouts).toEqual([2_500, 2_500]);
  });

  it("rejects invalid page and batch sizes before making a request", async () => {
    let calls = 0;
    const client = new AirtableClient({
      baseId: "appPreview",
      fetcher: async () => {
        calls += 1;
        return response({ records: [] });
      },
      token: "pat-secret",
    });

    await expect(
      client.listRecords("tblEvents", { pageSize: 101 }),
    ).rejects.toThrow("between 1 and 100");
    await expect(
      client.upsertRecords(
        "tblEvents",
        Array.from({ length: 11 }, (_, index) => ({
          fields: { ID: `entity_${index}` },
        })),
        ["ID"],
      ),
    ).rejects.toThrow("1 to 10");
    expect(calls).toBe(0);
  });

  it("deletes bounded record batches with Airtable's repeated query format", async () => {
    let seen: { method?: string; records: string[] } | undefined;
    const client = new AirtableClient({
      baseId: "appPreview",
      clock: new FakeClock(),
      fetcher: async (input, init) => {
        const url = new URL(input);
        seen = {
          ...(init?.method ? { method: init.method } : {}),
          records: url.searchParams.getAll("records[]"),
        };
        return response({
          records: [
            { deleted: true, id: "rec_one" },
            { deleted: true, id: "rec_two" },
          ],
        });
      },
      token: "pat-secret",
    });

    await expect(
      client.deleteRecords("tblEvents", ["rec_one", "rec_two"]),
    ).resolves.toEqual(["rec_one", "rec_two"]);
    expect(seen).toEqual({
      method: "DELETE",
      records: ["rec_one", "rec_two"],
    });
  });

  it("parses webhook cursors without retaining record payloads", async () => {
    const requests: URL[] = [];
    const client = new AirtableClient({
      baseId: "appPreview",
      clock: new FakeClock(),
      fetcher: async (input) => {
        requests.push(new URL(input));
        return response({
          cursor: 12,
          mightHaveMore: false,
          payloads: [
            {
              baseTransactionNumber: 42,
              changedTablesById: {
                tblRooms: { changedRecordsById: { rec_private: {} } },
              },
            },
          ],
        });
      },
      token: "pat-secret",
    });

    await expect(client.getWebhookPayloads("ach_webhook", 11)).resolves.toEqual(
      {
        cursor: 12,
        mightHaveMore: false,
        payloads: [
          { baseTransactionNumber: 42, changedTableIds: ["tblRooms"] },
        ],
      },
    );
    expect(requests[0]?.searchParams.get("cursor")).toBe("11");
    expect(requests[0]?.pathname).toContain("/webhooks/ach_webhook/payloads");
  });
});
