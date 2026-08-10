import {
  EmailTemplateValidationError,
  interpolateTemplateValue,
  validateEmailMergeValues,
} from "./merge.js";
import type {
  EmailDocumentBlock,
  EmailMergeValues,
  EmailTemplate,
  RenderedEmailTemplate,
} from "./types.js";

const maximumRenderedBytes = 96 * 1_024;
const unquotedDisplayNamePattern = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlText(value: string): string {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

function formatEmailAddress(name: string, address: string): string {
  if (unquotedDisplayNamePattern.test(name)) return `${name} <${address}>`;
  const quotedName = name.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${quotedName}" <${address}>`;
}

function renderHtmlBlock(
  block: EmailDocumentBlock,
  index: number,
  values: EmailMergeValues,
): string {
  const location = `body.blocks[${index}]`;
  if (block.type === "divider") {
    return '<hr style="border:0;border-top:1px solid #d9ddd8;margin:28px 0">';
  }
  if (block.type === "heading") {
    return `<h1 style="color:#18201b;font-family:Arial,sans-serif;font-size:28px;line-height:1.2;margin:0 0 20px">${htmlText(interpolateTemplateValue(block.text, `${location}.text`, values))}</h1>`;
  }
  if (block.type === "paragraph") {
    return `<p style="color:#3e4942;font-family:Arial,sans-serif;font-size:16px;line-height:1.6;margin:0 0 18px">${htmlText(interpolateTemplateValue(block.text, `${location}.text`, values))}</p>`;
  }
  const label = htmlText(
    interpolateTemplateValue(block.label, `${location}.label`, values),
  );
  const url = escapeHtml(
    interpolateTemplateValue(block.url, `${location}.url`, values),
  );
  return `<p style="margin:26px 0"><a href="${url}" style="background:#156b45;border-radius:8px;color:#ffffff;display:inline-block;font-family:Arial,sans-serif;font-size:16px;font-weight:700;padding:12px 18px;text-decoration:none">${label}</a></p>`;
}

function renderTextBlock(
  block: EmailDocumentBlock,
  index: number,
  values: EmailMergeValues,
): string {
  const location = `body.blocks[${index}]`;
  if (block.type === "divider")
    return "----------------------------------------";
  if (block.type === "heading" || block.type === "paragraph") {
    return interpolateTemplateValue(block.text, `${location}.text`, values);
  }
  return `${interpolateTemplateValue(block.label, `${location}.label`, values)}\n${interpolateTemplateValue(block.url, `${location}.url`, values)}`;
}

export function renderEmailTemplate(
  template: EmailTemplate,
  values: EmailMergeValues,
): RenderedEmailTemplate {
  const validation = validateEmailMergeValues(template, values);
  if (!validation.valid) {
    throw new EmailTemplateValidationError(validation.issues);
  }

  const subject = interpolateTemplateValue(template.subject, "subject", values);
  if (subject.length > 200 || /[\r\n\0]/.test(subject)) {
    throw new EmailTemplateValidationError([
      {
        code: "invalid_template",
        location: "subject",
        message: "Rendered subject is invalid.",
      },
    ]);
  }
  const previewText = htmlText(
    interpolateTemplateValue(
      template.body.previewText,
      "body.previewText",
      values,
    ),
  );
  const blocks = template.body.blocks
    .map((block, index) => renderHtmlBlock(block, index, values))
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#f3f5f2;margin:0;padding:24px"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${previewText}</div><main style="background:#ffffff;border:1px solid #d9ddd8;border-radius:12px;margin:0 auto;max-width:600px;padding:32px">${blocks}<p style="color:#69746d;font-family:Arial,sans-serif;font-size:13px;line-height:1.5;margin:30px 0 0">Sent by OpenSession.</p></main></body></html>`;
  const text = template.body.blocks
    .map((block, index) => renderTextBlock(block, index, values))
    .join("\n\n")
    .concat("\n\nSent by OpenSession.");
  if (
    new TextEncoder().encode(html).byteLength > maximumRenderedBytes ||
    new TextEncoder().encode(text).byteLength > maximumRenderedBytes
  ) {
    throw new EmailTemplateValidationError([
      {
        code: "output_too_large",
        location: "body",
        message: "Rendered email exceeds the 96 KiB delivery budget.",
      },
    ]);
  }

  return {
    from: formatEmailAddress(template.sender.name, template.sender.address),
    html,
    replyTo: template.replyTo,
    subject,
    templateId: template.id,
    templateVersion: template.version,
    text,
    usedFields: validation.usedFields,
  };
}
