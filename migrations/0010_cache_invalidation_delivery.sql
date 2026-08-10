CREATE TABLE authority_cache_invalidations_v2 (
  organization_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'published', 'enqueued', 'processed')),
  invalidation_version INTEGER NOT NULL DEFAULT 1
    CHECK (invalidation_version > 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  enqueued_at TEXT,
  processed_at TEXT,
  last_error_code TEXT,
  PRIMARY KEY (organization_id, event_id),
  FOREIGN KEY (organization_id, event_id)
    REFERENCES p_events(organization_id, id)
) WITHOUT ROWID, STRICT;

INSERT INTO authority_cache_invalidations_v2 (
  organization_id, event_id, status, invalidation_version, attempt_count,
  created_at, updated_at, published_at, enqueued_at, last_error_code
)
SELECT organization_id, event_id, status, 1, attempt_count,
       created_at, updated_at, published_at, published_at, last_error_code
FROM authority_cache_invalidations;

DROP TABLE authority_cache_invalidations;

ALTER TABLE authority_cache_invalidations_v2
  RENAME TO authority_cache_invalidations;

CREATE INDEX authority_cache_invalidations_pending
  ON authority_cache_invalidations(status, updated_at, organization_id, event_id);

CREATE TRIGGER authority_cache_invalidations_legacy_pending_version
AFTER UPDATE OF status, updated_at ON authority_cache_invalidations
WHEN NEW.status = 'pending'
  AND NEW.invalidation_version = OLD.invalidation_version
  AND (NEW.status <> OLD.status OR NEW.updated_at <> OLD.updated_at)
BEGIN
  UPDATE authority_cache_invalidations
  SET invalidation_version = OLD.invalidation_version + 1
  WHERE organization_id = NEW.organization_id
    AND event_id = NEW.event_id
    AND invalidation_version = OLD.invalidation_version;
END;
