DROP VIEW operational_metric_snapshot;

ALTER TABLE magic_link_tokens ADD COLUMN delivery_recipient_hash TEXT
  CHECK (delivery_recipient_hash IS NULL OR length(delivery_recipient_hash) = 64);
ALTER TABLE magic_link_tokens ADD COLUMN delivery_payload_hash TEXT
  CHECK (delivery_payload_hash IS NULL OR length(delivery_payload_hash) = 64);
ALTER TABLE magic_link_tokens ADD COLUMN delivery_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (delivery_attempt_count >= 0);
ALTER TABLE magic_link_tokens ADD COLUMN delivery_lease_expires_at TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN delivery_completed_at TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN delivery_mode TEXT
  CHECK (delivery_mode IS NULL OR delivery_mode IN ('sink', 'allowlist', 'live'));
ALTER TABLE magic_link_tokens ADD COLUMN provider_message_id TEXT;
ALTER TABLE magic_link_tokens ADD COLUMN delivery_error_code TEXT;

ALTER TABLE provider_messages RENAME TO provider_messages_v1;

CREATE TABLE provider_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT,
  campaign_id TEXT,
  contact_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('campaign', 'legacy')),
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  idempotency_key TEXT NOT NULL,
  recipient_hash TEXT NOT NULL CHECK (length(recipient_hash) = 64),
  payload_hash TEXT CHECK (payload_hash IS NULL OR length(payload_hash) = 64),
  template_id TEXT,
  template_version INTEGER CHECK (template_version IS NULL OR template_version > 0),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('sink', 'allowlist', 'live')),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued', 'sending', 'sent', 'delivered', 'bounced', 'complained',
      'failed', 'suppressed'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  delivered_at TEXT,
  error_code TEXT,
  last_provider_event_id TEXT,
  last_provider_event_at TEXT,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (provider, provider_message_id),
  CHECK ((status = 'sending') = (lease_expires_at IS NOT NULL)),
  CHECK (
    kind != 'campaign' OR (
      event_id IS NOT NULL AND campaign_id IS NOT NULL AND contact_id IS NOT NULL
      AND template_id IS NOT NULL AND template_version IS NOT NULL
      AND payload_hash IS NOT NULL
    )
  ),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

INSERT INTO provider_messages (
  id, organization_id, event_id, kind, provider, provider_message_id,
  idempotency_key, recipient_hash, template_id, payload_hash, delivery_mode, status,
  attempt_count, created_at, updated_at, sent_at, delivered_at, error_code
)
SELECT
  id, organization_id, event_id, 'legacy', provider, provider_message_id,
  idempotency_key, recipient_hash, template_id, NULL, 'sink', status,
  attempt_count, created_at, updated_at, sent_at, delivered_at, error_code
FROM provider_messages_v1;

DROP TABLE provider_messages_v1;

CREATE TABLE email_delivery_attempts (
  message_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('sink', 'allowlist', 'live')),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('sent', 'sink', 'retry', 'failed', 'suppressed', 'blocked')
  ),
  provider_message_id TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  PRIMARY KEY (message_id, attempt_number),
  FOREIGN KEY (organization_id, message_id)
    REFERENCES provider_messages(organization_id, id)
) WITHOUT ROWID, STRICT;

CREATE TABLE email_provider_events (
  provider_event_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  message_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'email.sent', 'email.delivered', 'email.bounced', 'email.complained',
      'email.failed', 'email.suppressed'
    )
  ),
  normalized_status TEXT NOT NULL CHECK (
    normalized_status IN ('sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed')
  ),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (organization_id, provider_event_id),
  FOREIGN KEY (organization_id, message_id)
    REFERENCES provider_messages(organization_id, id)
) STRICT;

CREATE TABLE email_suppressions (
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  recipient_hash TEXT NOT NULL CHECK (length(recipient_hash) = 64),
  reason TEXT NOT NULL CHECK (
    reason IN ('bounced', 'complained', 'manual', 'provider_suppressed')
  ),
  source_provider_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lifted_at TEXT,
  PRIMARY KEY (organization_id, recipient_hash),
  FOREIGN KEY (organization_id, source_provider_event_id)
    REFERENCES email_provider_events(organization_id, provider_event_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_provider_messages_event
  ON provider_messages(organization_id, event_id, status, created_at);
CREATE INDEX idx_provider_messages_campaign
  ON provider_messages(organization_id, campaign_id, status, created_at);
CREATE INDEX idx_provider_messages_provider
  ON provider_messages(provider, provider_message_id);
CREATE INDEX idx_email_provider_events_message
  ON email_provider_events(organization_id, message_id, occurred_at);
CREATE INDEX idx_email_suppressions_active
  ON email_suppressions(organization_id, recipient_hash)
  WHERE lifted_at IS NULL;
CREATE INDEX idx_magic_link_delivery_lease
  ON magic_link_tokens(delivery_state, delivery_lease_expires_at)
  WHERE delivery_completed_at IS NULL AND revoked_at IS NULL;

CREATE TRIGGER email_delivery_attempts_no_update
BEFORE UPDATE ON email_delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'email delivery attempts are append-only');
END;

CREATE TRIGGER email_delivery_attempts_no_delete
BEFORE DELETE ON email_delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'email delivery attempts are append-only');
END;

CREATE TRIGGER email_provider_events_no_update
BEFORE UPDATE ON email_provider_events
BEGIN
  SELECT RAISE(ABORT, 'email provider events are append-only');
END;

CREATE TRIGGER email_provider_events_no_delete
BEFORE DELETE ON email_provider_events
BEGIN
  SELECT RAISE(ABORT, 'email provider events are append-only');
END;

CREATE VIEW operational_metric_snapshot AS
WITH metrics(metric, value) AS (
  VALUES
    (
      'projection.public.max_age_seconds',
      (SELECT COALESCE(
         MAX(MAX(0, CAST((julianday('now') - julianday(projected_at)) * 86400 AS INTEGER))),
         0
       )
       FROM p_events
       WHERE status = 'published' AND source_deleted_at IS NULL)
    ),
    (
      'queue.outbox.oldest_age_seconds',
      (SELECT COALESCE(
         MAX(MAX(0, CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER))),
         0
       )
       FROM outbox_events
       WHERE status IN ('pending', 'leased', 'failed'))
    ),
    (
      'queue.outbox.retry_count',
      (SELECT COALESCE(SUM(attempt_count), 0)
       FROM outbox_events
       WHERE status IN ('pending', 'leased', 'failed', 'dead'))
    ),
    (
      'queue.projection_repair.oldest_age_seconds',
      (SELECT COALESCE(
         MAX(MAX(0, CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER))),
         0
       )
       FROM projection_repairs
       WHERE status IN ('pending', 'leased', 'failed'))
    ),
    (
      'queue.projection_repair.retry_count',
      (SELECT COALESCE(SUM(attempt_count), 0)
       FROM projection_repairs
       WHERE status IN ('pending', 'leased', 'failed', 'dead'))
    ),
    (
      'queue.webhook.oldest_age_seconds',
      (SELECT COALESCE(
         MAX(MAX(0, CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER))),
         0
       )
       FROM webhook_deliveries
       WHERE status IN ('queued', 'sending', 'retry', 'failed'))
    ),
    (
      'queue.webhook.retry_count',
      (SELECT COALESCE(SUM(attempt_count), 0)
       FROM webhook_deliveries
       WHERE status IN ('queued', 'sending', 'retry', 'failed', 'dead'))
    ),
    (
      'workflow.failed.count',
      (SELECT COUNT(*) FROM workflow_runs WHERE status = 'failed')
    ),
    (
      'email.failed.count',
      (SELECT COUNT(*) FROM provider_messages
       WHERE status IN ('bounced', 'complained', 'failed', 'suppressed'))
    ),
    (
      'export.failed.count',
      (SELECT COUNT(*) FROM integration_runs WHERE status = 'failed')
    ),
    (
      'conflict.review.open.count',
      (SELECT COUNT(*) FROM p_reviews
       WHERE conflict = 1 AND status != 'withdrawn' AND source_deleted_at IS NULL)
    ),
    (
      'operational.error.last_15_minutes.count',
      (SELECT COUNT(*) FROM operational_events
       WHERE level = 'error'
         AND julianday(occurred_at) >= julianday('now', '-15 minutes'))
    )
)
SELECT metric, value FROM metrics;
