import { describe, expect, it } from "vitest";

import sessionsPageZero from "./__fixtures__/accelevents/sessions-page-0.json";
import speakersPageZero from "./__fixtures__/accelevents/speakers-page-0.json";
import {
  probeAcceleventsReadiness,
  probeAirtableReadiness,
  probeResendReadiness,
} from "./provider-readiness.js";

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("read-only provider readiness probes", () => {
  it("validates Airtable schema access without returning schema or credentials", async () => {
    let authorization = "";
    let requestUrl = "";
    const receipt = await probeAirtableReadiness({
      baseId: "appFixture1234",
      fetcher: async (input, init) => {
        requestUrl = input;
        authorization = new Headers(init?.headers).get("Authorization") ?? "";
        return response({ tables: [{ id: "tblFixture" }] });
      },
      token: "pat-fixture-secret",
    });

    expect(receipt).toEqual({ provider: "airtable", resourcesObserved: 1 });
    expect(requestUrl).toBe(
      "https://api.airtable.com/v0/meta/bases/appFixture1234/tables",
    );
    expect(authorization).toBe("Bearer pat-fixture-secret");
    expect(JSON.stringify(receipt)).not.toContain("pat-fixture-secret");
  });

  it("validates Resend domain-list access with the required user agent", async () => {
    let headers = new Headers();
    const receipt = await probeResendReadiness({
      apiKey: "fixture-resend-api-key",
      fetcher: async (_input, init) => {
        headers = new Headers(init?.headers);
        return response({
          data: [{ id: "domain-fixture", status: "verified" }],
          has_more: false,
          object: "list",
        });
      },
    });

    expect(receipt).toEqual({ provider: "resend", resourcesObserved: 1 });
    expect(headers.get("Authorization")).toBe("Bearer fixture-resend-api-key");
    expect(headers.get("User-Agent")).toBe(
      "opensession-provider-readiness/1.0",
    );
  });

  it("validates both read-only Accelevents collections", async () => {
    const receipt = await probeAcceleventsReadiness({
      apiKey: "fixture-api-key",
      authenticationHeader: "Key",
      eventId: 42,
      eventUrl: "redacted-event",
      fetcher: async (input) =>
        response(
          input.includes("/speaker?")
            ? speakersPageZero
            : {
                ...sessionsPageZero,
                data: sessionsPageZero.data.slice(0, 1),
                recordsFiltered: 1,
                recordsTotal: 1,
              },
        ),
    });

    expect(receipt).toEqual({
      provider: "accelevents",
      resourcesObserved: 2,
    });
  });

  it("redacts provider error bodies and credentials", async () => {
    const error = await probeResendReadiness({
      apiKey: "fixture-private-resend-key",
      fetcher: async () =>
        response(
          { message: "Bearer fixture-private-resend-key was rejected" },
          401,
        ),
    }).catch((cause) => cause);

    expect(String(error)).toContain("code=http_401");
    expect(String(error)).not.toContain("fixture-private-resend-key");
  });
});
