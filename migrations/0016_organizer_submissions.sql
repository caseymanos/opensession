ALTER TABLE p_submissions ADD COLUMN organizer_activity_at TEXT;

CREATE TABLE p_submission_notes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  actor_id TEXT NOT NULL,
  actor_display_name TEXT NOT NULL CHECK (length(actor_display_name) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, submission_id)
    REFERENCES p_submissions(organization_id, event_id, id)
) STRICT;

CREATE TABLE organizer_submission_command_receipts (
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_hash TEXT NOT NULL CHECK (
    length(command_hash) = 64 AND command_hash NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('applying', 'complete')),
  operations_json TEXT CHECK (
    operations_json IS NULL OR
    (json_valid(operations_json) AND json_type(operations_json) = 'array')
  ),
  result_json TEXT CHECK (
    result_json IS NULL OR
    (json_valid(result_json) AND json_type(result_json) = 'object')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, event_id, command_id),
  FOREIGN KEY (organization_id, event_id, submission_id)
    REFERENCES p_submissions(organization_id, event_id, id),
  CHECK (
    (state = 'applying' AND operations_json IS NOT NULL AND result_json IS NULL) OR
    (state = 'complete' AND operations_json IS NULL AND result_json IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_p_submissions_activity
  ON p_submissions(organization_id, event_id, updated_at DESC, id DESC)
  WHERE source_deleted_at IS NULL;

CREATE INDEX idx_p_submissions_status_activity
  ON p_submissions(organization_id, event_id, status, updated_at DESC, id DESC)
  WHERE source_deleted_at IS NULL;

CREATE INDEX idx_p_submissions_track_activity
  ON p_submissions(organization_id, event_id, track_id, updated_at DESC, id DESC)
  WHERE source_deleted_at IS NULL;

CREATE INDEX idx_p_submission_notes_submission_time
  ON p_submission_notes(
    organization_id, event_id, submission_id, created_at DESC, id DESC
  )
  WHERE source_deleted_at IS NULL;

CREATE INDEX idx_organizer_submission_receipts_active
  ON organizer_submission_command_receipts(state, updated_at, organization_id, event_id);
