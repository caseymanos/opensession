import {
  protectedPublicCfpSubmissionRequestSchema,
  type ProtectedPublicCfpSubmissionRequest,
} from "@sessionbox-killer/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  requireCfpSubmissionCapacity,
  verifyCfpSubmissionChallenge,
} from "../src/cfp/routes";

const context = {} as Parameters<typeof requireCfpSubmissionCapacity>[0];

function submission(
  mode: "draft" | "submit",
): ProtectedPublicCfpSubmissionRequest {
  return protectedPublicCfpSubmissionRequestSchema.parse({
    answers: { title: "A bounded proposal" },
    form_version: 2,
    mode,
    ...(mode === "submit"
      ? {
          participant_consent: true,
          turnstile_action: "cfp_submit",
          turnstile_token: "fresh-final-submit-token",
        }
      : {}),
    participants: [
      {
        email: "speaker@example.test",
        id: "speaker-primary",
        name: "Speaker",
        role: "Engineer",
      },
    ],
  });
}

describe("public CFP route security hooks", () => {
  it.each([
    ["draft", "autosave"],
    ["submit", "submit"],
  ] as const)(
    "applies actor then event capacity for %s writes",
    async (mode, operation) => {
      const limiter = vi.fn().mockResolvedValue(null);
      await expect(
        requireCfpSubmissionCapacity(
          context,
          mode,
          "event_cfp",
          "user_cfp",
          "203.0.113.15",
          limiter,
        ),
      ).resolves.toBeNull();
      expect(limiter.mock.calls).toEqual([
        [context, operation, { identity: "user_cfp", ip: "203.0.113.15" }],
        [context, operation, { event: "event_cfp" }],
      ]);
    },
  );

  it("short-circuits before spending shared event capacity", async () => {
    const limited = new Response(null, { status: 429 });
    const limiter = vi.fn().mockResolvedValueOnce(limited);
    await expect(
      requireCfpSubmissionCapacity(
        context,
        "submit",
        "event_cfp",
        "user_cfp",
        null,
        limiter,
      ),
    ).resolves.toBe(limited);
    expect(limiter).toHaveBeenCalledOnce();
  });

  it("requires a fresh challenge only for final submit", async () => {
    const verifier = vi.fn().mockResolvedValue(undefined);
    await verifyCfpSubmissionChallenge(context, submission("draft"), verifier);
    expect(verifier).not.toHaveBeenCalled();

    await verifyCfpSubmissionChallenge(context, submission("submit"), verifier);
    expect(verifier).toHaveBeenCalledWith(
      context,
      "fresh-final-submit-token",
      "cfp_submit",
    );
  });
});
