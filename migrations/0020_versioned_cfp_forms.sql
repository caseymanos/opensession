ALTER TABLE p_form_rules RENAME TO p_form_rules_v0019;
ALTER TABLE p_form_fields RENAME TO p_form_fields_v0019;

CREATE TABLE p_form_fields (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  block_type TEXT NOT NULL CHECK (
    block_type IN (
      'text', 'textarea', 'select', 'multiselect', 'checkbox', 'file',
      'participant', 'section', 'url'
    )
  ),
  label TEXT NOT NULL,
  help_text TEXT,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  options_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(options_json) AND json_type(options_json) = 'array'),
  validation_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(validation_json) AND json_type(validation_json) = 'object'),
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, form_id, id),
  UNIQUE (form_id, stable_key),
  FOREIGN KEY (organization_id, event_id, form_id)
    REFERENCES p_forms(organization_id, event_id, id)
) STRICT;

INSERT INTO p_form_fields
SELECT * FROM p_form_fields_v0019;

CREATE TABLE p_form_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  target_field_id TEXT NOT NULL,
  source_field_id TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('show', 'require')),
  operator TEXT NOT NULL CHECK (
    operator IN (
      'equals', 'not_equals', 'contains', 'not_contains', 'is_empty',
      'is_not_empty'
    )
  ),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  sort_order INTEGER NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, form_id)
    REFERENCES p_forms(organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, form_id, target_field_id)
    REFERENCES p_form_fields(organization_id, event_id, form_id, id),
  FOREIGN KEY (organization_id, event_id, form_id, source_field_id)
    REFERENCES p_form_fields(organization_id, event_id, form_id, id)
) STRICT;

INSERT INTO p_form_rules
SELECT * FROM p_form_rules_v0019;

DROP TABLE p_form_rules_v0019;
DROP TABLE p_form_fields_v0019;

CREATE INDEX idx_p_form_fields_order
  ON p_form_fields(organization_id, event_id, form_id, sort_order)
  WHERE source_deleted_at IS NULL;

CREATE INDEX idx_p_form_rules_order
  ON p_form_rules(organization_id, event_id, form_id, sort_order)
  WHERE source_deleted_at IS NULL;

CREATE UNIQUE INDEX uq_p_forms_active_draft
  ON p_forms(organization_id, event_id)
  WHERE status = 'draft' AND source_deleted_at IS NULL;

CREATE UNIQUE INDEX uq_p_forms_active_publication
  ON p_forms(organization_id, event_id)
  WHERE status = 'published' AND source_deleted_at IS NULL;

CREATE UNIQUE INDEX uq_p_forms_publication_version
  ON p_forms(organization_id, event_id, version)
  WHERE status IN ('published', 'closed') AND source_deleted_at IS NULL;

ALTER TABLE p_submission_answers
  ADD COLUMN form_version_snapshot INTEGER
  CHECK (form_version_snapshot IS NULL OR form_version_snapshot >= 1);

UPDATE p_submission_answers
SET form_version_snapshot = (
  SELECT form_version
  FROM p_submissions
  WHERE p_submissions.organization_id = p_submission_answers.organization_id
    AND p_submissions.event_id = p_submission_answers.event_id
    AND p_submissions.id = p_submission_answers.submission_id
);

CREATE TRIGGER p_submission_answers_version_insert_guard
BEFORE INSERT ON p_submission_answers
WHEN NEW.form_version_snapshot IS NOT NULL
  AND NEW.form_version_snapshot != (
    SELECT form_version
    FROM p_submissions
    WHERE organization_id = NEW.organization_id
      AND event_id = NEW.event_id
      AND id = NEW.submission_id
  )
BEGIN
  SELECT RAISE(ABORT, 'submission answer form version mismatch');
END;

CREATE TRIGGER p_submission_answers_version_update_guard
BEFORE UPDATE OF form_version_snapshot, submission_id ON p_submission_answers
WHEN NEW.form_version_snapshot IS NOT NULL
  AND NEW.form_version_snapshot != (
    SELECT form_version
    FROM p_submissions
    WHERE organization_id = NEW.organization_id
      AND event_id = NEW.event_id
      AND id = NEW.submission_id
  )
BEGIN
  SELECT RAISE(ABORT, 'submission answer form version mismatch');
END;

CREATE TRIGGER p_submission_answers_version_insert_fill
AFTER INSERT ON p_submission_answers
WHEN NEW.form_version_snapshot IS NULL
BEGIN
  UPDATE p_submission_answers
  SET form_version_snapshot = (
    SELECT form_version
    FROM p_submissions
    WHERE organization_id = NEW.organization_id
      AND event_id = NEW.event_id
      AND id = NEW.submission_id
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER p_submission_answers_version_update_fill
AFTER UPDATE OF form_version_snapshot, submission_id ON p_submission_answers
WHEN NEW.form_version_snapshot IS NULL
BEGIN
  UPDATE p_submission_answers
  SET form_version_snapshot = (
    SELECT form_version
    FROM p_submissions
    WHERE organization_id = NEW.organization_id
      AND event_id = NEW.event_id
      AND id = NEW.submission_id
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER p_submissions_answer_version_guard
BEFORE UPDATE OF form_version ON p_submissions
WHEN EXISTS (
  SELECT 1
  FROM p_submission_answers
  WHERE organization_id = OLD.organization_id
    AND event_id = OLD.event_id
    AND submission_id = OLD.id
    AND form_version_snapshot != NEW.form_version
)
BEGIN
  SELECT RAISE(ABORT, 'submitted answer snapshots are immutable');
END;
