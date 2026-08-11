import { describe, expect, it } from "vitest";

import duplicateSpeaker from "./__fixtures__/accelevents/error-duplicate-speaker.json";
import rateLimit from "./__fixtures__/accelevents/error-rate-limit.json";
import validationError from "./__fixtures__/accelevents/error-validation.json";
import sessionsPageZero from "./__fixtures__/accelevents/sessions-page-0.json";
import sessionsPageOne from "./__fixtures__/accelevents/sessions-page-1.json";
import speakersPageZero from "./__fixtures__/accelevents/speakers-page-0.json";
import {
  AcceleventsClient,
  AcceleventsProviderError,
  type AcceleventsFetcher,
  type AcceleventsMutation,
  type AcceleventsSessionWrite,
} from "./accelevents.js";

function jsonResponse(
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", ...headers },
    status,
  });
}

function sessionWrite(
  overrides: Partial<AcceleventsSessionWrite> = {},
): AcceleventsSessionWrite {
  return {
    description: "A deterministic fixture session.",
    endTime: "2026/09/14 10:00",
    format: "BREAKOUT_SESSION",
    location: "Room A",
    sessionTypeFormat: "IN_PERSON",
    startTime: "2026/09/14 09:00",
    status: "DRAFT",
    title: "Provider contracts without live traffic",
    ...overrides,
  };
}

function client(
  fetcher: AcceleventsFetcher,
  overrides: Partial<ConstructorParameters<typeof AcceleventsClient>[0]> = {},
): AcceleventsClient {
  return new AcceleventsClient({
    apiKey: "fixture-api-key",
    eventId: 42,
    eventUrl: "redacted-event",
    fetcher,
    sleep: async () => undefined,
    ...overrides,
  });
}

describe("AcceleventsClient", () => {
  it("paginates documented list contracts and sends only the configured auth header", async () => {
    const requests: { headers: Headers; url: URL }[] = [];
    const fetcher: AcceleventsFetcher = async (input, init) => {
      requests.push({
        headers: new Headers(init?.headers),
        url: new URL(input),
      });
      const page = new URL(input).searchParams.get("page");
      return jsonResponse(page === "0" ? sessionsPageZero : sessionsPageOne);
    };

    const sessions = await client(fetcher, { pageSize: 2 }).listSessions();

    expect(sessions.map(({ sessionId }) => sessionId)).toEqual([
      3101, 3102, 3103,
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url.searchParams.get("size")).toBe("2");
    expect(requests[0]?.url.searchParams.get("expand")).toBe(
      "TAG,TRACK,SPEAKER",
    );
    expect(requests[0]?.headers.get("Key")).toBe("fixture-api-key");
    expect(requests[0]?.headers.has("Authorization")).toBe(false);
  });

  it("supports the documented Authorization-header variant explicitly", async () => {
    let headers = new Headers();
    await client(
      async (_input, init) => {
        headers = new Headers(init?.headers);
        return jsonResponse({ data: [], recordsFiltered: 0, recordsTotal: 0 });
      },
      { authenticationHeader: "Authorization" },
    ).listSpeakers();

    expect(headers.get("Authorization")).toBe("fixture-api-key");
    expect(headers.has("Key")).toBe(false);
  });

  it("enforces pagination and response-size limits", async () => {
    const fullPage = {
      data: sessionsPageZero.data,
      recordsFiltered: 3,
      recordsTotal: 3,
    };
    await expect(
      client(async () => jsonResponse(fullPage), {
        maximumPages: 1,
        pageSize: 2,
      }).listSessions(),
    ).rejects.toMatchObject({ code: "page_limit_exceeded" });

    await expect(
      client(
        async () =>
          jsonResponse({ data: [], recordsTotal: 0 }, 200, {
            "Content-Length": "1025",
          }),
        { responseLimitBytes: 1_024 },
      ).listSessions(),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("retries safe reads after a provider limit without wall-clock waiting", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const sessions = await client(
      async () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse(rateLimit, 429, { "Retry-After": "1" })
          : jsonResponse({ data: [], recordsFiltered: 0, recordsTotal: 0 });
      },
      {
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    ).listSessions();

    expect(sessions).toEqual([]);
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([1_000]);
  });

  it("reconciles a duplicate-speaker race by normalized email", async () => {
    const replies = [
      jsonResponse(duplicateSpeaker, 406),
      jsonResponse(speakersPageZero),
    ];
    const speakerId = await client(async () => {
      const response = replies.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    }).createSpeaker({
      email: "ADA@EXAMPLE.INVALID",
      firstName: "Ada",
      lastName: "Example",
    });

    expect(speakerId).toBe(4501);
    expect(replies).toHaveLength(0);
  });

  it("sends only documented session fields and normalizes track values", async () => {
    const bodies: unknown[] = [];
    const replies = [jsonResponse(110), jsonResponse(3115)];
    const provider = client(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as unknown);
      const response = replies.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    });

    await provider.createTrack({
      color: "#aabbcc",
      name: " Reliability ",
      type: "TRACK",
    });
    await provider.createSession(
      sessionWrite({
        tag: [{ id: 110, name: "Reliability" }],
        ticketTypesThatCanBeRegistered: [12],
      }),
    );

    expect(bodies[0]).toEqual({
      color: "#AABBCC",
      name: "Reliability",
      type: "TRACK",
    });
    expect(bodies[1]).toMatchObject({
      endTime: "2026/09/14 10:00",
      format: "BREAKOUT_SESSION",
      sessionTypeFormat: "IN_PERSON",
      startTime: "2026/09/14 09:00",
      tag: [{ id: 110, name: "Reliability" }],
      ticketTypesThatCanBeRegistered: [12],
    });
  });

  it("returns redacted per-operation receipts after a partial failure", async () => {
    const replies = [
      jsonResponse(110),
      jsonResponse(validationError, 400),
      jsonResponse(3115),
    ];
    const operations: AcceleventsMutation[] = [
      {
        operationId: "track:source-track-1",
        type: "create-track",
        value: { name: "Reliability", type: "TRACK" },
      },
      {
        operationId: "speaker:source-person-1",
        type: "create-speaker",
        value: {
          email: "fixture-person@example.invalid",
          firstName: "Fixture",
          lastName: "Person",
        },
      },
      {
        operationId: "session:source-session-1",
        type: "create-session",
        value: sessionWrite(),
      },
    ];

    const receipt = await client(async () => {
      const response = replies.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    }).applyOperations(operations);

    expect(receipt).toEqual({
      failed: 1,
      results: [
        {
          code: null,
          operationId: "track:source-track-1",
          providerId: 110,
          retryable: false,
          status: "succeeded",
        },
        {
          code: "invalid_session",
          operationId: "speaker:source-person-1",
          providerId: null,
          retryable: false,
          status: "failed",
        },
        {
          code: null,
          operationId: "session:source-session-1",
          providerId: 3115,
          retryable: false,
          status: "succeeded",
        },
      ],
      succeeded: 2,
    });
    expect(JSON.stringify(receipt)).not.toContain("example.invalid");
    expect(replies).toHaveLength(0);
  });

  it("does not retry an ambiguous create or expose its cause", async () => {
    let attempts = 0;
    const error = await client(async () => {
      attempts += 1;
      throw new Error("socket closed with fixture-api-key");
    })
      .createTrack({ name: "Reliability", type: "TRACK" })
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(AcceleventsProviderError);
    expect(error).toMatchObject({ code: "ambiguous_write", status: null });
    expect(String(error)).not.toContain("fixture-api-key");
    expect(attempts).toBe(1);
  });

  it("rejects invalid payloads and oversized batches before provider I/O", async () => {
    let requests = 0;
    const provider = client(async () => {
      requests += 1;
      return jsonResponse(1);
    });

    await expect(
      provider.createSession(sessionWrite({ title: "x".repeat(256) })),
    ).rejects.toThrow("title must contain between 1 and 255 characters");

    const operations = Array.from({ length: 101 }, (_, index) => ({
      operationId: `track:${index}`,
      type: "create-track" as const,
      value: { name: `Track ${index}`, type: "TRACK" as const },
    }));
    await expect(provider.applyOperations(operations)).rejects.toThrow(
      "limited to 100 operations",
    );
    expect(requests).toBe(0);
  });
});
