export type CfpRuleEffect = "require" | "show";

export type CfpRuleOperator = "equals" | "includes";

export type CfpRuleFieldType =
  | "checkbox"
  | "file"
  | "long_text"
  | "multi_select"
  | "participant"
  | "section"
  | "short_text"
  | "single_select"
  | "url";

export interface CfpConditionalRule {
  effect: CfpRuleEffect;
  id: string;
  operator: CfpRuleOperator;
  sourceKey: string;
  value: string;
}

export interface CfpRuleField {
  key: string;
  label: string;
  options?: readonly string[];
  required: boolean;
  rules?: readonly CfpConditionalRule[];
  type: CfpRuleFieldType;
}

export interface CfpRuleFieldState {
  key: string;
  required: boolean;
  visible: boolean;
}

export interface CfpRuleEvaluation {
  answers: Record<string, unknown>;
  clearedKeys: string[];
  fields: CfpRuleFieldState[];
}

export type CfpRuleDiagnosticCode =
  | "cyclic_reference"
  | "duplicate_key"
  | "forward_reference"
  | "invalid_operator"
  | "missing_option"
  | "missing_source"
  | "required_section"
  | "source_not_choice";

export interface CfpRuleDiagnostic {
  code: CfpRuleDiagnosticCode;
  fieldKey: string;
  message: string;
  ruleId?: string;
}

export interface CfpTrackRoute {
  aliases?: readonly string[];
  defaultReviewerGroupId: string;
  routeKey: string;
  selection: string;
  submissionTrack: string;
}

function ruleMatches(rule: CfpConditionalRule, answer: unknown) {
  if (rule.operator === "equals") {
    return typeof answer === "string" && answer === rule.value;
  }

  return (
    Array.isArray(answer) &&
    answer.some((value) => typeof value === "string" && value === rule.value)
  );
}

export function evaluateCfpRules(
  fields: readonly CfpRuleField[],
  answers: Readonly<Record<string, unknown>>,
): CfpRuleEvaluation {
  let sanitizedAnswers = { ...answers };
  const clearedKeys: string[] = [];
  const evaluatedFields: CfpRuleFieldState[] = [];

  for (const field of fields) {
    const rules = field.rules ?? [];
    const showRules = rules.filter((rule) => rule.effect === "show");
    const requireRules = rules.filter((rule) => rule.effect === "require");
    const visible =
      showRules.length === 0 ||
      showRules.every((rule) =>
        ruleMatches(rule, sanitizedAnswers[rule.sourceKey]),
      );
    const required =
      visible &&
      (field.required ||
        requireRules.some((rule) =>
          ruleMatches(rule, sanitizedAnswers[rule.sourceKey]),
        ));

    if (!visible && Object.hasOwn(sanitizedAnswers, field.key)) {
      sanitizedAnswers = Object.fromEntries(
        Object.entries(sanitizedAnswers).filter(([key]) => key !== field.key),
      );
      clearedKeys.push(field.key);
    }

    evaluatedFields.push({ key: field.key, required, visible });
  }

  return {
    answers: sanitizedAnswers,
    clearedKeys,
    fields: evaluatedFields,
  };
}

export function visibleFieldTransitions(
  previous: readonly CfpRuleFieldState[],
  next: readonly CfpRuleFieldState[],
) {
  const previousByKey = new Map(
    previous.map((field) => [field.key, field.visible]),
  );

  return next
    .filter(
      (field) =>
        previousByKey.has(field.key) &&
        previousByKey.get(field.key) !== field.visible,
    )
    .map((field) => ({ key: field.key, visible: field.visible }));
}

function cycleDiagnostics(fields: readonly CfpRuleField[]) {
  const fieldByKey = new Map(fields.map((field) => [field.key, field]));
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const diagnostics: CfpRuleDiagnostic[] = [];
  const reportedCycles = new Set<string>();

  function visit(key: string) {
    if (visited.has(key)) return;
    active.add(key);
    stack.push(key);

    const field = fieldByKey.get(key);
    for (const rule of field?.rules ?? []) {
      if (!fieldByKey.has(rule.sourceKey)) continue;
      if (active.has(rule.sourceKey)) {
        const cycleStart = stack.indexOf(rule.sourceKey);
        const cycle = [...stack.slice(cycleStart), rule.sourceKey];
        const signature = [...new Set(cycle)].sort().join("|");
        if (!reportedCycles.has(signature)) {
          reportedCycles.add(signature);
          diagnostics.push({
            code: "cyclic_reference",
            fieldKey: key,
            message: `Conditional rules contain a cycle: ${cycle.join(" → ")}. Rules may only reference an earlier field.`,
            ruleId: rule.id,
          });
        }
      } else {
        visit(rule.sourceKey);
      }
    }

    stack.pop();
    active.delete(key);
    visited.add(key);
  }

  for (const field of fields) visit(field.key);
  return diagnostics;
}

export function validateCfpRules(fields: readonly CfpRuleField[]) {
  const diagnostics: CfpRuleDiagnostic[] = [];
  const firstIndexByKey = new Map<string, number>();

  fields.forEach((field, index) => {
    if (firstIndexByKey.has(field.key)) {
      diagnostics.push({
        code: "duplicate_key",
        fieldKey: field.key,
        message: `Stable key “${field.key}” is used more than once. Every field needs a unique key.`,
      });
      return;
    }
    firstIndexByKey.set(field.key, index);
  });

  fields.forEach((field, fieldIndex) => {
    for (const rule of field.rules ?? []) {
      const sourceIndex = firstIndexByKey.get(rule.sourceKey);
      const source =
        sourceIndex === undefined ? undefined : fields[sourceIndex];

      if (sourceIndex === undefined || !source) {
        diagnostics.push({
          code: "missing_source",
          fieldKey: field.key,
          message: `“${field.label}” references deleted field “${rule.sourceKey}”. Choose an existing earlier choice field or remove the rule.`,
          ruleId: rule.id,
        });
        continue;
      }

      if (sourceIndex >= fieldIndex) {
        diagnostics.push({
          code: "forward_reference",
          fieldKey: field.key,
          message: `“${field.label}” references “${source.label}” at a later position. Move the choice field before this field or remove the rule.`,
          ruleId: rule.id,
        });
      }

      const expectedOperator =
        source.type === "single_select"
          ? "equals"
          : source.type === "multi_select"
            ? "includes"
            : null;
      if (!expectedOperator) {
        diagnostics.push({
          code: "source_not_choice",
          fieldKey: field.key,
          message: `“${field.label}” references “${source.label}”, but conditions require a single-choice or multiple-choice source field.`,
          ruleId: rule.id,
        });
        continue;
      }

      if (rule.operator !== expectedOperator) {
        diagnostics.push({
          code: "invalid_operator",
          fieldKey: field.key,
          message: `“${field.label}” must use “${expectedOperator}” with ${source.type === "single_select" ? "single-choice" : "multiple-choice"} field “${source.label}”.`,
          ruleId: rule.id,
        });
      }

      if (!(source.options ?? []).includes(rule.value)) {
        diagnostics.push({
          code: "missing_option",
          fieldKey: field.key,
          message: `“${field.label}” checks removed option “${rule.value}” on “${source.label}”. Choose a current option before publishing.`,
          ruleId: rule.id,
        });
      }

      if (rule.effect === "require" && field.type === "section") {
        diagnostics.push({
          code: "required_section",
          fieldKey: field.key,
          message: `Section “${field.label}” cannot be required. Change the rule to show the section or remove it.`,
          ruleId: rule.id,
        });
      }
    }
  });

  return [...cycleDiagnostics(fields), ...diagnostics];
}

export function resolveCfpTrackRoute(
  routes: readonly CfpTrackRoute[],
  selection: string,
) {
  const normalizedSelection = selection.trim().toLocaleLowerCase("en-US");
  return (
    routes.find((route) =>
      [route.selection, ...(route.aliases ?? [])].some(
        (candidate) =>
          candidate.trim().toLocaleLowerCase("en-US") === normalizedSelection,
      ),
    ) ?? null
  );
}
