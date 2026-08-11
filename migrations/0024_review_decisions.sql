ALTER TABLE p_submissions ADD COLUMN decision_snapshot_json TEXT NOT NULL DEFAULT '{}'
  CHECK (
    json_valid(decision_snapshot_json) AND
    json_type(decision_snapshot_json) = 'object'
  );
