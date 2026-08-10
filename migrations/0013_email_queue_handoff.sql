ALTER TABLE provider_messages
  ADD COLUMN queue_handoff_lease_expires_at TEXT;

ALTER TABLE provider_messages
  ADD COLUMN queue_handed_off_at TEXT;

ALTER TABLE provider_messages
  ADD COLUMN queue_payload_json TEXT;

CREATE INDEX idx_provider_messages_queue_handoff
  ON provider_messages(status, queue_handed_off_at, queue_handoff_lease_expires_at)
  WHERE status = 'queued';

CREATE UNIQUE INDEX idx_provider_messages_cfp_receipt_identity
  ON provider_messages(organization_id, campaign_id)
  WHERE kind = 'campaign' AND campaign_id GLOB 'cfp_receipt_*';
