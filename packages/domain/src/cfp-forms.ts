import {
  validateCfpRules,
  type CfpConditionalRule,
  type CfpRuleDiagnosticCode,
  type CfpRuleFieldType,
} from "./cfp-rules.js";

export type CfpFormDiagnosticCode =
  | CfpRuleDiagnosticCode
  | "duplicate_field_id"
  | "duplicate_option"
  | "duplicate_rule_id"
  | "empty_options"
  | "invalid_options"
  | "invalid_order"
  | "invalid_validation"
  | "too_many_rules";

export interface CfpFormDiagnostic {
  code: CfpFormDiagnosticCode;
  fieldId?: string;
  fieldKey?: string;
  message: string;
  path: string;
  ruleId?: string;
}

export interface CfpFormFieldDefinition {
  helpText: string;
  id: string;
  key: string;
  label: string;
  options: readonly string[];
  order: number;
  required: boolean;
  rules: readonly CfpConditionalRule[];
  type: CfpRuleFieldType;
  validation: {
    maxLength?: number | undefined;
    minLength?: number | undefined;
  };
}

export interface CfpFormVersionState {
  status: "closed" | "draft" | "published";
  version: number;
}

function diagnostic(
  field: CfpFormFieldDefinition,
  code: CfpFormDiagnostic["code"],
  message: string,
  suffix: string,
): CfpFormDiagnostic {
  return {
    code,
    fieldId: field.id,
    fieldKey: field.key,
    message,
    path: `fields.${field.id}.${suffix}`,
  };
}

export function validateCfpForm(
  fields: readonly CfpFormFieldDefinition[],
): CfpFormDiagnostic[] {
  const diagnostics: CfpFormDiagnostic[] = validateCfpRules(fields).map(
    (issue) => {
      const field = fields.find(
        (candidate) => candidate.key === issue.fieldKey,
      );
      return {
        code: issue.code,
        ...(field ? { fieldId: field.id } : {}),
        fieldKey: issue.fieldKey,
        message: issue.message,
        path: issue.ruleId
          ? `fields.${field?.id ?? issue.fieldKey}.rules.${issue.ruleId}`
          : `fields.${field?.id ?? issue.fieldKey}`,
        ...(issue.ruleId ? { ruleId: issue.ruleId } : {}),
      };
    },
  );
  const fieldIds = new Set<string>();
  const ruleIds = new Set<string>();
  const orders = new Set<number>();
  const ruleCount = fields.reduce(
    (count, field) => count + field.rules.length,
    0,
  );
  if (ruleCount > 256) {
    diagnostics.push({
      code: "too_many_rules",
      message: "A CFP form can contain at most 256 conditional rules.",
      path: "fields",
    });
  }

  for (const field of fields) {
    if (fieldIds.has(field.id)) {
      diagnostics.push(
        diagnostic(
          field,
          "duplicate_field_id",
          `${field.label} reuses another field identifier.`,
          "id",
        ),
      );
    }
    fieldIds.add(field.id);

    if (
      !Number.isInteger(field.order) ||
      field.order < 1 ||
      orders.has(field.order) ||
      field.order > fields.length
    ) {
      diagnostics.push(
        diagnostic(
          field,
          "invalid_order",
          `${field.label} must have one unique position in the form.`,
          "order",
        ),
      );
    }
    orders.add(field.order);

    const isChoice =
      field.type === "single_select" || field.type === "multi_select";
    if (isChoice && field.options.length === 0) {
      diagnostics.push(
        diagnostic(
          field,
          "empty_options",
          `${field.label} needs at least one choice.`,
          "options",
        ),
      );
    }
    if (!isChoice && field.options.length > 0) {
      diagnostics.push(
        diagnostic(
          field,
          "invalid_options",
          `${field.label} cannot define choices for its field type.`,
          "options",
        ),
      );
    }
    const normalizedOptions = field.options.map((option) =>
      option.toLocaleLowerCase("en-US"),
    );
    if (new Set(normalizedOptions).size !== normalizedOptions.length) {
      diagnostics.push(
        diagnostic(
          field,
          "duplicate_option",
          `${field.label} contains the same choice more than once.`,
          "options",
        ),
      );
    }

    const supportsLength =
      field.type === "short_text" ||
      field.type === "long_text" ||
      field.type === "url";
    const { maxLength, minLength } = field.validation;
    const invalidLength =
      (maxLength !== undefined &&
        (!Number.isInteger(maxLength) ||
          maxLength < 1 ||
          maxLength > 20_000)) ||
      (minLength !== undefined &&
        (!Number.isInteger(minLength) ||
          minLength < 0 ||
          minLength > 20_000)) ||
      (maxLength !== undefined &&
        minLength !== undefined &&
        minLength > maxLength);
    if (
      (!supportsLength && Object.keys(field.validation).length > 0) ||
      invalidLength
    ) {
      diagnostics.push(
        diagnostic(
          field,
          "invalid_validation",
          `${field.label} cannot use text-length validation.`,
          "validation",
        ),
      );
    }

    for (const rule of field.rules) {
      if (ruleIds.has(rule.id)) {
        diagnostics.push({
          ...diagnostic(
            field,
            "duplicate_rule_id",
            `${field.label} reuses another conditional rule identifier.`,
            `rules.${rule.id}`,
          ),
          ruleId: rule.id,
        });
      }
      ruleIds.add(rule.id);
    }
  }

  return diagnostics
    .sort((left, right) =>
      left.path === right.path
        ? left.code.localeCompare(right.code)
        : left.path.localeCompare(right.path),
    )
    .slice(0, 512);
}

export function nextCfpDraftVersion(
  forms: readonly CfpFormVersionState[],
): number {
  return Math.max(0, ...forms.map((form) => form.version)) + 1;
}

export function assertCfpFormTransition(
  current: CfpFormVersionState["status"],
  next: CfpFormVersionState["status"] | "archived",
): void {
  const allowed: Readonly<
    Record<CfpFormVersionState["status"], readonly string[]>
  > = {
    closed: [],
    draft: ["archived", "published"],
    published: ["closed"],
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`CFP form state cannot change from ${current} to ${next}.`);
  }
}
