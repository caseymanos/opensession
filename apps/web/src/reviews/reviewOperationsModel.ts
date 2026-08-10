export interface RubricCriterionView {
  guidance: string;
  id: string;
  label: string;
  weight: number;
}

export interface ReviewerGroupView {
  color: string;
  id: string;
  members: string[];
  name: string;
  route: string;
}

export type AssignmentStatus =
  "conflict" | "in_progress" | "pending" | "removed" | "submitted";

export interface ReviewAssignmentView {
  audit: { actor: string; detail: string; time: string }[];
  id: string;
  proposalReference: string;
  proposalTitle: string;
  rubricSnapshot: RubricCriterionView[];
  reviewer: string;
  rubricVersion: number;
  status: AssignmentStatus;
  track: string;
}

export const rubricCriteriaFixture: RubricCriterionView[] = [
  {
    guidance:
      "Would attendees leave with specific, reusable knowledge rather than a product pitch?",
    id: "audience-value",
    label: "Audience value",
    weight: 40,
  },
  {
    guidance:
      "Does the proposal make a focused claim with credible evidence or experience?",
    id: "specificity",
    label: "Specificity & evidence",
    weight: 35,
  },
  {
    guidance:
      "Is the topic additive to this program and distinct from other submissions?",
    id: "originality",
    label: "Originality",
    weight: 25,
  },
];

export const reviewerGroupsFixture: ReviewerGroupView[] = [
  {
    color: "coral",
    id: "group-ai-engineering",
    members: ["Maya Singh", "Theo Martin", "Drew Kim"],
    name: "AI Engineering reviewers",
    route: "AI Engineering",
  },
  {
    color: "blue",
    id: "group-evaluation",
    members: ["Priya Das", "Noah Williams"],
    name: "Evaluation reviewers",
    route: "Evaluation",
  },
  {
    color: "green",
    id: "group-infrastructure",
    members: ["Sam Rivera", "Leah Gardner"],
    name: "Infrastructure reviewers",
    route: "Infrastructure",
  },
  {
    color: "violet",
    id: "group-product",
    members: ["Casey Brooks", "Inez Park", "Omar Ali"],
    name: "Product reviewers",
    route: "Product · Track D",
  },
];

function assignmentFixture(
  assignment: Omit<ReviewAssignmentView, "rubricSnapshot">,
): ReviewAssignmentView {
  return {
    ...assignment,
    rubricSnapshot: rubricCriteriaFixture.map((criterion) => ({
      ...criterion,
    })),
  };
}

export const reviewAssignmentsFixture: ReviewAssignmentView[] = [
  assignmentFixture({
    audit: [
      {
        actor: "Route automation",
        detail: "Assigned from AI Engineering route",
        time: "Aug 8 · 9:41 AM",
      },
      {
        actor: "Maya Singh",
        detail: "Saved a draft review",
        time: "Aug 9 · 11:04 AM",
      },
    ],
    id: "assignment-1042-maya",
    proposalReference: "AES-1042",
    proposalTitle: "The Reliability Gap in Production Agents",
    reviewer: "Maya Singh",
    rubricVersion: 2,
    status: "in_progress",
    track: "AI Engineering",
  }),
  assignmentFixture({
    audit: [
      {
        actor: "Route automation",
        detail: "Assigned from Evaluation route",
        time: "Aug 8 · 9:42 AM",
      },
    ],
    id: "assignment-1081-priya",
    proposalReference: "AES-1081",
    proposalTitle: "Your Eval Suite Is Lying to You",
    reviewer: "Priya Das",
    rubricVersion: 2,
    status: "pending",
    track: "Evaluation",
  }),
  assignmentFixture({
    audit: [
      {
        actor: "Route automation",
        detail: "Assigned from Product · Track D route",
        time: "Aug 8 · 9:44 AM",
      },
      {
        actor: "Casey Brooks",
        detail: "Submitted the rubric snapshot",
        time: "Aug 9 · 2:18 PM",
      },
    ],
    id: "assignment-1120-casey",
    proposalReference: "AES-1120",
    proposalTitle: "Designing Human Checkpoints That Scale",
    reviewer: "Casey Brooks",
    rubricVersion: 2,
    status: "submitted",
    track: "Product · Track D",
  }),
  assignmentFixture({
    audit: [
      {
        actor: "Route automation",
        detail: "Assigned from Infrastructure route",
        time: "Aug 8 · 9:46 AM",
      },
      {
        actor: "Sam Rivera",
        detail:
          "Disclosed a prior advisory relationship; scoring requirement removed",
        time: "Aug 9 · 4:06 PM",
      },
    ],
    id: "assignment-1164-sam",
    proposalReference: "AES-1164",
    proposalTitle: "Small Models, Serious Systems",
    reviewer: "Sam Rivera",
    rubricVersion: 2,
    status: "conflict",
    track: "Infrastructure",
  }),
];
