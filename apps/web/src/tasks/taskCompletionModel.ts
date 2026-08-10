export interface TaskFileVersionView {
  fileName: string;
  id: string;
  mimeLabel: string;
  sizeLabel: string;
  submittedAt: string;
  submittedBy: string;
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
