export type CfpBlockType =
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

export const cfpBuilderFixture: CfpBuilderView = {
  blocks: [
    {
      help: "Set expectations before applicants begin.",
      id: "block-introduction",
      key: "proposal_details",
      label: "Proposal details",
      required: false,
      type: "section",
      visibility: "always",
    },
    {
      help: "Make it concise and specific. You can refine this later.",
      id: "block-title",
      key: "session_title",
      label: "Session title",
      maxLength: 100,
      minLength: 8,
      required: true,
      type: "short_text",
      visibility: "always",
    },
    {
      help: "What will attendees learn, and why does it matter now?",
      id: "block-abstract",
      key: "session_abstract",
      label: "Session abstract",
      maxLength: 1200,
      minLength: 120,
      required: true,
      type: "long_text",
      visibility: "always",
    },
    {
      help: "Choose the format that best supports this material.",
      id: "block-format",
      key: "session_format",
      label: "Session format",
      options: ["Talk", "Workshop", "Panel"],
      required: true,
      type: "single_select",
      visibility: "always",
    },
    {
      help: "List software, accounts, or experience attendees should bring.",
      id: "block-prerequisites",
      key: "workshop_prerequisites",
      label: "Workshop prerequisites",
      maxLength: 600,
      minLength: 20,
      required: false,
      rules: [
        {
          effect: "show",
          id: "rule-prerequisites-show",
          operator: "equals",
          sourceKey: "session_format",
          value: "Workshop",
        },
        {
          effect: "require",
          id: "rule-prerequisites-require",
          operator: "equals",
          sourceKey: "session_format",
          value: "Workshop",
        },
      ],
      type: "long_text",
      visibility: "conditional",
    },
    {
      help: "Share a representative talk, article, or project.",
      id: "block-reference",
      key: "supporting_url",
      label: "Supporting link",
      required: false,
      type: "url",
      visibility: "always",
    },
  ],
  closesAt: "August 12 at 11:59 PM",
  draftVersion: 2,
  eventName: "AI Engineer Summit",
  formName: "Call for proposals",
  publicUrl: "opensession.dev/e/ai-engineer-summit/cfp",
  publishedVersion: 1,
  status: "draft",
  timezone: "America/Los_Angeles",
};

export const cfpBlockLabels: Record<CfpBlockType, string> = {
  file: "File upload",
  long_text: "Long answer",
  multi_select: "Multiple choice",
  section: "Section intro",
  short_text: "Short answer",
  single_select: "Single choice",
  url: "URL",
};
import type { CfpConditionalRule } from "@sessionbox-killer/domain";
