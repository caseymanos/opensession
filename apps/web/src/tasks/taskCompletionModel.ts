import type { TaskAssignmentDetail } from "@sessionbox-killer/contracts/tasks";

export interface TaskFileVersionView {
  fileName: string;
  id: string;
  mimeLabel: string;
  sizeLabel: string;
  submittedAt: string;
  submittedBy: string;
  status?: "current" | "replaced" | "unavailable";
  version: number;
}

export interface TaskCompletionView {
  approvalPolicy: string;
  contactEmail: string;
  description: string;
  dueLabel: string;
  eventName: string;
  filePolicy: string;
  fileVersions: [TaskFileVersionView, ...TaskFileVersionView[]];
  id: string;
  required: boolean;
  sessionTitle: string;
  speakerName: string;
  title: string;
  whyItMatters: string;
}

export const taskCompletionFixture: TaskCompletionView = {
  approvalPolicy:
    "The program team reviews each replacement. Your task is complete only after approval.",
  contactEmail: "speakers@aiengineersummit.com",
  description:
    "Send the deck you plan to present so the production team can verify format, fonts, video, and accessibility before show day.",
  dueLabel: "Overdue by 2 days · due August 7 at 5:00 PM PDT",
  eventName: "AI Engineer Summit",
  filePolicy: "PDF or PPTX · 50 MB maximum · one active file",
  fileVersions: [
    {
      fileName: "mina-production-agents-v3.pdf",
      id: "file-version-3",
      mimeLabel: "PDF",
      sizeLabel: "8.4 MB",
      submittedAt: "August 8, 2026 at 4:18 PM PDT",
      submittedBy: "Mina Okafor",
      version: 3,
    },
    {
      fileName: "mina-production-agents-v2.pdf",
      id: "file-version-2",
      mimeLabel: "PDF",
      sizeLabel: "7.9 MB",
      submittedAt: "August 6, 2026 at 11:42 AM PDT",
      submittedBy: "Mina Okafor",
      version: 2,
    },
  ],
  id: "final-slides",
  required: true,
  sessionTitle: "The Reliability Gap in Production Agents",
  speakerName: "Mina Okafor",
  title: "Upload your final presentation",
  whyItMatters:
    "Submitting now gives production time to test your deck and preserves a reviewed backup if your laptop cannot be used on stage.",
};

export interface TaskCompletionProductionView extends Omit<
  TaskCompletionView,
  "fileVersions"
> {
  approvalRequired: boolean;
  detail: TaskAssignmentDetail;
  fileVersions: TaskFileVersionView[];
  state: TaskAssignmentDetail["assignment"]["state"];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
}

function dueLabel(detail: TaskAssignmentDetail): string {
  const dueAt = detail.assignment.due_at;
  if (!dueAt) return "No due date";
  const formatted = formatDate(dueAt, detail.event.timezone);
  return detail.overdue ? `Overdue · due ${formatted}` : `Due ${formatted}`;
}

function filePolicy(detail: TaskAssignmentDetail): string {
  const configuration = detail.definition.configuration;
  if (configuration.kind !== "file") return "No file requested";
  const extensions = configuration.extensions
    .map((extension) => extension.toLocaleUpperCase("en-US"))
    .join(" or ");
  return `${extensions} · ${formatBytes(configuration.max_bytes)} maximum · ${configuration.max_files} ${configuration.max_files === 1 ? "active file" : "active files"}`;
}

export function taskCompletionView(
  detail: TaskAssignmentDetail,
): TaskCompletionProductionView {
  return {
    approvalPolicy: detail.assignment.approval_required
      ? "The program team reviews each response. This task is complete only after approval."
      : "Your response completes this task immediately and remains in the task history.",
    approvalRequired: detail.assignment.approval_required,
    contactEmail: detail.speaker.email,
    description: detail.definition.description,
    detail,
    dueLabel: dueLabel(detail),
    eventName: detail.event.name,
    filePolicy: filePolicy(detail),
    fileVersions: detail.files.map((file) => ({
      fileName: file.display_filename,
      id: file.id,
      mimeLabel:
        file.declared_mime_type === "application/pdf"
          ? "PDF"
          : file.declared_mime_type.includes("presentation")
            ? "PowerPoint"
            : (file.declared_mime_type.split("/").at(-1)?.toUpperCase() ??
              "File"),
      sizeLabel: formatBytes(file.byte_size),
      submittedAt: file.finalized_at
        ? formatDate(file.finalized_at, detail.event.timezone)
        : "Processing",
      submittedBy: detail.speaker.display_name,
      status: file.status,
      version: file.version,
    })),
    id: detail.assignment.assignment_id,
    required: detail.assignment.required,
    sessionTitle: detail.session?.title ?? "General speaker task",
    speakerName: detail.speaker.display_name,
    state: detail.assignment.state,
    title: detail.definition.name,
    whyItMatters: detail.definition.required
      ? "This response contributes directly to speaker readiness for the event."
      : "This optional response helps the program team prepare a smoother event experience.",
  };
}
