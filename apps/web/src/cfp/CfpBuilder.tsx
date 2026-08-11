import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlignLeft,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Copy,
  FileUp,
  GripVertical,
  History,
  Link2,
  ListChecks,
  Monitor,
  Plus,
  Rows3,
  Smartphone,
  Sparkles,
  Trash2,
  Type,
} from "lucide-react";

import {
  Button,
  Dialog,
  Drawer,
  LiveRegion,
  SelectField,
  StatePanel,
  StatusPill,
  SwitchField,
  TextAreaField,
  TextField,
  ToastRegion,
  type ToastMessage,
} from "@sessionbox-killer/ui";
import {
  evaluateCfpRules,
  validateCfpRules,
  visibleFieldTransitions,
  type CfpConditionalRule,
} from "@sessionbox-killer/domain";
import type {
  CfpFormDiagnostic,
  OrganizerCfpFormReadResponse,
} from "@sessionbox-killer/contracts";

import {
  cfpBlockLabels,
  cfpBuilderBlocksFromForm,
  cfpBuilderEditableForm,
  type CfpBlockType,
  type CfpBlockView,
} from "./cfpModel";
import {
  CfpFormApiError,
  publishCfpForm,
  readCfpForm,
  saveCfpForm,
} from "./cfpClient";

const storageNamespace = "opensession.cfp-builder.visual-draft";

const blockTypes = new Set<CfpBlockType>([
  "checkbox",
  "file",
  "long_text",
  "multi_select",
  "section",
  "short_text",
  "single_select",
  "url",
]);

const palette: {
  description: string;
  icon: typeof Type;
  type: CfpBlockType;
}[] = [
  { description: "Heading and supporting copy", icon: Rows3, type: "section" },
  { description: "Required confirmation", icon: Check, type: "checkbox" },
  { description: "One-line response", icon: Type, type: "short_text" },
  { description: "Paragraph response", icon: AlignLeft, type: "long_text" },
  { description: "Validated web address", icon: Link2, type: "url" },
  { description: "Choose one option", icon: CircleDot, type: "single_select" },
  {
    description: "Choose several options",
    icon: ListChecks,
    type: "multi_select",
  },
  { description: "Private supporting file", icon: FileUp, type: "file" },
];

interface StoredCfpBuilderDraft {
  blocks: CfpBlockView[];
  formId: string;
  publishCommandId?: string;
  saveCommandId?: string;
  sourceVersion: number;
}

function storageKey(eventKey: string): string {
  return `${storageNamespace}.${eventKey}`;
}

function clearStoredDraft(eventKey: string): void {
  try {
    window.localStorage.removeItem(storageKey(eventKey));
  } catch {
    // The authoritative form remains current when browser storage is blocked.
  }
}

function readStoredDraft(
  eventKey: string,
  formId: string,
  sourceVersion: number,
): StoredCfpBuilderDraft | null {
  try {
    const value = window.localStorage.getItem(storageKey(eventKey));
    if (!value) return null;

    const result: unknown = JSON.parse(value);
    if (!result || typeof result !== "object") return null;
    const draft = result as Partial<StoredCfpBuilderDraft>;
    if (
      draft.formId !== formId ||
      draft.sourceVersion !== sourceVersion ||
      !Array.isArray(draft.blocks) ||
      !draft.blocks.every(isStoredBlock) ||
      (draft.publishCommandId !== undefined &&
        !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(draft.publishCommandId)) ||
      (draft.saveCommandId !== undefined &&
        !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(draft.saveCommandId))
    ) {
      return null;
    }
    return {
      blocks: draft.blocks,
      formId,
      ...(draft.publishCommandId
        ? { publishCommandId: draft.publishCommandId }
        : {}),
      ...(draft.saveCommandId ? { saveCommandId: draft.saveCommandId } : {}),
      sourceVersion,
    };
  } catch {
    return null;
  }
}

function storeDraft(
  eventKey: string,
  formId: string,
  sourceVersion: number,
  blocks: readonly CfpBlockView[],
  commands: Pick<
    StoredCfpBuilderDraft,
    "publishCommandId" | "saveCommandId"
  > = {},
): void {
  try {
    window.localStorage.setItem(
      storageKey(eventKey),
      JSON.stringify({ blocks, formId, sourceVersion, ...commands }),
    );
  } catch {
    // The authoritative save still protects the draft when storage is blocked.
  }
}

function isStoredRule(value: unknown): value is CfpConditionalRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<CfpConditionalRule>;
  return (
    (rule.effect === "show" || rule.effect === "require") &&
    typeof rule.id === "string" &&
    (rule.operator === "equals" || rule.operator === "includes") &&
    typeof rule.sourceKey === "string" &&
    typeof rule.value === "string"
  );
}

function isStoredBlock(value: unknown): value is CfpBlockView {
  if (!value || typeof value !== "object") return false;
  const block = value as Partial<CfpBlockView>;
  return (
    typeof block.help === "string" &&
    typeof block.id === "string" &&
    typeof block.key === "string" &&
    typeof block.label === "string" &&
    typeof block.required === "boolean" &&
    typeof block.type === "string" &&
    blockTypes.has(block.type as CfpBlockType) &&
    (block.visibility === "always" || block.visibility === "conditional") &&
    (block.options === undefined ||
      (Array.isArray(block.options) &&
        block.options.every((option) => typeof option === "string"))) &&
    (block.rules === undefined ||
      (Array.isArray(block.rules) && block.rules.every(isStoredRule)))
  );
}

function createBlock(type: CfpBlockType, index: number): CfpBlockView {
  const label = cfpBlockLabels[type];
  const selectable = type === "single_select" || type === "multi_select";

  return {
    help: type === "section" ? "Explain what applicants should include." : "",
    id: `block-${type}-${window.crypto.randomUUID()}`,
    key: `${type}_${index + 1}`,
    label,
    ...(selectable ? { options: ["Option one", "Option two"] } : {}),
    required: type !== "section",
    type,
    visibility: "always",
  };
}

function BlockPreview({
  answer,
  block,
  onAnswer,
  required,
}: {
  answer: unknown;
  block: CfpBlockView;
  onAnswer: (answer: unknown) => void;
  required: boolean;
}) {
  if (block.type === "section") {
    return (
      <div className="cfp-preview-section">
        <h3>{block.label}</h3>
        <p>{block.help}</p>
      </div>
    );
  }

  return (
    <div className="cfp-preview-field">
      <label>
        {block.label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {block.help ? <small>{block.help}</small> : null}
      {block.type === "long_text" ? (
        <textarea
          aria-label={block.label}
          onChange={(event) => onAnswer(event.target.value)}
          required={required}
          rows={4}
          value={typeof answer === "string" ? answer : ""}
        />
      ) : block.type === "single_select" ? (
        <select
          aria-label={block.label}
          onChange={(event) => onAnswer(event.target.value)}
          required={required}
          value={typeof answer === "string" ? answer : ""}
        >
          <option value="">Choose one</option>
          {(block.options ?? []).map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : block.type === "multi_select" ? (
        <fieldset className="cfp-preview-options">
          <legend className="ui-sr-only">{block.label}</legend>
          {(block.options ?? []).map((option) => {
            const values = Array.isArray(answer) ? answer : [];
            return (
              <label key={option}>
                <input
                  checked={values.includes(option)}
                  onChange={(event) =>
                    onAnswer(
                      event.target.checked
                        ? [...values, option]
                        : values.filter((value) => value !== option),
                    )
                  }
                  type="checkbox"
                />
                {option}
              </label>
            );
          })}
        </fieldset>
      ) : block.type === "file" ? (
        <div className="cfp-preview-upload">Choose a private file</div>
      ) : block.type === "checkbox" ? (
        <input
          aria-label={block.label}
          checked={answer === true}
          onChange={(event) => onAnswer(event.target.checked)}
          required={required}
          type="checkbox"
        />
      ) : (
        <input
          aria-label={block.label}
          onChange={(event) => onAnswer(event.target.value)}
          required={required}
          type={block.type === "url" ? "url" : "text"}
          value={typeof answer === "string" ? answer : ""}
        />
      )}
      {(block.rules ?? []).length ? <em>Conditional field</em> : null}
    </div>
  );
}

function CanvasBlock({
  block,
  index,
  isFirst,
  isLast,
  onDelete,
  onMove,
  onSelect,
  selected,
}: {
  block: CfpBlockView;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <article
      className={selected ? "cfp-canvas-block is-selected" : "cfp-canvas-block"}
      data-block-type={block.type}
    >
      <button
        aria-label={`Edit ${block.label}`}
        className="cfp-block-select"
        onClick={onSelect}
        type="button"
      >
        <GripVertical aria-hidden="true" size={18} />
        <span className="cfp-block-index">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span>
          <small>{cfpBlockLabels[block.type]}</small>
          <strong>{block.label}</strong>
          {block.help ? <em>{block.help}</em> : null}
        </span>
        <ChevronRight aria-hidden="true" size={18} />
      </button>
      <div className="cfp-block-controls">
        {block.required && block.type !== "section" ? (
          <span>Required</span>
        ) : null}
        {(block.rules ?? []).length ? <span>Conditional</span> : null}
        <button
          aria-label={`Move ${block.label} up`}
          disabled={isFirst}
          onClick={() => {
            onMove(-1);
          }}
          type="button"
        >
          <ArrowUp aria-hidden="true" size={15} />
        </button>
        <button
          aria-label={`Move ${block.label} down`}
          disabled={isLast}
          onClick={() => {
            onMove(1);
          }}
          type="button"
        >
          <ArrowDown aria-hidden="true" size={15} />
        </button>
        <button
          aria-label={`Delete ${block.label}`}
          onClick={onDelete}
          type="button"
        >
          <Trash2 aria-hidden="true" size={15} />
        </button>
      </div>
    </article>
  );
}

type BuilderSaveState = "failed" | "saved" | "saving" | "unsaved";

export function CfpBuilder({ eventKey }: { eventKey: string }) {
  const [blocks, setBlocks] = useState<CfpBlockView[]>([]);
  const [formResponse, setFormResponse] =
    useState<OrganizerCfpFormReadResponse | null>(null);
  const [loadState, setLoadState] = useState<
    "error" | "loading" | "ready" | "unsupported"
  >("loading");
  const [selectedId, setSelectedId] = useState(
    () => blocks[1]?.id ?? blocks[0]?.id ?? "",
  );
  const [saveState, setSaveState] = useState<BuilderSaveState>("saved");
  const [saveError, setSaveError] = useState("");
  const [serverDiagnostics, setServerDiagnostics] = useState<
    readonly CfpFormDiagnostic[]
  >([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">(
    "desktop",
  );
  const [publishOpen, setPublishOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [publishedVersion, setPublishedVersion] = useState(0);
  const [draftVersion, setDraftVersion] = useState(0);
  const [currentVersionPublished, setCurrentVersionPublished] = useState(false);
  const [previewAnswers, setPreviewAnswers] = useState<Record<string, unknown>>(
    {},
  );
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const latestBlocks = useRef(blocks);
  const saveInFlight = useRef(false);
  const publishCommand = useRef<{
    formId: string;
    id: string;
    sourceVersion: number;
  } | null>(null);
  const saveCommand = useRef<{ fingerprint: string; id: string } | null>(null);
  const selected = blocks.find((block) => block.id === selectedId) ?? blocks[0];
  const selectedIndex = selected
    ? blocks.findIndex((block) => block.id === selected.id)
    : -1;
  const priorChoiceFields = blocks
    .slice(0, Math.max(selectedIndex, 0))
    .filter(
      (block) =>
        block.type === "single_select" || block.type === "multi_select",
    );
  const choiceFields = blocks.filter(
    (block) =>
      block.id !== selected?.id &&
      (block.type === "single_select" || block.type === "multi_select"),
  );
  const ruleDiagnostics = useMemo(() => validateCfpRules(blocks), [blocks]);
  const previewEvaluation = useMemo(
    () => evaluateCfpRules(blocks, previewAnswers),
    [blocks, previewAnswers],
  );
  const previewStateByKey = new Map(
    previewEvaluation.fields.map((field) => [field.key, field]),
  );

  useEffect(() => {
    latestBlocks.current = blocks;
  }, [blocks]);

  useEffect(() => {
    const controller = new AbortController();
    void readCfpForm(window.fetch.bind(window), eventKey, controller.signal)
      .then((response) => {
        const authoritative = cfpBuilderBlocksFromForm(response.form);
        const recovered = readStoredDraft(
          eventKey,
          response.form.id,
          response.form.sourceVersion,
        );
        const next = recovered?.blocks ?? authoritative;
        if (recovered?.saveCommandId) {
          saveCommand.current = {
            fingerprint: JSON.stringify(cfpBuilderEditableForm(response, next)),
            id: recovered.saveCommandId,
          };
        }
        if (recovered?.publishCommandId) {
          publishCommand.current = {
            formId: response.form.id,
            id: recovered.publishCommandId,
            sourceVersion: response.form.sourceVersion,
          };
        }
        setFormResponse(response);
        setBlocks(next);
        latestBlocks.current = next;
        setSelectedId(next[1]?.id ?? next[0]?.id ?? "");
        setPublishedVersion(response.publishedVersion ?? 0);
        setDraftVersion(response.form.version);
        setCurrentVersionPublished(response.form.status !== "draft");
        setServerDiagnostics(response.diagnostics);
        setSaveState(recovered?.saveCommandId ? "unsaved" : "saved");
        setLoadState("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setSaveError(
          error instanceof CfpFormApiError
            ? error.message
            : "The authoritative CFP form could not be loaded.",
        );
        setLoadState(
          error instanceof Error && error.message.includes("not supported")
            ? "unsupported"
            : "error",
        );
      });
    return () => controller.abort();
  }, [eventKey]);

  useEffect(() => {
    if (
      loadState !== "ready" ||
      saveState !== "unsaved" ||
      !formResponse ||
      saveInFlight.current
    ) {
      return;
    }
    const fingerprint = JSON.stringify(
      cfpBuilderEditableForm(formResponse, blocks),
    );
    const command =
      saveCommand.current?.fingerprint === fingerprint
        ? saveCommand.current
        : { fingerprint, id: window.crypto.randomUUID() };
    saveCommand.current = command;
    storeDraft(
      eventKey,
      formResponse.form.id,
      formResponse.form.sourceVersion,
      blocks,
      { saveCommandId: command.id },
    );
    const timer = window.setTimeout(() => {
      saveInFlight.current = true;
      setSaveState("saving");
      setSaveError("");
      void saveCfpForm(window.fetch.bind(window), eventKey, {
        commandId: command.id,
        expectedFormId: formResponse.form.id,
        expectedSourceVersion: formResponse.form.sourceVersion,
        form: cfpBuilderEditableForm(formResponse, blocks),
      })
        .then(({ result }) => {
          saveInFlight.current = false;
          const currentFingerprint = JSON.stringify(
            cfpBuilderEditableForm(result, latestBlocks.current),
          );
          setFormResponse(result);
          setPublishedVersion(result.publishedVersion ?? 0);
          setDraftVersion(result.form.version);
          setCurrentVersionPublished(result.form.status === "published");
          setServerDiagnostics(result.diagnostics);
          const currentSaved = currentFingerprint === fingerprint;
          if (currentSaved) {
            saveCommand.current = null;
            clearStoredDraft(eventKey);
          } else {
            const nextCommand = {
              fingerprint: currentFingerprint,
              id: window.crypto.randomUUID(),
            };
            saveCommand.current = nextCommand;
            storeDraft(
              eventKey,
              result.form.id,
              result.form.sourceVersion,
              latestBlocks.current,
              { saveCommandId: nextCommand.id },
            );
          }
          setSaveState(currentSaved ? "saved" : "unsaved");
        })
        .catch((error: unknown) => {
          saveInFlight.current = false;
          setSaveError(
            error instanceof CfpFormApiError
              ? error.message
              : "The draft is safe on this device but has not synced yet.",
          );
          if (error instanceof CfpFormApiError) {
            setServerDiagnostics(error.diagnostics);
          }
          setSaveState("failed");
        });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [blocks, eventKey, formResponse, loadState, saveState]);

  useEffect(() => {
    const retry = () =>
      setSaveState((state) => (state === "failed" ? "unsaved" : state));
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);

  const changeSummary = useMemo(
    () => [
      `${blocks.length} blocks in this version`,
      `${blocks.reduce((count, block) => count + (block.rules?.length ?? 0), 0)} conditional rules validated`,
      `Existing version ${publishedVersion || 1} drafts keep their original field snapshot`,
    ],
    [blocks, publishedVersion],
  );

  function commitBlocks(nextBlocks: CfpBlockView[], message: string) {
    if (currentVersionPublished) {
      setDraftVersion((current) => current + 1);
      setCurrentVersionPublished(false);
    }
    setBlocks(nextBlocks);
    setSaveState("unsaved");
    setAnnouncement(message);
  }

  function addBlock(type: CfpBlockType) {
    const block = createBlock(type, blocks.length);
    const selectedIndex = blocks.findIndex((item) => item.id === selectedId);
    const insertAt = selectedIndex >= 0 ? selectedIndex + 1 : blocks.length;
    const next = [...blocks];
    next.splice(insertAt, 0, block);
    setSelectedId(block.id);
    commitBlocks(
      next,
      `${cfpBlockLabels[type]} added at position ${insertAt + 1}.`,
    );
  }

  function updateSelected(patch: Partial<CfpBlockView>) {
    if (!selected) {
      return;
    }

    commitBlocks(
      blocks.map((block) =>
        block.id === selected.id ? { ...block, ...patch } : block,
      ),
      `${patch.label ?? selected.label} updated.`,
    );
  }

  function addRule() {
    if (!selected) return;
    const source = priorChoiceFields[0];
    if (!source) {
      setAnnouncement(
        "Add a single-choice or multiple-choice field before this field to create a condition.",
      );
      return;
    }
    const rule: CfpConditionalRule = {
      effect: "show",
      id: `rule-${selected.id}-${window.crypto.randomUUID()}`,
      operator: source.type === "multi_select" ? "includes" : "equals",
      sourceKey: source.key,
      value: source.options?.[0] ?? "",
    };
    updateSelected({
      rules: [...(selected.rules ?? []), rule],
      visibility: "conditional",
    });
  }

  function updateRule(ruleId: string, patch: Partial<CfpConditionalRule>) {
    if (!selected) return;
    const nextRules = (selected.rules ?? []).map<CfpConditionalRule>((rule) => {
      if (rule.id !== ruleId) return rule;
      if (!patch.sourceKey) return { ...rule, ...patch };
      const source = blocks.find((block) => block.key === patch.sourceKey);
      return {
        ...rule,
        ...patch,
        operator: source?.type === "multi_select" ? "includes" : "equals",
        value: source?.options?.[0] ?? "",
      };
    });
    updateSelected({ rules: nextRules });
  }

  function removeRule(ruleId: string) {
    if (!selected) return;
    const nextRules = (selected.rules ?? []).filter(
      (rule) => rule.id !== ruleId,
    );
    updateSelected({
      rules: nextRules,
      visibility: nextRules.length ? "conditional" : "always",
    });
  }

  function changePreviewAnswer(key: string, value: unknown) {
    const nextEvaluation = evaluateCfpRules(blocks, {
      ...previewEvaluation.answers,
      [key]: value,
    });
    const transitions = visibleFieldTransitions(
      previewEvaluation.fields,
      nextEvaluation.fields,
    );
    setPreviewAnswers(nextEvaluation.answers);
    if (transitions.length) {
      setAnnouncement(
        transitions
          .map((transition) => {
            const field = blocks.find((block) => block.key === transition.key);
            const state = nextEvaluation.fields.find(
              (item) => item.key === transition.key,
            );
            return `${field?.label ?? transition.key} is now ${transition.visible ? `visible${state?.required ? " and required" : ""}` : "hidden; its preview answer was cleared"}.`;
          })
          .join(" "),
      );
    }
  }

  function moveSelected(id: string, direction: -1 | 1) {
    const currentIndex = blocks.findIndex((block) => block.id === id);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= blocks.length) {
      return;
    }

    const next = [...blocks];
    const [block] = next.splice(currentIndex, 1);
    if (!block) {
      return;
    }
    next.splice(targetIndex, 0, block);
    commitBlocks(next, `${block.label} moved to position ${targetIndex + 1}.`);
  }

  function deleteBlock(id: string) {
    const currentIndex = blocks.findIndex((block) => block.id === id);
    const block = blocks[currentIndex];
    const next = blocks.filter((item) => item.id !== id);
    setSelectedId(next[Math.min(currentIndex, next.length - 1)]?.id ?? "");
    commitBlocks(next, `${block?.label ?? "Block"} deleted.`);
  }

  async function publish() {
    if (
      ruleDiagnostics.length ||
      serverDiagnostics.length ||
      saveState !== "saved" ||
      formResponse?.form.status !== "draft"
    ) {
      return;
    }
    setSaveState("saving");
    setSaveError("");
    try {
      const command =
        publishCommand.current?.formId === formResponse.form.id &&
        publishCommand.current.sourceVersion === formResponse.form.sourceVersion
          ? publishCommand.current
          : {
              formId: formResponse.form.id,
              id: window.crypto.randomUUID(),
              sourceVersion: formResponse.form.sourceVersion,
            };
      publishCommand.current = command;
      storeDraft(
        eventKey,
        formResponse.form.id,
        formResponse.form.sourceVersion,
        blocks,
        { publishCommandId: command.id },
      );
      const { result } = await publishCfpForm(
        window.fetch.bind(window),
        eventKey,
        {
          commandId: command.id,
          expectedFormId: formResponse.form.id,
          expectedSourceVersion: formResponse.form.sourceVersion,
        },
      );
      publishCommand.current = null;
      setFormResponse(result);
      setPublishedVersion(result.publishedVersion ?? result.form.version);
      setDraftVersion(result.form.version);
      setCurrentVersionPublished(true);
      setServerDiagnostics(result.diagnostics);
      setPublishOpen(false);
      setSaveState("saved");
      clearStoredDraft(eventKey);
      setToasts([
        {
          id: "cfp-published",
          message: `Version ${result.form.version} is live. Existing older drafts retain their original form snapshot.`,
          title: "CFP published",
          tone: "success",
        },
      ]);
    } catch (error) {
      setSaveError(
        error instanceof CfpFormApiError
          ? error.message
          : "The CFP version could not be published.",
      );
      if (error instanceof CfpFormApiError) {
        setServerDiagnostics(error.diagnostics);
      }
      setSaveState("saved");
    }
  }

  if (loadState !== "ready" || !formResponse) {
    return (
      <StatePanel
        description={
          loadState === "loading"
            ? "Loading the current authoritative form and publication state."
            : saveError ||
              "This form contains a field that the visual builder cannot edit safely."
        }
        state={loadState === "loading" ? "loading" : "error"}
        title={
          loadState === "loading"
            ? "Loading CFP builder"
            : loadState === "unsupported"
              ? "This form needs a supported editor"
              : "CFP form unavailable"
        }
      />
    );
  }
  const publicUrl = new URL(
    formResponse.publicUrl,
    window.location.origin,
  ).toString();
  const closesLabel = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: formResponse.event.timezone,
  }).format(new Date(formResponse.event.cfpClosesAt));

  return (
    <div className="cfp-builder-page">
      <header className="cfp-builder-header">
        <div>
          <p className="overline">Collect · CFP builder</p>
          <div className="cfp-title-line">
            <h1>{formResponse.form.name}</h1>
            <StatusPill
              tone={
                formResponse.form.status === "published"
                  ? "success"
                  : formResponse.form.status === "closed"
                    ? "neutral"
                    : "warning"
              }
            >
              {formResponse.form.status === "published"
                ? `Published v${draftVersion}`
                : formResponse.form.status === "closed"
                  ? `Closed v${draftVersion}`
                  : `Draft v${draftVersion}`}
            </StatusPill>
          </div>
          <p>
            Build a clear application once, then publish a versioned snapshot
            without breaking proposals already in progress.
          </p>
        </div>
        <div className="cfp-header-actions">
          <span className={`cfp-save-state is-${saveState}`} role="status">
            <i aria-hidden="true" />
            {saveState === "saved"
              ? "Saved securely"
              : saveState === "saving"
                ? "Saving…"
                : saveState === "failed"
                  ? "Saved on this device"
                  : "Unsaved changes"}
          </span>
          <Button variant="secondary" onClick={() => setHistoryOpen(true)}>
            <History aria-hidden="true" size={16} /> Version history
          </Button>
          <Button variant="secondary" onClick={() => setPreviewOpen(true)}>
            <Monitor aria-hidden="true" size={16} /> Preview
          </Button>
          <Button
            disabled={
              saveState !== "saved" || formResponse.form.status !== "draft"
            }
            onClick={() => setPublishOpen(true)}
          >
            <Sparkles aria-hidden="true" size={16} /> Publish changes
          </Button>
        </div>
      </header>
      {saveError ? (
        <p className="cfp-publish-error" role="alert">
          {saveError} Your device copy remains available for recovery.
        </p>
      ) : null}

      <div className="cfp-builder-layout">
        <aside className="cfp-palette" aria-labelledby="palette-title">
          <div className="cfp-pane-heading">
            <div>
              <p className="overline">Add content</p>
              <h2 id="palette-title">Field palette</h2>
            </div>
            <span>{palette.length}</span>
          </div>
          <p className="cfp-pane-copy">
            Add a block after the selected field. Reorder it in the canvas.
          </p>
          <div className="cfp-palette-list">
            {palette.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.type}
                  onClick={() => addBlock(item.type)}
                  type="button"
                >
                  <span className="cfp-palette-icon">
                    <Icon aria-hidden="true" size={17} />
                  </span>
                  <span>
                    <strong>{cfpBlockLabels[item.type]}</strong>
                    <small>{item.description}</small>
                  </span>
                  <Plus aria-hidden="true" size={16} />
                </button>
              );
            })}
          </div>
        </aside>

        <section className="cfp-canvas" aria-labelledby="canvas-title">
          <div className="cfp-canvas-toolbar">
            <div>
              <p className="overline">Version {draftVersion}</p>
              <h2 id="canvas-title">Application canvas</h2>
            </div>
            <span>{blocks.length} blocks</span>
          </div>
          <div className="cfp-form-intro">
            <span>AS</span>
            <div>
              <small>{formResponse.event.name}</small>
              <h3>{formResponse.form.name}</h3>
              <p>
                {formResponse.form.welcomeContent ||
                  "Drafts are private until applicants submit them."}
              </p>
            </div>
          </div>
          <div className="cfp-canvas-list">
            {blocks.map((block, index) => (
              <CanvasBlock
                block={block}
                index={index}
                isFirst={index === 0}
                isLast={index === blocks.length - 1}
                key={block.id}
                onDelete={() => deleteBlock(block.id)}
                onMove={(direction) => moveSelected(block.id, direction)}
                onSelect={() => setSelectedId(block.id)}
                selected={block.id === selectedId}
              />
            ))}
          </div>
          <button
            className="cfp-add-inline"
            onClick={() => addBlock("short_text")}
            type="button"
          >
            <Plus aria-hidden="true" size={17} /> Add another field
          </button>
        </section>

        <aside className="cfp-inspector" aria-labelledby="inspector-title">
          {selected ? (
            <>
              <div className="cfp-pane-heading">
                <div>
                  <p className="overline">Selected block</p>
                  <h2 id="inspector-title">Edit field</h2>
                </div>
                <StatusPill tone="neutral">
                  {cfpBlockLabels[selected.type]}
                </StatusPill>
              </div>
              <div className="cfp-inspector-form">
                <TextField
                  id="cfp-field-label"
                  label="Label"
                  onChange={(event) =>
                    updateSelected({ label: event.target.value })
                  }
                  value={selected.label}
                />
                <TextField
                  description="Stable after publish; used by rules and exports."
                  id="cfp-field-key"
                  label="Stable key"
                  onChange={(event) =>
                    updateSelected({
                      key: event.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9_]/g, "_"),
                    })
                  }
                  value={selected.key}
                />
                <TextAreaField
                  id="cfp-field-help"
                  label="Help text"
                  onChange={(event) =>
                    updateSelected({ help: event.target.value })
                  }
                  rows={3}
                  value={selected.help}
                />
                {selected.type !== "section" ? (
                  <SwitchField
                    checked={selected.required}
                    description="Applicants must complete this field before submitting."
                    label="Required"
                    onChange={(required) => updateSelected({ required })}
                  />
                ) : null}
                <section
                  aria-labelledby="cfp-logic-title"
                  className="cfp-logic-builder"
                >
                  <div className="cfp-logic-heading">
                    <div>
                      <h3 id="cfp-logic-title">Conditional logic</h3>
                      <p>Show or require this field from an earlier choice.</p>
                    </div>
                    <span>{selected.rules?.length ?? 0}</span>
                  </div>
                  {(selected.rules ?? []).map((rule, index) => {
                    const source = blocks.find(
                      (block) => block.key === rule.sourceKey,
                    );
                    const sourceOptions = source?.options ?? [];
                    const sourceChoices = choiceFields.map((block) => {
                      const sourceIndex = blocks.findIndex(
                        (item) => item.id === block.id,
                      );
                      return {
                        label:
                          sourceIndex >= selectedIndex
                            ? `${block.label} · later field (blocks publish)`
                            : block.label,
                        value: block.key,
                      };
                    });
                    if (!source) {
                      sourceChoices.unshift({
                        label: `Deleted field · ${rule.sourceKey}`,
                        value: rule.sourceKey,
                      });
                    }
                    const values = sourceOptions.map((option) => ({
                      label: option,
                      value: option,
                    }));
                    if (!sourceOptions.includes(rule.value)) {
                      values.unshift({
                        label: `Removed option · ${rule.value}`,
                        value: rule.value,
                      });
                    }
                    return (
                      <div className="cfp-logic-rule" key={rule.id}>
                        <div className="cfp-logic-rule-title">
                          <strong>Rule {index + 1}</strong>
                          <button
                            aria-label={`Remove rule ${index + 1}`}
                            onClick={() => removeRule(rule.id)}
                            type="button"
                          >
                            <Trash2 aria-hidden="true" size={14} />
                          </button>
                        </div>
                        <SelectField
                          id={`cfp-rule-${rule.id}-effect`}
                          label="Action"
                          onChange={(event) =>
                            updateRule(rule.id, {
                              effect: event.target
                                .value as CfpConditionalRule["effect"],
                            })
                          }
                          options={[
                            { label: "Show field", value: "show" },
                            { label: "Require field", value: "require" },
                          ]}
                          value={rule.effect}
                        />
                        <SelectField
                          id={`cfp-rule-${rule.id}-source`}
                          label="Earlier choice field"
                          onChange={(event) =>
                            updateRule(rule.id, {
                              sourceKey: event.target.value,
                            })
                          }
                          options={sourceChoices}
                          value={rule.sourceKey}
                        />
                        <div className="cfp-field-pair">
                          <SelectField
                            id={`cfp-rule-${rule.id}-operator`}
                            label="Operator"
                            onChange={(event) =>
                              updateRule(rule.id, {
                                operator: event.target
                                  .value as CfpConditionalRule["operator"],
                              })
                            }
                            options={[
                              source?.type === "multi_select"
                                ? { label: "includes", value: "includes" }
                                : { label: "equals", value: "equals" },
                            ]}
                            value={rule.operator}
                          />
                          <SelectField
                            id={`cfp-rule-${rule.id}-value`}
                            label="Value"
                            onChange={(event) =>
                              updateRule(rule.id, {
                                value: event.target.value,
                              })
                            }
                            options={values}
                            value={rule.value}
                          />
                        </div>
                      </div>
                    );
                  })}
                  <Button
                    disabled={!priorChoiceFields.length}
                    onClick={addRule}
                    variant="secondary"
                  >
                    <Plus aria-hidden="true" size={15} /> Add condition
                  </Button>
                  {!priorChoiceFields.length ? (
                    <p className="cfp-logic-empty">
                      Move this field after a single-choice or multiple-choice
                      field to add a condition.
                    </p>
                  ) : null}
                  {ruleDiagnostics
                    .filter(
                      (diagnostic) => diagnostic.fieldKey === selected.key,
                    )
                    .map((diagnostic) => (
                      <p
                        className="cfp-publish-error"
                        key={`${diagnostic.code}-${diagnostic.ruleId ?? diagnostic.fieldKey}`}
                        role="alert"
                      >
                        {diagnostic.message}
                      </p>
                    ))}
                </section>
                {selected.type === "short_text" ||
                selected.type === "long_text" ? (
                  <div className="cfp-field-pair">
                    <TextField
                      id="cfp-field-min"
                      label="Minimum"
                      min="0"
                      onChange={(event) =>
                        updateSelected({
                          minLength: Number(event.target.value),
                        })
                      }
                      type="number"
                      value={selected.minLength ?? 0}
                    />
                    <TextField
                      id="cfp-field-max"
                      label="Maximum"
                      min="1"
                      onChange={(event) =>
                        updateSelected({
                          maxLength: Number(event.target.value),
                        })
                      }
                      type="number"
                      value={selected.maxLength ?? 500}
                    />
                  </div>
                ) : null}
                {selected.type === "single_select" ||
                selected.type === "multi_select" ? (
                  <TextAreaField
                    description="One option per line."
                    id="cfp-field-options"
                    label="Options"
                    onChange={(event) =>
                      updateSelected({
                        options: event.target.value.split("\n").filter(Boolean),
                      })
                    }
                    rows={5}
                    value={(selected.options ?? []).join("\n")}
                  />
                ) : null}
              </div>
            </>
          ) : (
            <div className="cfp-inspector-empty">
              <Rows3 aria-hidden="true" size={24} />
              <h2 id="inspector-title">Select a field</h2>
              <p>Choose a canvas block to edit its copy and behavior.</p>
            </div>
          )}
        </aside>
      </div>

      <Drawer
        description="Review the published applicant experience before sharing it."
        onClose={() => setPreviewOpen(false)}
        open={previewOpen}
        title="Preview application"
      >
        <div className="cfp-device-toggle" aria-label="Preview size">
          <button
            aria-pressed={previewDevice === "desktop"}
            onClick={() => setPreviewDevice("desktop")}
            type="button"
          >
            <Monitor aria-hidden="true" size={16} /> Desktop
          </button>
          <button
            aria-pressed={previewDevice === "mobile"}
            onClick={() => setPreviewDevice("mobile")}
            type="button"
          >
            <Smartphone aria-hidden="true" size={16} /> Mobile
          </button>
        </div>
        <div className={`cfp-public-preview is-${previewDevice}`}>
          <div className="cfp-public-preview-header">
            <span>{formResponse.event.name.toLocaleUpperCase("en-US")}</span>
            <small>Applications close {closesLabel}</small>
            <h2>{formResponse.form.name}</h2>
            <p>
              Drafts save as you go. Nothing is submitted until your final
              review.
            </p>
          </div>
          {blocks.map((block) => {
            const state = previewStateByKey.get(block.key);
            return state?.visible ? (
              <BlockPreview
                answer={previewEvaluation.answers[block.key]}
                block={block}
                key={block.id}
                onAnswer={(answer) => changePreviewAnswer(block.key, answer)}
                required={state.required}
              />
            ) : null;
          })}
          <Button>Continue to participants</Button>
        </div>
      </Drawer>

      <Drawer
        description="Published versions are immutable. New edits begin the next draft."
        onClose={() => setHistoryOpen(false)}
        open={historyOpen}
        title="Version history"
      >
        <ol className="cfp-version-list">
          <li className="is-current">
            <span>
              <Clock3 aria-hidden="true" size={17} />
            </span>
            <div>
              <strong>
                Version {draftVersion} ·{" "}
                {formResponse.form.status === "draft"
                  ? "Current draft"
                  : "Current publication"}
              </strong>
              <small>{blocks.length} blocks · Authoritative snapshot</small>
            </div>
            <StatusPill
              tone={
                formResponse.form.status === "published"
                  ? "success"
                  : formResponse.form.status === "closed"
                    ? "neutral"
                    : "warning"
              }
            >
              {formResponse.form.status === "published"
                ? "Live"
                : formResponse.form.status === "closed"
                  ? "Closed"
                  : "Draft"}
            </StatusPill>
          </li>
          {formResponse.form.status === "draft" && publishedVersion ? (
            <li>
              <span>
                <Check aria-hidden="true" size={17} />
              </span>
              <div>
                <strong>Version {publishedVersion} · Published</strong>
                <small>Immutable applicant snapshot</small>
              </div>
              <StatusPill tone="success">Live</StatusPill>
            </li>
          ) : null}
        </ol>
      </Drawer>

      <Dialog
        description="Publishing creates a new immutable version for future applicants."
        onClose={() => setPublishOpen(false)}
        open={publishOpen}
        title={`Publish version ${draftVersion}?`}
      >
        <div className="cfp-publish-summary">
          <div className="cfp-public-url">
            <span>Public URL</span>
            <strong>{publicUrl}</strong>
            <button
              aria-label="Copy public CFP URL"
              onClick={() => {
                setToasts([
                  {
                    id: "url-copied",
                    message: publicUrl,
                    title: "URL copied",
                  },
                ]);
              }}
              type="button"
            >
              <Copy aria-hidden="true" size={16} />
            </button>
          </div>
          <div className="cfp-publish-meta">
            <span>
              <Clock3 aria-hidden="true" size={16} /> Closes {closesLabel}
            </span>
            <span>{formResponse.event.timezone}</span>
          </div>
          <ul>
            {changeSummary.map((item) => (
              <li key={item}>
                <Check aria-hidden="true" size={16} /> {item}
              </li>
            ))}
          </ul>
          {serverDiagnostics.length ? (
            <div className="cfp-publish-errors" role="alert">
              <strong>
                Resolve {serverDiagnostics.length} form issue before publishing
              </strong>
              <ul>
                {serverDiagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.path}-${diagnostic.code}-${index}`}>
                    {diagnostic.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="cfp-publish-actions">
            <Button variant="secondary" onClick={() => setPublishOpen(false)}>
              Keep editing
            </Button>
            <Button
              disabled={Boolean(
                ruleDiagnostics.length ||
                serverDiagnostics.length ||
                saveState !== "saved",
              )}
              onClick={() => void publish()}
            >
              Publish version {draftVersion}
            </Button>
          </div>
        </div>
      </Dialog>

      <LiveRegion message={announcement} />
      <ToastRegion
        messages={toasts}
        onDismiss={(id) =>
          setToasts((current) => current.filter((toast) => toast.id !== id))
        }
      />
    </div>
  );
}
