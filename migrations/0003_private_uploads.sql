ALTER TABLE file_objects ADD COLUMN purpose TEXT NOT NULL
  DEFAULT 'submission_attachment'
  CHECK (
    purpose IN (
      'headshot',
      'slides',
      'submission_attachment',
      'task_attachment',
      'resource'
    )
  );

ALTER TABLE file_objects ADD COLUMN lineage_id TEXT;
ALTER TABLE file_objects ADD COLUMN version_number INTEGER NOT NULL
  DEFAULT 1 CHECK (version_number > 0);
ALTER TABLE file_objects ADD COLUMN replaces_file_id TEXT;
ALTER TABLE file_objects ADD COLUMN r2_version TEXT;
ALTER TABLE file_objects ADD COLUMN r2_etag TEXT;
ALTER TABLE file_objects ADD COLUMN last_error_code TEXT;
ALTER TABLE file_objects ADD COLUMN updated_at TEXT;

CREATE TABLE file_upload_intents (
  id TEXT PRIMARY KEY,
  file_object_id TEXT NOT NULL UNIQUE REFERENCES file_objects(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'issued', 'uploading', 'uploaded', 'finalized', 'cleanup', 'failed', 'expired'
    )
  ),
  expires_at TEXT NOT NULL,
  cleanup_after TEXT NOT NULL,
  lease_id TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  uploaded_at TEXT,
  finalized_at TEXT,
  last_cleanup_at TEXT,
  CHECK (
    (status = 'uploading' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status != 'uploading'
  )
) STRICT;

CREATE UNIQUE INDEX ux_file_objects_lineage_version
  ON file_objects(lineage_id, version_number)
  WHERE lineage_id IS NOT NULL;

CREATE INDEX idx_file_upload_intents_cleanup
  ON file_upload_intents(status, cleanup_after, lease_expires_at);

CREATE INDEX idx_file_upload_intents_reconcile
  ON file_upload_intents(status, last_cleanup_at);

CREATE INDEX idx_file_objects_event_quota
  ON file_objects(organization_id, event_id, status, byte_size);
