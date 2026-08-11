/// <reference types="node" />

import { describe, expect, it } from "vitest";

import {
  probeAcceleventsReadiness,
  probeAirtableReadiness,
  probeResendReadiness,
} from "./provider-readiness.js";
import type { AcceleventsAuthenticationHeader } from "./accelevents.js";

const liveProvider = process.env.LIVE_PROVIDER;

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new TypeError(`${name} is required.`);
  return value;
}

describe("explicit read-only live provider contracts", () => {
  it.skipIf(liveProvider !== "airtable")(
    "authenticates and reads the configured Airtable base schema",
    async () => {
      const receipt = await probeAirtableReadiness({
        baseId: requireEnvironment("AIRTABLE_BASE_ID"),
        token: requireEnvironment("AIRTABLE_PAT"),
      });
      expect(receipt.provider).toBe("airtable");
      expect(receipt.resourcesObserved).toBeGreaterThan(0);
    },
  );

  it.skipIf(liveProvider !== "resend")(
    "authenticates and reads the configured Resend domain inventory",
    async () => {
      const receipt = await probeResendReadiness({
        apiKey: requireEnvironment("RESEND_API_KEY"),
      });
      expect(receipt.provider).toBe("resend");
      expect(receipt.resourcesObserved).toBeGreaterThanOrEqual(0);
    },
  );

  it.skipIf(liveProvider !== "accelevents")(
    "authenticates and reads the configured Accelevents event contracts",
    async () => {
      const header = requireEnvironment("ACCELEVENTS_AUTH_HEADER");
      if (header !== "Authorization" && header !== "Key") {
        throw new TypeError(
          "ACCELEVENTS_AUTH_HEADER must be Authorization or Key.",
        );
      }
      const receipt = await probeAcceleventsReadiness({
        apiKey: requireEnvironment("ACCELEVENTS_API_KEY"),
        authenticationHeader: header as AcceleventsAuthenticationHeader,
        eventId: Number(requireEnvironment("ACCELEVENTS_EVENT_ID")),
        eventUrl: requireEnvironment("ACCELEVENTS_EVENT_URL"),
      });
      expect(receipt.provider).toBe("accelevents");
      expect(receipt.resourcesObserved).toBeGreaterThanOrEqual(0);
    },
  );
});
