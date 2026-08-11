ALTER TABLE p_events ADD COLUMN review_closes_at TEXT;

ALTER TABLE p_reviews ADD COLUMN score_snapshot_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(score_snapshot_json) AND
    json_type(score_snapshot_json) = 'array'
  );
ALTER TABLE p_reviews ADD COLUMN reviewer_note TEXT;

CREATE INDEX idx_p_reviews_reviewer_deadline
  ON p_reviews(organization_id, event_id, reviewer_id, status, updated_at DESC, id DESC)
  WHERE source_deleted_at IS NULL AND status <> 'withdrawn';
