import {
  demoEventId,
  demoEventRootFields,
  demoOrganizationId,
  demoOrganizationRootFields,
  demoResetPhrase,
  demoSeedVersion,
} from "@sessionbox-killer/domain";

import type {
  DemoAirtableTableKey,
  DemoEntityReference,
  DemoSeedEntity,
  DemoSeedFieldValue,
  DemoSeedSource,
} from "./types";

export { demoEventId, demoOrganizationId, demoResetPhrase };

const createdAt = "2026-07-01T16:00:00.000Z";
const futureDue = "2026-08-15T23:59:00.000Z";
const overdueDue = "2026-08-01T23:59:00.000Z";

function reference(entityId: string): DemoEntityReference {
  return { entityId, kind: "entity_reference" };
}

function links(...entityIds: string[]): readonly DemoEntityReference[] {
  return entityIds.map(reference);
}

function entity(
  table: DemoAirtableTableKey,
  entityId: string,
  fields: Readonly<Record<string, DemoSeedFieldValue>>,
): DemoSeedEntity {
  return { entityId, fields, table };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

const organizationAndEvent: DemoSeedEntity[] = [
  entity("organizations", demoOrganizationId, demoOrganizationRootFields),
  entity("events", demoEventId, {
    ...demoEventRootFields,
    Organization: links(demoOrganizationId),
  }),
];

const trackDefinitions = [
  {
    aliases: [],
    color: "#285c4c",
    defaultReviewerGroupId: "group-ai-engineering",
    description:
      "Architecture, orchestration, reliability, and evaluation in production.",
    id: "track_agents",
    routeKey: "ai-engineering",
    selection: "AI Engineering",
    submissionTrack: "AI Engineering",
  },
  {
    aliases: [],
    color: "#7b61a8",
    defaultReviewerGroupId: "group-evaluation",
    description:
      "Measurement systems, evaluation practice, and quality operations.",
    id: "track_inference",
    routeKey: "evaluation",
    selection: "Evaluation",
    submissionTrack: "Evaluation",
  },
  {
    aliases: [],
    color: "#bd6b35",
    defaultReviewerGroupId: "group-infrastructure",
    description:
      "Platforms, inference, tooling, security, and developer infrastructure.",
    id: "track_platform",
    routeKey: "infrastructure",
    selection: "Infrastructure",
    submissionTrack: "Infrastructure",
  },
  {
    aliases: ["Track D", "Product · Track D"],
    color: "#43759d",
    defaultReviewerGroupId: "group-product",
    description:
      "Human workflows, product strategy, and responsible deployment.",
    id: "track_responsible",
    routeKey: "product-track-d",
    selection: "Product",
    submissionTrack: "Product · Track D",
  },
] as const;

const tracks: DemoSeedEntity[] = trackDefinitions.map((track, index) =>
  entity("tracks", track.id, {
    "CFP aliases JSON": json(track.aliases),
    "CFP selection": track.selection,
    Color: track.color,
    "Default reviewer group ID": track.defaultReviewerGroupId,
    Description: track.description,
    Event: links(demoEventId),
    Name: track.selection,
    "Route key": track.routeKey,
    "Sort order": index + 1,
    "Submission track": track.submissionTrack,
  }),
);

const rooms: DemoSeedEntity[] = [
  ["room_harbor", "Harbor Stage", 420],
  ["room_redwood", "Redwood Room", 180],
  ["room_studio", "Builder Studio", 90],
].map(([id, name, capacity], index) =>
  entity("rooms", String(id), {
    Capacity: Number(capacity),
    Event: links(demoEventId),
    Name: String(name),
    "Sort order": index + 1,
  }),
);

const formats: DemoSeedEntity[] = [
  ["format_talk", "30-minute talk", 30],
  ["format_keynote", "45-minute talk", 45],
  ["format_workshop", "90-minute workshop", 90],
].map(([id, name, duration], index) =>
  entity("formats", String(id), {
    "Default duration minutes": Number(duration),
    Event: links(demoEventId),
    Name: String(name),
    "Sort order": index + 1,
  }),
);

const formId = "form_cfp_2026";
const formFieldDefinitions = [
  {
    blockType: "text",
    id: "field_title",
    label: "Session title",
    order: 1,
    required: true,
    stableKey: "title",
    validation: { maxLength: 100, minLength: 8 },
  },
  {
    blockType: "textarea",
    id: "field_abstract",
    label: "Abstract",
    order: 2,
    required: true,
    stableKey: "abstract",
    validation: { maxLength: 1200, minLength: 120 },
  },
  {
    blockType: "textarea",
    id: "field_outcomes",
    label: "Attendee outcomes",
    order: 3,
    required: true,
    stableKey: "outcomes",
    validation: { maxLength: 4000, minLength: 1 },
  },
  {
    blockType: "select",
    id: "field_track",
    label: "Track",
    options: trackDefinitions.map((track) => track.selection),
    order: 4,
    required: true,
    stableKey: "track",
    validation: {},
  },
  {
    blockType: "select",
    id: "field_format",
    label: "Format",
    options: formats.map(({ fields }) => String(fields.Name)),
    order: 5,
    required: true,
    stableKey: "format",
    validation: {},
  },
  {
    blockType: "textarea",
    help: "What should attendees install or know before arriving?",
    id: "field_workshop_prerequisites",
    label: "Workshop prerequisites",
    order: 6,
    required: false,
    stableKey: "workshop_prerequisites",
    validation: { maxLength: 4000 },
  },
] as const;

const formFields: DemoSeedEntity[] = formFieldDefinitions.map((field) =>
  entity("form_fields", field.id, {
    "Block type": field.blockType,
    Form: links(formId),
    Help: "help" in field ? field.help : "",
    Label: field.label,
    "Options JSON": json("options" in field ? field.options : []),
    Order: field.order,
    Required: field.required,
    "Stable key": field.stableKey,
    "Validation JSON": json(field.validation),
  }),
);

const cfpEntities: DemoSeedEntity[] = [
  entity("forms", formId, {
    "Edit after close": false,
    Event: links(demoEventId),
    Name: "AI Engineer Summit call for proposals",
    "Published at": "2026-06-01T16:00:00.000Z",
    Status: "published",
    "Submission limit": 3,
    Version: 2,
    "Welcome content":
      "Share a practical lesson for engineers shipping reliable AI systems.",
  }),
  ...formFields,
  entity("form_rules", "rule_show_workshop_prerequisites", {
    Effect: "show",
    Form: links(formId),
    Operator: "equals",
    Order: 1,
    "Source field": links("field_format"),
    "Target field": links("field_workshop_prerequisites"),
    "Value JSON": json("90-minute workshop"),
  }),
  entity("form_rules", "rule_require_workshop_prerequisites", {
    Effect: "require",
    Form: links(formId),
    Operator: "equals",
    Order: 2,
    "Source field": links("field_format"),
    "Target field": links("field_workshop_prerequisites"),
    "Value JSON": json("90-minute workshop"),
  }),
];

const speakerProfiles = [
  ["Ada", "Chen", "She/her", "Staff AI Engineer", "Northstar Labs"],
  ["Mateo", "Rivera", "He/him", "ML Platform Lead", "Orbit Systems"],
  ["Priya", "Nair", "She/her", "Principal Research Engineer", "Lattice"],
  ["Jordan", "Bell", "They/them", "Developer Experience Lead", "Fathom"],
  ["Noor", "Haddad", "She/her", "Responsible AI Director", "Commons AI"],
  ["Eli", "Brooks", "He/him", "Inference Engineer", "Vector Works"],
  ["Samira", "Okafor", "She/her", "Applied AI Founder", "Fieldnote"],
  ["Theo", "Martin", "He/him", "Open Source Maintainer", "Patchwork"],
] as const;

const readinessStates = [
  "ready",
  "ready",
  "ready",
  "outstanding",
  "outstanding",
  "outstanding",
  "overdue",
  "overdue",
] as const;

const speakerContacts: DemoSeedEntity[] = speakerProfiles.map(
  ([firstName, lastName, pronouns, title, company], index) => {
    const number = String(index + 1).padStart(2, "0");
    return entity("contacts", `contact_speaker_${number}`, {
      Bio: `${firstName} builds dependable AI products and shares field-tested lessons.`,
      Company: company,
      "Display name": `${firstName} ${lastName}`,
      "Email normalized": `speaker-${number}@demo.opensession.invalid`,
      "First name": firstName,
      "Headshot object key":
        index < 3 ? `demo/${demoEventId}/headshots/speaker-${number}.png` : "",
      "Last name": lastName,
      Organization: links(demoOrganizationId),
      Pronouns: pronouns,
      "Social JSON": json({
        website: `https://example.invalid/speaker-${number}`,
      }),
      Title: title,
    });
  },
);

const speakerEventContacts: DemoSeedEntity[] = speakerProfiles.map(
  ([firstName], index) => {
    const number = String(index + 1).padStart(2, "0");
    const state = readinessStates[index] ?? "outstanding";
    return entity("event_contacts", `event_contact_speaker_${number}`, {
      Contact: links(`contact_speaker_${number}`),
      Event: links(demoEventId),
      "Invitation time": "2026-07-20T16:00:00.000Z",
      "Last active": index < 4 ? "2026-08-08T18:00:00.000Z" : null,
      "Portal state": "active",
      "Readiness projection JSON": json({
        displayName: firstName,
        overdueCount: state === "overdue" ? 1 : 0,
        requiredComplete: state === "ready" ? 1 : 0,
        requiredTotal: 1,
        state,
      }),
      Roles: ["speaker"],
    });
  },
);

const reviewerProfiles = [
  ["reviewer_01", "Riley Reviewer"],
  ["reviewer_02", "Morgan Reviewer"],
  ["reviewer_03", "Quinn Reviewer"],
] as const;

const reviewerContacts = reviewerProfiles.flatMap(([suffix, name], index) => [
  entity("contacts", `contact_${suffix}`, {
    Bio: "Program committee reviewer.",
    Company: "OpenSession Community",
    "Display name": name,
    "Email normalized": `${suffix.replace("_", "-")}@demo.opensession.invalid`,
    "First name": name.split(" ")[0] ?? name,
    "Last name": "Reviewer",
    Organization: links(demoOrganizationId),
    Pronouns: "They/them",
    "Social JSON": json({}),
    Title: "Program committee",
  }),
  entity("event_contacts", `event_contact_${suffix}`, {
    Contact: links(`contact_${suffix}`),
    Event: links(demoEventId),
    "Invitation time": createdAt,
    "Last active": `2026-08-0${index + 6}T18:00:00.000Z`,
    "Portal state": "active",
    "Readiness projection JSON": json({}),
    Roles: ["reviewer"],
  }),
]);

const peopleEntities = [
  ...speakerContacts,
  ...speakerEventContacts,
  ...reviewerContacts,
];

const submissionStates = [
  "accepted",
  "accepted",
  "accepted",
  "accepted",
  "accepted",
  "accepted",
  "waitlisted",
  "declined",
  "in_review",
  "submitted",
  "draft",
  "withdrawn",
] as const;

const sessionTitles = [
  "Agents that recover in production",
  "The inference latency budget",
  "Designing an AI platform team",
  "Operationalizing responsible evaluations",
  "Durable workflows for long-running agents",
  "Open source observability for model systems",
] as const;

const submissions: DemoSeedEntity[] = submissionStates.map((status, index) => {
  const number = String(index + 1).padStart(2, "0");
  const speakerNumber = String((index % 8) + 1).padStart(2, "0");
  const track = trackDefinitions[index % trackDefinitions.length];
  if (!track) throw new Error("Demo track fixture is incomplete");
  return entity("submissions", `submission_${number}`, {
    "Default reviewer group ID": track.defaultReviewerGroupId,
    "Decision note": status === "declined" ? "Strong idea; limited space." : "",
    "Draft JSON": json(
      status === "draft"
        ? {
            answers: {
              abstract: "A durable in-progress demo proposal.",
              format: "30-minute talk",
              outcomes: "Share one practical operating pattern.",
              title: "Reliable retrieval in practice",
              track: track.selection,
              workshop_prerequisites: "",
            },
            participants: [],
            step: "submission",
          }
        : {},
    ),
    Event: links(demoEventId),
    Form: links(formId),
    "Form version": 2,
    "Friendly ID": `SUB-${number}`,
    "Route key": track.routeKey,
    Status: status,
    "Submitted at":
      status === "draft"
        ? null
        : `2026-07-${String(10 + index).padStart(2, "0")}T18:00:00.000Z`,
    "Submitter contact": links(`contact_speaker_${speakerNumber}`),
    Title:
      sessionTitles[index] ??
      [
        "Evaluations at the edge",
        "What failed in our first copilot",
        "Serving small models well",
        "Building useful AI guardrails",
        "Reliable retrieval in practice",
        "Community models after launch",
      ][index - 6] ??
      `Demo proposal ${number}`,
    Track: links(track.id),
  });
});

const submissionDetails = submissions.flatMap((submission, index) => {
  const number = String(index + 1).padStart(2, "0");
  const speakerNumber = String((index % 8) + 1).padStart(2, "0");
  return [
    entity("submission_answers", `answer_${number}_abstract`, {
      "Field label snapshot": "Abstract",
      "Field stable key": "abstract",
      "Form version snapshot": 2,
      Order: 1,
      Submission: links(submission.entityId),
      Type: "textarea",
      "Value JSON": json(
        "A concrete field report with architecture, failure modes, and takeaways.",
      ),
    }),
    entity("submission_participants", `submission_participant_${number}`, {
      Contact: links(`contact_speaker_${speakerNumber}`),
      "Is primary": true,
      Order: 1,
      Role: "speaker",
      Submission: links(submission.entityId),
    }),
  ];
});

const rubricId = "rubric_program_quality";
const rubricCriteriaSnapshot = [
  {
    guidance: "Does this serve working AI engineers?",
    id: "criterion_relevance",
    label: "Audience relevance",
    weight: 40,
  },
  {
    guidance: "Are the lessons concrete and reusable?",
    id: "criterion_practicality",
    label: "Practical value",
    weight: 40,
  },
  {
    guidance: "Does this add a distinct point of view?",
    id: "criterion_originality",
    label: "Originality",
    weight: 20,
  },
];
const rubricSnapshot = {
  criteria: rubricCriteriaSnapshot,
  id: rubricId,
  name: "Program quality",
  version: 2,
};
const reviewerGroupDefinitions = [
  [
    "group-ai-engineering",
    "AI Engineering reviewers",
    "ai-engineering",
    ["event_contact_reviewer_01", "event_contact_reviewer_02"],
  ],
  [
    "group-evaluation",
    "Evaluation reviewers",
    "evaluation",
    ["event_contact_reviewer_02", "event_contact_reviewer_03"],
  ],
  [
    "group-infrastructure",
    "Infrastructure reviewers",
    "infrastructure",
    ["event_contact_reviewer_01", "event_contact_reviewer_03"],
  ],
  [
    "group-product",
    "Product reviewers",
    "product-track-d",
    [
      "event_contact_reviewer_01",
      "event_contact_reviewer_02",
      "event_contact_reviewer_03",
    ],
  ],
] as const;
const reviewEntities: DemoSeedEntity[] = [
  entity("rubrics", rubricId, {
    "Criteria snapshot JSON": json(rubricCriteriaSnapshot),
    Event: links(demoEventId),
    Name: "Program quality",
    Status: "active",
    Version: 2,
  }),
  ...reviewerGroupDefinitions.map(([id, name, routeKey, memberIds]) =>
    entity("reviewer_groups", id, {
      Event: links(demoEventId),
      "Member IDs JSON": json(memberIds),
      Name: name,
      "Route key": routeKey,
      Status: "active",
    }),
  ),
  entity("criteria", "criterion_relevance", {
    Guidance: "Does this serve working AI engineers?",
    Label: "Audience relevance",
    Maximum: 5,
    Minimum: 1,
    Order: 1,
    Rubric: links(rubricId),
    Weight: 0.4,
  }),
  entity("criteria", "criterion_practicality", {
    Guidance: "Are the lessons concrete and reusable?",
    Label: "Practical value",
    Maximum: 5,
    Minimum: 1,
    Order: 2,
    Rubric: links(rubricId),
    Weight: 0.4,
  }),
  entity("criteria", "criterion_originality", {
    Guidance: "Does this add a distinct point of view?",
    Label: "Originality",
    Maximum: 5,
    Minimum: 1,
    Order: 3,
    Rubric: links(rubricId),
    Weight: 0.2,
  }),
  ...[
    "submitted",
    "submitted",
    "draft",
    "assigned",
    "submitted",
    "draft",
  ].flatMap((status, index) => {
    const number = String(index + 1).padStart(2, "0");
    const reviewerNumber = String((index % 3) + 1).padStart(2, "0");
    const reviewerGroupId =
      reviewerGroupDefinitions[index % reviewerGroupDefinitions.length]?.[0] ??
      "group-ai-engineering";
    const reviewId = `review_${number}`;
    const review = entity("reviews", reviewId, {
      "Assigned at": `2026-07-${String(index + 20).padStart(2, "0")}T16:00:00.000Z`,
      Conflict: index === 3,
      "Conflict note": index === 3 ? "Prior collaborator" : "",
      "Reviewer group ID": reviewerGroupId,
      "Reviewer membership": links(`event_contact_reviewer_${reviewerNumber}`),
      "Rubric snapshot JSON": json(rubricSnapshot),
      "Rubric version": 2,
      "Scoring required": index !== 3,
      "Score snapshot JSON": json(
        status === "submitted"
          ? rubricCriteriaSnapshot.map((criterion, criterionIndex) => ({
              criterionId: criterion.id,
              score: Math.max(1, 5 - ((index + criterionIndex) % 2)),
            }))
          : status === "draft"
            ? [
                {
                  criterionId: rubricCriteriaSnapshot[0]?.id,
                  score: 4,
                },
              ]
            : [],
      ),
      "Reviewer note":
        status === "submitted"
          ? "Strong practical framing and clear evidence."
          : "",
      Status: status,
      Submission: links(`submission_${number}`),
      "Submitted at":
        status === "submitted" ? "2026-07-29T18:00:00.000Z" : null,
    });
    if (status !== "submitted") return [review];
    return [
      review,
      entity("review_scores", `score_${number}_relevance`, {
        Comment: "Strong fit for the audience.",
        Criterion: links("criterion_relevance"),
        "Numeric score": 4 + (index % 2),
        Review: links(reviewId),
      }),
      entity("review_scores", `score_${number}_practicality`, {
        Comment: "Clear operational takeaways.",
        Criterion: links("criterion_practicality"),
        "Numeric score": 4,
        Review: links(reviewId),
      }),
    ];
  }),
];

const sessionMetadata = [
  ["session_01", "submission_01", "track_agents", "format_keynote", 45, 320],
  ["session_02", "submission_02", "track_inference", "format_talk", 30, 160],
  ["session_03", "submission_03", "track_platform", "format_talk", 30, 140],
  ["session_04", "submission_04", "track_responsible", "format_talk", 30, 120],
  ["session_05", "submission_05", "track_agents", "format_workshop", 90, 80],
  ["session_06", "submission_06", "track_platform", "format_workshop", 90, 75],
] as const;

const sessions = sessionMetadata.map(
  ([id, submissionId, trackId, formatId, duration, attendance], index) =>
    entity("sessions", id, {
      Abstract:
        "A practical session grounded in real architecture and production lessons.",
      "Duration minutes": duration,
      Event: links(demoEventId),
      "Expected attendance": attendance,
      "External mapping JSON": json({}),
      Format: links(formatId),
      "Friendly ID": `SES-${String(index + 1).padStart(2, "0")}`,
      Public: true,
      "Source submission": links(submissionId),
      Status: index < 4 ? "published" : "accepted",
      Title: sessionTitles[index] ?? `Demo session ${index + 1}`,
      Track: links(trackId),
    }),
);

const sessionParticipants: DemoSeedEntity[] = [
  ["session_01", "contact_speaker_01", "speaker"],
  ["session_02", "contact_speaker_01", "moderator"],
  ["session_02", "contact_speaker_02", "speaker"],
  ["session_03", "contact_speaker_03", "speaker"],
  ["session_04", "contact_speaker_04", "chair"],
  ["session_05", "contact_speaker_05", "speaker"],
  ["session_06", "contact_speaker_06", "speaker"],
].map(([sessionId, contactId, role], index) =>
  entity(
    "session_participants",
    `session_participant_${String(index + 1).padStart(2, "0")}`,
    {
      "Confirmed state": "confirmed",
      Contact: links(contactId ?? ""),
      Order: 1,
      Role: role ?? "speaker",
      Session: links(sessionId ?? ""),
    },
  ),
);

const scheduleSlots: DemoSeedEntity[] = [
  [
    "slot_01",
    "session_01",
    "room_harbor",
    "2026-10-13T17:00:00.000Z",
    "2026-10-13T17:45:00.000Z",
  ],
  [
    "slot_02",
    "session_02",
    "room_redwood",
    "2026-10-13T17:15:00.000Z",
    "2026-10-13T17:45:00.000Z",
  ],
  [
    "slot_03",
    "session_03",
    "room_harbor",
    "2026-10-14T17:00:00.000Z",
    "2026-10-14T17:30:00.000Z",
  ],
  [
    "slot_04",
    "session_04",
    "room_studio",
    "2026-10-14T18:00:00.000Z",
    "2026-10-14T18:30:00.000Z",
  ],
].map(([id, sessionId, roomId, startsAt, endsAt]) =>
  entity("schedule_slots", id ?? "", {
    "End UTC": endsAt ?? "",
    Event: links(demoEventId),
    "Override reason": "",
    "Published version": 3,
    Room: links(roomId ?? ""),
    Session: links(sessionId ?? ""),
    "Start UTC": startsAt ?? "",
    Version: 3,
  }),
);

const taskDefinitions = [
  entity("task_definitions", "task_ack_code_of_conduct", {
    "Approval required": false,
    Description: "Acknowledge the speaker code of conduct.",
    Event: links(demoEventId),
    "File policy JSON": json({}),
    "Form schema JSON": json({}),
    Name: "Code of conduct",
    "Required default": true,
    "Target rule JSON": json({ roles: ["speaker"] }),
    Type: "ack",
  }),
  entity("task_definitions", "task_upload_slides", {
    "Approval required": true,
    Description: "Upload presentation slides as PDF or PPTX.",
    Event: links(demoEventId),
    "File policy JSON": json({
      extensions: ["pdf", "pptx"],
      maxBytes: 52428800,
    }),
    "Form schema JSON": json({}),
    Name: "Presentation slides",
    "Required default": true,
    "Target rule JSON": json({ sessionRequired: true }),
    Type: "file",
  }),
  entity("task_definitions", "task_profile_review", {
    "Approval required": false,
    Description: "Review the public speaker profile.",
    Event: links(demoEventId),
    "File policy JSON": json({}),
    "Form schema JSON": json({ fields: ["bio", "headshot"] }),
    Name: "Profile review",
    "Required default": true,
    "Target rule JSON": json({ roles: ["speaker"] }),
    Type: "form",
  }),
];

const taskAssignments = readinessStates.map((state, index) => {
  const number = String(index + 1).padStart(2, "0");
  const complete = state === "ready";
  const overdue = state === "overdue";
  return entity("task_assignments", `assignment_speaker_${number}`, {
    "Approved at": complete ? "2026-08-05T20:00:00.000Z" : null,
    "Completed at": complete ? "2026-08-05T19:30:00.000Z" : null,
    Contact: links(`contact_speaker_${number}`),
    Definition: links(
      index % 3 === 0
        ? "task_upload_slides"
        : index % 3 === 1
          ? "task_profile_review"
          : "task_ack_code_of_conduct",
    ),
    "Due UTC": overdue ? overdueDue : futureDue,
    Event: links(demoEventId),
    "File object IDs JSON":
      complete && index === 0 ? json(["asset_slides_01"]) : json([]),
    Required: true,
    "Response JSON": json(complete ? { acknowledged: true } : {}),
    Session: index < 6 ? links(`session_${number}`) : [],
    Status: complete ? "complete" : overdue ? "not_started" : "in_progress",
  });
});

const programEntities = [
  ...submissions,
  ...submissionDetails,
  ...reviewEntities,
  ...sessions,
  ...sessionParticipants,
  ...scheduleSlots,
  ...taskDefinitions,
  ...taskAssignments,
];

const templateDefinitions = [
  [
    "template_receipt",
    "Submission receipt",
    "We received {{submission.title}}.",
  ],
  [
    "template_acceptance",
    "Acceptance",
    "Your session {{session.title}} is accepted.",
  ],
  [
    "template_decline",
    "Decline",
    "Thank you for sharing {{submission.title}}.",
  ],
  [
    "template_waitlist",
    "Waitlist",
    "{{submission.title}} is currently waitlisted.",
  ],
  [
    "template_task_reminder",
    "Task reminder",
    "Your next task is {{task.name}}.",
  ],
  [
    "template_schedule_update",
    "Schedule update",
    "{{session.title}} has a schedule update.",
  ],
] as const;

const templates = templateDefinitions.map(([id, name, body]) =>
  entity("email_templates", id, {
    "Audience type": ["Decline", "Submission receipt", "Waitlist"].includes(
      name,
    )
      ? "submitter"
      : "speaker",
    "Body document JSON": json({ blocks: [{ text: body, type: "paragraph" }] }),
    "Body HTML": `<p>${body}</p>`,
    "Body text": body,
    Event: links(demoEventId),
    "Merge schema version": 1,
    Name: name,
    "Reply to": "hello@demo.opensession.invalid",
    "Sender email": "auth@demo.opensession.invalid",
    "Sender name": "OpenSession Demo",
    Status: "active",
    Subject: `${name} · AI Engineer Summit`,
    "Used merge fields JSON": json(
      [...body.matchAll(/{{([^}]+)}}/g)].map((match) => match[1]),
    ),
    Version: 1,
  }),
);

const deliveryAndIntegrationEntities: DemoSeedEntity[] = [
  ...templates,
  entity("resources", "resource_speaker_guide", {
    Event: links(demoEventId),
    "Published at": "2026-07-20T16:00:00.000Z",
    "Sanitized HTML":
      "<h2>Speaker guide</h2><p>Dates, recording consent, and venue details.</p>",
    Status: "published",
    Subtitle: "Everything speakers need before arrival",
    "Target rule JSON": json({ roles: ["speaker"] }),
    Title: "Speaker guide",
  }),
  entity("campaigns", "campaign_acceptance_demo", {
    "Audience filter snapshot JSON": json({
      contactIds: ["contact_speaker_01"],
    }),
    Event: links(demoEventId),
    "Scheduled at": null,
    Status: "complete",
    Template: links("template_acceptance"),
    "Template snapshot JSON": json({ name: "Acceptance", version: 1 }),
    "Template version": 1,
    Trigger: "demo_seed",
  }),
  entity("messages", "message_acceptance_demo", {
    Campaign: links("campaign_acceptance_demo"),
    Contact: links("contact_speaker_01"),
    "Delivered at": null,
    "Error code": "",
    "Idempotency key": "demo_acceptance_contact_speaker_01_v1",
    "Provider ID": "sink_demo_acceptance_01",
    "Queued at": "2026-08-05T17:00:00.000Z",
    "Recipient email": "speaker-01@demo.opensession.invalid",
    "Sent at": "2026-08-05T17:00:01.000Z",
    Status: "sent",
  }),
  entity("integrations", "integration_accelevents_fixture", {
    Enabled: true,
    Event: links(demoEventId),
    "Non-secret config JSON": json({
      eventId: "fixture-event",
      mode: "fixture",
    }),
    Provider: "accelevents",
    Status: "degraded",
  }),
  entity("external_mappings", "mapping_session_01_fixture", {
    "Content hash": "a".repeat(64),
    "Entity type": "session",
    "External ID": "fixture-session-001",
    Integration: links("integration_accelevents_fixture"),
    "Last synced": "2026-08-07T18:00:00.000Z",
    "Source ID": "session_01",
  }),
  entity("sync_runs", "sync_run_failed_retryable", {
    "Counts JSON": json({ attempted: 6, failed: 1, succeeded: 5 }),
    Cursor: "fixture_cursor_005",
    "Error summary": "provider_rate_limited: retry scheduled",
    "Finished at": "2026-08-08T18:02:00.000Z",
    Integration: links("integration_accelevents_fixture"),
    Mode: "apply",
    "Started at": "2026-08-08T18:00:00.000Z",
    Status: "failed",
    Trigger: "demo_seed",
  }),
];

export const demoSeedSource: DemoSeedSource = {
  assets: [
    {
      assetId: "asset_headshot_01",
      contentBase64:
        "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsItjGCPYP4cRfAuDFVhq+rUICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICFwWUZAAxFdbOLwAAAAASUVORK5CYII=",
      contentType: "image/png",
      kind: "headshot",
      license: "CC0-1.0",
      objectKey: `demo/${demoEventId}/headshots/speaker-01.png`,
      ownerContactId: "contact_speaker_01",
      synthetic: true,
    },
    {
      assetId: "asset_headshot_02",
      contentBase64:
        "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsKtqDgsZ0wi+hcEKLF3zWgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELgupiUFpHeU5zwAAAABJRU5ErkJggg==",
      contentType: "image/png",
      kind: "headshot",
      license: "CC0-1.0",
      objectKey: `demo/${demoEventId}/headshots/speaker-02.png`,
      ownerContactId: "contact_speaker_02",
      synthetic: true,
    },
    {
      assetId: "asset_headshot_03",
      contentBase64:
        "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsCtlKjPazQi+hcEKLNP1WgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELguH79E8RviwaQAAAABJRU5ErkJggg==",
      contentType: "image/png",
      kind: "headshot",
      license: "CC0-1.0",
      objectKey: `demo/${demoEventId}/headshots/speaker-03.png`,
      ownerContactId: "contact_speaker_03",
      synthetic: true,
    },
    {
      assetId: "asset_slides_01",
      contentBase64:
        "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2OCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcwMCBUZCAoQUkgRW5naW5lZXIgU3VtbWl0IDIwMjYgLSBEZW1vIFNsaWRlcykgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNTkgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MjkKJSVFT0YK",
      contentType: "application/pdf",
      kind: "slides",
      license: "CC0-1.0",
      objectKey: `demo/${demoEventId}/slides/session-01.pdf`,
      ownerContactId: "contact_speaker_01",
      synthetic: true,
    },
  ],
  delivery: { allowlist: [], mode: "sink" },
  entities: [
    ...organizationAndEvent,
    ...tracks,
    ...rooms,
    ...formats,
    ...cfpEntities,
    ...peopleEntities,
    ...programEntities,
    ...deliveryAndIntegrationEntities,
  ],
  eventId: demoEventId,
  organizationId: demoOrganizationId,
  resetPhrase: demoResetPhrase,
  schemaVersion: 1,
  seedVersion: demoSeedVersion,
};
