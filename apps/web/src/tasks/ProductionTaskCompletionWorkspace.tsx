import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  FileCheck2,
  FileText,
  History,
  Info,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  UploadCloud,
  UserRoundCheck,
  XCircle,
} from "lucide-react";

import type {
  TaskAssignmentDetail,
  TaskSubmissionResponse,
} from "@sessionbox-killer/contracts/tasks";
import {
  Button,
  Dialog,
  LiveRegion,
  SelectField,
  StatePanel,
  StatusPill,
  TextAreaField,
  TextField,
} from "@sessionbox-killer/ui";

import { AppShell } from "../AppShell";
import {
  finalizePrivateUpload,
  preparePrivateUpload,
  PrivateUploadFinalizeError,
} from "../uploads/privateUploadClient";
import {
  createTaskCompletionPort,
  TaskCompletionApiError,
  type TaskCompletionMutation,
  type TaskCompletionPort,
} from "./taskCompletionClient";
import {
  taskCompletionView,
  type TaskCompletionProductionView,
  type TaskFileVersionView,
} from "./taskCompletionModel";

import "./task-completion.css";

type Runtime =
  | { detail: null; error: string; state: "error" | "loading" }
  | { detail: TaskAssignmentDetail; error: string; state: "ready" };

type UploadPhase =
  "failed" | "idle" | "processing" | "submitting" | "syncing" | "uploading";

const contentTypes = new Map([
  ["pdf", "application/pdf"],
  [
    "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

function commandId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "_")}`;
}

function useTaskDetail(eventKey: string, assignmentId: string) {
  const port = useMemo(() => createTaskCompletionPort(), []);
  const [attempt, setAttempt] = useState(0);
  const [runtime, setRuntime] = useState<Runtime>({
    detail: null,
    error: "",
    state: "loading",
  });
  useEffect(() => {
    const controller = new AbortController();
    void port
      .detail(eventKey, assignmentId, controller.signal)
      .then((detail) => setRuntime({ detail, error: "", state: "ready" }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setRuntime({
          detail: null,
          error:
            error instanceof Error
              ? error.message
              : "This task could not be loaded.",
          state: "error",
        });
      });
    return () => controller.abort();
  }, [assignmentId, attempt, eventKey, port]);
  return {
    port,
    retry: () => {
      setRuntime({ detail: null, error: "", state: "loading" });
      setAttempt((value) => value + 1);
    },
    runtime,
    setDetail: (detail: TaskAssignmentDetail) =>
      setRuntime({ detail, error: "", state: "ready" }),
  };
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function FileIdentity({ file }: { file: TaskFileVersionView }) {
  return (
    <div className="task-file-identity">
      <span aria-hidden="true">
        <FileText size={22} />
      </span>
      <div>
        <strong>{file.fileName}</strong>
        <small>
          {file.mimeLabel} · {file.sizeLabel}
        </small>
      </div>
    </div>
  );
}

function taskStateLabel(detail: TaskAssignmentDetail): string {
  const state = detail.assignment.state;
  if (state === "approved") return "Approved";
  if (state === "complete") return "Complete";
  if (state === "submitted") return "Awaiting review";
  if (state === "rejected") return "Changes requested";
  return detail.overdue ? "Overdue" : "Open";
}

function taskStateTone(
  detail: TaskAssignmentDetail,
): "neutral" | "preview" | "success" | "warning" {
  if (
    detail.assignment.state === "approved" ||
    detail.assignment.state === "complete"
  ) {
    return "success";
  }
  if (detail.assignment.state === "submitted") return "preview";
  return detail.overdue || detail.assignment.state === "rejected"
    ? "warning"
    : "neutral";
}

function TaskBrief({ view }: { view: TaskCompletionProductionView }) {
  return (
    <aside className="task-brief" aria-labelledby="task-brief-title">
      <div className="task-brief-heading">
        <span aria-hidden="true">
          <Info size={18} />
        </span>
        <div>
          <p className="overline">Task brief</p>
          <h2 id="task-brief-title">What the team needs</h2>
        </div>
      </div>
      <p>{view.description}</p>
      <section>
        <strong>Why this matters</strong>
        <p>{view.whyItMatters}</p>
      </section>
      <dl>
        <DetailItem label="For" value={view.sessionTitle} />
        <DetailItem label="Due" value={view.dueLabel} />
        <DetailItem
          label="Requirement"
          value={view.required ? "Required" : "Optional"}
        />
        <DetailItem label="Completion" value={view.approvalPolicy} />
      </dl>
      <div className="task-brief-contact">
        <LockKeyhole aria-hidden="true" size={17} />
        <span>
          <strong>Private event response</strong>
          Only you and authorized event organizers can access this task.
        </span>
      </div>
    </aside>
  );
}

function VersionHistory({ view }: { view: TaskCompletionProductionView }) {
  if (view.fileVersions.length === 0) return null;
  return (
    <section
      className="task-version-history"
      aria-labelledby="task-history-title"
    >
      <div className="task-section-heading">
        <span aria-hidden="true">
          <History size={17} />
        </span>
        <div>
          <h3 id="task-history-title">Version history</h3>
          <p>
            Only the latest associated version can be downloaded or approved.
          </p>
        </div>
      </div>
      <ol>
        {view.fileVersions.map((file, index) => (
          <li key={file.id}>
            <span aria-hidden="true" />
            <div>
              <strong>
                Version {file.version} ·{" "}
                {file.status ?? (index === 0 ? "current" : "replaced")}
              </strong>
              <p>{file.fileName}</p>
              <small>{file.submittedAt}</small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LoadingTask({
  error,
  onRetry,
}: {
  error?: string;
  onRetry: () => void;
}) {
  return (
    <main className="task-completion task-completion--speaker">
      <StatePanel
        description={
          error ?? "Loading the authoritative task response and file history."
        }
        onRetry={error ? onRetry : undefined}
        state={error ? "error" : "loading"}
        title={error ? "Task unavailable" : "Loading task"}
      />
    </main>
  );
}

function responseFromForm(
  detail: TaskAssignmentDetail,
  values: Readonly<Record<string, boolean | string>>,
): TaskSubmissionResponse {
  const configuration = detail.definition.configuration;
  if (configuration.kind !== "form") {
    throw new Error("This task is not a form.");
  }
  return {
    answers: configuration.fields
      .filter((field) => field.required || values[field.id] !== undefined)
      .map((field) => ({ field_id: field.id, value: values[field.id] ?? "" })),
    kind: "form",
  };
}

export function ProductionSpeakerTaskWorkspace({
  assignmentId,
  eventKey,
}: {
  assignmentId: string;
  eventKey: string;
}) {
  const { port, retry, runtime, setDetail } = useTaskDetail(
    eventKey,
    assignmentId,
  );
  if (runtime.state !== "ready") {
    return (
      <LoadingTask
        {...(runtime.error ? { error: runtime.error } : {})}
        onRetry={retry}
      />
    );
  }
  return (
    <ProductionSpeakerTaskReady
      assignmentId={assignmentId}
      detail={runtime.detail}
      eventKey={eventKey}
      key={assignmentId}
      port={port}
      setDetail={setDetail}
    />
  );
}

function responseValues(
  response: TaskSubmissionResponse | null,
): Record<string, boolean | string> {
  return response?.kind === "form"
    ? response.answers.reduce<Record<string, boolean | string>>(
        (values, answer) => {
          if (!Array.isArray(answer.value)) {
            values[answer.field_id] = answer.value;
          }
          return values;
        },
        {},
      )
    : {};
}

function ProductionSpeakerTaskReady({
  assignmentId,
  detail,
  eventKey,
  port,
  setDetail,
}: {
  assignmentId: string;
  detail: TaskAssignmentDetail;
  eventKey: string;
  port: TaskCompletionPort;
  setDetail: (detail: TaskAssignmentDetail) => void;
}) {
  const response = detail.current_response;
  const [acknowledged, setAcknowledged] = useState(
    response?.kind === "ack" ||
      response?.kind === "link" ||
      response?.kind === "file",
  );
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState("");
  const [formValues, setFormValues] = useState(() => responseValues(response));
  const [message, setMessage] = useState("");
  const [notes, setNotes] = useState(
    response?.kind === "file" ? response.notes : "",
  );
  const [pendingFileIds, setPendingFileIds] = useState<string[]>([]);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const pendingCommand = useRef<{
    expectedVersion: number;
    id: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const view = taskCompletionView(detail);
  const configuration = detail.definition.configuration;
  const currentFiles = detail.files.filter(
    ({ status }) => status === "current",
  );
  const busy =
    phase === "uploading" ||
    phase === "processing" ||
    phase === "submitting" ||
    phase === "syncing";
  const formComplete =
    configuration.kind !== "form" ||
    configuration.fields.every((field) => {
      if (!field.required) return true;
      const value = formValues[field.id];
      return field.type === "checkbox"
        ? value === true
        : typeof value === "string" && value.trim().length > 0;
    });

  async function download(fileId: string) {
    setMessage("");
    try {
      const refreshed = await port.detail(eventKey, assignmentId);
      setDetail(refreshed);
      const receipt = refreshed.files.find(({ id }) => id === fileId)?.download;
      if (!receipt)
        throw new Error("This file version is no longer available.");
      window.location.assign(receipt.url);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The download could not be prepared.",
      );
    }
  }

  function chooseFiles(candidates: FileList | null) {
    if (!candidates || configuration.kind !== "file") return;
    const selected = [...candidates];
    const slideOnly = configuration.extensions.every(
      (value) => value === "pdf" || value === "pptx",
    );
    const transportLimit = (slideOnly ? 50 : 25) * 1024 * 1024;
    const maximum = Math.min(configuration.max_bytes, transportLimit);
    const invalidType = selected.find((candidate) => {
      const extension = candidate.name.split(".").at(-1)?.toLowerCase() ?? "";
      return !configuration.extensions.includes(extension);
    });
    const mismatchedMime = selected.find((candidate) => {
      const extension = candidate.name.split(".").at(-1)?.toLowerCase() ?? "";
      return candidate.type !== contentTypes.get(extension);
    });
    const oversized = selected.find((candidate) => candidate.size > maximum);
    const error =
      selected.length === 0
        ? "Choose at least one file."
        : selected.length > configuration.max_files
          ? `Choose no more than ${configuration.max_files} ${configuration.max_files === 1 ? "file" : "files"}.`
          : invalidType
            ? `${invalidType.name}: choose a ${configuration.extensions.join(" or ").toUpperCase()} file.`
            : mismatchedMime
              ? `${mismatchedMime.name}: the file type does not match its filename extension.`
              : oversized
                ? `${oversized.name}: choose a file smaller than ${(maximum / 1024 / 1024).toFixed(0)} MB.`
                : "";
    setFileError(error);
    setFiles(error ? [] : selected);
    setPendingFileIds([]);
    pendingCommand.current = null;
    setPhase("idle");
  }

  async function submitResponse(
    response: TaskSubmissionResponse,
    checkingSynchronization = false,
  ) {
    let command = pendingCommand.current ?? {
      expectedVersion: detail.assignment.version,
      id: commandId("task_submit"),
    };
    pendingCommand.current = command;
    setMessage("");
    setPhase("submitting");
    try {
      let outcome: TaskCompletionMutation;
      try {
        outcome = await port.submit(eventKey, assignmentId, {
          command_id: command.id,
          expected_version: command.expectedVersion,
          response,
          type: "submit_assignment",
        });
      } catch (error) {
        if (
          response.kind !== "file" ||
          !(error instanceof TaskCompletionApiError) ||
          error.code !== "task_version_conflict"
        ) {
          throw error;
        }
        const refreshed = await port.detail(eventKey, assignmentId);
        command = {
          expectedVersion: refreshed.assignment.version,
          id: commandId("task_submit"),
        };
        pendingCommand.current = command;
        try {
          outcome = await port.submit(eventKey, assignmentId, {
            command_id: command.id,
            expected_version: command.expectedVersion,
            response,
            type: "submit_assignment",
          });
        } catch (retryError) {
          setDetail(refreshed);
          setFiles([]);
          setPendingFileIds([]);
          pendingCommand.current = null;
          throw retryError;
        }
      }
      const receipt = outcome.receipt;
      if (outcome.repairPending) {
        setPhase("syncing");
        setMessage(
          `Response recorded by authority · audit ${receipt.audit.id}. Readiness is still synchronizing.`,
        );
        return;
      }
      pendingCommand.current = null;
      setDetail(receipt.detail);
      setFiles([]);
      setPendingFileIds([]);
      setPhase("idle");
      setMessage(`Response recorded · audit ${receipt.audit.id}`);
      if (inputRef.current) inputRef.current.value = "";
    } catch (error) {
      if (
        response.kind !== "file" &&
        error instanceof TaskCompletionApiError &&
        error.code === "task_version_conflict"
      ) {
        pendingCommand.current = null;
        try {
          const refreshed = await port.detail(eventKey, assignmentId);
          const refreshedResponse = refreshed.current_response;
          setDetail(refreshed);
          setAcknowledged(
            refreshedResponse?.kind === "ack" ||
              refreshedResponse?.kind === "link" ||
              refreshedResponse?.kind === "file",
          );
          setFormValues(responseValues(refreshedResponse));
          setPhase("idle");
          setMessage(
            "This task changed while you were editing. The latest response is loaded; review it before submitting again.",
          );
          return;
        } catch (refreshError) {
          setPhase("failed");
          setMessage(
            refreshError instanceof Error
              ? refreshError.message
              : "The task changed, but the latest response could not be loaded.",
          );
          return;
        }
      }
      setPhase(checkingSynchronization ? "syncing" : "failed");
      setMessage(
        error instanceof Error
          ? error.message
          : "The response was not recorded.",
      );
    }
  }

  async function associatePreparedFiles(
    fileIds: string[],
    checkingSynchronization = false,
  ) {
    await submitResponse(
      {
        acknowledged: true,
        file_ids: [
          ...fileIds,
          ...currentFiles.slice(fileIds.length).map(({ id }) => id),
        ],
        kind: "file",
        notes,
      },
      checkingSynchronization,
    );
  }

  async function uploadFiles() {
    if (
      files.length === 0 ||
      configuration.kind !== "file" ||
      !acknowledged ||
      busy
    ) {
      return;
    }
    pendingCommand.current ??= {
      expectedVersion: detail.assignment.version,
      id: commandId("task_submit"),
    };
    setMessage("");
    setPhase("uploading");
    setProgress(
      files.length === 0
        ? 0
        : Math.round((pendingFileIds.length / files.length) * 100),
    );
    const purpose = configuration.extensions.every(
      (value) => value === "pdf" || value === "pptx",
    )
      ? "slides"
      : "task_attachment";
    const preparedFileIds = [...pendingFileIds];
    try {
      for (
        let index = preparedFileIds.length;
        index < files.length;
        index += 1
      ) {
        const file = files[index];
        if (!file) throw new Error("The selected upload is unavailable.");
        const currentFile = currentFiles[index];
        try {
          const prepared = await preparePrivateUpload(
            {
              eventId: detail.event.id,
              file,
              organizationId: detail.organization_id,
              ownerContactId: detail.speaker.contact_id,
              purpose,
              ...(currentFile ? { replacesFileId: currentFile.id } : {}),
            },
            (value) => {
              setProgress(Math.round((index * 100 + value) / files.length));
              if (index === files.length - 1 && value === 100) {
                setPhase("processing");
              }
            },
          );
          preparedFileIds.push(prepared.fileId);
        } catch (error) {
          if (!(error instanceof PrivateUploadFinalizeError)) throw error;
          preparedFileIds.push(error.fileId);
        }
        setPendingFileIds([...preparedFileIds]);
      }
      setPhase("processing");
      try {
        await Promise.all(
          preparedFileIds.map((fileId) => finalizePrivateUpload(fileId)),
        );
      } catch (error) {
        setPendingFileIds([...preparedFileIds]);
        setPhase("failed");
        setMessage(
          error instanceof Error
            ? error.message
            : "The files arrived, but processing did not finish.",
        );
        return;
      }
      await associatePreparedFiles(preparedFileIds);
    } catch (error) {
      setPendingFileIds([...preparedFileIds]);
      setPhase("failed");
      setMessage(
        preparedFileIds.length > 0
          ? `Upload interrupted after ${preparedFileIds.length} of ${files.length} files. Continue to upload the remaining files without repeating completed uploads.`
          : error instanceof Error
            ? error.message
            : "The upload did not finish.",
      );
    }
  }

  async function retryFinalize() {
    if (pendingFileIds.length === 0 || busy) return;
    setPhase("processing");
    setMessage("");
    try {
      await Promise.all(
        pendingFileIds.map((fileId) => finalizePrivateUpload(fileId)),
      );
      await associatePreparedFiles(pendingFileIds);
    } catch (error) {
      setPhase("failed");
      setMessage(
        error instanceof Error ? error.message : "Processing did not finish.",
      );
    }
  }

  async function checkSynchronization() {
    if (phase !== "syncing" || !pendingCommand.current) return;
    if (configuration.kind === "file") {
      await associatePreparedFiles(pendingFileIds, true);
      return;
    }
    if (configuration.kind === "ack") {
      await submitResponse({ acknowledged: true, kind: "ack" }, true);
    } else if (configuration.kind === "link") {
      await submitResponse({ acknowledged: true, kind: "link" }, true);
    } else if (configuration.kind === "form") {
      await submitResponse(responseFromForm(detail, formValues), true);
    }
  }

  async function submitNonFile() {
    if (configuration.kind === "ack") {
      await submitResponse({ acknowledged: true, kind: "ack" });
    } else if (configuration.kind === "link") {
      await submitResponse({ acknowledged: true, kind: "link" });
    } else if (configuration.kind === "form") {
      await submitResponse(responseFromForm(detail, formValues));
    }
  }

  function setFormValue(fieldId: string, value: boolean | string) {
    pendingCommand.current = null;
    setFormValues((current) => ({ ...current, [fieldId]: value }));
  }

  return (
    <main className="task-completion task-completion--speaker">
      <a
        className="task-back-link"
        href={`/portal/${encodeURIComponent(detail.event.slug)}#portal-tasks`}
      >
        <ArrowLeft aria-hidden="true" size={15} /> Back to your tasks
      </a>
      <header className="task-page-header">
        <div>
          <p className="overline">
            {view.required ? "Required" : "Optional"} ·{" "}
            {configuration.kind === "file" ? "File request" : "Task response"}
          </p>
          <h1>{view.title}</h1>
          <p>{view.sessionTitle}</p>
        </div>
        <div className="task-header-status">
          <StatusPill tone={taskStateTone(detail)}>
            {taskStateLabel(detail)}
          </StatusPill>
          <small>{view.dueLabel}</small>
        </div>
      </header>
      <div className="task-workspace-grid">
        <div className="task-workspace-main">
          {currentFiles.length > 0 ? (
            <section
              className="task-submission-card"
              aria-labelledby="current-response-title"
            >
              <div className="task-card-heading">
                <div>
                  <p className="overline">Your current response</p>
                  <h2 id="current-response-title">
                    {currentFiles.length === 1
                      ? "Your file is "
                      : "Your files are "}
                    {detail.assignment.state === "submitted"
                      ? "waiting for review"
                      : "on file"}
                  </h2>
                </div>
                <StatusPill tone={taskStateTone(detail)}>
                  {taskStateLabel(detail)}
                </StatusPill>
              </div>
              {currentFiles.map((currentFile) => {
                const currentFileView = view.fileVersions.find(
                  ({ id }) => id === currentFile.id,
                );
                return currentFileView ? (
                  <div className="task-current-file" key={currentFile.id}>
                    <FileIdentity file={currentFileView} />
                    <div className="task-file-actions">
                      <Button
                        variant="secondary"
                        onClick={() => void download(currentFile.id)}
                      >
                        <Download aria-hidden="true" size={15} /> Download
                      </Button>
                    </div>
                  </div>
                ) : null;
              })}
            </section>
          ) : null}

          {configuration.kind === "file" ? (
            <section
              className="task-upload-card"
              aria-labelledby="task-response-title"
            >
              <div className="task-card-heading">
                <div>
                  <p className="overline">
                    {currentFiles.length > 0 ? "New version" : "Your response"}
                  </p>
                  <h2 id="task-response-title">
                    {currentFiles.length > 0
                      ? "Replace your current files"
                      : "Upload the requested files"}
                  </h2>
                </div>
              </div>
              {phase === "failed" &&
              files.length > 0 &&
              pendingFileIds.length === files.length ? (
                <div className="task-upload-failure" role="alert">
                  <AlertCircle aria-hidden="true" size={20} />
                  <div>
                    <strong>
                      The file arrived, but processing did not finish
                    </strong>
                    <p>
                      Retry processing without selecting or uploading the file
                      again.
                    </p>
                    <Button onClick={() => void retryFinalize()}>
                      <RefreshCw aria-hidden="true" size={15} /> Retry
                      processing
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <label
                    className={
                      fileError ? "task-dropzone has-error" : "task-dropzone"
                    }
                    htmlFor="task-production-file"
                  >
                    <span aria-hidden="true">
                      <UploadCloud size={25} />
                    </span>
                    <strong>
                      {files.length > 0
                        ? "Choose different files"
                        : configuration.max_files === 1
                          ? "Choose your file"
                          : "Choose your files"}
                    </strong>
                    <small>{view.filePolicy}</small>
                    <input
                      accept={configuration.extensions
                        .map((value) => `.${value}`)
                        .join(",")}
                      disabled={busy}
                      id="task-production-file"
                      multiple={configuration.max_files > 1}
                      onChange={(event) => chooseFiles(event.target.files)}
                      ref={inputRef}
                      type="file"
                    />
                  </label>
                  {fileError ? (
                    <p className="task-file-error" role="alert">
                      <AlertCircle size={15} /> {fileError}
                    </p>
                  ) : null}
                  {files.map((file) => (
                    <div
                      className="task-selected-file"
                      key={`${file.name}:${file.size}`}
                    >
                      <FileIdentity
                        file={{
                          fileName: file.name,
                          id: "selected",
                          mimeLabel: file.type.includes("pdf") ? "PDF" : "File",
                          sizeLabel: `${(file.size / 1024 / 1024).toFixed(1)} MB`,
                          submittedAt: "",
                          submittedBy: "",
                          version: 1,
                        }}
                      />
                      <CheckCircle2 aria-hidden="true" size={18} />
                    </div>
                  ))}
                </>
              )}
              {busy ? (
                <div className="task-upload-progress" role="status">
                  <div>
                    {phase === "uploading" ? (
                      <UploadCloud size={18} />
                    ) : (
                      <ShieldCheck size={18} />
                    )}
                    <span>
                      <strong>
                        {phase === "uploading"
                          ? "Uploading securely…"
                          : phase === "processing"
                            ? "Processing and scanning…"
                            : "Recording task response…"}
                      </strong>
                      <small>
                        The current task version changes only after finalization
                        succeeds.
                      </small>
                    </span>
                  </div>
                  <div
                    aria-label="Upload progress"
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={phase === "uploading" ? progress : 100}
                    className="task-progress-track"
                    role="progressbar"
                  >
                    <span
                      style={{
                        width: `${phase === "uploading" ? progress : 100}%`,
                      }}
                    />
                  </div>
                </div>
              ) : null}
              <div className="task-response-fields">
                <TextAreaField
                  disabled={busy}
                  id="task-file-notes"
                  label="Notes for the program team"
                  maxLength={2_000}
                  onChange={(event) => {
                    pendingCommand.current = null;
                    setNotes(event.target.value);
                  }}
                  rows={3}
                  value={notes}
                />
                <label className="task-acknowledgement">
                  <input
                    checked={acknowledged}
                    disabled={busy}
                    onChange={(event) => {
                      pendingCommand.current = null;
                      setAcknowledged(event.target.checked);
                    }}
                    type="checkbox"
                  />
                  <span>
                    <strong>
                      I confirm this is the file I want associated with this
                      task.
                    </strong>
                    Replacing it creates a new response version and starts a new
                    review.
                  </span>
                </label>
              </div>
              <div className="task-upload-actions">
                <Button
                  disabled={files.length === 0 || !acknowledged || busy}
                  onClick={() => void uploadFiles()}
                >
                  <UploadCloud aria-hidden="true" size={16} />{" "}
                  {currentFiles.length > 0
                    ? pendingFileIds.length > 0
                      ? "Continue replacement"
                      : "Submit replacement"
                    : pendingFileIds.length > 0
                      ? "Continue upload"
                      : "Submit files"}
                </Button>
                <small>
                  {currentFiles.length > 0
                    ? "Every replaced version stays in the task history."
                    : "The file is associated only after secure processing succeeds."}
                </small>
              </div>
            </section>
          ) : (
            <section
              className="task-upload-card"
              aria-labelledby="task-response-title"
            >
              <div className="task-card-heading">
                <div>
                  <p className="overline">Your response</p>
                  <h2 id="task-response-title">Complete this task</h2>
                </div>
              </div>
              {configuration.kind === "link" ? (
                <p className="task-production-copy">
                  <a href={configuration.url} rel="noreferrer" target="_blank">
                    Open the requested resource{" "}
                    <ExternalLink aria-hidden="true" size={14} />
                  </a>
                </p>
              ) : null}
              {configuration.kind === "form" ? (
                <div className="task-production-form">
                  {configuration.fields.map((field) =>
                    field.type === "checkbox" ? (
                      <label className="task-acknowledgement" key={field.id}>
                        <input
                          checked={formValues[field.id] === true}
                          onChange={(event) =>
                            setFormValue(field.id, event.target.checked)
                          }
                          type="checkbox"
                        />
                        <span>
                          <strong>{field.label}</strong>
                          {field.help_text}
                        </span>
                      </label>
                    ) : field.type === "select" ? (
                      <SelectField
                        id={`task-${field.id}`}
                        key={field.id}
                        label={field.label}
                        onChange={(event) =>
                          setFormValue(field.id, event.target.value)
                        }
                        options={[
                          { label: "Select an option", value: "" },
                          ...field.options.map((option) => ({
                            label: option,
                            value: option,
                          })),
                        ]}
                        required={field.required}
                        value={String(formValues[field.id] ?? "")}
                      />
                    ) : field.type === "textarea" ? (
                      <TextAreaField
                        description={field.help_text}
                        id={`task-${field.id}`}
                        key={field.id}
                        label={field.label}
                        maxLength={4_000}
                        onChange={(event) =>
                          setFormValue(field.id, event.target.value)
                        }
                        required={field.required}
                        rows={4}
                        value={String(formValues[field.id] ?? "")}
                      />
                    ) : (
                      <TextField
                        description={field.help_text}
                        id={`task-${field.id}`}
                        key={field.id}
                        label={field.label}
                        maxLength={4_000}
                        onChange={(event) =>
                          setFormValue(field.id, event.target.value)
                        }
                        required={field.required}
                        value={String(formValues[field.id] ?? "")}
                      />
                    ),
                  )}
                </div>
              ) : (
                <label className="task-acknowledgement">
                  <input
                    checked={acknowledged}
                    onChange={(event) => {
                      pendingCommand.current = null;
                      setAcknowledged(event.target.checked);
                    }}
                    type="checkbox"
                  />
                  <span>
                    <strong>{configuration.acknowledgement_label}</strong>Your
                    acknowledgement is recorded in the versioned task history.
                  </span>
                </label>
              )}
              <div className="task-upload-actions">
                <Button
                  disabled={
                    busy ||
                    !formComplete ||
                    (configuration.kind !== "form" && !acknowledged)
                  }
                  onClick={() => void submitNonFile()}
                >
                  <Check aria-hidden="true" size={16} /> Save response
                </Button>
              </div>
            </section>
          )}
          <VersionHistory view={view} />
        </div>
        <TaskBrief view={view} />
      </div>
      <div className="task-access-note">
        <LockKeyhole aria-hidden="true" size={16} />
        Downloads use short-lived receipts and current event authorization. Old
        or shared links cannot be reused.
      </div>
      <LiveRegion message={message} />
      {phase === "syncing" ? (
        <div className="task-sync-pending" role="status">
          <RefreshCw aria-hidden="true" size={18} />
          <span>
            <strong>Response recorded; readiness is synchronizing</strong>
            {message ||
              "The authority accepted this exact command. Check again to replay it safely and load the repaired task projection."}
          </span>
          <Button onClick={() => void checkSynchronization()}>
            Check task status
          </Button>
        </div>
      ) : null}
      {message && phase === "failed" ? (
        <p className="task-production-error" role="alert">
          {message}
        </p>
      ) : null}
    </main>
  );
}

function ResponseSummary({
  response,
}: {
  response: TaskSubmissionResponse | null;
}) {
  if (!response) return <p>No structured response is recorded yet.</p>;
  if (response.kind === "ack" || response.kind === "link") {
    return (
      <p className="organizer-acknowledgement">
        <CheckCircle2 size={17} />
        Speaker acknowledgement recorded.
      </p>
    );
  }
  if (response.kind === "file") {
    return (
      <dl>
        <DetailItem
          label="Files"
          value={`${response.file_ids.length} finalized`}
        />
        <DetailItem
          label="Notes"
          value={response.notes || "No notes provided"}
        />
      </dl>
    );
  }
  return (
    <dl>
      {response.answers.map((answer) => (
        <DetailItem
          key={answer.field_id}
          label={answer.field_id.replaceAll("_", " ")}
          value={
            Array.isArray(answer.value)
              ? answer.value.join(", ")
              : String(answer.value)
          }
        />
      ))}
    </dl>
  );
}

export function ProductionOrganizerTaskReviewWorkspace({
  assignmentId,
  eventKey,
}: {
  assignmentId: string;
  eventKey: string;
}) {
  const { port, retry, runtime, setDetail } = useTaskDetail(
    eventKey,
    assignmentId,
  );
  const [decision, setDecision] = useState<"approve" | "reject">("approve");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("");
  const [syncPending, setSyncPending] = useState(false);
  const pendingCommand = useRef<string | null>(null);
  if (runtime.state !== "ready") {
    return (
      <LoadingTask
        {...(runtime.error ? { error: runtime.error } : {})}
        onRetry={retry}
      />
    );
  }
  const detail = runtime.detail;
  const view = taskCompletionView(detail);
  const currentFiles = detail.files.filter(
    ({ status }) => status === "current",
  );

  async function download(fileId: string) {
    setError("");
    try {
      const refreshed = await port.detail(eventKey, assignmentId);
      setDetail(refreshed);
      const url = refreshed.files.find(({ id }) => id === fileId)?.download
        ?.url;
      if (!url) throw new Error("This file version is no longer available.");
      window.location.assign(url);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The download could not be prepared.",
      );
    }
  }

  async function review() {
    if (!reason.trim() || pending) {
      setError("Record a reason for this decision.");
      return;
    }
    const id = pendingCommand.current ?? commandId("task_review");
    pendingCommand.current = id;
    setPending(true);
    setError("");
    try {
      const outcome = await port.review(eventKey, assignmentId, {
        command_id: id,
        decision,
        expected_version: detail.assignment.version,
        reason,
        type: "review_assignment",
      });
      const receipt = outcome.receipt;
      if (outcome.repairPending) {
        setDialogOpen(false);
        setSyncPending(true);
        setMessage(
          `Decision recorded by authority · audit ${receipt.audit.id}. Readiness is still synchronizing.`,
        );
        return;
      }
      pendingCommand.current = null;
      setSyncPending(false);
      setDetail(receipt.detail);
      setDialogOpen(false);
      setMessage(
        `${decision === "approve" ? "Approved" : "Changes requested"} · audit ${receipt.audit.id} · readiness ${receipt.detail.readiness.ratio.complete}/${receipt.detail.readiness.ratio.total}`,
      );
    } catch (cause) {
      if (
        cause instanceof TaskCompletionApiError &&
        cause.code === "task_version_conflict"
      ) {
        pendingCommand.current = null;
        setSyncPending(false);
        try {
          const refreshed = await port.detail(eventKey, assignmentId);
          setDetail(refreshed);
          setDialogOpen(false);
          setReason("");
          setMessage("");
          setError(
            "This task changed during review. The latest response is loaded; review it before recording a new decision.",
          );
          return;
        } catch (refreshError) {
          setDialogOpen(false);
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : "The task changed, but the latest response could not be loaded.",
          );
          return;
        }
      }
      setError(
        cause instanceof TaskCompletionApiError
          ? cause.message
          : "The decision was not recorded.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="task-completion task-completion--organizer">
      <a
        className="task-back-link"
        href={`/app/${encodeURIComponent(eventKey)}/people`}
      >
        <ArrowLeft size={15} /> Back to speaker readiness
      </a>
      <header className="task-page-header organizer-task-header">
        <div>
          <p className="overline">
            {view.speakerName} ·{" "}
            {view.required ? "Required task" : "Optional task"}
          </p>
          <h1>Review {view.title.toLocaleLowerCase("en-US")}</h1>
          <p>{view.sessionTitle}</p>
        </div>
        <div className="task-header-status">
          <StatusPill tone={taskStateTone(detail)}>
            {taskStateLabel(detail)}
          </StatusPill>
          <small>{view.dueLabel}</small>
        </div>
      </header>
      <section className="organizer-task-summary" aria-label="Review summary">
        <article>
          <span>
            <UserRoundCheck size={19} />
          </span>
          <small>Speaker readiness</small>
          <strong>
            {detail.readiness.ratio.complete} / {detail.readiness.ratio.total}
          </strong>
          <p>{detail.readiness.explanation}</p>
        </article>
        <article>
          <span>
            <Clock3 size={19} />
          </span>
          <small>Due status</small>
          <strong>{detail.overdue ? "Late" : "On time"}</strong>
          <p>{view.dueLabel}</p>
        </article>
        <article>
          <span>
            <FileCheck2 size={19} />
          </span>
          <small>Current version</small>
          <strong>
            {currentFiles.length > 0
              ? `${currentFiles.length} ${currentFiles.length === 1 ? "file" : "files"}`
              : "—"}
          </strong>
          <p>
            {currentFiles.length > 0
              ? "Finalized and verified"
              : "No file response"}
          </p>
        </article>
      </section>
      <div className="organizer-review-grid">
        <div className="organizer-review-main">
          {currentFiles.length > 0 ? (
            <section
              className="organizer-file-card"
              aria-labelledby="review-file-title"
            >
              <div className="task-card-heading">
                <div>
                  <p className="overline">Submitted file</p>
                  <h2 id="review-file-title">Current response file</h2>
                </div>
                <StatusPill tone={taskStateTone(detail)}>
                  {taskStateLabel(detail)}
                </StatusPill>
              </div>
              <div className="organizer-file-preview">
                <div aria-hidden="true" className="organizer-slide-preview">
                  <span>{view.eventName}</span>
                  <strong>{view.title}</strong>
                  <small>{view.speakerName}</small>
                </div>
                <div>
                  {currentFiles.map((currentFile) => {
                    const fileView = view.fileVersions.find(
                      ({ id }) => id === currentFile.id,
                    );
                    return fileView ? (
                      <div className="organizer-file-item" key={currentFile.id}>
                        <FileIdentity file={fileView} />
                        <dl className="organizer-file-metadata">
                          <DetailItem
                            label="Version"
                            value={`Version ${currentFile.version}`}
                          />
                          <DetailItem
                            label="Submitted by"
                            value={view.speakerName}
                          />
                          <DetailItem
                            label="Finalized"
                            value={fileView.submittedAt}
                          />
                          <DetailItem
                            label="Security scan"
                            value={
                              currentFile.detected_mime_type
                                ? "Passed"
                                : "Unavailable"
                            }
                          />
                        </dl>
                        <div className="task-file-actions">
                          <Button
                            variant="secondary"
                            onClick={() => void download(currentFile.id)}
                          >
                            <Download size={15} /> Authorized download
                          </Button>
                        </div>
                      </div>
                    ) : null;
                  })}
                </div>
              </div>
              <div className="task-access-note">
                <LockKeyhole size={16} />
                This view exposes safe metadata and a short-lived receipt, never
                a storage key or reusable object URL.
              </div>
            </section>
          ) : null}
          <section
            className="organizer-response-card"
            aria-labelledby="response-title"
          >
            <div className="task-card-heading">
              <div>
                <p className="overline">Structured response</p>
                <h2 id="response-title">Speaker handoff</h2>
              </div>
              <StatusPill tone="neutral">
                Version {detail.assignment.version}
              </StatusPill>
            </div>
            <ResponseSummary response={detail.current_response} />
          </section>
          <VersionHistory view={view} />
        </div>
        <aside
          className="organizer-decision-card"
          aria-labelledby="decision-title"
        >
          <div>
            <p className="overline">Decision</p>
            <h2 id="decision-title">
              {detail.assignment.state === "submitted"
                ? "Ready for your review"
                : taskStateLabel(detail)}
            </h2>
            <p>
              Approve the current response or give the speaker a specific reason
              to replace it. Every decision is version-checked and audited.
            </p>
          </div>
          {detail.assignment.state === "submitted" ? (
            <div className="organizer-decision-actions">
              {syncPending ? (
                <div className="task-sync-pending" role="status">
                  <RefreshCw aria-hidden="true" size={18} />
                  <span>
                    <strong>
                      Decision recorded; projection is synchronizing
                    </strong>
                    Check again to replay the same audited command and load the
                    repaired readiness projection.
                  </span>
                  <Button disabled={pending} onClick={() => void review()}>
                    {pending ? "Checking…" : "Check task status"}
                  </Button>
                </div>
              ) : null}
              <Button
                disabled={syncPending}
                onClick={() => {
                  pendingCommand.current = null;
                  setSyncPending(false);
                  setDecision("approve");
                  setReason("");
                  setError("");
                  setDialogOpen(true);
                }}
              >
                <Check size={16} /> Approve response
              </Button>
              <Button
                disabled={syncPending}
                variant="secondary"
                onClick={() => {
                  pendingCommand.current = null;
                  setSyncPending(false);
                  setDecision("reject");
                  setReason("");
                  setError("");
                  setDialogOpen(true);
                }}
              >
                <XCircle size={16} /> Request changes
              </Button>
            </div>
          ) : (
            <div
              className={`organizer-decision-result ${detail.assignment.state === "approved" ? "is-approved" : "is-rejected"}`}
              role="status"
            >
              <CheckCircle2 size={19} />
              <span>
                <strong>{taskStateLabel(detail)}</strong>The current projection
                and readiness are up to date.
              </span>
            </div>
          )}
          <div className="organizer-task-policy">
            <ShieldCheck size={18} />
            <span>
              <strong>
                {detail.assignment.approval_required
                  ? "Required approval"
                  : "No approval required"}
              </strong>
              {detail.assignment.approval_required
                ? "This task counts toward readiness only after approval."
                : "Submission completes this task immediately."}
            </span>
          </div>
          <section className="organizer-audit" aria-labelledby="audit-title">
            <h3 id="audit-title">Task history</h3>
            <ol>
              {[...detail.assignment.history].reverse().map((entry) => (
                <li key={`${entry.command_id}:${entry.version}`}>
                  <span />
                  <p>
                    <strong>
                      {entry.from} → {entry.to}
                    </strong>
                    <small>
                      {entry.at} ·{" "}
                      {entry.reason ?? "No private response data in audit"}
                    </small>
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
      {error ? (
        <p className="task-production-error" role="alert">
          {error}
        </p>
      ) : null}
      <LiveRegion message={message} />
      <Dialog
        description="The reason is retained with this versioned decision and shown in task history."
        onClose={() => !pending && setDialogOpen(false)}
        open={dialogOpen}
        title={
          decision === "approve" ? "Approve this response" : "Request changes"
        }
      >
        <div className="organizer-reject-form">
          <TextAreaField
            disabled={pending}
            error={error}
            id="task-review-reason"
            label="Decision reason"
            maxLength={2_000}
            onChange={(event) => {
              pendingCommand.current = null;
              setSyncPending(false);
              setReason(event.target.value);
              setError("");
            }}
            required
            rows={4}
            value={reason}
          />
          <div>
            <Button
              disabled={pending}
              variant="secondary"
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => void review()}>
              {pending
                ? "Recording…"
                : decision === "approve"
                  ? "Approve response"
                  : "Send request"}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

export function ProductionOrganizerTaskPage(props: {
  assignmentId: string;
  eventKey: string;
}) {
  return (
    <AppShell
      environment={null}
      isDemoEvent={false}
      onResetDemo={async () => {
        throw new Error("Demo reset is unavailable on this route.");
      }}
    >
      <ProductionOrganizerTaskReviewWorkspace {...props} />
    </AppShell>
  );
}
