ALTER TABLE api_keys ADD COLUMN verifier_salt TEXT CHECK (
  verifier_salt IS NULL OR (
    length(verifier_salt) = 32 AND
    verifier_salt NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE INDEX idx_api_keys_management
  ON api_keys(organization_id, event_id, created_at DESC, id DESC);
