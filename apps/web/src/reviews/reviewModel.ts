export type ReviewQueueStatus = "not_started" | "draft" | "submitted";

export interface ReviewQueueItemView {
  abstract: string;
  audience: string;
  format: string;
  id: string;
  outcomes: string[];
  reference: string;
  status: ReviewQueueStatus;
  title: string;
  track: string;
}

export interface ReviewCriterionView {
  guidance: string;
  id: string;
  label: string;
  weight: number;
}

export interface ReviewerWorkspaceView {
  criteria: ReviewCriterionView[];
  dueLabel: string;
  eventName: string;
  queue: ReviewQueueItemView[];
  reviewerName: string;
  track: string;
}

export const reviewerWorkspaceFixture: ReviewerWorkspaceView = {
  criteria: [
    {
      guidance:
        "Would attendees leave with specific, reusable knowledge rather than a product pitch?",
      id: "relevance",
      label: "Audience value",
      weight: 40,
    },
    {
      guidance:
        "Does the proposal make a focused claim with credible evidence or experience behind it?",
      id: "specificity",
      label: "Specificity & evidence",
      weight: 35,
    },
    {
      guidance:
        "Is the topic additive to this program and distinct from the other submissions you have seen?",
      id: "originality",
      label: "Originality",
      weight: 25,
    },
  ],
  dueLabel: "Due August 12 · 3 days left",
  eventName: "AI Engineer Summit",
  queue: [
    {
      abstract:
        "Agent systems fail in production for reasons that rarely appear in benchmarks: incomplete context, tool drift, hidden retries, and missing human checkpoints. This session presents a practical reliability model built from production incident reviews, then turns it into a set of design and observability patterns teams can use immediately.",
      audience:
        "Engineers and product leaders already shipping LLM-powered workflows. No deep ML background is required.",
      format: "30-minute talk",
      id: "proposal-1042",
      outcomes: [
        "Recognize four common reliability failure modes in agent workflows.",
        "Choose checkpoints and recovery paths without making every action synchronous.",
        "Instrument tool calls and retries so incidents are explainable.",
      ],
      reference: "AES-1042",
      status: "draft",
      title: "The Reliability Gap in Production Agents",
      track: "AI Engineering",
    },
    {
      abstract:
        "Evaluation suites can look stable while production quality quietly drifts. This talk shows how sampling bias, contaminated fixtures, and aggregate scores hide failures, then demonstrates a layered evaluation plan that keeps teams honest.",
      audience:
        "AI engineers and product teams responsible for evaluation, release confidence, or model-quality reporting.",
      format: "30-minute talk",
      id: "proposal-1036",
      outcomes: [
        "Detect sampling and fixture bias in an existing evaluation suite.",
        "Separate regression signals from product-specific quality thresholds.",
        "Build a review loop for failures that aggregate scores conceal.",
      ],
      reference: "AES-1036",
      status: "not_started",
      title: "Your Eval Suite Is Lying to You",
      track: "Evaluation",
    },
    {
      abstract:
        "Human review does not have to become a throughput bottleneck. This session maps checkpoints to consequence and uncertainty, showing how product teams can reserve attention for decisions where it changes the outcome.",
      audience:
        "Product leaders and engineers designing approval, escalation, and exception flows for AI products.",
      format: "45-minute panel",
      id: "proposal-1018",
      outcomes: [
        "Choose review points using consequence and uncertainty.",
        "Design escalation paths that preserve operator context.",
        "Measure whether a checkpoint improves outcomes or only adds delay.",
      ],
      reference: "AES-1018",
      status: "submitted",
      title: "Designing Human Checkpoints That Scale",
      track: "Product",
    },
    {
      abstract:
        "Small language models can carry serious production workloads when the surrounding system is designed deliberately. This talk covers routing, constrained tasks, cache strategy, and fallback paths from several deployed systems.",
      audience:
        "Infrastructure and application engineers balancing latency, cost, privacy, and model capability.",
      format: "30-minute talk",
      id: "proposal-1007",
      outcomes: [
        "Identify tasks that are good candidates for smaller models.",
        "Design routing and fallback policies around observable limits.",
        "Compare total system cost instead of model price alone.",
      ],
      reference: "AES-1007",
      status: "not_started",
      title: "Small Models, Serious Systems",
      track: "Infrastructure",
    },
    {
      abstract:
        "Tool-calling failures repeat in recognizable patterns across APIs and model families. This field guide organizes those patterns into detection, containment, and recovery techniques teams can apply without replacing their stack.",
      audience:
        "Engineers operating agents that call external tools, services, or business workflows.",
      format: "60-minute workshop",
      id: "proposal-998",
      outcomes: [
        "Classify common tool-selection and argument failures.",
        "Add validation and idempotency at the right system boundaries.",
        "Create recovery traces that are useful during incidents.",
      ],
      reference: "AES-0998",
      status: "submitted",
      title: "A Field Guide to Tool-Calling Failures",
      track: "AI Engineering",
    },
  ],
  reviewerName: "Morgan Lee",
  track: "AI Engineering",
};
