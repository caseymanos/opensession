ALTER TABLE p_rubrics ADD COLUMN rubric_version INTEGER NOT NULL DEFAULT 1
  CHECK (rubric_version > 0);
ALTER TABLE p_rubrics ADD COLUMN criteria_snapshot_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(criteria_snapshot_json) AND
    json_type(criteria_snapshot_json) = 'array'
  );

ALTER TABLE p_reviews ADD COLUMN reviewer_group_id TEXT;
ALTER TABLE p_reviews ADD COLUMN rubric_version INTEGER
  CHECK (rubric_version IS NULL OR rubric_version > 0);
ALTER TABLE p_reviews ADD COLUMN rubric_snapshot_json TEXT
  CHECK (
    rubric_snapshot_json IS NULL OR (
      json_valid(rubric_snapshot_json) AND
      json_type(rubric_snapshot_json) = 'object'
    )
  );
ALTER TABLE p_reviews ADD COLUMN scoring_required INTEGER NOT NULL DEFAULT 1
  CHECK (scoring_required IN (0, 1));
ALTER TABLE p_reviews ADD COLUMN assigned_at TEXT;

CREATE TABLE p_reviewer_groups (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  route_key TEXT NOT NULL CHECK (length(route_key) BETWEEN 3 AND 128),
  member_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(member_ids_json) AND json_type(member_ids_json) = 'array'
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, route_key),
  FOREIGN KEY (organization_id, event_id)
    REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE review_operation_command_receipts (
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_hash TEXT NOT NULL CHECK (
    length(command_hash) = 64 AND command_hash NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('applying', 'complete')),
  operation_json TEXT CHECK (
    operation_json IS NULL OR
    (json_valid(operation_json) AND json_type(operation_json) = 'object')
  ),
  result_json TEXT CHECK (
    result_json IS NULL OR
    (json_valid(result_json) AND json_type(result_json) = 'object')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, event_id, command_id),
  CHECK (
    (state = 'applying' AND operation_json IS NOT NULL AND result_json IS NULL) OR
    (state = 'complete' AND operation_json IS NULL AND result_json IS NOT NULL)
  )
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_p_reviewer_groups_event_route
  ON p_reviewer_groups(organization_id, event_id, route_key, id)
  WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_reviews_assignment_state
  ON p_reviews(organization_id, event_id, reviewer_group_id, status, updated_at DESC, id DESC)
  WHERE source_deleted_at IS NULL;
CREATE INDEX idx_review_operation_receipts_active
  ON review_operation_command_receipts(state, updated_at, organization_id, event_id);
