CREATE TABLE abuse_rate_limits (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL CHECK (
    length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  window_started_at INTEGER NOT NULL CHECK (window_started_at >= 0),
  request_count INTEGER NOT NULL CHECK (request_count >= 1),
  blocked_until INTEGER NOT NULL DEFAULT 0 CHECK (blocked_until >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, key_hash)
) WITHOUT ROWID, STRICT;

CREATE INDEX abuse_rate_limits_cleanup
  ON abuse_rate_limits (updated_at);
