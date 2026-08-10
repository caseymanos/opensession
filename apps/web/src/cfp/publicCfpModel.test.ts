import { describe, expect, it } from "vitest";

import type { PublicCfpConfigurationResponse } from "@sessionbox-killer/contracts";

import {
  emptyPublicCfpDraft,
  publicCfpConfigurationSupportsFlow,
  publicCfpDraftForConfiguration,
  publicCfpEventFromConfiguration,
  publicCfpRuleFieldsFromConfiguration,
} from "./publicCfpModel";

const configuration: PublicCfpConfigurationResponse = {
  acceptingSubmissions: true,
  event: {
    cfpClosesAt: "2026-08-22T00:00:00.000Z",
    cfpOpensAt: "2026-07-01T16:00:00.000Z",
    endsAt: "2026-10-15T00:00:00.000Z",
    name: "Config-driven Summit",
    slug: "config-summit",
    startsAt: "2026-10-13T16:00:00.000Z",
    timezone: "America/Los_Angeles",
    venue: "Fort Mason Center",
  },
  form: {
    editAfterClose: false,
    fields: [
      {
        helpText: "",
        key: "format",
        label: "Session format",
        options: ["Talk", "Workshop"],
        required: true,
        rules: [],
        type: "single_select",
        validation: {},
      },
      {
        helpText: "",
        key: "workshop_prerequisites",
        label: "Before the workshop",
        options: [],
        required: false,
        rules: [
          {
            effect: "show",
            id: "show-workshop",
            operator: "equals",
            sourceKey: "format",
            value: "Workshop",
          },
        ],
        type: "long_text",
        validation: { maxLength: 2_000 },
      },
    ],
    name: "CFP",
    submissionLimit: 4,
    version: 9,
    welcomeContent: "Share the decisions behind the result.",
  },
  formats: ["Talk", "Workshop"],
  tracks: [
    {
      description: "Production systems and operations.",
      selection: "Systems",
    },
  ],
};

const supportedConfiguration: PublicCfpConfigurationResponse = {
  ...configuration,
  form: {
    ...configuration.form,
    fields: [
      {
        helpText: "",
        key: "title",
        label: "Session title",
        options: [],
        required: true,
        rules: [],
        type: "short_text",
        validation: {},
      },
      {
        helpText: "",
        key: "abstract",
        label: "Abstract",
        options: [],
        required: true,
        rules: [],
        type: "long_text",
        validation: {},
      },
      {
        helpText: "",
        key: "outcomes",
        label: "Attendee outcomes",
        options: [],
        required: true,
        rules: [],
        type: "long_text",
        validation: {},
      },
      {
        helpText: "",
        key: "track",
        label: "Track",
        options: ["Systems"],
        required: true,
        rules: [],
        type: "single_select",
        validation: {},
      },
      {
        helpText: "",
        key: "format",
        label: "Session format",
        options: ["Talk", "Workshop"],
        required: true,
        rules: [],
        type: "single_select",
        validation: {},
      },
      {
        helpText: "",
        key: "workshop_prerequisites",
        label: "Before the workshop",
        options: [],
        required: false,
        rules: [],
        type: "long_text",
        validation: { maxLength: 2_000 },
      },
    ],
  },
};

describe("public CFP presentation model", () => {
  it("derives public event copy and local-time labels from server configuration", () => {
    expect(publicCfpEventFromConfiguration(configuration)).toMatchObject({
      closesLabel: "Friday, August 21 at 5:00 PM PDT",
      eventDateLabel: "October 13–14, 2026",
      eventName: "Config-driven Summit",
      formats: ["Talk", "Workshop"],
      location: "Fort Mason Center",
      maxSubmissions: 4,
      timezoneLabel: "America/Los_Angeles",
      tracks: [
        {
          description: "Production systems and operations.",
          selection: "Systems",
        },
      ],
      welcomeContent: "Share the decisions behind the result.",
    });
  });

  it("maps server answer keys and conditional-rule sources to the UI model", () => {
    expect(publicCfpRuleFieldsFromConfiguration(configuration)).toEqual([
      expect.objectContaining({ key: "format", rules: [] }),
      expect.objectContaining({
        key: "workshopPrerequisites",
        rules: [expect.objectContaining({ sourceKey: "format" })],
      }),
    ]);
  });

  it("fails a non-renderable form closed instead of sending unknown answers", () => {
    expect(publicCfpConfigurationSupportsFlow(configuration)).toBe(false);
  });

  it("accepts the exact supported topology and uses server-owned defaults", () => {
    expect(publicCfpConfigurationSupportsFlow(supportedConfiguration)).toBe(
      true,
    );
    expect(
      publicCfpDraftForConfiguration(
        emptyPublicCfpDraft,
        supportedConfiguration,
      ),
    ).toMatchObject({
      format: "Talk",
      routeKey: "Systems",
      submissionTrack: "Systems",
      track: "Systems",
    });
  });

  it("preserves an explicit unlimited-submission policy", () => {
    expect(
      publicCfpEventFromConfiguration({
        ...supportedConfiguration,
        form: { ...supportedConfiguration.form, submissionLimit: null },
      }).maxSubmissions,
    ).toBeNull();
  });
});
