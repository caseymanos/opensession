import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  FileCheck2,
  FileText,
  History,
  Info,
  LockKeyhole,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  UploadCloud,
  UserRoundCheck,
  XCircle,
} from "lucide-react";

import {
  Button,
  Dialog,
  LiveRegion,
  SelectField,
  StatusPill,
  TextAreaField,
  ToastRegion,
  type ToastMessage,
} from "@sessionbox-killer/ui";

import {
  taskCompletionFixture,
  type TaskFileVersionView,
} from "./taskCompletionModel";

import "./task-completion.css";

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ACCEPTED_FILE_TYPES = new Map([
  [".pdf", "application/pdf"],
  [
    ".pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
]);

type UploadPhase =
  "idle" | "ready" | "uploading" | "processing" | "failed" | "submitted";

export type TaskFixtureState = "default" | "failed";

interface SelectedFileView {
  fileName: string;
  mimeLabel: string;
  sizeLabel: string;
}

function formatFileSize(size: number) {
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function fileExtension(fileName: string) {
  const index = fileName.lastIndexOf(".");
  return index >= 0 ? fileName.slice(index).toLowerCase() : "";
}

function fileTypeLabel(fileName: string) {
  const extension = fileExtension(fileName);
  return extension === ".pdf" ? "PDF" : "PowerPoint";
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function FileIdentity({
  file,
  state,
}: {
  file: SelectedFileView | TaskFileVersionView;
  state?: string;
}) {
  return (
    <div className="task-file-identity">
      <span aria-hidden="true">
        <FileText size={22} />
      </span>
      <div>
        <strong>{file.fileName}</strong>
        <small>
          {file.mimeLabel} · {file.sizeLabel}
          {state ? ` · ${state}` : ""}
        </small>
      </div>
    </div>
  );
}

function TaskBrief() {
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
      <p>{taskCompletionFixture.description}</p>
      <section>
        <strong>Why this matters</strong>
        <p>{taskCompletionFixture.whyItMatters}</p>
      </section>
      <dl>
        <DetailItem label="For" value={taskCompletionFixture.sessionTitle} />
        <DetailItem label="Due" value={taskCompletionFixture.dueLabel} />
        <DetailItem
          label="Requirement"
          value={taskCompletionFixture.required ? "Required" : "Optional"}
        />
        <DetailItem label="Completion" value="Program-team approval required" />
      </dl>
      <div className="task-brief-contact">
        <MessageSquareText aria-hidden="true" size={17} />
        <span>
          <strong>Questions about the task?</strong>
          <a href={`mailto:${taskCompletionFixture.contactEmail}`}>
            {taskCompletionFixture.contactEmail}
          </a>
        </span>
      </div>
    </aside>
  );
}

function validateFile(file: File) {
  const expectedContentType = ACCEPTED_FILE_TYPES.get(fileExtension(file.name));
  if (!expectedContentType) {
    return "Choose a PDF or PPTX file.";
  }

  if (file.type && file.type !== expectedContentType) {
    return "The file type does not match its PDF or PPTX extension.";
  }

  if (file.size > MAX_FILE_SIZE) {
    return "Choose a file smaller than 50 MB.";
  }

  return "";
}

function VersionHistory({
  newestVersion,
}: {
  newestVersion: TaskFileVersionView;
}) {
  const currentVersion = taskCompletionFixture.fileVersions[0].version;
  const history = [
    newestVersion,
    ...(newestVersion.version > currentVersion
      ? taskCompletionFixture.fileVersions
      : taskCompletionFixture.fileVersions.slice(1)),
  ];

  return (
    <section
      className="task-version-history"
      aria-labelledby="task-version-history-title"
    >
      <div className="task-section-heading">
        <span aria-hidden="true">
          <History size={17} />
        </span>
        <div>
          <h3 id="task-version-history-title">Version history</h3>
          <p>Only the latest submitted file can be approved.</p>
        </div>
      </div>
      <ol>
        {history.map((version, index) => (
          <li key={version.id}>
            <span aria-hidden="true" />
            <div>
              <strong>
                Version {version.version}
                {index === 0 ? " · current" : " · replaced"}
              </strong>
              <p>{version.fileName}</p>
              <small>{version.submittedAt}</small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function SpeakerTaskWorkspace({
  fixtureState = "default",
}: {
  fixtureState?: TaskFixtureState;
}) {
  const initialFailedFile: SelectedFileView = {
    fileName: "mina-production-agents-v4.pdf",
    mimeLabel: "PDF",
    sizeLabel: "9.1 MB",
  };
  const [replacementOpen, setReplacementOpen] = useState(
    fixtureState === "failed",
  );
  const [selectedFile, setSelectedFile] = useState<SelectedFileView | null>(
    fixtureState === "failed" ? initialFailedFile : null,
  );
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>(
    fixtureState === "failed" ? "failed" : "idle",
  );
  const [fileError, setFileError] = useState("");
  const [deliveryMode, setDeliveryMode] = useState("presenter-laptop");
  const [notes, setNotes] = useState(
    "Embedded demo video includes open captions. Please use the event confidence monitor.",
  );
  const [acknowledged, setAcknowledged] = useState(true);
  const [downloadMessage, setDownloadMessage] = useState("");
  const [submittedFile, setSubmittedFile] = useState<SelectedFileView | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (uploadPhase !== "uploading" && uploadPhase !== "processing") {
      return;
    }

    const nextPhase = uploadPhase === "uploading" ? "processing" : "submitted";
    const timeout = window.setTimeout(
      () => {
        setUploadPhase(nextPhase);
        if (nextPhase === "submitted" && selectedFile) {
          setSubmittedFile(selectedFile);
          setReplacementOpen(false);
        }
      },
      uploadPhase === "uploading" ? 450 : 650,
    );

    return () => window.clearTimeout(timeout);
  }, [selectedFile, uploadPhase]);

  const activeVersion = useMemo<TaskFileVersionView>(() => {
    if (!submittedFile) {
      return taskCompletionFixture.fileVersions[0];
    }

    return {
      ...submittedFile,
      id: "file-version-4",
      submittedAt: "Submitted just now",
      submittedBy: taskCompletionFixture.speakerName,
      version: 4,
    };
  }, [submittedFile]);

  const busy = uploadPhase === "uploading" || uploadPhase === "processing";

  function chooseFile(file: File | undefined) {
    if (!file) return;

    const error = validateFile(file);
    if (error) {
      setFileError(error);
      setSelectedFile(null);
      setUploadPhase("idle");
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    setFileError("");
    setSelectedFile({
      fileName: file.name,
      mimeLabel: fileTypeLabel(file.name),
      sizeLabel: formatFileSize(file.size),
    });
    setUploadPhase("ready");
  }

  function beginUpload() {
    if (!selectedFile || !acknowledged) return;
    setUploadPhase("uploading");
  }

  function retryFinalize() {
    setUploadPhase("processing");
  }

  return (
    <main className="task-completion task-completion--speaker">
      <a
        className="task-back-link"
        href="/portal/ai-engineer-summit#portal-tasks"
      >
        <ArrowLeft aria-hidden="true" size={15} /> Back to your tasks
      </a>

      <header className="task-page-header">
        <div>
          <p className="overline">Required · File request</p>
          <h1>{taskCompletionFixture.title}</h1>
          <p>{taskCompletionFixture.sessionTitle}</p>
        </div>
        <div className="task-header-status">
          <StatusPill tone={uploadPhase === "failed" ? "warning" : "preview"}>
            {uploadPhase === "failed" ? "Action needed" : "Needs approval"}
          </StatusPill>
          <small>{taskCompletionFixture.dueLabel}</small>
        </div>
      </header>

      <div className="task-workspace-grid">
        <div className="task-workspace-main">
          <section
            className="task-submission-card"
            aria-labelledby="submission-title"
          >
            <div className="task-card-heading">
              <div>
                <p className="overline">Your submission</p>
                <h2 id="submission-title">
                  Version {activeVersion.version} is waiting for review
                </h2>
              </div>
              <StatusPill tone="warning">Submitted</StatusPill>
            </div>

            <div className="task-current-file">
              <FileIdentity file={activeVersion} state="Virus scan passed" />
              <div className="task-file-actions">
                <Button
                  variant="secondary"
                  onClick={() =>
                    setDownloadMessage(
                      `Authorized download prepared for ${activeVersion.fileName}.`,
                    )
                  }
                >
                  <Download aria-hidden="true" size={15} /> Download
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setReplacementOpen(true);
                    setUploadPhase("idle");
                    setSelectedFile(null);
                    setFileError("");
                  }}
                >
                  <RefreshCw aria-hidden="true" size={15} /> Replace file
                </Button>
              </div>
            </div>

            <div className="task-review-note">
              <Clock3 aria-hidden="true" size={17} />
              <span>
                <strong>Submitted {activeVersion.submittedAt}</strong>
                The program team is usually able to review files within one
                business day.
              </span>
            </div>
          </section>

          {replacementOpen ? (
            <section
              className="task-upload-card"
              aria-labelledby="replacement-title"
            >
              <div className="task-card-heading">
                <div>
                  <p className="overline">New version</p>
                  <h2 id="replacement-title">Replace your current file</h2>
                </div>
                <button
                  aria-label="Cancel file replacement"
                  disabled={busy}
                  onClick={() => setReplacementOpen(false)}
                  type="button"
                >
                  ×
                </button>
              </div>

              {uploadPhase === "failed" ? (
                <div className="task-upload-failure" role="alert">
                  <AlertCircle aria-hidden="true" size={20} />
                  <div>
                    <strong>
                      The file arrived, but processing did not finish
                    </strong>
                    <p>
                      Your upload is safe. Retry processing without selecting or
                      uploading the file again.
                    </p>
                    {selectedFile ? <FileIdentity file={selectedFile} /> : null}
                    <Button onClick={retryFinalize}>
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
                    htmlFor="task-file-input"
                  >
                    <span aria-hidden="true">
                      <UploadCloud size={25} />
                    </span>
                    <strong>
                      {selectedFile
                        ? "Choose a different file"
                        : "Choose your file"}
                    </strong>
                    <small>{taskCompletionFixture.filePolicy}</small>
                    <input
                      accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                      id="task-file-input"
                      onChange={(event) => chooseFile(event.target.files?.[0])}
                      ref={inputRef}
                      type="file"
                    />
                  </label>
                  {fileError ? (
                    <p className="task-file-error" role="alert">
                      <AlertCircle aria-hidden="true" size={15} /> {fileError}
                    </p>
                  ) : null}
                  {selectedFile ? (
                    <div className="task-selected-file">
                      <FileIdentity
                        file={selectedFile}
                        state="Ready to upload"
                      />
                      <CheckCircle2 aria-hidden="true" size={18} />
                    </div>
                  ) : null}
                </>
              )}

              {busy ? (
                <div className="task-upload-progress" role="status">
                  <div>
                    {uploadPhase === "uploading" ? (
                      <UploadCloud aria-hidden="true" size={18} />
                    ) : (
                      <ShieldCheck aria-hidden="true" size={18} />
                    )}
                    <span>
                      <strong>
                        {uploadPhase === "uploading"
                          ? "Uploading securely…"
                          : "Processing and scanning…"}
                      </strong>
                      <small>
                        {uploadPhase === "uploading"
                          ? "Keep this page open until processing begins."
                          : "The new version will appear automatically."}
                      </small>
                    </span>
                  </div>
                  <div
                    aria-label={
                      uploadPhase === "uploading"
                        ? "Upload 64 percent complete"
                        : "Processing file"
                    }
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={uploadPhase === "uploading" ? 64 : 92}
                    className="task-progress-track"
                    role="progressbar"
                  >
                    <span
                      style={{
                        width: uploadPhase === "uploading" ? "64%" : "92%",
                      }}
                    />
                  </div>
                </div>
              ) : null}

              <div className="task-response-fields">
                <SelectField
                  disabled={busy}
                  id="task-delivery-mode"
                  label="How will you present?"
                  onChange={(event) => setDeliveryMode(event.target.value)}
                  options={[
                    {
                      label: "From my own laptop",
                      value: "presenter-laptop",
                    },
                    { label: "From the event laptop", value: "event-laptop" },
                    { label: "I need help deciding", value: "needs-help" },
                  ]}
                  value={deliveryMode}
                />
                <TextAreaField
                  disabled={busy}
                  id="task-production-notes"
                  label="Production or accessibility notes"
                  maxLength={500}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={3}
                  value={notes}
                />
                <label className="task-acknowledgement">
                  <input
                    checked={acknowledged}
                    disabled={busy}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    <strong>
                      I confirm this is the version I plan to present.
                    </strong>
                    Replacing it starts a new program-team review.
                  </span>
                </label>
              </div>

              {uploadPhase !== "failed" ? (
                <div className="task-upload-actions">
                  <Button
                    disabled={!selectedFile || !acknowledged || busy}
                    onClick={beginUpload}
                  >
                    <UploadCloud aria-hidden="true" size={16} /> Submit
                    replacement
                  </Button>
                  <small>
                    Version {activeVersion.version} remains available until the
                    new file finishes processing.
                  </small>
                </div>
              ) : null}
            </section>
          ) : null}

          <VersionHistory newestVersion={activeVersion} />
        </div>

        <TaskBrief />
      </div>

      <div className="task-access-note">
        <LockKeyhole aria-hidden="true" size={16} />
        Downloads are checked against your current event access. Old or shared
        links cannot be reused.
      </div>
      <LiveRegion message={downloadMessage} />
    </main>
  );
}

type ReviewDecision = "pending" | "approved" | "rejected";

function ReviewStatus({ decision }: { decision: ReviewDecision }) {
  if (decision === "approved") {
    return <StatusPill tone="success">Approved</StatusPill>;
  }
  if (decision === "rejected") {
    return <StatusPill tone="warning">Changes requested</StatusPill>;
  }
  return <StatusPill tone="preview">Awaiting review</StatusPill>;
}

export function OrganizerTaskReviewWorkspace() {
  const [decision, setDecision] = useState<ReviewDecision>("pending");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState("");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const file = taskCompletionFixture.fileVersions[0];

  function approve() {
    if (decision === "approved") return;
    setDecision("approved");
    setToasts([
      {
        id: "slides-approved",
        message:
          "Mina is now 5 of 5 required tasks complete. The readiness view updated immediately.",
        title: "Presentation approved",
        tone: "success",
      },
    ]);
  }

  function reject() {
    if (!rejectReason.trim()) {
      setRejectError("Explain what Mina needs to change.");
      return;
    }
    setDecision("rejected");
    setRejectOpen(false);
    setRejectError("");
    setToasts([
      {
        id: "slides-rejected",
        message:
          "Mina can see the reason and replace the file. Readiness remains 4 of 5.",
        title: "Changes requested",
      },
    ]);
  }

  const readinessCopy =
    decision === "approved"
      ? { detail: "All required tasks complete", value: "5 / 5" }
      : decision === "rejected"
        ? { detail: "Replacement requested", value: "4 / 5" }
        : { detail: "Approval will make Mina ready", value: "4 / 5" };

  return (
    <div className="task-completion task-completion--organizer">
      <a className="task-back-link" href="/app/ai-engineer-summit/people">
        <ArrowLeft aria-hidden="true" size={15} /> Back to speaker readiness
      </a>

      <header className="task-page-header organizer-task-header">
        <div>
          <p className="overline">Mina Okafor · Required task</p>
          <h1>Review final presentation</h1>
          <p>{taskCompletionFixture.sessionTitle}</p>
        </div>
        <div className="task-header-status">
          <ReviewStatus decision={decision} />
          <small>Submitted August 8 at 4:18 PM PDT</small>
        </div>
      </header>

      <section className="organizer-task-summary" aria-label="Review summary">
        <article>
          <span aria-hidden="true">
            <UserRoundCheck size={19} />
          </span>
          <small>Speaker readiness</small>
          <strong>{readinessCopy.value}</strong>
          <p>{readinessCopy.detail}</p>
        </article>
        <article>
          <span aria-hidden="true">
            <Clock3 size={19} />
          </span>
          <small>Response time</small>
          <strong>19 hr</strong>
          <p>Overdue submission</p>
        </article>
        <article>
          <span aria-hidden="true">
            <FileCheck2 size={19} />
          </span>
          <small>Current version</small>
          <strong>v{file.version}</strong>
          <p>Scan passed</p>
        </article>
      </section>

      <div className="organizer-review-grid">
        <div className="organizer-review-main">
          <section
            className="organizer-file-card"
            aria-labelledby="review-file-title"
          >
            <div className="task-card-heading">
              <div>
                <p className="overline">Submitted file</p>
                <h2 id="review-file-title">Presentation deck</h2>
              </div>
              <ReviewStatus decision={decision} />
            </div>
            <div className="organizer-file-preview">
              <div aria-hidden="true" className="organizer-slide-preview">
                <span>AI Engineer Summit</span>
                <strong>The reliability gap</strong>
                <small>Mina Okafor · Northstar Labs</small>
              </div>
              <div>
                <FileIdentity file={file} />
                <dl className="organizer-file-metadata">
                  <DetailItem
                    label="Version"
                    value={`Version ${file.version}`}
                  />
                  <DetailItem label="Submitted by" value={file.submittedBy} />
                  <DetailItem label="Submitted" value={file.submittedAt} />
                  <DetailItem label="Security scan" value="Passed" />
                </dl>
                <div className="task-file-actions">
                  <Button variant="secondary">
                    <FileText aria-hidden="true" size={15} /> Open preview
                  </Button>
                  <Button variant="secondary">
                    <Download aria-hidden="true" size={15} /> Authorized
                    download
                  </Button>
                </div>
              </div>
            </div>
            <div className="task-access-note">
              <LockKeyhole aria-hidden="true" size={16} />
              Access is checked when the file opens. This view exposes file
              metadata, never a storage key or reusable object URL.
            </div>
          </section>

          <section
            className="organizer-response-card"
            aria-labelledby="response-title"
          >
            <div className="task-card-heading">
              <div>
                <p className="overline">Structured response</p>
                <h2 id="response-title">Production handoff</h2>
              </div>
              <StatusPill tone="neutral">2 responses</StatusPill>
            </div>
            <dl>
              <DetailItem
                label="Presentation source"
                value="Presenter laptop"
              />
              <DetailItem
                label="Production or accessibility notes"
                value="Embedded demo video includes open captions. Please use the event confidence monitor."
              />
            </dl>
            <p className="organizer-acknowledgement">
              <CheckCircle2 aria-hidden="true" size={17} />
              Mina confirmed this is the version she plans to present.
            </p>
          </section>
        </div>

        <aside
          className="organizer-decision-card"
          aria-labelledby="decision-title"
        >
          <div>
            <p className="overline">Decision</p>
            <h2 id="decision-title">
              {decision === "pending"
                ? "Ready for your review"
                : decision === "approved"
                  ? "Presentation approved"
                  : "Replacement requested"}
            </h2>
            <p>
              {decision === "pending"
                ? "Approve the current version or give Mina a specific reason to replace it."
                : decision === "approved"
                  ? "Version 3 is the approved show-day backup. Repeating this decision will not create another event."
                  : `Mina can see your note: “${rejectReason}”`}
            </p>
          </div>
          {decision === "pending" ? (
            <div className="organizer-decision-actions">
              <Button onClick={approve}>
                <Check aria-hidden="true" size={16} /> Approve version 3
              </Button>
              <Button variant="secondary" onClick={() => setRejectOpen(true)}>
                <XCircle aria-hidden="true" size={16} /> Request changes
              </Button>
            </div>
          ) : (
            <div
              className={
                decision === "approved"
                  ? "organizer-decision-result is-approved"
                  : "organizer-decision-result is-rejected"
              }
              role="status"
            >
              {decision === "approved" ? (
                <CheckCircle2 aria-hidden="true" size={19} />
              ) : (
                <AlertCircle aria-hidden="true" size={19} />
              )}
              <span>
                <strong>
                  {decision === "approved"
                    ? "Ready for show day"
                    : "Speaker notified"}
                </strong>
                Recorded just now by Casey Manos
              </span>
            </div>
          )}

          <div className="organizer-task-policy">
            <ShieldCheck aria-hidden="true" size={18} />
            <span>
              <strong>Required approval</strong>
              This task contributes to readiness only after an organizer
              approves the latest version.
            </span>
          </div>

          <section className="organizer-audit" aria-labelledby="audit-title">
            <h3 id="audit-title">Task history</h3>
            <ol>
              {decision !== "pending" ? (
                <li>
                  <span aria-hidden="true" />
                  <p>
                    <strong>
                      {decision === "approved"
                        ? "Version approved"
                        : "Changes requested"}
                    </strong>
                    <small>Just now · Casey Manos</small>
                  </p>
                </li>
              ) : null}
              <li>
                <span aria-hidden="true" />
                <p>
                  <strong>Version 3 submitted</strong>
                  <small>Aug 8, 4:18 PM · Mina Okafor</small>
                </p>
              </li>
              <li>
                <span aria-hidden="true" />
                <p>
                  <strong>Version 2 replaced</strong>
                  <small>Aug 6, 11:42 AM · Mina Okafor</small>
                </p>
              </li>
            </ol>
          </section>
        </aside>
      </div>

      <Dialog
        description="Mina will see this note in the portal and can upload a replacement."
        onClose={() => {
          setRejectOpen(false);
          setRejectError("");
        }}
        open={rejectOpen}
        title="Request changes to version 3"
      >
        <div className="organizer-reject-form">
          <TextAreaField
            error={rejectError}
            id="task-reject-reason"
            label="Reason for requesting changes"
            onChange={(event) => {
              setRejectReason(event.target.value);
              if (event.target.value.trim()) setRejectError("");
            }}
            placeholder="For example: Please embed the demo video and export the deck again."
            required
            rows={4}
            value={rejectReason}
          />
          <div>
            <Button variant="secondary" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button onClick={reject}>Send request</Button>
          </div>
        </div>
      </Dialog>

      <ToastRegion
        messages={toasts}
        onDismiss={(id) =>
          setToasts((current) => current.filter((toast) => toast.id !== id))
        }
      />
    </div>
  );
}
