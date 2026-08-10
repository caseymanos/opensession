import type { EmailTemplate } from "./types.js";

const stableIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const versionPrefix = "emailv_";
const versionedIdentifierPattern = /^emailv_([A-Za-z0-9_-]+)_v([1-9][0-9]*)$/;

interface ParsedVersionIdentifier {
  readonly familyId: string;
  readonly version: number;
}

function encodeFamilyId(familyId: string): string {
  return btoa(familyId)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeFamilyId(encoded: string): string | null {
  try {
    const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (standard.length % 4)) % 4);
    const familyId = atob(`${standard}${padding}`);
    return stableIdentifierPattern.test(familyId) &&
      !familyId.startsWith(versionPrefix) &&
      encodeFamilyId(familyId) === encoded
      ? familyId
      : null;
  } catch {
    return null;
  }
}

function parseVersionIdentifier(
  templateId: string,
): ParsedVersionIdentifier | null {
  const match = versionedIdentifierPattern.exec(templateId);
  const familyId = match?.[1] ? decodeFamilyId(match[1]) : null;
  const version = Number(match?.[2]);
  if (!familyId || !Number.isSafeInteger(version) || version < 2) return null;
  return templateId === emailTemplateVersionIdentifier(familyId, version)
    ? { familyId, version }
    : null;
}

function emailTemplateVersionIdentifier(
  familyId: string,
  version: number,
): string {
  return `${versionPrefix}${encodeFamilyId(familyId)}_v${version}`;
}

export function emailTemplateIdentityIssue(
  templateId: string,
  version: number,
): string | null {
  if (!stableIdentifierPattern.test(templateId)) {
    return "Template ID is invalid.";
  }
  if (version === 1) {
    return templateId.startsWith(versionPrefix)
      ? "Version-one template ID uses the reserved version namespace."
      : null;
  }
  const parsed = parseVersionIdentifier(templateId);
  return parsed?.version === version
    ? null
    : "Template ID does not match its immutable version.";
}

export function emailTemplateFamilyId(templateId: string): string {
  return parseVersionIdentifier(templateId)?.familyId ?? templateId;
}

export function emailTemplateVersionId(
  templateId: string,
  version: number,
): string {
  if (!Number.isSafeInteger(version) || version < 2) {
    throw new TypeError("Template version must be at least two.");
  }
  const parsed = parseVersionIdentifier(templateId);
  if (templateId.startsWith(versionPrefix) && !parsed) {
    throw new TypeError(
      "Template ID uses an invalid reserved version namespace.",
    );
  }
  const familyId = parsed?.familyId ?? templateId;
  if (
    !stableIdentifierPattern.test(familyId) ||
    familyId.startsWith(versionPrefix)
  ) {
    throw new TypeError("Template family ID is invalid.");
  }
  const identifier = emailTemplateVersionIdentifier(familyId, version);
  if (identifier.length > 128) {
    throw new TypeError("Template family ID is too long to version safely.");
  }
  return identifier;
}

export function emailTemplateHead(
  templates: readonly EmailTemplate[],
  familyId: string,
): EmailTemplate | null {
  let head: EmailTemplate | null = null;
  for (const template of templates) {
    if (emailTemplateIdentityIssue(template.id, template.version)) continue;
    if (emailTemplateFamilyId(template.id) !== familyId) continue;
    if (!head || template.version > head.version) head = template;
  }
  return head;
}
