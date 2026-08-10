ALTER TABLE p_tracks
  ADD COLUMN cfp_selection TEXT COLLATE NOCASE
  CHECK (cfp_selection IS NULL OR length(trim(cfp_selection)) > 0);

ALTER TABLE p_tracks
  ADD COLUMN cfp_aliases_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(cfp_aliases_json) AND json_type(cfp_aliases_json) = 'array');

ALTER TABLE p_tracks
  ADD COLUMN route_key TEXT COLLATE NOCASE
  CHECK (route_key IS NULL OR length(trim(route_key)) > 0);

ALTER TABLE p_tracks
  ADD COLUMN submission_track TEXT
  CHECK (submission_track IS NULL OR length(trim(submission_track)) > 0);

ALTER TABLE p_tracks
  ADD COLUMN default_reviewer_group_id TEXT
  CHECK (
    default_reviewer_group_id IS NULL OR
    length(trim(default_reviewer_group_id)) > 0
  );

ALTER TABLE p_submissions
  ADD COLUMN draft_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(draft_json) AND json_type(draft_json) = 'object');

ALTER TABLE p_submissions
  ADD COLUMN default_reviewer_group_id TEXT
  CHECK (
    default_reviewer_group_id IS NULL OR
    length(trim(default_reviewer_group_id)) > 0
  );

CREATE UNIQUE INDEX ux_p_tracks_cfp_selection_active
  ON p_tracks(organization_id, event_id, cfp_selection)
  WHERE source_deleted_at IS NULL AND cfp_selection IS NOT NULL;

CREATE UNIQUE INDEX ux_p_tracks_route_key_active
  ON p_tracks(organization_id, event_id, route_key)
  WHERE source_deleted_at IS NULL AND route_key IS NOT NULL;
