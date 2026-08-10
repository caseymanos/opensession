import { useEffect, useMemo, useState, type FocusEventHandler } from "react";
import {
  AlertTriangle,
  Archive,
  Braces,
  CheckCircle2,
  Code2,
  FileText,
  Mail,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  UserRound,
  WandSparkles,
} from "lucide-react";

import {
  emailTemplateFamilyId,
  emailTemplateDraft,
  emailTemplateHead,
  type EmailDocumentBlock,
  type EmailMergeFieldName,
  type EmailTemplateDraft,
  type EmailTemplatePreviewResponse,
  type EmailTemplatePreviewSource,
  type EmailTemplateRecord,
  type EmailTemplateWorkspace as EmailTemplateWorkspaceData,
} from "@sessionbox-killer/email";
import {
  Button,
  LiveRegion,
  SelectField,
  StatePanel,
  StatusPill,
  TextAreaField,
  TextField,
} from "@sessionbox-killer/ui";

import {
  createEmailTemplatePort,
  EmailTemplateApiError,
  type EmailTemplatePort,
} from "./emailTemplateClient";
import { createFixtureEmailTemplatePort } from "./emailTemplateFixture";

import "./email-template-workspace.css";

type PreviewTab = "html" | "text";
type InsertTarget =
  | "body.previewText"
  | "subject"
  | `body.blocks[${number}].label`
  | `body.blocks[${number}].text`
  | `body.blocks[${number}].url`;

interface PreviewState {
  readonly error: unknown;
  readonly loading: boolean;
  readonly result: EmailTemplatePreviewResponse | null;
}

interface CommandNotice {
  readonly kind: "error" | "success";
  readonly message: string;
  readonly reload?: boolean;
}

function commandId() {
  return `email_template_${crypto.randomUUID().replaceAll("-", "")}`;
}

function statusTone(status: EmailTemplateRecord["template"]["status"]) {
  return status === "active"
    ? ("success" as const)
    : status === "draft"
      ? ("preview" as const)
      : ("neutral" as const);
}

function templateLabel(record: EmailTemplateRecord) {
  return `${record.template.internalName} · v${record.template.version}`;
}

function preferredTemplate(
  workspace: EmailTemplateWorkspaceData,
): EmailTemplateRecord | undefined {
  return (
    workspace.templates.find(({ template }) =>
      template.internalName.toLowerCase().includes("accepted"),
    ) ?? workspace.templates[0]
  );
}

function sourceFromKey(sourceKey: string): EmailTemplatePreviewSource {
  return sourceKey === "seed"
    ? { kind: "seed" }
    : { kind: "recipient", recipientId: sourceKey };
}

function issueAt(
  result: EmailTemplatePreviewResponse | null,
  location: string,
): string | undefined {
  if (!result || result.ok) return undefined;
  return result.issues.find((issue) => issue.location === location)?.message;
}

function appendToken(value: string, token: string) {
  if (value.length === 0 || /\s$/u.test(value)) return `${value}${token}`;
  return `${value} ${token}`;
}

function updateBlock(
  block: EmailDocumentBlock,
  property: "label" | "text" | "url",
  value: string,
): EmailDocumentBlock {
  if (block.type === "button") {
    if (property === "label") return { ...block, label: value };
    if (property === "url") return { ...block, url: value };
    return block;
  }
  if (
    (block.type === "heading" || block.type === "paragraph") &&
    property === "text"
  ) {
    return { ...block, text: value };
  }
  return block;
}

function blockTitle(block: EmailDocumentBlock, index: number) {
  if (block.type === "divider") return `Divider ${index + 1}`;
  if (block.type === "button") return `Button ${index + 1}`;
  return `${block.type === "heading" ? "Heading" : "Paragraph"} ${index + 1}`;
}

export function EmailTemplateWorkspace({
  eventKey,
  fixture = false,
}: {
  eventKey: string;
  fixture?: boolean;
}) {
  const port = useMemo<EmailTemplatePort>(
    () =>
      fixture
        ? createFixtureEmailTemplatePort()
        : createEmailTemplatePort(eventKey),
    [eventKey, fixture],
  );
  const [workspace, setWorkspace] = useState<EmailTemplateWorkspaceData | null>(
    null,
  );
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [draft, setDraft] = useState<EmailTemplateDraft | null>(null);
  const [sourceKey, setSourceKey] = useState("seed");
  const [activeTarget, setActiveTarget] = useState<InsertTarget>("subject");
  const [previewTab, setPreviewTab] = useState<PreviewTab>("html");
  const [invalidProof, setInvalidProof] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({
    error: null,
    loading: false,
    result: null,
  });
  const [pendingAction, setPendingAction] = useState<
    "activate" | "archive" | "save" | null
  >(null);
  const [announcement, setAnnouncement] = useState("");
  const [commandNotice, setCommandNotice] = useState<CommandNotice | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    void port.read().then(
      (result) => {
        if (!active) return;
        setWorkspace(result);
        const selected = preferredTemplate(result);
        if (selected) {
          setSelectedTemplateId(selected.template.id);
          setDraft(emailTemplateDraft(selected.template));
        }
        setSourceKey(result.recipients[0]?.id ?? "seed");
      },
      (error: unknown) => {
        if (active) setLoadError(error);
      },
    );
    return () => {
      active = false;
    };
  }, [port, retryVersion]);

  const selected = workspace?.templates.find(
    ({ template }) => template.id === selectedTemplateId,
  );
  const selectedHead =
    workspace && selected
      ? emailTemplateHead(
          workspace.templates.map(({ template }) => template),
          emailTemplateFamilyId(selected.template.id),
        )
      : null;
  const selectedIsHead = selectedHead?.id === selected?.template.id;
  const hasUnsavedChanges = Boolean(
    selected &&
    draft &&
    JSON.stringify(draft) !==
      JSON.stringify(emailTemplateDraft(selected.template)),
  );

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!selected || !draft) return;
    let active = true;
    const timeout = window.setTimeout(() => {
      setPreview({ error: null, loading: true, result: null });
      const proofDraft = invalidProof
        ? {
            ...draft,
            subject: `${draft.subject} · {{recipient.nickname}}`,
          }
        : draft;
      void port
        .preview({
          baseTemplateId: selected.template.id,
          source: sourceFromKey(sourceKey),
          template: proofDraft,
        })
        .then(
          (result) => {
            if (active) setPreview({ error: null, loading: false, result });
          },
          (error: unknown) => {
            if (active) setPreview({ error, loading: false, result: null });
          },
        );
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [draft, invalidProof, port, selected, sourceKey]);

  function selectTemplate(record: EmailTemplateRecord) {
    if (
      hasUnsavedChanges &&
      !window.confirm(
        "Discard unsaved template edits and open another immutable version?",
      )
    ) {
      return;
    }
    setSelectedTemplateId(record.template.id);
    setDraft(emailTemplateDraft(record.template));
    setInvalidProof(false);
    setCommandNotice(null);
    setAnnouncement(`Editing ${templateLabel(record)}.`);
  }

  function changeDraft(
    update: (current: EmailTemplateDraft) => EmailTemplateDraft,
  ) {
    if (!selectedIsHead) return;
    setDraft((current) => (current ? update(current) : current));
    setInvalidProof(false);
    setCommandNotice(null);
  }

  function applyDurableResult(
    record: EmailTemplateRecord,
    successMessage: string,
  ) {
    setWorkspace((current) =>
      current
        ? { ...current, templates: [record, ...current.templates] }
        : current,
    );
    setSelectedTemplateId(record.template.id);
    setDraft(emailTemplateDraft(record.template));
    setCommandNotice({ kind: "success", message: successMessage });
  }

  function commandFailed(error: unknown, fallback: string) {
    const message = error instanceof Error ? error.message : fallback;
    const reload =
      error instanceof EmailTemplateApiError &&
      (error.code === "email_template_historical_version" ||
        error.code === "email_template_version_conflict");
    setCommandNotice({ kind: "error", message, ...(reload ? { reload } : {}) });
  }

  function repairPending(message: string) {
    const notice = `${message} Authoritative storage accepted the change, but this view is still catching up.`;
    setCommandNotice({ kind: "success", message: notice, reload: true });
  }

  function reloadWorkspace() {
    setWorkspace(null);
    setLoadError(null);
    setCommandNotice(null);
    setRetryVersion((current) => current + 1);
  }

  function changeBlock(index: number, block: EmailDocumentBlock) {
    changeDraft((current) => ({
      ...current,
      body: {
        ...current.body,
        blocks: current.body.blocks.map((candidate, candidateIndex) =>
          candidateIndex === index ? block : candidate,
        ),
      },
    }));
  }

  function removeBlock(index: number) {
    changeDraft((current) => ({
      ...current,
      body: {
        ...current.body,
        blocks: current.body.blocks.filter(
          (_, candidate) => candidate !== index,
        ),
      },
    }));
  }

  function addBlock(type: "button" | "paragraph") {
    changeDraft((current) => ({
      ...current,
      body: {
        ...current.body,
        blocks: [
          ...current.body.blocks,
          type === "button"
            ? {
                label: "Open your workspace",
                type: "button" as const,
                url: "https://events.opensession.invalid",
              }
            : { text: "Add your message here.", type: "paragraph" as const },
        ],
      },
    }));
  }

  function insertMergeField(name: EmailMergeFieldName) {
    const token = `{{${name}}}`;
    changeDraft((current) => {
      const allowedMergeFields = current.allowedMergeFields.includes(name)
        ? current.allowedMergeFields
        : [...current.allowedMergeFields, name];
      if (activeTarget === "subject") {
        return {
          ...current,
          allowedMergeFields,
          subject: appendToken(current.subject, token),
        };
      }
      if (activeTarget === "body.previewText") {
        return {
          ...current,
          allowedMergeFields,
          body: {
            ...current.body,
            previewText: appendToken(current.body.previewText, token),
          },
        };
      }
      const match = /^body\.blocks\[(\d+)]\.(label|text|url)$/.exec(
        activeTarget,
      );
      if (!match?.[1] || !match[2]) return current;
      const index = Number(match[1]);
      const property = match[2] as "label" | "text" | "url";
      return {
        ...current,
        allowedMergeFields,
        body: {
          ...current.body,
          blocks: current.body.blocks.map((block, blockIndex) => {
            if (blockIndex !== index) return block;
            const currentValue =
              property === "text" &&
              (block.type === "heading" || block.type === "paragraph")
                ? block.text
                : property === "label" && block.type === "button"
                  ? block.label
                  : property === "url" && block.type === "button"
                    ? block.url
                    : "";
            const nextValue =
              property === "url" ? token : appendToken(currentValue, token);
            return updateBlock(block, property, nextValue);
          }),
        },
      };
    });
    setAnnouncement(`${name} inserted into ${activeTarget}.`);
  }

  async function saveRevision() {
    if (!selected || !draft || !selectedIsHead) return;
    setPendingAction("save");
    setCommandNotice(null);
    try {
      const result = await port.execute({
        baseTemplateId: selected.template.id,
        commandId: commandId(),
        expectedSourceVersion: selected.sourceVersion,
        template: draft,
        type: "create_revision",
      });
      const message = `Draft version ${result.record.template.version} saved as an immutable record.`;
      if (result.projection === "repair_pending") repairPending(message);
      else applyDurableResult(result.record, message);
    } catch (error) {
      commandFailed(error, "The draft could not be saved.");
    } finally {
      setPendingAction(null);
    }
  }

  async function activateVersion() {
    if (!selected || !draft || !selectedIsHead) return;
    setPendingAction("activate");
    setCommandNotice(null);
    try {
      const result = await port.execute({
        baseTemplateId: selected.template.id,
        commandId: commandId(),
        expectedSourceVersion: selected.sourceVersion,
        source: sourceFromKey(sourceKey),
        template: draft,
        type: "activate_version",
      });
      const message = `Version ${result.record.template.version} activated from the current validated preview. Earlier versions remain unchanged.`;
      if (result.projection === "repair_pending") repairPending(message);
      else applyDurableResult(result.record, message);
    } catch (error) {
      commandFailed(error, "The version could not be activated.");
    } finally {
      setPendingAction(null);
    }
  }

  async function archiveVersion() {
    if (!selected || hasUnsavedChanges || !selectedIsHead) return;
    setPendingAction("archive");
    setCommandNotice(null);
    try {
      const result = await port.execute({
        baseTemplateId: selected.template.id,
        commandId: commandId(),
        expectedSourceVersion: selected.sourceVersion,
        type: "archive_version",
      });
      const message = `Version ${result.record.template.version} archived as the immutable family head. Earlier records remain historical and cannot start a campaign.`;
      if (result.projection === "repair_pending") repairPending(message);
      else applyDurableResult(result.record, message);
    } catch (error) {
      commandFailed(error, "The version could not be archived.");
    } finally {
      setPendingAction(null);
    }
  }

  if (!workspace) {
    const permissionDenied =
      loadError instanceof EmailTemplateApiError &&
      loadError.code === "forbidden";
    return (
      <div className="email-template-page">
        <StatePanel
          description={
            permissionDenied
              ? "Ask an event owner for communications access. Recipient data and template content remain private."
              : loadError instanceof Error
                ? loadError.message
                : "Loading authoritative template versions and eligible preview recipients."
          }
          {...(loadError
            ? {
                onRetry: reloadWorkspace,
              }
            : {})}
          state={
            permissionDenied ? "permission" : loadError ? "error" : "loading"
          }
          {...(permissionDenied
            ? { title: "Communications access required" }
            : {})}
        />
      </div>
    );
  }

  if (!selected || !draft) {
    return (
      <div className="email-template-page">
        <StatePanel
          description="Create or seed an email template before opening the editor."
          state="empty"
          title="No template versions"
        />
      </div>
    );
  }

  const previewResult = preview.result;
  const previewFailure = previewResult && !previewResult.ok;
  const previewBlocked = preview.loading || previewResult?.ok !== true;
  const sourceRecipient = workspace.recipients.find(
    ({ id }) => id === sourceKey,
  );
  const focusTarget =
    (
      target: InsertTarget,
    ): FocusEventHandler<HTMLInputElement | HTMLTextAreaElement> =>
    () => {
      setActiveTarget(target);
    };

  return (
    <div className="email-template-page">
      <LiveRegion message={announcement} />
      <header className="email-template-hero">
        <div>
          <p className="overline">Communications · Email templates</p>
          <div className="email-template-title-line">
            <h1>Write once. Preview every person.</h1>
            <StatusPill tone={statusTone(selected.template.status)}>
              {selected.template.status} · v{selected.template.version}
            </StatusPill>
          </div>
          <p>
            Edit structured content, validate every merge token, and inspect the
            exact HTML and plain-text output before a campaign can use it.
          </p>
        </div>
        <div className="email-template-actions">
          <span className="email-template-save-state">
            <ShieldCheck size={15} aria-hidden="true" />
            {!selectedIsHead
              ? "Historical version · read-only"
              : hasUnsavedChanges
                ? "Unsaved edits"
                : "Immutable versions"}
          </span>
          {selectedIsHead && selected.template.status === "draft" ? (
            <Button
              disabled={pendingAction !== null || previewBlocked}
              onClick={() => void activateVersion()}
            >
              <CheckCircle2 size={16} aria-hidden="true" />
              {pendingAction === "activate"
                ? "Activating…"
                : "Activate version"}
            </Button>
          ) : null}
          {selectedIsHead && selected.template.status !== "archived" ? (
            <Button
              disabled={pendingAction !== null || hasUnsavedChanges}
              onClick={() => void archiveVersion()}
              variant="secondary"
            >
              <Archive size={16} aria-hidden="true" />
              {pendingAction === "archive" ? "Archiving…" : "Archive version"}
            </Button>
          ) : null}
          {selectedIsHead ? (
            <Button
              disabled={pendingAction !== null || previewBlocked}
              onClick={() => void saveRevision()}
              variant="secondary"
            >
              <Save size={16} aria-hidden="true" />
              {pendingAction === "save" ? "Saving…" : "Save new version"}
            </Button>
          ) : null}
        </div>
      </header>

      {!selectedIsHead ? (
        <section className="email-historical-notice">
          <ShieldCheck size={16} aria-hidden="true" />
          <p>
            This immutable version is retained for audit and campaign history.
            Open the latest family version to make a change.
          </p>
        </section>
      ) : null}

      {commandNotice ? (
        <section
          className={`email-command-notice is-${commandNotice.kind}`}
          role={commandNotice.kind === "error" ? "alert" : "status"}
        >
          <p>{commandNotice.message}</p>
          {commandNotice.reload ? (
            <Button onClick={reloadWorkspace} variant="secondary">
              Reload versions
            </Button>
          ) : null}
        </section>
      ) : null}

      <div className="email-template-layout">
        <aside className="email-template-library">
          <div className="email-template-panel-heading">
            <span aria-hidden="true">
              <Mail size={17} />
            </span>
            <div>
              <h2>Template library</h2>
              <p>{workspace.templates.length} immutable versions</p>
            </div>
          </div>
          <nav aria-label="Email template versions">
            {workspace.templates.map((record) => (
              <button
                aria-current={
                  record.template.id === selected.template.id
                    ? "page"
                    : undefined
                }
                className={
                  record.template.id === selected.template.id
                    ? "email-template-library-item is-current"
                    : "email-template-library-item"
                }
                key={record.template.id}
                onClick={() => selectTemplate(record)}
                type="button"
              >
                <span>
                  <strong>{record.template.internalName}</strong>
                  <small>{record.template.audience} audience</small>
                </span>
                <span
                  className={`template-status-dot is-${record.template.status}`}
                >
                  v{record.template.version}
                </span>
              </button>
            ))}
          </nav>
          <div className="email-template-library-note">
            <ShieldCheck size={16} aria-hidden="true" />
            <p>
              Campaigns retain the exact active version and rendered snapshot;
              edits never rewrite history.
            </p>
          </div>
        </aside>

        <fieldset
          aria-label="Template editor"
          className="email-template-editor"
          disabled={!selectedIsHead}
        >
          <section className="email-template-section">
            <div className="email-template-section-heading">
              <span aria-hidden="true">
                <FileText size={18} />
              </span>
              <div>
                <h2>Identity and delivery</h2>
                <p>
                  Internal metadata and reply handling stay separate from
                  content.
                </p>
              </div>
            </div>
            <div className="email-template-fields two-columns">
              <TextField
                label="Internal name"
                maxLength={120}
                onChange={(event) =>
                  changeDraft((current) => ({
                    ...current,
                    internalName: event.target.value,
                  }))
                }
                value={draft.internalName}
              />
              <SelectField
                label="Audience"
                onChange={(event) =>
                  changeDraft((current) => ({
                    ...current,
                    audience: event.target
                      .value as EmailTemplateDraft["audience"],
                  }))
                }
                options={[
                  { label: "Speakers", value: "speaker" },
                  { label: "Submitters", value: "submitter" },
                  { label: "Reviewers", value: "reviewer" },
                  { label: "Organizers", value: "organizer" },
                ]}
                value={draft.audience}
              />
              <TextField
                label="Sender name"
                maxLength={80}
                onChange={(event) =>
                  changeDraft((current) => ({
                    ...current,
                    sender: { ...current.sender, name: event.target.value },
                  }))
                }
                value={draft.sender.name}
              />
              <TextField
                label="Sender email"
                onChange={(event) =>
                  changeDraft((current) => ({
                    ...current,
                    sender: { ...current.sender, address: event.target.value },
                  }))
                }
                type="email"
                value={draft.sender.address}
              />
              <TextField
                className="email-template-wide-field"
                label="Reply-to"
                onChange={(event) =>
                  changeDraft((current) => ({
                    ...current,
                    replyTo: event.target.value,
                  }))
                }
                type="email"
                value={draft.replyTo}
              />
            </div>
          </section>

          <section className="email-template-section">
            <div className="email-template-section-heading">
              <span aria-hidden="true">
                <WandSparkles size={18} />
              </span>
              <div>
                <h2>Subject and rich body</h2>
                <p>
                  Structured blocks are escaped and rendered into matching HTML
                  and text.
                </p>
              </div>
            </div>
            <div className="email-template-fields">
              <TextField
                error={issueAt(previewResult, "subject")}
                label="Subject"
                maxLength={200}
                onChange={(event) =>
                  changeDraft((current) => ({
                    ...current,
                    subject: event.target.value,
                  }))
                }
                onFocus={focusTarget("subject")}
                value={draft.subject}
              />
              <TextField
                description="Shown by inboxes before the message is opened."
                error={issueAt(previewResult, "body.previewText")}
                label="Inbox preview text"
                maxLength={180}
                onChange={(event) =>
                  changeDraft((current) => ({
                    ...current,
                    body: { ...current.body, previewText: event.target.value },
                  }))
                }
                onFocus={focusTarget("body.previewText")}
                value={draft.body.previewText}
              />
            </div>

            <div
              className="email-block-list"
              aria-label="Rich email body blocks"
            >
              {draft.body.blocks.map((block, index) => {
                const location = `body.blocks[${index}]`;
                const textIssue = issueAt(previewResult, `${location}.text`);
                return (
                  <article
                    className="email-block"
                    key={`${block.type}-${index}`}
                  >
                    <header>
                      <span className="email-block-number">{index + 1}</span>
                      <strong>{blockTitle(block, index)}</strong>
                      <button
                        aria-label={`Remove ${blockTitle(block, index)}`}
                        disabled={draft.body.blocks.length === 1}
                        onClick={() => removeBlock(index)}
                        type="button"
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </header>
                    {block.type === "heading" || block.type === "paragraph" ? (
                      <TextAreaField
                        {...(textIssue ? { error: textIssue } : {})}
                        label={
                          block.type === "heading"
                            ? "Heading text"
                            : "Paragraph text"
                        }
                        onChange={(event) =>
                          changeBlock(index, {
                            ...block,
                            text: event.target.value,
                          })
                        }
                        onFocus={focusTarget(`body.blocks[${index}].text`)}
                        rows={block.type === "heading" ? 2 : 4}
                        value={block.text}
                      />
                    ) : block.type === "button" ? (
                      <div className="email-template-fields two-columns">
                        <TextField
                          error={issueAt(previewResult, `${location}.label`)}
                          label="Button label"
                          onChange={(event) =>
                            changeBlock(index, {
                              ...block,
                              label: event.target.value,
                            })
                          }
                          onFocus={focusTarget(`body.blocks[${index}].label`)}
                          value={block.label}
                        />
                        <TextField
                          error={issueAt(previewResult, `${location}.url`)}
                          label="HTTPS target or URL field"
                          onChange={(event) =>
                            changeBlock(index, {
                              ...block,
                              url: event.target.value,
                            })
                          }
                          onFocus={focusTarget(`body.blocks[${index}].url`)}
                          value={block.url}
                        />
                      </div>
                    ) : (
                      <p className="email-divider-description">
                        A visual divider in HTML and a text rule in plain text.
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
            <div className="email-block-actions">
              <Button onClick={() => addBlock("paragraph")} variant="secondary">
                <Plus size={15} aria-hidden="true" /> Add paragraph
              </Button>
              <Button onClick={() => addBlock("button")} variant="secondary">
                <Plus size={15} aria-hidden="true" /> Add button
              </Button>
            </div>
          </section>

          <section className="email-template-section merge-field-section">
            <div className="email-template-section-heading">
              <span aria-hidden="true">
                <Braces size={18} />
              </span>
              <div>
                <h2>Typed merge fields</h2>
                <p>
                  Focus a subject or body field, then insert a typed token.
                  Unknown or missing values fail with an exact location.
                </p>
              </div>
            </div>
            <p className="merge-field-target">
              Inserting into <code>{activeTarget}</code>
            </p>
            <div className="merge-field-grid">
              {workspace.mergeFields.map((field) => {
                const allowed = draft.allowedMergeFields.includes(field.name);
                return (
                  <button
                    aria-label={`Insert ${field.name} into ${activeTarget}`}
                    className={
                      allowed ? "merge-field is-allowed" : "merge-field"
                    }
                    key={field.name}
                    onClick={() => insertMergeField(field.name)}
                    type="button"
                  >
                    <code>{`{{${field.name}}}`}</code>
                    <span>{field.type.replace("_", " ")}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </fieldset>

        <aside className="email-preview-panel" aria-label="Recipient preview">
          <div className="email-preview-sticky">
            <div className="email-template-panel-heading">
              <span aria-hidden="true">
                <UserRound size={17} />
              </span>
              <div>
                <h2>Recipient preview</h2>
                <p>Exact HTML and plain text</p>
              </div>
            </div>
            <SelectField
              description="Choose projected event data or a deterministic seed."
              label="Preview recipient"
              onChange={(event) => {
                setSourceKey(event.target.value);
                setInvalidProof(false);
              }}
              options={[
                ...workspace.recipients.map((recipient) => ({
                  label: `${recipient.name} · selected speaker`,
                  value: recipient.id,
                })),
                { label: "Deterministic seed data", value: "seed" },
              ]}
              value={sourceKey}
            />
            <div className="email-preview-source-card">
              <span className="email-preview-avatar" aria-hidden="true">
                {sourceRecipient
                  ? sourceRecipient.name
                      .split(" ")
                      .map((part) => part[0])
                      .join("")
                      .slice(0, 2)
                  : "SD"}
              </span>
              <div>
                <strong>{sourceRecipient?.name ?? "Deterministic seed"}</strong>
                <span>{sourceRecipient?.email ?? "Stable QA values"}</span>
              </div>
              <StatusPill tone={sourceRecipient ? "success" : "preview"}>
                {sourceRecipient ? "Selected speaker" : "Seed"}
              </StatusPill>
            </div>

            <button
              aria-pressed={invalidProof}
              className={
                invalidProof ? "invalid-proof is-active" : "invalid-proof"
              }
              onClick={() => setInvalidProof((current) => !current)}
              type="button"
            >
              <AlertTriangle size={16} aria-hidden="true" />
              <span>
                <strong>
                  {invalidProof
                    ? "Return to valid preview"
                    : "Show invalid-token proof"}
                </strong>
                <small>This QA check never changes the draft.</small>
              </span>
            </button>

            {preview.loading ? (
              <div className="email-preview-loading" role="status">
                <span aria-hidden="true" /> Rendering both formats…
              </div>
            ) : null}
            {preview.error ? (
              <div className="email-preview-error" role="alert">
                <strong>Preview unavailable</strong>
                <p>
                  {preview.error instanceof Error
                    ? preview.error.message
                    : "The preview could not be rendered."}
                </p>
              </div>
            ) : null}
            {previewFailure ? (
              <section
                className="email-validation-errors"
                aria-labelledby="email-validation-title"
                role="alert"
              >
                <div>
                  <AlertTriangle size={17} aria-hidden="true" />
                  <h3 id="email-validation-title">
                    {invalidProof
                      ? "Intentional invalid token caught"
                      : "Preview blocked"}
                  </h3>
                </div>
                <ul>
                  {previewResult.issues.map((issue, index) => (
                    <li key={`${issue.location}-${issue.code}-${index}`}>
                      <code>
                        {issue.location}
                        {issue.offset === undefined ? "" : `:${issue.offset}`}
                      </code>
                      <strong>{issue.message}</strong>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {previewResult?.ok ? (
              <>
                <div
                  className="email-preview-tabs"
                  role="tablist"
                  aria-label="Preview format"
                >
                  <button
                    aria-controls="email-template-html-preview"
                    aria-selected={previewTab === "html"}
                    id="email-template-html-tab"
                    onClick={() => setPreviewTab("html")}
                    role="tab"
                    type="button"
                  >
                    <Code2 size={15} aria-hidden="true" /> HTML
                  </button>
                  <button
                    aria-controls="email-template-text-preview"
                    aria-selected={previewTab === "text"}
                    id="email-template-text-tab"
                    onClick={() => setPreviewTab("text")}
                    role="tab"
                    type="button"
                  >
                    <FileText size={15} aria-hidden="true" /> Plain text
                  </button>
                </div>
                <div className="email-preview-envelope">
                  <dl>
                    <div>
                      <dt>From</dt>
                      <dd>{previewResult.preview.from}</dd>
                    </div>
                    <div>
                      <dt>Reply to</dt>
                      <dd>{previewResult.preview.replyTo}</dd>
                    </div>
                    <div>
                      <dt>Subject</dt>
                      <dd>{previewResult.preview.subject}</dd>
                    </div>
                  </dl>
                  {previewTab === "html" ? (
                    <iframe
                      aria-labelledby="email-template-html-tab"
                      id="email-template-html-preview"
                      referrerPolicy="no-referrer"
                      role="tabpanel"
                      sandbox=""
                      srcDoc={previewResult.preview.html}
                      title={`Sanitized HTML preview for ${sourceRecipient?.name ?? "seed data"}`}
                    />
                  ) : (
                    <pre
                      aria-labelledby="email-template-text-tab"
                      id="email-template-text-preview"
                      role="tabpanel"
                    >
                      {previewResult.preview.text}
                    </pre>
                  )}
                </div>
                <div className="email-safe-render-note">
                  <ShieldCheck size={16} aria-hidden="true" />
                  <span>
                    <strong>Safe render</strong>
                    Values are escaped; the preview frame has no script
                    permissions.
                  </span>
                </div>
              </>
            ) : null}

            {previewResult ? (
              <section
                className="resolved-fields"
                aria-labelledby="resolved-fields-title"
              >
                <h3 id="resolved-fields-title">Resolved values</h3>
                {previewResult.resolvedFields.length > 0 ? (
                  <dl>
                    {previewResult.resolvedFields.map((field) => (
                      <div key={field.name}>
                        <dt>
                          <code>{field.name}</code>
                          <span>{field.type.replace("_", " ")}</span>
                        </dt>
                        <dd>{field.displayValue}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p>No merge values are used by this version.</p>
                )}
              </section>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
