import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const submissionsPath = "/app/ai-engineer-summit/submissions";
const fixturePath = "/fixtures/submissions/interactive";
const detailPath = `${fixturePath}/AI-1042`;
const liveDetailPath = `${submissionsPath}/submission_alpha`;

const projection = {
  asOf: "2026-08-10T19:00:00.000Z",
  pendingRepairs: 0,
  reasons: [],
  state: "current",
};

const liveRow = {
  id: "submission_alpha",
  lastActivityAt: "2026-08-10T19:00:00.000Z",
  reference: "AI-2042",
  reviews: { aggregateScore: 4.5, assigned: 2, submitted: 1 },
  routing: { reviewerGroupId: "group_systems", routeKey: "reliability" },
  status: "submitted",
  submitter: {
    company: "Northstar Labs",
    displayName: "Mina Okafor",
    email: "mina@example.com",
    id: "contact_mina",
    title: "Principal Engineer",
  },
  title: "Durable agent systems",
  track: { id: "track_reliability", name: "Reliability" },
  version: 2,
};

function liveDetail(status = "submitted", version = 2) {
  return {
    allowedCommands:
      status === "submitted"
        ? ["start_review", "withdraw", "add_note"]
        : ["withdraw", "add_note"],
    answerSnapshot: {
      answers: [
        {
          fieldKey: "outcomes",
          fieldType: "long_text",
          formVersion: 3,
          label: "What will attendees learn?",
          order: 0,
          redacted: false,
          value: "How to make recovery state understandable.",
        },
        {
          fieldKey: "private_file",
          fieldType: "file",
          formVersion: 3,
          label: "Private attachment",
          order: 1,
          redacted: true,
          value: null,
        },
      ],
      formVersion: 3,
      state: "submitted",
    },
    history:
      status === "in_review"
        ? [
            {
              action: "start_review",
              actor: { displayName: "Casey Manos", id: "user_casey" },
              commandId: "submission_testcommand",
              createdAt: "2026-08-10T19:05:00.000Z",
              fromStatus: "submitted",
              id: "activity_review",
              reason: "Eligibility check completed.",
              toStatus: "in_review",
            },
          ]
        : [],
    notes: [],
    participants: [
      {
        contact: liveRow.submitter,
        id: "participant_mina",
        isPrimary: true,
        order: 0,
        role: "Primary speaker",
      },
    ],
    projection,
    reviews: [],
    submission: { ...liveRow, status, version },
    submittedAt: "2026-08-09T18:00:00.000Z",
  };
}

async function mockLiveList(page: Page) {
  await page.route(
    "**/api/events/ai-engineer-summit/submissions*",
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        request.method() !== "GET" ||
        !url.pathname.endsWith("/submissions")
      ) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        json: {
          eventId: "event_alpha",
          items: [liveRow],
          nextCursor: null,
          projection,
        },
      });
    },
  );
}

test("organizer can search and filter the submission queue with URL persistence", async ({
  page,
}) => {
  await page.goto(fixturePath);

  await expect(
    page.getByRole("heading", { name: "Every proposal, in context." }),
  ).toBeVisible();
  const queue = page.locator(
    ".submission-table-desktop:visible, .submission-cards:visible",
  );
  const rows = page.locator(
    ".ui-table tbody tr:visible, .submission-cards > article:visible",
  );
  await expect(queue).toContainText(
    "From Prototype to Production: Reliable Agent Systems",
  );
  await expect(queue).toContainText("4.42");
  await expect(rows).toHaveCount(6);

  await page.getByLabel("Search submissions").fill("Mina Okafor");
  await expect(page).toHaveURL(/q=Mina/);
  await expect(rows).toHaveCount(1);
  await expect(queue).toContainText("AI-1042");

  await page.getByLabel("Search submissions").fill("");
  await page.getByLabel("Status", { exact: true }).selectOption("accepted");
  await expect(page).toHaveURL(/status=accepted/);
  await expect(rows).toHaveCount(1);
  await expect(queue).toContainText("Designing Human Checkpoints That Scale");

  const results = await new AxeBuilder({ page })
    .include(".submission-list")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("detail preserves the exact submitted form and organizer context", async ({
  page,
}) => {
  await page.goto(detailPath);

  await expect(
    page.getByRole("heading", {
      name: "From Prototype to Production: Reliable Agent Systems",
      level: 1,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("CFP form v2 · submitted snapshot"),
  ).toBeVisible();
  await expect(page.getByText("What will attendees learn?")).toBeVisible();
  await expect(page.getByText("Mina Okafor", { exact: true })).toBeVisible();
  await expect(page.getByText("Theo Martin", { exact: true })).toBeVisible();
  await expect(page.locator(".submission-score")).toContainText("4.42");
  await expect(page.getByText("3 of 4")).toBeVisible();
  await expect(
    page.getByText("Moved into review after eligibility check."),
  ).toBeVisible();
});

test("legal lifecycle changes require a reason and record an audit entry", async ({
  page,
}) => {
  await page.goto(`${fixturePath}/AI-1068`);

  await page.getByRole("button", { name: "Move to review" }).click();
  const dialog = page.getByRole("dialog", { name: "Move to review" });
  await expect(
    dialog.getByRole("button", { name: "Record change" }),
  ).toBeDisabled();
  await dialog
    .getByLabel("Reason for change")
    .fill("Eligibility check completed; route to the architecture panel.");
  await dialog.getByRole("button", { name: "Record change" }).click();

  await expect(page.getByText("Under review", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Moved to review", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Eligibility check completed; route to the architecture panel.",
    ),
  ).toBeVisible();
  await expect(page.locator(".ui-toast")).toContainText("Status updated");
});

test("internal notes are required, private, and immediately visible", async ({
  page,
}) => {
  await page.goto(detailPath);

  const addNote = page.getByRole("button", { name: "Add note" });
  await expect(addNote).toBeDisabled();
  await page
    .getByLabel("Add an internal note")
    .fill("Confirm the incident diagram has alt text before scheduling.");
  await addNote.click();
  await expect(
    page.getByText(
      "Confirm the incident diagram has alt text before scheduling.",
    ),
  ).toBeVisible();
  await expect(
    page.locator(".ui-toast").filter({ hasText: "Internal note added" }),
  ).toBeVisible();
});

test("degraded and access fixtures preserve safe boundaries", async ({
  page,
}) => {
  await page.goto("/fixtures/submissions/partial");
  await expect(
    page.getByText("Upstream history is temporarily unavailable"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "From Prototype to Production: Reliable Agent Systems",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Withdraw" })).toBeDisabled();
  await expect(page.getByLabel("Add an internal note")).toBeDisabled();

  await page.goto("/fixtures/submissions/permission");
  await expect(
    page.getByRole("heading", { name: "Submissions are restricted" }),
  ).toBeVisible();

  await page.goto("/fixtures/submissions/stale");
  await expect(page.getByText("This snapshot may be behind")).toBeVisible();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(
    page.getByText("Submission projection is current"),
  ).toBeVisible();

  await mockLiveList(page);
  await page.goto(`${submissionsPath}?state=permission`);
  await expect(
    page.getByRole("heading", { name: "Every proposal, in context." }),
  ).toBeVisible();
});

test("empty fixtures and 360px layouts remain clear and accessible", async ({
  page,
}) => {
  await page.goto("/fixtures/submissions/empty");
  await expect(
    page.getByRole("heading", { name: "No submissions yet" }),
  ).toBeVisible();

  await page.goto("/fixtures/submissions/empty-filter");
  await expect(
    page.getByRole("heading", { name: "No submissions match" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(fixturePath);
  await expect(page.getByLabel("Submission cards")).toBeVisible();
  await expect(page.getByRole("table")).toBeHidden();

  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

  const results = await new AxeBuilder({ page })
    .include(".submission-list")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("production list consumes canonical filters and ignores fixture query state", async ({
  page,
}) => {
  await mockLiveList(page);
  await page.goto(`${submissionsPath}?state=permission`);

  await expect(
    page.getByRole("heading", { name: "Every proposal, in context." }),
  ).toBeVisible();
  const liveQueue = page.locator(
    ".submission-table-desktop:visible, .submission-cards:visible",
  );
  await expect(liveQueue).toContainText("Durable agent systems");
  await expect(liveQueue).toContainText("AI-2042");

  const filtered = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.searchParams.get("status") === "in_review";
  });
  await page.getByLabel("Status", { exact: true }).selectOption("under_review");
  await filtered;
  await expect(page).toHaveURL(/status=in_review/);

  const results = await new AxeBuilder({ page })
    .include(".submission-list")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("production list fails closed when organizer access is denied", async ({
  page,
}) => {
  await page.route(
    "**/api/events/ai-engineer-summit/submissions*",
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        json: {
          error: {
            code: "forbidden",
            message: "This event is outside the current organizer scope.",
          },
          request_id: "request_forbidden",
        },
        status: 403,
      });
    },
  );

  await page.goto(submissionsPath);
  await expect(
    page.getByRole("heading", { name: "Submission access required" }),
  ).toBeVisible();
  await expect(
    page.getByText("From Prototype to Production: Reliable Agent Systems"),
  ).toHaveCount(0);
});

test("production detail renders immutable response data and records a versioned command", async ({
  page,
}) => {
  let status = "submitted";
  let version = 2;
  let command: Record<string, unknown> | null = null;
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      get: () => "__Host-opensession-csrf=csrf-token",
    });
  });
  await page.route(
    "**/api/events/ai-engineer-summit/submissions/**",
    async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        command = request.postDataJSON() as Record<string, unknown>;
        status = "in_review";
        version = 3;
        await route.fulfill({
          contentType: "application/json",
          json: {
            ok: true,
            result: {
              appliedAt: "2026-08-10T19:05:00.000Z",
              commandId: command.commandId,
              note: null,
              outcome: "applied",
              projection: "durable",
              status,
              submissionId: "submission_alpha",
              version,
            },
          },
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        json: liveDetail(status, version),
      });
    },
  );

  await page.goto(liveDetailPath);
  await expect(
    page.getByRole("heading", { name: "Durable agent systems", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("CFP form v3 · submitted snapshot"),
  ).toBeVisible();
  await expect(page.getByText("Private answer redacted")).toBeVisible();

  await page.getByRole("button", { name: "Move to review" }).click();
  const dialog = page.getByRole("dialog", { name: "Move to review" });
  await dialog
    .getByLabel("Reason for change")
    .fill("Eligibility check completed.");
  await dialog.getByRole("button", { name: "Record change" }).click();

  await expect(page.getByText("Under review", { exact: true })).toBeVisible();
  await expect(page.locator(".ui-toast")).toContainText("Status updated");
  expect(command).toMatchObject({
    expectedVersion: 2,
    reason: "Eligibility check completed.",
    submissionId: "submission_alpha",
    type: "start_review",
  });
  expect(command?.commandId).toMatch(/^submission_[a-f0-9]{32}$/);
});

test("outcome-unknown lifecycle and note retries survive interleaved intents", async ({
  page,
}) => {
  let status = "submitted";
  let version = 2;
  let logicalMutations = 0;
  const notes: {
    actor: { displayName: string; id: string };
    body: string;
    createdAt: string;
    id: string;
    version: number;
  }[] = [];
  const requests: Record<string, unknown>[] = [];
  const receipts = new Map<
    string,
    {
      command: Record<string, unknown>;
      result: Record<string, unknown>;
    }
  >();

  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      get: () => "__Host-opensession-csrf=csrf-token",
    });
  });
  await page.route(
    "**/api/events/ai-engineer-summit/submissions/**",
    async (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        await route.fulfill({
          contentType: "application/json",
          json: { ...liveDetail(status, version), notes },
        });
        return;
      }

      const command = request.postDataJSON() as Record<string, unknown>;
      requests.push(command);
      const id = String(command.commandId);
      const receipt = receipts.get(id);
      if (receipt) {
        expect(command).toEqual(receipt.command);
        await route.fulfill({
          contentType: "application/json",
          json: {
            ok: true,
            result: { ...receipt.result, outcome: "replayed" },
          },
        });
        return;
      }

      if (command.type === "withdraw") {
        await route.fulfill({
          contentType: "application/json",
          json: {
            error: {
              actualVersion: version,
              code: "submission_version_conflict",
              expectedVersion: command.expectedVersion,
              message: "The submission changed.",
            },
            ok: false,
          },
          status: 409,
        });
        return;
      }

      logicalMutations += 1;
      status = command.type === "start_review" ? "in_review" : status;
      version += 1;
      const note =
        command.type === "add_note"
          ? {
              actor: { displayName: "Owen Organizer", id: "user_organizer" },
              body: String(command.body),
              createdAt: "2026-08-10T19:06:00.000Z",
              id: "note_outcome_unknown",
              version: 1,
            }
          : null;
      if (note) notes.push(note);
      receipts.set(id, {
        command,
        result: {
          appliedAt: "2026-08-10T19:06:00.000Z",
          commandId: id,
          note,
          outcome: "applied",
          projection: "durable",
          status,
          submissionId: "submission_alpha",
          version,
        },
      });
      await route.abort("failed");
    },
  );

  await page.goto(liveDetailPath);
  await page.getByRole("button", { name: "Move to review" }).click();
  const dialog = page.getByRole("dialog", { name: "Move to review" });
  await dialog
    .getByLabel("Reason for change")
    .fill("Eligibility check completed once.");
  await dialog.getByRole("button", { name: "Record change" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Confirmation was interrupted",
  );
  await dialog.getByRole("button", { name: "Record change" }).click();
  await expect(page.locator(".ui-toast")).toContainText("Status updated");

  const noteInput = page.getByLabel("Add an internal note");
  await noteInput.fill("Record this note exactly once.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Confirmation was interrupted",
  );
  await expect(noteInput).toHaveValue("Record this note exactly once.");

  await page.getByRole("button", { name: "Withdraw" }).click();
  const withdrawDialog = page.getByRole("dialog", {
    name: "Withdraw submission",
  });
  await withdrawDialog
    .getByLabel("Reason for change")
    .fill("This stale interleaved intent must not displace the note.");
  await withdrawDialog.getByRole("button", { name: "Record change" }).click();
  await expect(page.getByRole("alert")).toContainText("The submission changed");
  await withdrawDialog.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Add note" }).click();
  await expect(
    page.locator(".ui-toast").filter({ hasText: "Internal note added" }),
  ).toBeVisible();

  expect(requests).toHaveLength(5);
  expect(requests[0]).toMatchObject({
    expectedVersion: 2,
    reason: "Eligibility check completed once.",
    submissionId: "submission_alpha",
    type: "start_review",
  });
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[2]).toMatchObject({
    body: "Record this note exactly once.",
    expectedVersion: 3,
    submissionId: "submission_alpha",
    type: "add_note",
  });
  expect(requests[3]).toMatchObject({
    expectedVersion: 3,
    reason: "This stale interleaved intent must not displace the note.",
    submissionId: "submission_alpha",
    type: "withdraw",
  });
  expect(requests[4]).toEqual(requests[2]);
  expect(requests[2]?.commandId).not.toBe(requests[0]?.commandId);
  expect(logicalMutations).toBe(2);
});

test("a live version conflict preserves the organizer reason for recovery", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      get: () => "__Host-opensession-csrf=csrf-token",
    });
  });
  await page.route(
    "**/api/events/ai-engineer-summit/submissions/**",
    async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          contentType: "application/json",
          json: {
            error: {
              actualVersion: 3,
              code: "submission_version_conflict",
              expectedVersion: 2,
              message: "The submission changed.",
            },
            ok: false,
          },
          status: 409,
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        json: liveDetail(),
      });
    },
  );

  await page.goto(liveDetailPath);
  await page.getByRole("button", { name: "Move to review" }).click();
  const dialog = page.getByRole("dialog", { name: "Move to review" });
  const reason = dialog.getByLabel("Reason for change");
  await reason.fill("Keep this explanation while I refresh.");
  await dialog.getByRole("button", { name: "Record change" }).click();

  await expect(dialog).toBeVisible();
  await expect(reason).toHaveValue("Keep this explanation while I refresh.");
  await expect(page.getByRole("alert")).toContainText(
    "Someone changed this submission after you opened it",
  );
});
