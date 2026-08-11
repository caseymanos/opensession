import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  ClipboardCheck,
  Eye,
  History,
  Plus,
  Route,
  ShieldCheck,
  Trash2,
  UserPlus,
} from "lucide-react";

import {
  Button,
  Dialog,
  Drawer,
  LiveRegion,
  SelectField,
  StatePanel,
  StatusPill,
  TextAreaField,
  TextField,
  ToastRegion,
  type ToastMessage,
} from "@sessionbox-killer/ui";
import type {
  ReviewOperationsCommand,
  ReviewOperationsResponse,
} from "@sessionbox-killer/contracts";

import {
  reviewAssignmentsFixture,
  reviewerGroupsFixture,
  rubricCriteriaFixture,
  type AssignmentStatus,
  type ReviewAssignmentView,
  type ReviewProposalView,
  type ReviewerGroupView,
  type RubricCriterionView,
} from "./reviewOperationsModel";
import {
  createReviewOperationsPort,
  type ReviewOperationsPort,
} from "./reviewOperationsClient";

import "./review-operations.css";

type ReviewOperationsTab = "assignments" | "groups" | "rubric";

interface ReviewerOption {
  label: string;
  value: string;
}

const groupColors = ["coral", "blue", "green", "violet"] as const;

function commandId(type: ReviewOperationsCommand["type"]): string {
  return `review_${type}_${crypto.randomUUID()}`;
}

function productionGroups(
  response: ReviewOperationsResponse,
): ReviewerGroupView[] {
  return response.groups.map((group, index) => ({
    color: groupColors[index % groupColors.length] ?? "blue",
    id: group.id,
    memberIds: group.members.map(({ id }) => id),
    members: group.members.map(({ displayName }) => displayName),
    name: group.name,
    route: group.routeKey,
    routeKey: group.routeKey,
    sourceVersion: group.sourceVersion,
  }));
}

function productionAssignments(
  response: ReviewOperationsResponse,
): ReviewAssignmentView[] {
  return response.assignments.map((assignment) => ({
    audit: assignment.audit.map((entry) => ({
      actor: entry.actorDisplayName,
      detail:
        entry.action === "reviews.assignment.conflict"
          ? "Disclosed a conflict; scoring requirement removed and organizer alerted"
          : entry.action === "reviews.assignment.remove"
            ? "Removed the assignment and revoked proposal access"
            : entry.action === "reviews.assignment.restore"
              ? "Restored the assignment and proposal access"
              : "Created the assignment and granted proposal access",
      time: new Date(entry.at).toLocaleString(),
    })),
    id: assignment.id,
    proposalReference: assignment.submission.reference,
    proposalTitle: assignment.submission.title,
    reviewer: assignment.reviewer.displayName,
    reviewerGroupId: assignment.reviewerGroupId,
    reviewerId: assignment.reviewer.id,
    rubricSnapshot: assignment.rubric.criteria,
    rubricVersion: assignment.rubric.version,
    sourceVersion: assignment.sourceVersion,
    status: assignment.status,
    submissionId: assignment.submission.id,
    track: assignment.submission.track ?? "Unassigned",
  }));
}

function productionProposals(
  response: ReviewOperationsResponse,
): ReviewProposalView[] {
  return response.proposals.map((proposal) => ({
    proposalReference: proposal.reference,
    proposalTitle: proposal.title,
    reviewerGroupId: proposal.reviewerGroupId,
    routeKey: proposal.routeKey,
    submissionId: proposal.id,
    track: proposal.track ?? "Unassigned",
  }));
}

function cloneRubricSnapshot(criteria: RubricCriterionView[]) {
  return criteria.map((criterion) => ({ ...criterion }));
}

const statusLabels: Record<AssignmentStatus, string> = {
  conflict: "Conflict · no score",
  in_progress: "In progress",
  pending: "Pending",
  removed: "Removed · no access",
  submitted: "Submitted",
};

function statusTone(status: AssignmentStatus) {
  if (status === "submitted") return "success" as const;
  if (status === "conflict") return "warning" as const;
  if (status === "in_progress") return "preview" as const;
  return "neutral" as const;
}

function ReviewOperationsHeader({ activeVersion }: { activeVersion: number }) {
  return (
    <header className="review-ops-header">
      <div>
        <p className="overline">Decide · Review operations</p>
        <h1>A fair process people can inspect.</h1>
        <p>
          Publish one rubric, route every proposal deliberately, and keep
          assignment history legible from first read to final score.
        </p>
      </div>
      <div className="review-ops-header-status">
        <StatusPill tone="success">Rubric v{activeVersion} active</StatusPill>
        <span>
          <ShieldCheck aria-hidden="true" size={15} /> Assigned proposals only
        </span>
      </div>
    </header>
  );
}

function ReviewOperationsTabs({
  active,
  assignmentCount,
  groupCount,
  onChange,
}: {
  active: ReviewOperationsTab;
  assignmentCount: number;
  groupCount: number;
  onChange: (tab: ReviewOperationsTab) => void;
}) {
  const tabs: { count?: number; id: ReviewOperationsTab; label: string }[] = [
    { id: "rubric", label: "Rubric" },
    {
      count: groupCount,
      id: "groups",
      label: "Reviewer groups",
    },
    {
      count: assignmentCount,
      id: "assignments",
      label: "Assignments",
    },
  ];
  return (
    <nav aria-label="Review operations" className="review-ops-tabs">
      {tabs.map((tab) => (
        <button
          aria-current={active === tab.id ? "page" : undefined}
          className={active === tab.id ? "is-active" : ""}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          type="button"
        >
          {tab.label}
          {tab.count !== undefined ? <span>{tab.count}</span> : null}
        </button>
      ))}
    </nav>
  );
}

function RubricEditor({
  activeVersion,
  criteria,
  onChange,
  onPublish,
  snapshotVersions,
}: {
  activeVersion: number;
  criteria: RubricCriterionView[];
  onChange: (criteria: RubricCriterionView[]) => void;
  onPublish: () => void;
  snapshotVersions: number[];
}) {
  const [publishOpen, setPublishOpen] = useState(false);
  const totalWeight = criteria.reduce(
    (sum, criterion) => sum + criterion.weight,
    0,
  );
  const rubricValid =
    criteria.length >= 1 &&
    criteria.length <= 5 &&
    totalWeight === 100 &&
    criteria.every(
      (criterion) =>
        criterion.weight > 0 &&
        criterion.label.trim().length > 0 &&
        criterion.guidance.trim().length > 0,
    );
  const snapshotVersionLabel = Array.from(new Set(snapshotVersions))
    .sort()
    .map((version) => `v${version}`)
    .join(", ");

  function updateCriterion(id: string, changes: Partial<RubricCriterionView>) {
    onChange(
      criteria.map((criterion) =>
        criterion.id === id ? { ...criterion, ...changes } : criterion,
      ),
    );
  }

  function moveCriterion(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= criteria.length) return;
    const next = [...criteria];
    const [criterion] = next.splice(index, 1);
    if (!criterion) return;
    next.splice(target, 0, criterion);
    onChange(next);
  }

  return (
    <section aria-labelledby="rubric-title" className="review-ops-panel">
      <div className="review-ops-panel-heading">
        <div>
          <p className="overline">Active scoring contract</p>
          <h2 id="rubric-title">Weighted rubric</h2>
          <p>
            Reviewers score every applicable criterion from 1 (weak) to 5
            (exceptional). Guidance remains attached to the published snapshot.
          </p>
        </div>
        <div className="review-ops-weight-total">
          <small>Total weight</small>
          <strong className={rubricValid ? "is-valid" : "is-invalid"}>
            {totalWeight}%
          </strong>
          <span>
            {rubricValid
              ? "Ready to publish"
              : totalWeight === 100
                ? "Every criterion needs guidance and weight"
                : "Must equal 100%"}
          </span>
        </div>
      </div>

      <div className="review-ops-snapshot-note">
        <History aria-hidden="true" size={18} />
        <div>
          <strong>
            Existing assignments keep their rubric snapshots
            {snapshotVersionLabel ? ` (${snapshotVersionLabel})` : ""}.
          </strong>
          <p>
            Publishing a new version affects new assignments only. Existing
            scoring and guidance remain attached to the version assigned.
          </p>
        </div>
      </div>

      <div className="review-ops-criteria">
        {criteria.map((criterion, index) => (
          <article key={criterion.id}>
            <div className="review-ops-criterion-order">
              <span>{index + 1}</span>
              <button
                aria-label={`Move ${criterion.label} up`}
                disabled={index === 0}
                onClick={() => moveCriterion(index, -1)}
                type="button"
              >
                <ArrowUp aria-hidden="true" size={14} />
              </button>
              <button
                aria-label={`Move ${criterion.label} down`}
                disabled={index === criteria.length - 1}
                onClick={() => moveCriterion(index, 1)}
                type="button"
              >
                <ArrowDown aria-hidden="true" size={14} />
              </button>
            </div>
            <div className="review-ops-criterion-fields">
              <div className="review-ops-criterion-topline">
                <TextField
                  id={`criterion-${criterion.id}-label`}
                  label="Criterion"
                  onChange={(event) =>
                    updateCriterion(criterion.id, { label: event.target.value })
                  }
                  required
                  value={criterion.label}
                />
                <TextField
                  id={`criterion-${criterion.id}-weight`}
                  label="Weight"
                  max={100}
                  min={1}
                  onChange={(event) =>
                    updateCriterion(criterion.id, {
                      weight: Number(event.target.value),
                    })
                  }
                  required
                  type="number"
                  value={criterion.weight}
                />
              </div>
              <TextAreaField
                id={`criterion-${criterion.id}-guidance`}
                label="Reviewer guidance"
                onChange={(event) =>
                  updateCriterion(criterion.id, {
                    guidance: event.target.value,
                  })
                }
                rows={3}
                value={criterion.guidance}
              />
              <div
                className="review-ops-score-scale"
                aria-label="Score scale 1 through 5"
              >
                {[1, 2, 3, 4, 5].map((score) => (
                  <span key={score}>{score}</span>
                ))}
                <small>Weak</small>
                <small>Exceptional</small>
              </div>
            </div>
            <button
              aria-label={`Delete ${criterion.label}`}
              className="review-ops-icon-action"
              disabled={criteria.length <= 1}
              onClick={() =>
                onChange(criteria.filter((item) => item.id !== criterion.id))
              }
              type="button"
            >
              <Trash2 aria-hidden="true" size={16} />
            </button>
          </article>
        ))}
      </div>

      <div className="review-ops-panel-actions">
        <button
          className="review-ops-secondary-action"
          disabled={criteria.length >= 5}
          onClick={() =>
            onChange([
              ...criteria,
              {
                guidance: "Explain what a strong score looks like.",
                id: `criterion-${Date.now()}`,
                label: "New criterion",
                weight: 0,
              },
            ])
          }
          type="button"
        >
          <Plus aria-hidden="true" size={16} /> Add criterion
        </button>
        <Button disabled={!rubricValid} onClick={() => setPublishOpen(true)}>
          Publish rubric v{activeVersion + 1}
        </Button>
      </div>

      <Dialog
        description={`New assignments will use v${activeVersion + 1}. Every existing assignment keeps its current rubric snapshot.`}
        onClose={() => setPublishOpen(false)}
        open={publishOpen}
        title={`Publish rubric v${activeVersion + 1}?`}
      >
        <div className="review-ops-publish-dialog">
          <div>
            <Check aria-hidden="true" size={17} />
            <span>Weights total exactly 100%</span>
          </div>
          <div>
            <History aria-hidden="true" size={17} />
            <span>Existing assignment snapshots remain unchanged</span>
          </div>
          <div className="review-ops-dialog-actions">
            <Button variant="secondary" onClick={() => setPublishOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                onPublish();
                setPublishOpen(false);
              }}
            >
              Publish version
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}

function ReviewerGroups({
  groups,
  onChange,
  routeProof,
  reviewerOptions,
}: {
  groups: ReviewerGroupView[];
  onChange: (
    groups: ReviewerGroupView[],
    action: "added" | "removed",
    changed: ReviewerGroupView,
  ) => void;
  routeProof?: string;
  reviewerOptions?: ReviewerOption[];
}) {
  const [addGroup, setAddGroup] = useState<ReviewerGroupView | null>(null);
  const [newReviewer, setNewReviewer] = useState("");
  const [removal, setRemoval] = useState<{
    group: ReviewerGroupView;
    member: string;
  } | null>(null);
  const selectedReviewer = reviewerOptions?.find(
    ({ value }) => value === newReviewer,
  );
  const normalizedReviewer = selectedReviewer?.label ?? newReviewer.trim();
  const reviewerExists = Boolean(
    selectedReviewer && addGroup?.memberIds
      ? addGroup.memberIds.includes(selectedReviewer.value)
      : addGroup?.members.some(
          (member) => member.toLowerCase() === normalizedReviewer.toLowerCase(),
        ),
  );

  function removeMember(groupId: string, member: string) {
    const next = groups.map((group) => {
      if (group.id !== groupId) return group;
      const memberIndex = group.members.indexOf(member);
      const memberIds = group.memberIds?.filter(
        (_, index) => index !== memberIndex,
      );
      return {
        ...group,
        members: group.members.filter((_, index) => index !== memberIndex),
        ...(memberIds ? { memberIds } : {}),
      };
    });
    const changed = next.find((group) => group.id === groupId);
    if (changed) onChange(next, "removed", changed);
    setRemoval(null);
  }

  function addMember() {
    if (!addGroup || normalizedReviewer.length < 2 || reviewerExists) return;
    const next = groups.map((group) =>
      group.id === addGroup.id
        ? {
            ...group,
            members: [...group.members, normalizedReviewer],
            ...(group.memberIds && selectedReviewer
              ? {
                  memberIds: [...group.memberIds, selectedReviewer.value],
                }
              : {}),
          }
        : group,
    );
    const changed = next.find((group) => group.id === addGroup.id);
    if (changed) onChange(next, "added", changed);
    setAddGroup(null);
    setNewReviewer("");
  }

  return (
    <section aria-labelledby="groups-title" className="review-ops-panel">
      <div className="review-ops-panel-heading">
        <div>
          <p className="overline">Route coverage</p>
          <h2 id="groups-title">Reviewer groups</h2>
          <p>
            Each published CFP route resolves to one reviewer group before
            individual assignments are created.
          </p>
        </div>
        <StatusPill tone="success">{groups.length} routes mapped</StatusPill>
      </div>
      <div className="review-ops-route-proof">
        <Route aria-hidden="true" size={18} />
        <span>
          <strong>Route proof:</strong>{" "}
          {routeProof ??
            "Product submissions route to Product reviewers; Casey Brooks sees AES-1120 and rubric v2 only."}
        </span>
      </div>
      <div className="review-ops-group-grid">
        {groups.map((group) => (
          <article className={`is-${group.color}`} key={group.id}>
            <header>
              <span aria-hidden="true" />
              <div>
                <h3>{group.name}</h3>
                <p>
                  <Route aria-hidden="true" size={13} /> {group.route}
                </p>
              </div>
              <StatusPill tone="neutral">
                {group.members.length} members
              </StatusPill>
            </header>
            <ul>
              {group.members.map((member) => (
                <li key={member}>
                  <span aria-hidden="true">
                    {member
                      .split(" ")
                      .map((part) => part[0])
                      .join("")}
                  </span>
                  <strong>{member}</strong>
                  <button
                    aria-label={`Remove ${member} from ${group.name}`}
                    onClick={() => setRemoval({ group, member })}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </li>
              ))}
            </ul>
            <button
              className="review-ops-group-add"
              onClick={() => {
                setAddGroup(group);
                setNewReviewer("");
              }}
              type="button"
            >
              <UserPlus aria-hidden="true" size={15} /> Add reviewer
            </button>
          </article>
        ))}
      </div>

      <Dialog
        description={
          addGroup
            ? `Add an existing reviewer to ${addGroup.name}. This changes routing eligibility for future assignments; it does not expose proposals by itself.`
            : "Add an existing reviewer to this group."
        }
        onClose={() => setAddGroup(null)}
        open={Boolean(addGroup)}
        title="Add reviewer to group"
      >
        <div className="review-ops-assign-dialog">
          {reviewerOptions ? (
            <SelectField
              label="Reviewer name"
              onChange={(event) => setNewReviewer(event.target.value)}
              options={reviewerOptions.filter(
                ({ value }) => !addGroup?.memberIds?.includes(value),
              )}
              value={newReviewer}
            />
          ) : (
            <TextField
              error={reviewerExists ? "This reviewer is already a member." : ""}
              label="Reviewer name"
              onChange={(event) => setNewReviewer(event.target.value)}
              placeholder="Name as shown in the workspace"
              value={newReviewer}
            />
          )}
          <div className="review-ops-dialog-note">
            <ShieldCheck aria-hidden="true" size={16} />
            <span>
              Proposal access still requires an individual assignment.
            </span>
          </div>
          <div className="review-ops-dialog-actions">
            <Button variant="secondary" onClick={() => setAddGroup(null)}>
              Cancel
            </Button>
            <Button
              disabled={normalizedReviewer.length < 2 || reviewerExists}
              onClick={addMember}
            >
              Add reviewer
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        description={
          removal
            ? `${removal.member} will leave ${removal.group.name}. Existing individual assignments and their audit history will not be changed.`
            : "Existing assignments remain unchanged."
        }
        onClose={() => setRemoval(null)}
        open={Boolean(removal)}
        title="Remove reviewer from group?"
      >
        <div className="review-ops-publish-dialog">
          <div>
            <ShieldCheck aria-hidden="true" size={17} />
            <span>Future route assignments will no longer include them</span>
          </div>
          <div className="review-ops-dialog-actions">
            <Button variant="secondary" onClick={() => setRemoval(null)}>
              Keep reviewer
            </Button>
            <Button
              onClick={() => {
                if (removal) removeMember(removal.group.id, removal.member);
              }}
            >
              Remove reviewer
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}

function Assignments({
  activeCriteria,
  activeVersion,
  assignments,
  groups,
  onChange,
  proposals,
  reviewerOptions,
}: {
  activeCriteria: RubricCriterionView[];
  activeVersion: number;
  assignments: ReviewAssignmentView[];
  groups: ReviewerGroupView[];
  onChange: (
    assignments: ReviewAssignmentView[],
    action: "conflict" | "created" | "removed" | "restored",
    changed: ReviewAssignmentView,
  ) => void;
  proposals: ReviewProposalView[];
  reviewerOptions?: ReviewerOption[];
}) {
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedProposal, setSelectedProposal] = useState("AES-1081");
  const [selectedReviewer, setSelectedReviewer] = useState("Theo Martin");
  const [auditAssignment, setAuditAssignment] =
    useState<ReviewAssignmentView | null>(null);
  const [conflictAssignment, setConflictAssignment] =
    useState<ReviewAssignmentView | null>(null);
  const [removalAssignment, setRemovalAssignment] =
    useState<ReviewAssignmentView | null>(null);

  const effectiveSelectedProposal = proposals.some(
    (proposal) =>
      (proposal.submissionId ?? proposal.proposalReference) ===
      selectedProposal,
  )
    ? selectedProposal
    : (proposals[0]?.submissionId ?? proposals[0]?.proposalReference ?? "");

  const proposal = proposals.find(
    (candidate) =>
      (candidate.submissionId ?? candidate.proposalReference) ===
      effectiveSelectedProposal,
  );
  const proposalGroup = groups.find(
    (group) => group.id === proposal?.reviewerGroupId,
  );
  const eligibleReviewerOptions = reviewerOptions?.filter((reviewer) =>
    proposalGroup?.memberIds?.includes(reviewer.value),
  );

  const effectiveSelectedReviewer =
    eligibleReviewerOptions &&
    !eligibleReviewerOptions.some(({ value }) => value === selectedReviewer)
      ? (eligibleReviewerOptions[0]?.value ?? "")
      : selectedReviewer;

  const visible = useMemo(
    () =>
      assignments.filter((assignment) => {
        const matchesStatus = status === "all" || assignment.status === status;
        const haystack =
          `${assignment.proposalReference} ${assignment.proposalTitle} ${assignment.reviewer} ${assignment.track}`.toLowerCase();
        return matchesStatus && haystack.includes(query.toLowerCase());
      }),
    [assignments, query, status],
  );

  function addAssignment() {
    if (!proposal) return;
    const reviewer = eligibleReviewerOptions?.find(
      ({ value }) => value === effectiveSelectedReviewer,
    );
    const reviewerLabel = reviewer?.label ?? effectiveSelectedReviewer;
    const id =
      proposal.submissionId && reviewer
        ? `assignment_${crypto.randomUUID()}`
        : `${proposal.proposalReference}-${effectiveSelectedReviewer}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-");
    const existing = assignments.find(
      (assignment) =>
        (assignment.submissionId ?? assignment.proposalReference) ===
          (proposal.submissionId ?? proposal.proposalReference) &&
        (assignment.reviewerId ?? assignment.reviewer) ===
          effectiveSelectedReviewer,
    );
    if (existing && existing.status !== "removed") {
      setAssignOpen(false);
      return;
    }
    if (existing) {
      const next = assignments.map((assignment) =>
        assignment.id === existing.id
          ? {
              ...assignment,
              audit: [
                ...assignment.audit,
                {
                  actor: "Casey Manos",
                  detail: `Restored ${reviewerLabel}'s assignment and proposal access`,
                  time: "Just now",
                },
              ],
              rubricSnapshot: cloneRubricSnapshot(activeCriteria),
              rubricVersion: activeVersion,
              status: "pending" as const,
            }
          : assignment,
      );
      const changed = next.find((assignment) => assignment.id === existing.id);
      if (changed) onChange(next, "restored", changed);
    } else {
      const changed: ReviewAssignmentView = {
        audit: [
          {
            actor: "Casey Manos",
            detail: `Assigned ${reviewerLabel}`,
            time: "Just now",
          },
        ],
        id,
        proposalReference: proposal.proposalReference,
        proposalTitle: proposal.proposalTitle,
        reviewer: reviewerLabel,
        ...(proposal.reviewerGroupId
          ? { reviewerGroupId: proposal.reviewerGroupId }
          : {}),
        ...(reviewer ? { reviewerId: reviewer.value } : {}),
        rubricSnapshot: cloneRubricSnapshot(activeCriteria),
        rubricVersion: activeVersion,
        sourceVersion: 0,
        status: "pending",
        ...(proposal.submissionId
          ? { submissionId: proposal.submissionId }
          : {}),
        track: proposal.track,
      };
      onChange([...assignments, changed], "created", changed);
    }
    setAssignOpen(false);
  }

  function discloseConflict(assignment: ReviewAssignmentView) {
    const next = assignments.map((item) =>
      item.id === assignment.id
        ? {
            ...item,
            audit: [
              ...item.audit,
              {
                actor: item.reviewer,
                detail:
                  "Disclosed a conflict; scoring requirement removed and organizer alerted",
                time: "Just now",
              },
            ],
            status: "conflict" as const,
          }
        : item,
    );
    const changed = next.find((item) => item.id === assignment.id);
    if (changed) onChange(next, "conflict", changed);
    setConflictAssignment(null);
  }

  function removeAssignment(assignment: ReviewAssignmentView) {
    const next = assignments.map((item) =>
      item.id === assignment.id
        ? {
            ...item,
            audit: [
              ...item.audit,
              {
                actor: "Casey Manos",
                detail: `Removed ${item.reviewer}'s assignment; proposal access revoked`,
                time: "Just now",
              },
            ],
            status: "removed" as const,
          }
        : item,
    );
    const changed = next.find((item) => item.id === assignment.id);
    if (changed) onChange(next, "removed", changed);
    setRemovalAssignment(null);
  }

  return (
    <section aria-labelledby="assignments-title" className="review-ops-panel">
      <div className="review-ops-panel-heading">
        <div>
          <p className="overline">Proposal access</p>
          <h2 id="assignments-title">Individual assignments</h2>
          <p>
            Reviewers can open only assigned proposals and the rubric snapshot
            attached at assignment time.
          </p>
        </div>
        <Button onClick={() => setAssignOpen(true)}>
          <UserPlus aria-hidden="true" size={16} /> Assign reviewer
        </Button>
      </div>
      <div className="review-ops-assignment-metrics">
        <span>
          <strong>
            {assignments.filter((item) => item.status === "pending").length}
          </strong>{" "}
          Pending
        </span>
        <span>
          <strong>
            {assignments.filter((item) => item.status === "in_progress").length}
          </strong>{" "}
          In progress
        </span>
        <span>
          <strong>
            {assignments.filter((item) => item.status === "submitted").length}
          </strong>{" "}
          Submitted
        </span>
        <span className="is-warning">
          <strong>
            {assignments.filter((item) => item.status === "conflict").length}
          </strong>{" "}
          Conflict removed
        </span>
      </div>
      <div className="review-ops-filters">
        <TextField
          label="Search assignments"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Proposal, reviewer, track…"
          type="search"
          value={query}
        />
        <SelectField
          label="Status"
          onChange={(event) => setStatus(event.target.value)}
          options={[
            { label: "All statuses", value: "all" },
            { label: "Pending", value: "pending" },
            { label: "In progress", value: "in_progress" },
            { label: "Submitted", value: "submitted" },
            { label: "Conflict", value: "conflict" },
            { label: "Removed", value: "removed" },
          ]}
          value={status}
        />
      </div>
      <p className="review-ops-table-cue">
        Scroll the table to see reviewer, rubric, status, and actions.
      </p>
      <div
        aria-label="Assignments table; scroll horizontally for more details"
        className="review-ops-table-wrap"
        role="region"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Proposal</th>
              <th>Reviewer</th>
              <th>Rubric</th>
              <th>Status</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((assignment) => (
              <tr key={assignment.id}>
                <td>
                  <button
                    className="review-ops-proposal-link"
                    onClick={() => setAuditAssignment(assignment)}
                    type="button"
                  >
                    <strong>{assignment.proposalTitle}</strong>
                    <span>
                      {assignment.proposalReference} · {assignment.track}
                    </span>
                  </button>
                </td>
                <td>
                  <strong>{assignment.reviewer}</strong>
                  <small>
                    <Eye aria-hidden="true" size={12} /> Assigned content only
                  </small>
                </td>
                <td>v{assignment.rubricVersion} snapshot</td>
                <td>
                  <StatusPill tone={statusTone(assignment.status)}>
                    {statusLabels[assignment.status]}
                  </StatusPill>
                </td>
                <td>
                  <div className="review-ops-row-actions">
                    <button
                      aria-label={`View audit for ${assignment.proposalReference} and ${assignment.reviewer}`}
                      onClick={() => setAuditAssignment(assignment)}
                      type="button"
                    >
                      <History aria-hidden="true" size={15} />
                    </button>
                    {assignment.status === "pending" ||
                    assignment.status === "in_progress" ? (
                      <button
                        aria-label={`Disclose conflict for ${assignment.reviewer} on ${assignment.proposalReference}`}
                        onClick={() => setConflictAssignment(assignment)}
                        type="button"
                      >
                        <CircleAlert aria-hidden="true" size={15} />
                      </button>
                    ) : null}
                    {assignment.status !== "submitted" &&
                    assignment.status !== "removed" ? (
                      <button
                        aria-label={`Remove assignment for ${assignment.reviewer} on ${assignment.proposalReference}`}
                        onClick={() => setRemovalAssignment(assignment)}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={15} />
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!visible.length ? (
        <div className="review-ops-empty">
          <ClipboardCheck aria-hidden="true" size={24} />
          <h3>No assignments match</h3>
          <p>Clear the current search or status filter.</p>
        </div>
      ) : null}

      <Dialog
        description="The command is safe to retry; an existing reviewer/proposal pair will not be duplicated."
        onClose={() => setAssignOpen(false)}
        open={assignOpen}
        title="Assign a reviewer"
      >
        <div className="review-ops-assign-dialog">
          <SelectField
            label="Proposal"
            onChange={(event) => setSelectedProposal(event.target.value)}
            options={proposals.map((item) => ({
              label: `${item.proposalReference} · ${item.proposalTitle}`,
              value: item.submissionId ?? item.proposalReference,
            }))}
            value={effectiveSelectedProposal}
          />
          <SelectField
            label="Reviewer"
            onChange={(event) => setSelectedReviewer(event.target.value)}
            options={
              eligibleReviewerOptions ??
              ["Theo Martin", "Drew Kim", "Noah Williams", "Inez Park"].map(
                (reviewer) => ({ label: reviewer, value: reviewer }),
              )
            }
            value={effectiveSelectedReviewer}
          />
          <div className="review-ops-dialog-note">
            <ShieldCheck aria-hidden="true" size={16} />
            <span>
              This grants access to one proposal and its rubric snapshot only.
            </span>
          </div>
          <div className="review-ops-dialog-actions">
            <Button variant="secondary" onClick={() => setAssignOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!proposal || !effectiveSelectedReviewer}
              onClick={addAssignment}
            >
              Create assignment
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        description={
          conflictAssignment
            ? `Record the conflict disclosed by ${conflictAssignment.reviewer} for ${conflictAssignment.proposalReference}. Their scoring requirement will be removed and the organizer alert will remain auditable.`
            : "The scoring requirement will be removed."
        }
        onClose={() => setConflictAssignment(null)}
        open={Boolean(conflictAssignment)}
        title="Record this conflict?"
      >
        <div className="review-ops-publish-dialog">
          <div>
            <AlertTriangle aria-hidden="true" size={17} />
            <span>The reviewer will no longer affect aggregate scoring</span>
          </div>
          <div className="review-ops-dialog-actions">
            <Button
              variant="secondary"
              onClick={() => setConflictAssignment(null)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (conflictAssignment) discloseConflict(conflictAssignment);
              }}
            >
              Record conflict
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        description={
          removalAssignment
            ? `${removalAssignment.reviewer} will lose access to ${removalAssignment.proposalReference}. The assignment and its history remain in the audit log.`
            : "The assignment history remains auditable."
        }
        onClose={() => setRemovalAssignment(null)}
        open={Boolean(removalAssignment)}
        title="Remove this assignment?"
      >
        <div className="review-ops-publish-dialog">
          <div>
            <ShieldCheck aria-hidden="true" size={17} />
            <span>Proposal access is revoked without deleting history</span>
          </div>
          <div className="review-ops-dialog-actions">
            <Button
              variant="secondary"
              onClick={() => setRemovalAssignment(null)}
            >
              Keep assignment
            </Button>
            <Button
              onClick={() => {
                if (removalAssignment) removeAssignment(removalAssignment);
              }}
            >
              Remove assignment
            </Button>
          </div>
        </div>
      </Dialog>

      <Drawer
        description={
          auditAssignment
            ? `${auditAssignment.proposalReference} · ${auditAssignment.reviewer}`
            : "Assignment change history"
        }
        onClose={() => setAuditAssignment(null)}
        open={Boolean(auditAssignment)}
        title="Assignment history"
      >
        {auditAssignment ? (
          <div className="review-ops-audit">
            <div className="review-ops-audit-summary">
              <strong>{auditAssignment.proposalTitle}</strong>
              <StatusPill tone={statusTone(auditAssignment.status)}>
                {statusLabels[auditAssignment.status]}
              </StatusPill>
              <p>
                Rubric v{auditAssignment.rubricVersion} snapshot · assigned
                proposal content only
              </p>
              <ul className="review-ops-audit-rubric">
                {auditAssignment.rubricSnapshot.map((criterion) => (
                  <li key={criterion.id}>
                    <strong>{criterion.label}</strong>
                    <span>{criterion.weight}%</span>
                    <small>{criterion.guidance}</small>
                  </li>
                ))}
              </ul>
            </div>
            <ol>
              {auditAssignment.audit.map((entry) => (
                <li key={`${entry.time}-${entry.detail}`}>
                  <span aria-hidden="true" />
                  <div>
                    <strong>{entry.detail}</strong>
                    <p>
                      {entry.actor} · {entry.time}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            {auditAssignment.status === "conflict" ? (
              <div className="review-ops-conflict-alert">
                <AlertTriangle aria-hidden="true" size={17} />
                <p>
                  <strong>Scoring requirement removed.</strong> This reviewer no
                  longer affects completion or aggregate math.
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </section>
  );
}

interface ReviewOperationsProps {
  eventKey?: string;
  port?: ReviewOperationsPort;
}

export function ReviewOperations({
  eventKey,
  port,
}: ReviewOperationsProps = {}) {
  const client = useMemo(() => port ?? createReviewOperationsPort(), [port]);
  const [tab, setTab] = useState<ReviewOperationsTab>("rubric");
  const [criteria, setCriteria] = useState(() =>
    cloneRubricSnapshot(rubricCriteriaFixture),
  );
  const [publishedCriteria, setPublishedCriteria] = useState(() =>
    cloneRubricSnapshot(rubricCriteriaFixture),
  );
  const [groups, setGroups] = useState(reviewerGroupsFixture);
  const [assignments, setAssignments] = useState(reviewAssignmentsFixture);
  const [activeVersion, setActiveVersion] = useState(2);
  const [announcement, setAnnouncement] = useState("");
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [serverResponse, setServerResponse] =
    useState<ReviewOperationsResponse | null>(null);
  const [loadState, setLoadState] = useState<"error" | "loading" | "ready">(
    eventKey ? "loading" : "ready",
  );
  const [mutationError, setMutationError] = useState("");
  const [pendingCommand, setPendingCommand] =
    useState<ReviewOperationsCommand | null>(null);
  const mutationInFlight = useRef(false);

  const applyResponse = useCallback((response: ReviewOperationsResponse) => {
    const rubricCriteria = cloneRubricSnapshot(response.activeRubric.criteria);
    setServerResponse(response);
    setCriteria(rubricCriteria);
    setPublishedCriteria(cloneRubricSnapshot(rubricCriteria));
    setGroups(productionGroups(response));
    setAssignments(productionAssignments(response));
    setActiveVersion(response.activeRubric.version);
    setMutationError("");
    setLoadState("ready");
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!eventKey) return;
      try {
        applyResponse(await client.load(eventKey, signal));
      } catch (error) {
        if (signal?.aborted) return;
        setLoadState("error");
        setMutationError(
          error instanceof Error
            ? error.message
            : "Review operations could not be loaded.",
        );
      }
    },
    [applyResponse, client, eventKey],
  );

  useEffect(() => {
    if (!eventKey) return;
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [eventKey, load]);

  function announce(
    title: string,
    message: string,
    tone: ToastMessage["tone"] = "success",
  ) {
    setAnnouncement(message);
    setToasts((current) => [
      ...current,
      { id: crypto.randomUUID(), message, title, tone },
    ]);
  }

  async function executeProductionCommand(
    command: ReviewOperationsCommand,
    notice: { message: string; title: string },
  ) {
    if (!eventKey) return;
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setPendingCommand(command);
    setMutationError("");
    try {
      await client.execute(eventKey, command);
      applyResponse(await client.load(eventKey));
      setPendingCommand(null);
      announce(notice.title, notice.message);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The authoritative review change could not be confirmed.";
      setMutationError(message);
      announce("Change not confirmed", message, "error");
    } finally {
      mutationInFlight.current = false;
    }
  }

  const reviewerOptions = serverResponse?.reviewers.map((reviewer) => ({
    label: reviewer.displayName,
    value: reviewer.id,
  }));
  const proposals = serverResponse
    ? productionProposals(serverResponse)
    : Array.from(
        new Map(
          assignments.map((assignment) => [
            assignment.proposalReference,
            {
              proposalReference: assignment.proposalReference,
              proposalTitle: assignment.proposalTitle,
              track: assignment.track,
            },
          ]),
        ).values(),
      );
  const routeProof = eventKey
    ? (() => {
        const group =
          groups.find((candidate) =>
            candidate.route.toLowerCase().includes("product"),
          ) ?? groups[0];
        const assignment = assignments.find(
          (candidate) => candidate.reviewerGroupId === group?.id,
        );
        return group && assignment
          ? `${group.route} routes to ${group.name}; ${assignment.reviewer} sees ${assignment.proposalReference} and rubric v${assignment.rubricVersion} only.`
          : "Every routable proposal resolves to one reviewer group before individual access is granted.";
      })()
    : undefined;

  if (eventKey && loadState === "loading") {
    return (
      <StatePanel
        description="Loading the active rubric, reviewer groups, and assignment snapshots."
        state="loading"
        title="Loading review operations"
      />
    );
  }

  if (eventKey && loadState === "error" && !serverResponse) {
    return (
      <StatePanel
        description={
          mutationError || "Review operations are temporarily unavailable."
        }
        onRetry={() => {
          setLoadState("loading");
          setMutationError("");
          void load();
        }}
        state="error"
        title="Review operations unavailable"
      />
    );
  }

  return (
    <div className="review-operations-page">
      <ReviewOperationsHeader activeVersion={activeVersion} />
      <ReviewOperationsTabs
        active={tab}
        assignmentCount={assignments.length}
        groupCount={groups.length}
        onChange={setTab}
      />
      {mutationError ? (
        <div className="review-ops-conflict-alert" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <p>
            <strong>Change not confirmed.</strong> {mutationError}
          </p>
          {pendingCommand ? (
            <Button
              onClick={() =>
                void executeProductionCommand(pendingCommand, {
                  message:
                    "The saved command completed without changing its request body.",
                  title: "Change confirmed",
                })
              }
            >
              Retry saved change
            </Button>
          ) : null}
          <Button
            onClick={() => {
              setPendingCommand(null);
              setMutationError("");
              void load();
            }}
            variant="secondary"
          >
            Load latest
          </Button>
        </div>
      ) : null}
      {tab === "rubric" ? (
        <RubricEditor
          activeVersion={activeVersion}
          criteria={criteria}
          onChange={setCriteria}
          onPublish={() => {
            const publishedSnapshot = cloneRubricSnapshot(criteria);
            if (eventKey && serverResponse) {
              void executeProductionCommand(
                {
                  commandId: commandId("publish_rubric"),
                  criteria: publishedSnapshot,
                  expectedVersion: serverResponse.activeRubric.sourceVersion,
                  name: serverResponse.activeRubric.name,
                  rubricId: serverResponse.activeRubric.id,
                  type: "publish_rubric",
                },
                {
                  message:
                    "New assignments use the published rubric; existing assignment snapshots did not change.",
                  title: "Rubric published",
                },
              );
              return;
            }
            setPublishedCriteria(publishedSnapshot);
            setActiveVersion((version) => version + 1);
            announce(
              "Rubric published",
              "New assignments now use the new rubric; existing snapshots did not change.",
            );
          }}
          snapshotVersions={assignments.map(
            (assignment) => assignment.rubricVersion,
          )}
        />
      ) : tab === "groups" ? (
        <ReviewerGroups
          groups={groups}
          onChange={(next, action, changed) => {
            const notice =
              action === "added"
                ? {
                    message:
                      "Group eligibility changed once; proposal access still requires an assignment.",
                    title: "Reviewer added",
                  }
                : {
                    message:
                      "Group eligibility changed once; existing assignments and history remain intact.",
                    title: "Reviewer removed",
                  };
            if (
              eventKey &&
              changed.memberIds &&
              changed.routeKey &&
              changed.sourceVersion !== undefined
            ) {
              void executeProductionCommand(
                {
                  commandId: commandId("upsert_group"),
                  expectedVersion: changed.sourceVersion,
                  groupId: changed.id,
                  memberIds: changed.memberIds,
                  name: changed.name,
                  routeKey: changed.routeKey,
                  status: "active",
                  type: "upsert_group",
                },
                notice,
              );
              return;
            }
            setGroups(next);
            announce(notice.title, notice.message);
          }}
          {...(routeProof ? { routeProof } : {})}
          {...(reviewerOptions ? { reviewerOptions } : {})}
        />
      ) : (
        <Assignments
          activeCriteria={publishedCriteria}
          activeVersion={activeVersion}
          assignments={assignments}
          groups={groups}
          onChange={(next, action, changed) => {
            const notices = {
              conflict: {
                message:
                  "Scoring requirement removed and the organizer alert is visible.",
                title: "Conflict disclosed",
              },
              created: {
                message:
                  "Reviewer access is limited to the assigned proposal and rubric snapshot.",
                title: "Assignment created",
              },
              removed: {
                message:
                  "Proposal access was revoked; the assignment history remains auditable.",
                title: "Assignment removed",
              },
              restored: {
                message:
                  "The existing assignment was restored once with its prior history intact.",
                title: "Assignment restored",
              },
            } as const;
            if (eventKey) {
              let command: ReviewOperationsCommand | null = null;
              if (
                (action === "created" || action === "restored") &&
                changed.reviewerGroupId &&
                changed.reviewerId &&
                changed.submissionId
              ) {
                command = {
                  assignmentId: changed.id,
                  commandId: commandId("assign_reviewer"),
                  expectedVersion: changed.sourceVersion ?? 0,
                  reviewerGroupId: changed.reviewerGroupId,
                  reviewerId: changed.reviewerId,
                  submissionId: changed.submissionId,
                  type: "assign_reviewer",
                };
              } else if (action === "removed") {
                command = {
                  assignmentId: changed.id,
                  commandId: commandId("remove_assignment"),
                  expectedVersion: changed.sourceVersion ?? 0,
                  type: "remove_assignment",
                };
              } else if (action === "conflict") {
                command = {
                  assignmentId: changed.id,
                  commandId: commandId("disclose_conflict"),
                  expectedVersion: changed.sourceVersion ?? 0,
                  note: "Conflict disclosed in the organizer review workspace.",
                  type: "disclose_conflict",
                };
              }
              if (command) {
                void executeProductionCommand(command, notices[action]);
                return;
              }
            }
            setAssignments(next);
            announce(notices[action].title, notices[action].message);
          }}
          proposals={proposals}
          {...(reviewerOptions ? { reviewerOptions } : {})}
        />
      )}
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
