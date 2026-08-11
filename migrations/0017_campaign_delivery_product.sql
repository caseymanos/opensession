ALTER TABLE provider_messages ADD COLUMN scheduled_at TEXT;

DROP INDEX idx_provider_messages_queue_handoff;

CREATE INDEX idx_provider_messages_queue_handoff
  ON provider_messages(
    status, scheduled_at, queue_handed_off_at, queue_handoff_lease_expires_at
  )
  WHERE status = 'queued';

CREATE TABLE campaign_command_receipts (
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  campaign_id TEXT NOT NULL,
  preview_id TEXT NOT NULL CHECK (
    preview_id GLOB 'campaign_preview_*' AND length(preview_id) = 81
  ),
  plan_json TEXT NOT NULL CHECK (
    json_valid(plan_json) AND json_type(plan_json) = 'object'
  ),
  state TEXT NOT NULL CHECK (state IN ('preparing', 'applying', 'complete')),
  result_json TEXT CHECK (
    result_json IS NULL OR (
      json_valid(result_json) AND json_type(result_json) = 'object'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (organization_id, event_id, command_id),
  UNIQUE (organization_id, event_id, campaign_id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id),
  CHECK ((state = 'complete') = (result_json IS NOT NULL)),
  CHECK ((state = 'complete') = (completed_at IS NOT NULL))
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_campaign_command_receipts_pending
  ON campaign_command_receipts(organization_id, event_id, created_at, command_id)
  WHERE state IN ('preparing', 'applying');

CREATE TABLE campaign_message_receipts (
  organization_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  contact_source_record_id TEXT NOT NULL,
  queue_payload_json TEXT NOT NULL CHECK (
    json_valid(queue_payload_json) AND json_type(queue_payload_json) = 'object'
  ),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'queued')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, event_id, command_id, message_id),
  UNIQUE (organization_id, message_id),
  FOREIGN KEY (organization_id, event_id, command_id)
    REFERENCES campaign_command_receipts(organization_id, event_id, command_id)
    ON DELETE CASCADE,
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id),
  FOREIGN KEY (organization_id, contact_id) REFERENCES p_contacts(organization_id, id),
  CHECK (message_id GLOB 'email_*' AND length(message_id) = 70)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_campaign_message_receipts_resume
  ON campaign_message_receipts(
    organization_id, event_id, command_id, state, message_id
  );
