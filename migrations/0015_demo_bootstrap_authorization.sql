CREATE TABLE demo_bootstrap_authorizations (
  operation_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  environment TEXT NOT NULL CHECK (
    environment IN ('local', 'preview', 'production')
  ),
  base_key TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  organization_source_record_id TEXT NOT NULL,
  event_source_record_id TEXT NOT NULL,
  seed_version INTEGER NOT NULL CHECK (seed_version > 0),
  snapshot_id TEXT NOT NULL,
  seed_digest TEXT NOT NULL CHECK (
    length(seed_digest) = 64 AND seed_digest NOT GLOB '*[^0-9a-f]*'
  ),
  owner_email_hash TEXT CHECK (
    owner_email_hash IS NULL OR (
      length(owner_email_hash) = 64
      AND owner_email_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'leased', 'complete', 'failed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_expires_at TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK ((status = 'leased') = (lease_expires_at IS NOT NULL)),
  CHECK ((status = 'complete') = (completed_at IS NOT NULL)),
  CHECK ((status = 'complete') = (result_json IS NOT NULL))
) STRICT;

CREATE INDEX idx_demo_bootstrap_authorizations_pending
  ON demo_bootstrap_authorizations(status, expires_at, lease_expires_at)
  WHERE status IN ('pending', 'leased');
