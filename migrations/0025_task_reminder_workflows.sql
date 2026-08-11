CREATE TABLE task_reminder_results (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (
    disposition IN ('queued', 'skipped')
  ),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'already_queued', 'completed', 'missing_due', 'missing_email',
      'optional', 'queued', 'suppressed'
    )
  ),
  message_id TEXT,
  evaluated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, workflow_id, assignment_id),
  FOREIGN KEY (organization_id, event_id)
    REFERENCES p_events(organization_id, id),
  FOREIGN KEY (organization_id, workflow_id)
    REFERENCES workflow_runs(organization_id, id),
  CHECK ((disposition = 'queued') = (message_id IS NOT NULL))
) STRICT;

CREATE INDEX idx_task_reminder_results_workflow
  ON task_reminder_results(
    organization_id, event_id, workflow_id, disposition, assignment_id
  );

CREATE INDEX idx_workflow_runs_operator
  ON workflow_runs(
    organization_id, event_id, workflow_type, status, updated_at, id
  );

