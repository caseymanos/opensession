import {
  EMAIL_MERGE_SCHEMA_VERSION,
  emailMergeFieldDefinitions,
  type EmailMergeFieldName,
  type EmailMergeValue,
  type EmailMergeValues,
  type EmailTemplate,
  type EmailTemplateAnalysis,
  type EmailTemplateIssue,
} from "./types.js";

interface Segment {
  readonly field?: EmailMergeFieldName;
  readonly literal?: string;
}

interface TemplateSlot {
  readonly location: string;
  readonly value: string;
}

interface CompiledTemplate {
  readonly issues: EmailTemplateIssue[];
  readonly occurrences: Map<EmailMergeFieldName, string[]>;
  readonly usedFields: EmailMergeFieldName[];
}

const stableIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const emailAddressPattern = /^[^\s@<>]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/;
const tokenPattern = /^\{\{\s*([a-z][a-z0-9_.]{2,63})\s*}}$/;
const audiences = new Set(["organizer", "reviewer", "speaker", "submitter"]);
const statuses = new Set(["active", "archived", "draft"]);

function isMergeFieldName(value: string): value is EmailMergeFieldName {
  return Object.hasOwn(emailMergeFieldDefinitions, value);
}

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function isSafeHttpsUrl(value: string): boolean {
  if (value.length > 2_048 || /\s/u.test(value) || hasAsciiControl(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function issue(
  issues: EmailTemplateIssue[],
  code: EmailTemplateIssue["code"],
  location: string,
  message: string,
  offset?: number,
): void {
  issues.push({
    code,
    location,
    message,
    ...(offset === undefined ? {} : { offset }),
  });
}

function templateSlots(template: EmailTemplate): TemplateSlot[] {
  const slots: TemplateSlot[] = [
    { location: "subject", value: template.subject },
    { location: "body.previewText", value: template.body.previewText },
  ];
  template.body.blocks.forEach((block, index) => {
    if (block.type === "heading" || block.type === "paragraph") {
      slots.push({ location: `body.blocks[${index}].text`, value: block.text });
    } else if (block.type === "button") {
      slots.push(
        { location: `body.blocks[${index}].label`, value: block.label },
        { location: `body.blocks[${index}].url`, value: block.url },
      );
    }
  });
  return slots;
}

function parseSegments(
  value: string,
  location: string,
  issues: EmailTemplateIssue[],
): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const opening = value.indexOf("{{", cursor);
    const strayClosing = value.indexOf("}}", cursor);
    if (strayClosing >= 0 && (opening < 0 || strayClosing < opening)) {
      issue(
        issues,
        "invalid_token",
        location,
        "Merge token has a closing marker without an opening marker.",
        strayClosing,
      );
      segments.push({ literal: value.slice(cursor, strayClosing + 2) });
      cursor = strayClosing + 2;
      continue;
    }
    if (opening < 0) {
      segments.push({ literal: value.slice(cursor) });
      break;
    }
    if (opening > cursor) {
      segments.push({ literal: value.slice(cursor, opening) });
    }
    const closing = value.indexOf("}}", opening + 2);
    if (closing < 0) {
      issue(
        issues,
        "invalid_token",
        location,
        "Merge token is missing its closing marker.",
        opening,
      );
      segments.push({ literal: value.slice(opening) });
      break;
    }
    const rawToken = value.slice(opening, closing + 2);
    const match = tokenPattern.exec(rawToken);
    if (!match?.[1]) {
      issue(
        issues,
        "invalid_token",
        location,
        "Merge token must use the form {{namespace.field}}.",
        opening,
      );
      segments.push({ literal: rawToken });
    } else if (!isMergeFieldName(match[1])) {
      issue(
        issues,
        "unknown_field",
        location,
        `Unknown merge field ${match[1]}.`,
        opening,
      );
      segments.push({ literal: rawToken });
    } else {
      segments.push({ field: match[1] });
    }
    cursor = closing + 2;
  }
  return segments;
}

function validateAddress(
  value: string,
  location: string,
  issues: EmailTemplateIssue[],
): void {
  if (
    value.length > 320 ||
    /[\r\n\0]/.test(value) ||
    !emailAddressPattern.test(value)
  ) {
    issue(issues, "invalid_address", location, "Email address is invalid.");
  }
}

function validateTemplateShape(
  template: EmailTemplate,
  issues: EmailTemplateIssue[],
): void {
  if (!stableIdentifierPattern.test(template.id)) {
    issue(issues, "invalid_template", "id", "Template ID is invalid.");
  }
  if (!stableIdentifierPattern.test(template.eventId)) {
    issue(issues, "invalid_template", "eventId", "Event ID is invalid.");
  }
  if (
    template.internalName.trim().length === 0 ||
    template.internalName.length > 120 ||
    /[\r\n\0]/.test(template.internalName)
  ) {
    issue(
      issues,
      "invalid_template",
      "internalName",
      "Internal name must be 1–120 printable characters.",
    );
  }
  if (!audiences.has(template.audience)) {
    issue(issues, "invalid_template", "audience", "Audience is invalid.");
  }
  if (!statuses.has(template.status)) {
    issue(issues, "invalid_template", "status", "Status is invalid.");
  }
  if (template.mergeSchemaVersion !== EMAIL_MERGE_SCHEMA_VERSION) {
    issue(
      issues,
      "invalid_template",
      "mergeSchemaVersion",
      "Merge schema version is unsupported.",
    );
  }
  if (!Number.isInteger(template.version) || template.version < 1) {
    issue(issues, "invalid_template", "version", "Version must be positive.");
  }
  for (const [location, timestamp] of [
    ["createdAt", template.createdAt],
    ["updatedAt", template.updatedAt],
  ] as const) {
    if (!timestamp.endsWith("Z") || !Number.isFinite(Date.parse(timestamp))) {
      issue(issues, "invalid_template", location, "Timestamp must be UTC.");
    }
  }
  if (
    template.sender.name.trim().length === 0 ||
    template.sender.name.length > 80 ||
    hasAsciiControl(template.sender.name) ||
    /[<>]/u.test(template.sender.name)
  ) {
    issue(issues, "invalid_template", "sender.name", "Sender name is invalid.");
  }
  validateAddress(template.sender.address, "sender.address", issues);
  validateAddress(template.replyTo, "replyTo", issues);
  if (
    template.subject.trim().length === 0 ||
    template.subject.length > 200 ||
    /[\r\n\0]/.test(template.subject)
  ) {
    issue(issues, "invalid_template", "subject", "Subject is invalid.");
  }
  if (
    template.body.previewText.length > 180 ||
    /[\r\n\0]/.test(template.body.previewText)
  ) {
    issue(
      issues,
      "invalid_template",
      "body.previewText",
      "Preview text must be at most 180 characters on one line.",
    );
  }
  if (template.body.blocks.length === 0 || template.body.blocks.length > 100) {
    issue(
      issues,
      "invalid_template",
      "body.blocks",
      "Email body must contain 1–100 blocks.",
    );
  }
  template.body.blocks.forEach((block, index) => {
    const location = `body.blocks[${index}]`;
    if (block.type === "divider") return;
    if (block.type === "button") {
      if (block.label.trim().length === 0 || block.label.length > 120) {
        issue(
          issues,
          "invalid_template",
          `${location}.label`,
          "Button label is invalid.",
        );
      }
      if (block.url.length > 2_048) {
        issue(
          issues,
          "unsafe_url",
          `${location}.url`,
          "Button URL is too long.",
        );
      }
      return;
    }
    if (block.text.trim().length === 0 || block.text.length > 8_000) {
      issue(
        issues,
        "invalid_template",
        `${location}.text`,
        "Block text is invalid.",
      );
    }
  });
}

function compileTemplate(template: EmailTemplate): CompiledTemplate {
  const issues: EmailTemplateIssue[] = [];
  validateTemplateShape(template, issues);
  const allowed = new Set<EmailMergeFieldName>();
  for (const field of template.allowedMergeFields) {
    if (!isMergeFieldName(field)) {
      issue(
        issues,
        "unknown_field",
        "allowedMergeFields",
        `Unknown merge field ${String(field)}.`,
      );
      continue;
    }
    if (allowed.has(field)) {
      issue(
        issues,
        "duplicate_field",
        "allowedMergeFields",
        `Merge field ${field} is declared more than once.`,
      );
    }
    allowed.add(field);
  }

  const occurrences = new Map<EmailMergeFieldName, string[]>();
  for (const slot of templateSlots(template)) {
    const segments = parseSegments(slot.value, slot.location, issues);
    for (const segment of segments) {
      if (!segment.field) continue;
      if (!allowed.has(segment.field)) {
        issue(
          issues,
          "field_not_allowed",
          slot.location,
          `Merge field ${segment.field} is not allowlisted for this template.`,
        );
      }
      const locations = occurrences.get(segment.field) ?? [];
      locations.push(slot.location);
      occurrences.set(segment.field, locations);
    }
  }

  template.body.blocks.forEach((block, index) => {
    if (block.type !== "button") return;
    const location = `body.blocks[${index}].url`;
    const segments = parseSegments(block.url, location, []);
    const dynamicUrl = segments.length === 1 ? segments[0]?.field : undefined;
    if (dynamicUrl) {
      if (emailMergeFieldDefinitions[dynamicUrl].type !== "url") {
        issue(
          issues,
          "unsafe_url",
          location,
          "Button target must use a URL merge field.",
        );
      }
      return;
    }
    if (!isSafeHttpsUrl(block.url)) {
      issue(
        issues,
        "unsafe_url",
        location,
        "Button target must be one URL merge field or a static HTTPS URL.",
      );
    }
  });

  return {
    issues,
    occurrences,
    usedFields: [...occurrences.keys()].sort(),
  };
}

export function analyzeEmailTemplate(
  template: EmailTemplate,
): EmailTemplateAnalysis {
  const compiled = compileTemplate(template);
  return {
    issues: compiled.issues,
    usedFields: compiled.usedFields,
    valid: compiled.issues.length === 0,
  };
}

function valueDisplay(value: EmailMergeValue): string {
  return value.type === "date_time" ? value.display : String(value.value);
}

function validateMergeValue(
  field: EmailMergeFieldName,
  value: EmailMergeValue,
  location: string,
  issues: EmailTemplateIssue[],
): void {
  const expected = emailMergeFieldDefinitions[field].type;
  if (value.type !== expected) {
    issue(
      issues,
      "invalid_field_value",
      location,
      `Merge field ${field} requires ${expected}, received ${value.type}.`,
    );
    return;
  }
  if (value.type === "url") {
    if (!isSafeHttpsUrl(value.value)) {
      issue(issues, "unsafe_url", location, `${field} must be an HTTPS URL.`);
    }
    return;
  }
  if (value.type === "date_time") {
    if (
      !value.value.endsWith("Z") ||
      !Number.isFinite(Date.parse(value.value)) ||
      value.display.trim().length === 0 ||
      value.display.length > 200 ||
      /[\r\n\0]/.test(value.display)
    ) {
      issue(
        issues,
        "invalid_field_value",
        location,
        `${field} has an invalid date-time.`,
      );
    }
    return;
  }
  if (value.type === "email") {
    validateAddress(value.value, location, issues);
    return;
  }
  if (value.value.length > 2_000 || /[\0\r]/.test(value.value)) {
    issue(
      issues,
      "invalid_field_value",
      location,
      `${field} has an invalid text value.`,
    );
  }
}

export function validateEmailMergeValues(
  template: EmailTemplate,
  values: EmailMergeValues,
): EmailTemplateAnalysis {
  const compiled = compileTemplate(template);
  const issues = [...compiled.issues];
  for (const field of compiled.usedFields) {
    const value = values[field];
    const location = compiled.occurrences.get(field)?.[0] ?? "mergeValues";
    if (!value) {
      issue(
        issues,
        "missing_field_value",
        location,
        `Merge field ${field} is required.`,
      );
      continue;
    }
    validateMergeValue(field, value, location, issues);
  }
  return {
    issues,
    usedFields: compiled.usedFields,
    valid: issues.length === 0,
  };
}

export function interpolateTemplateValue(
  value: string,
  location: string,
  values: EmailMergeValues,
): string {
  const issues: EmailTemplateIssue[] = [];
  const segments = parseSegments(value, location, issues);
  if (issues.length > 0) {
    throw new EmailTemplateValidationError(issues);
  }
  return segments
    .map((segment) =>
      segment.field
        ? valueDisplay(values[segment.field] as EmailMergeValue)
        : segment.literal,
    )
    .join("");
}

export class EmailTemplateValidationError extends Error {
  readonly issues: readonly EmailTemplateIssue[];

  constructor(issues: readonly EmailTemplateIssue[]) {
    super(
      issues.length === 1
        ? `${issues[0]?.location}: ${issues[0]?.message}`
        : `Email template has ${issues.length} validation errors.`,
    );
    this.name = "EmailTemplateValidationError";
    this.issues = issues;
  }
}
