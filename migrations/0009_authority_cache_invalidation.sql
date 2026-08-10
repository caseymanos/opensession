CREATE TABLE authority_cache_invalidations (
  organization_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'published')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  last_error_code TEXT,
  PRIMARY KEY (organization_id, event_id),
  FOREIGN KEY (organization_id, event_id)
    REFERENCES p_events(organization_id, id)
) WITHOUT ROWID, STRICT;

CREATE INDEX authority_cache_invalidations_pending
  ON authority_cache_invalidations(status, updated_at, organization_id, event_id);
