import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import type { TaskAssignmentDetail } from "@sessionbox-killer/contracts/tasks";

import { mockPortalAuth } from "./portal-auth";

const portalPath = "/fixtures/portal/active";
const speakerTaskPath = "/fixtures/portal-task/default";
const organizerTaskPath = "/fixtures/organizer-task/default";

test.beforeEach(async ({ page }) => mockPortalAuth(page));

function productionFormTaskDetail({
  canReview,
  state,
  value,
  version,
}: {
  canReview: boolean;
  state: TaskAssignmentDetail["assignment"]["state"];
  value: string | null;
  version: number;
}): TaskAssignmentDetail {
  return {
    assignment: {
      approval_required: true,
      assignment_id: "assignment_conflict",
      contact_id: "contact_speaker",
      definition_id: "definition_conflict",
      due_at: null,
      event_id: "event_conflict",
      history: [],
      required: true,
      session_id: null,
      state,
      version,
    },
    current_response:
      value === null
        ? null
        : {
            answers: [{ field_id: "biography", value }],
            kind: "form",
          },
    definition: {
      approval_required: true,
      configuration: {
        fields: [
          {
            help_text: "Confirm the biography that will be published.",
            id: "biography",
            label: "Biography confirmation",
            options: [],
            required: true,
            type: "text",
          },
        ],
        kind: "form",
      },
      description: "Confirm the current public biography.",
      due: null,
      event_id: "event_conflict",
      id: "definition_conflict",
      name: "Confirm biography",
      required: true,
      target: {
        assignment_scope: "contact",
        contact: {
          exclude_contact_ids: [],
          include_contact_ids: [],
          roles: ["speaker"],
        },
        session: null,
      },
      version: 1,
    },
    event: {
      id: "event_conflict",
      name: "Conflict Summit",
      slug: "conflict-summit",
      timezone: "UTC",
    },
    files: [],
    generated_at: "2026-08-11T08:00:00.000Z",
    organization_id: "organization_conflict",
    overdue: false,
    permissions: { can_review: canReview, can_submit: !canReview },
    readiness: {
      configuration: "configured",
      explanation: "One required response remains.",
      next_due: null,
      outstanding_count: 1,
      overdue_count: 0,
      ratio: { complete: 0, percent: 0, total: 1 },
      status: "outstanding",
    },
    response_history: [],
    session: null,
    speaker: {
      contact_id: "contact_speaker",
      display_name: "Sam Speaker",
      email: "sam@example.test",
    },
  };
}

function mutationResponse(
  detail: TaskAssignmentDetail,
  action: "tasks.assignment.review" | "tasks.assignment.submit",
) {
  return {
    ok: true,
    repair_pending: false,
    replayed: false,
    result: {
      audit: {
        action,
        id: `audit_${action.split(".").at(-1)}`,
        recorded_at: "2026-08-11T08:05:00.000Z",
      },
      detail,
    },
  };
}

test("speaker can reach a complete task brief without exposing event task data in the profile", async ({
  page,
}) => {
  await page.goto(portalPath);

  await expect(
    page.getByText("Final presentation", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review submission" }).click();
  await expect(page).toHaveURL(speakerTaskPath);
  await expect(
    page.getByRole("heading", { name: "Upload your final presentation" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Tasks 3/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText("Program-team approval required")).toBeVisible();
  await expect(page.getByText("Required", { exact: true })).toBeVisible();
  await expect(
    page.locator(".task-brief").getByText(/Overdue by 2 days · due August 7/),
  ).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include(".task-completion")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("speaker file replacement validates input and preserves version history", async ({
  page,
}) => {
  await page.goto(speakerTaskPath);
  await page.getByRole("button", { name: "Replace file" }).click();

  await page.locator("#task-file-input").setInputFiles({
    buffer: Buffer.from("not a presentation"),
    mimeType: "application/octet-stream",
    name: "unsafe-deck.exe",
  });
  await expect(page.getByRole("alert")).toContainText(
    "Choose a PDF or PPTX file.",
  );

  await page.locator("#task-file-input").setInputFiles({
    buffer: Buffer.from("renamed executable"),
    mimeType: "application/octet-stream",
    name: "renamed-deck.pdf",
  });
  await expect(page.getByRole("alert")).toContainText(
    "The file type does not match its PDF or PPTX extension.",
  );

  await page.locator("#task-file-input").evaluate((input) => {
    const oversizedFile = new File(
      ["oversized fixture"],
      "oversized-deck.pdf",
      {
        type: "application/pdf",
      },
    );
    Object.defineProperty(oversizedFile, "size", {
      value: 50 * 1024 * 1024 + 1,
    });
    const transfer = new DataTransfer();
    transfer.items.add(oversizedFile);
    Object.defineProperty(input, "files", {
      configurable: true,
      value: transfer.files,
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.getByRole("alert")).toContainText(
    "Choose a file smaller than 50 MB.",
  );
  await page
    .locator("#task-file-input")
    .evaluate((input) => Reflect.deleteProperty(input, "files"));

  await page.locator("#task-file-input").setInputFiles({
    buffer: Buffer.from("pptx fixture"),
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    name: "mina-production-agents-v4.pptx",
  });
  await expect(page.getByText("Ready to upload")).toBeVisible();

  await page.getByRole("checkbox").uncheck();
  await expect(
    page.getByRole("button", { name: "Submit replacement" }),
  ).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Submit replacement" }).click();

  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Version 4 is waiting for review" }),
  ).toBeVisible({ timeout: 3_000 });
  await expect(page.locator(".task-version-history")).toContainText(
    "Version 4 · current",
  );
  await expect(page.locator(".task-version-history")).toContainText(
    "Version 3 · replaced",
  );
});

test("failed processing recovery is fixture-only and does not require reupload", async ({
  page,
}) => {
  await page.goto(`${speakerTaskPath}?state=failed`);
  await expect(
    page.getByRole("heading", { name: "Version 3 is waiting for review" }),
  ).toBeVisible();
  await expect(page.getByText("processing did not finish")).toHaveCount(0);

  await page.goto("/fixtures/portal-task/failed");
  await expect(page.getByRole("alert")).toContainText(
    "processing did not finish",
  );
  await expect(page.getByText("mina-production-agents-v4.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Retry processing" }).click();
  await expect(
    page.getByRole("heading", { name: "Version 4 is waiting for review" }),
  ).toBeVisible({ timeout: 2_500 });
});

test("organizer approval updates readiness and audit state without a reload", async ({
  page,
}) => {
  await page.goto(organizerTaskPath);

  const workspace = page.locator(".task-completion");
  await expect(workspace).toContainText("mina-production-agents-v3.pdf");
  await expect(workspace).toContainText("Security scan");
  await expect(workspace).not.toContainText("r2://");
  await expect(workspace).not.toContainText("sessionbox-killer-uploads");

  await page.getByRole("button", { name: "Approve version 3" }).click();
  await expect(
    page.locator(".organizer-task-summary").filter({
      hasText: "Speaker readiness",
    }),
  ).toContainText("5 / 5");
  await expect(
    page.getByRole("heading", { name: "Presentation approved" }),
  ).toBeVisible();
  await expect(page.locator(".ui-toast")).toContainText(
    "readiness view updated immediately",
  );
  await expect(page.locator(".organizer-audit")).toContainText(
    "Version approved",
  );
});

test("organizer rejection requires and records a reason", async ({ page }) => {
  await page.goto(organizerTaskPath);
  await page.getByRole("button", { name: "Request changes" }).click();
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(
    page.getByText("Explain what Mina needs to change."),
  ).toBeVisible();

  await page
    .getByLabel("Reason for requesting changes")
    .fill("Please embed the demo video and export the deck again.");
  await page.getByRole("button", { name: "Send request" }).click();

  await expect(
    page.getByRole("heading", { name: "Replacement requested" }),
  ).toBeVisible();
  await expect(page.getByText(/Please embed the demo video/)).toBeVisible();
  await expect(page.locator(".ui-toast")).toContainText(
    "Readiness remains 4 of 5",
  );
  await expect(page.locator(".organizer-audit")).toContainText(
    "Changes requested",
  );
});

test("non-file version conflicts load the latest response before explicit resubmission", async ({
  page,
}) => {
  const initial = productionFormTaskDetail({
    canReview: false,
    state: "incomplete",
    value: null,
    version: 1,
  });
  const refreshed = productionFormTaskDetail({
    canReview: false,
    state: "rejected",
    value: "Latest response from another session",
    version: 2,
  });
  const committed = productionFormTaskDetail({
    canReview: false,
    state: "submitted",
    value: "Reviewed response",
    version: 3,
  });
  const submissions: Record<string, unknown>[] = [];
  let detailReads = 0;
  await page.route(
    "**/api/events/conflict-summit/task-assignments/assignment_conflict",
    async (route) => {
      detailReads += 1;
      await route.fulfill({ json: detailReads === 1 ? initial : refreshed });
    },
  );
  await page.route(
    "**/api/events/conflict-summit/task-assignments/assignment_conflict/submissions",
    async (route) => {
      submissions.push(route.request().postDataJSON());
      await route.fulfill(
        submissions.length === 1
          ? {
              json: {
                error: {
                  code: "task_version_conflict",
                  message:
                    "The task changed before this response was recorded.",
                },
              },
              status: 409,
            }
          : { json: mutationResponse(committed, "tasks.assignment.submit") },
      );
    },
  );

  await page.goto("/portal/conflict-summit/tasks/assignment_conflict");
  const biography = page.getByLabel("Biography confirmation");
  await biography.fill("My stale edit");
  await page.getByRole("button", { name: "Save response" }).click();
  await expect(biography).toHaveValue("Latest response from another session");
  await expect(page.getByText(/The latest response is loaded/)).toBeVisible();
  expect(submissions).toHaveLength(1);

  await biography.fill("Reviewed response");
  await page.getByRole("button", { name: "Save response" }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[0]?.expected_version).toBe(1);
  expect(submissions[1]?.expected_version).toBe(2);
  expect(submissions[1]?.command_id).not.toBe(submissions[0]?.command_id);
});

test("organizer version conflicts refresh and require a new reviewed decision", async ({
  page,
}) => {
  const initial = productionFormTaskDetail({
    canReview: true,
    state: "submitted",
    value: "First submitted response",
    version: 2,
  });
  const refreshed = productionFormTaskDetail({
    canReview: true,
    state: "submitted",
    value: "New response from the speaker",
    version: 3,
  });
  const approved = productionFormTaskDetail({
    canReview: true,
    state: "approved",
    value: "New response from the speaker",
    version: 4,
  });
  const reviews: Record<string, unknown>[] = [];
  let detailReads = 0;
  await page.route(
    "**/api/events/conflict-summit/task-assignments/assignment_conflict",
    async (route) => {
      detailReads += 1;
      await route.fulfill({ json: detailReads === 1 ? initial : refreshed });
    },
  );
  await page.route(
    "**/api/events/conflict-summit/task-assignments/assignment_conflict/reviews",
    async (route) => {
      reviews.push(route.request().postDataJSON());
      await route.fulfill(
        reviews.length === 1
          ? {
              json: {
                error: {
                  code: "task_version_conflict",
                  message: "The task changed during review.",
                },
              },
              status: 409,
            }
          : { json: mutationResponse(approved, "tasks.assignment.review") },
      );
    },
  );

  await page.goto(
    "/app/conflict-summit/people/sam-speaker/tasks/assignment_conflict",
  );
  await page.getByRole("button", { name: "Approve response" }).click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Decision reason")
    .fill("Approve the first response.");
  await dialog.getByRole("button", { name: "Approve response" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText(
    "The latest response is loaded",
  );
  await expect(page.getByText("New response from the speaker")).toBeVisible();
  expect(reviews).toHaveLength(1);

  await page.getByRole("button", { name: "Approve response" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Decision reason")).toHaveValue("");
  await dialog
    .getByLabel("Decision reason")
    .fill("Reviewed and approved the latest response.");
  await dialog.getByRole("button", { name: "Approve response" }).click();
  await expect.poll(() => reviews.length).toBe(2);
  expect(reviews[0]?.expected_version).toBe(2);
  expect(reviews[1]?.expected_version).toBe(3);
  expect(reviews[1]?.command_id).not.toBe(reviews[0]?.command_id);
});

test("speaker and organizer task workspaces remain contained at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });

  for (const path of [speakerTaskPath, organizerTaskPath]) {
    await page.goto(path);
    await expect(page.locator(".task-completion")).toBeVisible();
    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

    const results = await new AxeBuilder({ page })
      .include(".task-completion")
      .analyze();
    expect(results.violations).toEqual([]);
  }
});
