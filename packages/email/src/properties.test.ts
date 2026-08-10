import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  activateEmailTemplate,
  analyzeEmailTemplate,
  createCampaignMessageKey,
  createEmailTemplateRevision,
  createSeedEmailTemplates,
  emailMergeFieldDefinitions,
  EmailTemplateValidationError,
  renderEmailTemplate,
  serializeEmailTemplateSnapshot,
  snapshotEmailTemplate,
  type EmailMergeFieldName,
  type EmailTemplate,
} from "./index.js";

const createdAt = "2026-08-09T21:00:00.000Z";
const revisionAt = "2026-08-09T21:01:00.000Z";
const activationAt = "2026-08-09T21:02:00.000Z";

function baseTemplate(): EmailTemplate {
  const template = createSeedEmailTemplates({
    createdAt,
    eventId: "event_property",
    replyTo: "hello@example.test",
    sender: {
      address: "updates@example.test",
      name: "OpenSession",
    },
  })[0];
  if (!template) throw new TypeError("Seed template is required.");
  return template;
}

function paragraphTemplate(
  text: string,
  allowedMergeFields: readonly EmailMergeFieldName[] = ["recipient.full_name"],
): EmailTemplate {
  return {
    ...baseTemplate(),
    allowedMergeFields,
    body: {
      blocks: [{ text, type: "paragraph" }],
      previewText: "Property test",
    },
    id: "template_property",
    internalName: "Property test",
    subject: "Property test",
  };
}

function referenceHtmlText(value: string): string {
  return [...value]
    .map((character) => {
      if (character === "&") return "&amp;";
      if (character === "<") return "&lt;";
      if (character === ">") return "&gt;";
      if (character === '"') return "&quot;";
      if (character === "'") return "&#39;";
      if (character === "\n") return "<br>";
      return character;
    })
    .join("");
}

const safeMergeText = fc
  .string({ maxLength: 256 })
  .filter((value) => !/[\0\r]/u.test(value));
const stableId = fc.stringMatching(/^[a-z][a-z0-9_-]{2,32}$/);

describe("email domain properties", () => {
  it("round-trips arbitrary safe merge text without creating HTML markup", () => {
    fc.assert(
      fc.property(safeMergeText, (value) => {
        const rendered = renderEmailTemplate(
          paragraphTemplate("{{recipient.full_name}}"),
          {
            "recipient.full_name": { type: "text", value },
          },
        );

        expect(rendered.text).toBe(`${value}\n\nSent by OpenSession.`);
        expect(rendered.html).toContain(`${referenceHtmlText(value)}</p>`);
        expect(rendered.usedFields).toEqual(["recipient.full_name"]);
      }),
      { numRuns: 200, seed: 0x4f50454e },
    );
  });

  it("fails closed for arbitrary token-shaped fields outside the registry", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9]{1,24}$/), (suffix) => {
        const field = `custom.${suffix}`;
        expect(Object.hasOwn(emailMergeFieldDefinitions, field)).toBe(false);

        const template = paragraphTemplate(`{{${field}}}`, []);
        const analysis = analyzeEmailTemplate(template);
        expect(analysis.valid).toBe(false);
        expect(analysis.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "unknown_field",
              location: "body.blocks[0].text",
            }),
          ]),
        );
        expect(() => renderEmailTemplate(template, {})).toThrow(
          EmailTemplateValidationError,
        );
      }),
      { numRuns: 200, seed: 0x52554c45 },
    );
  });

  it("increments arbitrary valid versions and preserves immutable snapshots", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,39}$/),
        (version, internalName) => {
          const current: EmailTemplate = {
            ...baseTemplate(),
            version,
          };
          const revision = createEmailTemplateRevision(
            current,
            { internalName },
            revisionAt,
          );
          const active = activateEmailTemplate(revision, activationAt);
          const snapshot = snapshotEmailTemplate(active);

          expect(current.version).toBe(version);
          expect(revision).toMatchObject({
            internalName,
            status: "draft",
            version: version + 1,
          });
          expect(active).toMatchObject({
            status: "active",
            version: version + 2,
          });
          expect(Object.isFrozen(snapshot)).toBe(true);
          expect(Object.isFrozen(snapshot.body)).toBe(true);
          expect(Object.isFrozen(snapshot.body.blocks)).toBe(true);
          expect(
            snapshot.body.blocks.every((block) => Object.isFrozen(block)),
          ).toBe(true);
          expect(Object.isFrozen(snapshot.sender)).toBe(true);
          expect(Object.isFrozen(snapshot.allowedMergeFields)).toBe(true);
          expect(JSON.parse(serializeEmailTemplateSnapshot(active))).toEqual(
            active,
          );
        },
      ),
      { numRuns: 200, seed: 0x56455253 },
    );
  });

  it("binds every arbitrary message identity dimension deterministically", async () => {
    await fc.assert(
      fc.asyncProperty(
        stableId,
        stableId,
        stableId,
        fc.integer({ min: 1, max: 1_000_000 }),
        async (campaignId, contactId, templateId, templateVersion) => {
          const input = {
            campaignId,
            contactId,
            templateId,
            templateVersion,
          };
          const original = await createCampaignMessageKey(input);
          const repeated = await createCampaignMessageKey(input);
          const variants = await Promise.all([
            createCampaignMessageKey({
              ...input,
              campaignId: `${campaignId}_x`,
            }),
            createCampaignMessageKey({
              ...input,
              contactId: `${contactId}_x`,
            }),
            createCampaignMessageKey({
              ...input,
              templateId: `${templateId}_x`,
            }),
            createCampaignMessageKey({
              ...input,
              templateVersion: templateVersion + 1,
            }),
          ]);

          expect(original).toMatch(/^email_[a-f\d]{64}$/);
          expect(repeated).toBe(original);
          expect(new Set([original, ...variants])).toHaveLength(5);
        },
      ),
      { numRuns: 200, seed: 0x4944454d },
    );
  });
});
