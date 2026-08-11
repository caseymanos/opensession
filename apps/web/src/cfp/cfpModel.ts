import type {
  OrganizerCfpForm,
  OrganizerCfpFormReadResponse,
} from "@sessionbox-killer/contracts";
import type { CfpConditionalRule } from "@sessionbox-killer/domain";

export type CfpBlockType =
  | "checkbox"
  | "section"
  | "short_text"
  | "long_text"
  | "url"
  | "single_select"
  | "multi_select"
  | "file";

export type CfpFormStatus = "draft" | "published" | "closed";

export interface CfpBlockView {
  help: string;
  id: string;
  key: string;
  label: string;
  maxLength?: number;
  minLength?: number;
  options?: string[];
  required: boolean;
  rules?: CfpConditionalRule[];
  type: CfpBlockType;
  visibility: "always" | "conditional";
}

export interface CfpBuilderView {
  blocks: CfpBlockView[];
  closesAt: string;
  draftVersion: number;
  eventName: string;
  formName: string;
  publicUrl: string;
  publishedVersion: number;
  status: CfpFormStatus;
  timezone: string;
}

export const cfpBlockLabels: Record<CfpBlockType, string> = {
  checkbox: "Confirmation checkbox",
  file: "File upload",
  long_text: "Long answer",
  multi_select: "Multiple choice",
  section: "Section intro",
  short_text: "Short answer",
  single_select: "Single choice",
  url: "URL",
};

const builderBlockTypes = new Set<CfpBlockType>([
  "checkbox",
  "file",
  "long_text",
  "multi_select",
  "section",
  "short_text",
  "single_select",
  "url",
]);

export function cfpBuilderBlocksFromForm(
  form: OrganizerCfpForm,
): CfpBlockView[] {
  return form.fields.map((field) => {
    if (!builderBlockTypes.has(field.type as CfpBlockType)) {
      throw new Error(
        `The ${field.type} field is not supported by this builder.`,
      );
    }
    return {
      help: field.helpText,
      id: field.id,
      key: field.key,
      label: field.label,
      ...(field.validation.maxLength === undefined
        ? {}
        : { maxLength: field.validation.maxLength }),
      ...(field.validation.minLength === undefined
        ? {}
        : { minLength: field.validation.minLength }),
      ...(field.options.length ? { options: [...field.options] } : {}),
      required: field.required,
      ...(field.rules.length ? { rules: [...field.rules] } : {}),
      type: field.type as CfpBlockType,
      visibility: field.rules.length ? "conditional" : "always",
    };
  });
}

export function cfpBuilderEditableForm(
  response: OrganizerCfpFormReadResponse,
  blocks: readonly CfpBlockView[],
) {
  return {
    editAfterClose: response.form.editAfterClose,
    fields: blocks.map((block, index) => ({
      helpText: block.help,
      id: block.id,
      key: block.key,
      label: block.label,
      options: block.options ?? [],
      order: index + 1,
      required: block.type === "section" ? false : block.required,
      rules: block.rules ?? [],
      type: block.type,
      validation: {
        ...(block.maxLength === undefined
          ? {}
          : { maxLength: block.maxLength }),
        ...(block.minLength === undefined
          ? {}
          : { minLength: block.minLength }),
      },
    })),
    name: response.form.name,
    submissionLimit: response.form.submissionLimit,
    welcomeContent: response.form.welcomeContent,
  };
}
