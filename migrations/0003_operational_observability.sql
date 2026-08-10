CREATE TABLE operational_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE CHECK (
    length(dedupe_key) BETWEEN 3 AND 255
  ),
  event_type TEXT NOT NULL CHECK (
    length(event_type) BETWEEN 3 AND 128
  ),
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('accepted', 'client_error', 'failure', 'server_error', 'success')
  ),
  organization_id TEXT REFERENCES tenant_registry(organization_id),
  event_id TEXT,
  request_id TEXT,
  job_id TEXT,
  delivery_id TEXT,
  command_id TEXT,
  route TEXT,
  method TEXT CHECK (
    method IS NULL OR method IN ('DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT')
  ),
  response_status INTEGER CHECK (
    response_status IS NULL OR response_status BETWEEN 100 AND 599
  ),
  duration_ms REAL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  attempt_count INTEGER CHECK (attempt_count IS NULL OR attempt_count >= 0),
  queue_name TEXT,
  cache_status TEXT CHECK (
    cache_status IS NULL OR cache_status IN ('bypass', 'hit', 'miss')
  ),
  error_code TEXT,
  projection_lag_ms REAL CHECK (
    projection_lag_ms IS NULL OR projection_lag_ms >= 0
  ),
  queue_age_ms REAL CHECK (queue_age_ms IS NULL OR queue_age_ms >= 0),
  occurred_at TEXT NOT NULL CHECK (
    julianday(occurred_at) IS NOT NULL AND substr(occurred_at, -1) = 'Z'
  ),
  expires_at TEXT NOT NULL CHECK (
    julianday(expires_at) IS NOT NULL AND substr(expires_at, -1) = 'Z' AND
    julianday(expires_at) > julianday(occurred_at)
  ),
  CHECK (
    request_id IS NOT NULL OR job_id IS NOT NULL OR delivery_id IS NOT NULL OR
    command_id IS NOT NULL OR event_id IS NOT NULL
  )
) STRICT;

CREATE INDEX idx_operational_events_request
  ON operational_events(request_id, occurred_at, id)
  WHERE request_id IS NOT NULL;
CREATE INDEX idx_operational_events_job
  ON operational_events(job_id, occurred_at, id)
  WHERE job_id IS NOT NULL;
CREATE INDEX idx_operational_events_delivery
  ON operational_events(delivery_id, occurred_at, id)
  WHERE delivery_id IS NOT NULL;
CREATE INDEX idx_operational_events_event
  ON operational_events(organization_id, event_id, occurred_at DESC, id DESC)
  WHERE event_id IS NOT NULL;
CREATE INDEX idx_operational_events_expiry
  ON operational_events(expires_at, id);

CREATE TRIGGER operational_events_no_update
BEFORE UPDATE ON operational_events
BEGIN
  SELECT RAISE(ABORT, 'operational events are append-only');
END;

CREATE TRIGGER operational_events_no_early_delete
BEFORE DELETE ON operational_events
WHEN julianday(OLD.expires_at) > julianday('now')
BEGIN
  SELECT RAISE(ABORT, 'operational event retention has not elapsed');
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
       WHERE status IN ('bounced', 'complained', 'failed'))
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
