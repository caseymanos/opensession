CREATE TABLE cfp_submission_reservations (
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, event_id, submission_id),
  UNIQUE (organization_id, event_id, plan_id),
  FOREIGN KEY (organization_id, event_id)
    REFERENCES p_events(organization_id, id)
) WITHOUT ROWID, STRICT;

CREATE INDEX ix_cfp_submission_reservations_user
  ON cfp_submission_reservations(organization_id, event_id, user_id);
