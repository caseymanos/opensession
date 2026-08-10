ALTER TABLE magic_link_tokens ADD COLUMN delivery_state TEXT NOT NULL
  DEFAULT 'queued'
  CHECK (delivery_state IN ('pending', 'queued', 'failed'));

CREATE TABLE auth_session_secrets (
  session_id TEXT PRIMARY KEY REFERENCES auth_sessions(id) ON DELETE CASCADE,
  csrf_token_hash TEXT NOT NULL UNIQUE CHECK (
    length(csrf_token_hash) = 64 AND csrf_token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE magic_link_scopes (
  token_id TEXT PRIMARY KEY REFERENCES magic_link_tokens(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  contact_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, event_id)
    REFERENCES p_events(organization_id, id),
  FOREIGN KEY (organization_id, contact_id)
    REFERENCES p_contacts(organization_id, id)
) STRICT;

CREATE TABLE magic_link_request_limits (
  dimension TEXT NOT NULL CHECK (dimension IN ('email', 'ip')),
  key_hash TEXT NOT NULL CHECK (
    length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  blocked_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (dimension, key_hash)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_magic_link_scope_event
  ON magic_link_scopes(organization_id, event_id, contact_id);

CREATE INDEX idx_magic_link_request_limits_blocked
  ON magic_link_request_limits(blocked_until)
  WHERE blocked_until IS NOT NULL;
