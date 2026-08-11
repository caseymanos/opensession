ALTER TABLE authority_cache_invalidations
  ADD COLUMN publication_version INTEGER
  CHECK (publication_version IS NULL OR publication_version > 0);

ALTER TABLE authority_cache_invalidations
  ADD COLUMN surfaces_json TEXT NOT NULL DEFAULT '["schedule","gallery","feed"]'
  CHECK (
    json_valid(surfaces_json) AND
    json_type(surfaces_json) = 'array' AND
    json_array_length(surfaces_json) > 0
  );

CREATE TABLE schedule_publications (
  organization_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  publication_version INTEGER NOT NULL CHECK (publication_version > 0),
  schedule_version INTEGER NOT NULL CHECK (schedule_version >= publication_version),
  snapshot_id TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL,
  schedule_snapshot_json TEXT NOT NULL CHECK (
    json_valid(schedule_snapshot_json) AND
    json_type(schedule_snapshot_json) = 'object'
  ),
  public_projection_json TEXT NOT NULL CHECK (
    json_valid(public_projection_json) AND
    json_type(public_projection_json) = 'object'
  ),
  snapshot_sha256 TEXT NOT NULL CHECK (
    length(snapshot_sha256) = 64 AND
    snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  soft_warning_override_json TEXT CHECK (
    soft_warning_override_json IS NULL OR (
      json_valid(soft_warning_override_json) AND
      json_type(soft_warning_override_json) = 'object'
    )
  ),
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, event_id, publication_version),
  UNIQUE (organization_id, event_id, command_id),
  FOREIGN KEY (organization_id, event_id)
    REFERENCES p_events(organization_id, id)
) WITHOUT ROWID, STRICT;

CREATE INDEX schedule_publications_latest
  ON schedule_publications(event_id, publication_version DESC);

CREATE TRIGGER schedule_publications_immutable_update
BEFORE UPDATE ON schedule_publications
BEGIN
  SELECT RAISE(ABORT, 'schedule publications are immutable');
END;

CREATE TRIGGER schedule_publications_immutable_delete
BEFORE DELETE ON schedule_publications
BEGIN
  SELECT RAISE(ABORT, 'schedule publications are immutable');
END;

CREATE TABLE schedule_public_changes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  source_publication_version INTEGER NOT NULL
    CHECK (source_publication_version > 0),
  change_type TEXT NOT NULL
    CHECK (change_type IN ('rescheduled', 'canceled', 'unassigned')),
  previous_public_session_json TEXT NOT NULL CHECK (
    json_valid(previous_public_session_json) AND
    json_type(previous_public_session_json) = 'object'
  ),
  next_draft_session_json TEXT NOT NULL CHECK (
    json_valid(next_draft_session_json) AND
    json_type(next_draft_session_json) = 'object'
  ),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, event_id, command_id, session_id, change_type),
  FOREIGN KEY (organization_id, event_id)
    REFERENCES p_events(organization_id, id)
) STRICT;

CREATE INDEX schedule_public_changes_event
  ON schedule_public_changes(
    organization_id, event_id, source_publication_version, occurred_at
  );
