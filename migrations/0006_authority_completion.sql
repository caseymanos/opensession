CREATE TABLE authority_source_records (
  base_key TEXT NOT NULL,
  provider_table_key TEXT NOT NULL,
  provider_record_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  source_content_hash TEXT NOT NULL CHECK (
    length(source_content_hash) = 64 AND source_content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  last_command_id TEXT,
  last_command_hash TEXT CHECK (
    last_command_hash IS NULL OR
    (length(last_command_hash) = 64 AND last_command_hash NOT GLOB '*[^0-9a-f]*')
  ),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  last_seen_scan_id TEXT,
  projected_at TEXT NOT NULL,
  source_deleted_at TEXT,
  PRIMARY KEY (base_key, provider_table_key, provider_record_id),
  UNIQUE (base_key, provider_table_key, entity_id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) WITHOUT ROWID, STRICT;

CREATE INDEX authority_source_records_scope
  ON authority_source_records (
    organization_id, event_id, provider_table_key, source_deleted_at, entity_id
  );
CREATE INDEX authority_source_records_scan
  ON authority_source_records (
    base_key, provider_table_key, organization_id, last_seen_scan_id, source_deleted_at
  );

CREATE TABLE p_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  default_timezone TEXT NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  FOREIGN KEY (id) REFERENCES tenant_registry(organization_id)
) STRICT;

CREATE TABLE p_email_templates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  audience_type TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  sender_email TEXT NOT NULL COLLATE NOCASE,
  subject TEXT NOT NULL,
  body_document_json TEXT NOT NULL CHECK (json_valid(body_document_json)),
  body_html TEXT NOT NULL,
  body_text TEXT NOT NULL,
  reply_to TEXT COLLATE NOCASE,
  used_merge_fields_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(used_merge_fields_json) AND json_type(used_merge_fields_json) = 'array'
  ),
  merge_schema_version INTEGER NOT NULL CHECK (merge_schema_version >= 1),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  version INTEGER NOT NULL CHECK (version >= 1),
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE p_campaigns (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK (template_version >= 1),
  template_snapshot_json TEXT NOT NULL CHECK (json_valid(template_snapshot_json)),
  audience_filter_snapshot_json TEXT NOT NULL CHECK (json_valid(audience_filter_snapshot_json)),
  trigger_name TEXT NOT NULL,
  scheduled_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'complete', 'failed')),
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id),
  FOREIGN KEY (organization_id, event_id, template_id)
    REFERENCES p_email_templates(organization_id, event_id, id)
) STRICT;

CREATE TABLE p_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL COLLATE NOCASE,
  idempotency_key TEXT NOT NULL,
  provider_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'bounced', 'failed')),
  queued_at TEXT,
  sent_at TEXT,
  delivered_at TEXT,
  error_code TEXT,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, event_id, campaign_id)
    REFERENCES p_campaigns(organization_id, event_id, id),
  FOREIGN KEY (organization_id, contact_id) REFERENCES p_contacts(organization_id, id)
) STRICT;

CREATE TABLE p_integrations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('disabled', 'enabled', 'degraded')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  non_secret_config_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(non_secret_config_json) AND json_type(non_secret_config_json) = 'object'
  ),
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE p_external_mappings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  last_synced_at TEXT,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, integration_id)
    REFERENCES p_integrations(organization_id, event_id, id)
) STRICT;

CREATE TABLE p_sync_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'apply')),
  cursor TEXT,
  counts_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counts_json)),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  started_at TEXT,
  finished_at TEXT,
  error_summary TEXT,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, integration_id)
    REFERENCES p_integrations(organization_id, event_id, id)
) STRICT;

CREATE INDEX p_organizations_active_slug
  ON p_organizations (slug) WHERE source_deleted_at IS NULL;
CREATE INDEX p_email_templates_event_active
  ON p_email_templates (organization_id, event_id, status, name)
  WHERE source_deleted_at IS NULL;
CREATE INDEX p_campaigns_event_active
  ON p_campaigns (organization_id, event_id, status, scheduled_at)
  WHERE source_deleted_at IS NULL;
CREATE INDEX p_messages_campaign_active
  ON p_messages (organization_id, event_id, campaign_id, status)
  WHERE source_deleted_at IS NULL;
CREATE INDEX p_integrations_event_active
  ON p_integrations (organization_id, event_id, status)
  WHERE source_deleted_at IS NULL;
CREATE INDEX p_external_mappings_lookup
  ON p_external_mappings (organization_id, event_id, integration_id, entity_type, source_id)
  WHERE source_deleted_at IS NULL;
CREATE INDEX p_sync_runs_integration_active
  ON p_sync_runs (organization_id, event_id, integration_id, status, started_at)
  WHERE source_deleted_at IS NULL;

CREATE TABLE authority_traces (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT,
  request_id TEXT NOT NULL,
  command_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN (
    'received', 'provider_dispatched', 'provider_committed', 'projection_pending',
    'projection_repaired', 'complete', 'failed'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'success', 'failure')),
  table_key TEXT,
  entity_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  occurred_at TEXT NOT NULL,
  UNIQUE (organization_id, request_id, command_id, phase, attempt_count),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE INDEX authority_traces_request
  ON authority_traces (organization_id, request_id, occurred_at);
CREATE INDEX authority_traces_command
  ON authority_traces (organization_id, command_id, occurred_at);

CREATE TABLE demo_snapshot_runs (
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  reset_run_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  actor_id TEXT NOT NULL,
  expected_source_version INTEGER NOT NULL CHECK (expected_source_version >= 0),
  operation_count INTEGER NOT NULL CHECK (operation_count >= 0),
  state TEXT NOT NULL CHECK (state IN ('received', 'applying', 'assets', 'deleting', 'complete', 'failed')),
  audit_event_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (organization_id, reset_run_id),
  UNIQUE (organization_id, event_id, snapshot_id, reset_run_id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) WITHOUT ROWID, STRICT;

CREATE TABLE demo_snapshot_items (
  organization_id TEXT NOT NULL,
  reset_run_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('record_upsert', 'record_delete', 'asset')),
  table_key TEXT,
  entity_id TEXT,
  provider_record_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'complete', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  last_error_code TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, reset_run_id, item_key),
  FOREIGN KEY (organization_id, reset_run_id)
    REFERENCES demo_snapshot_runs(organization_id, reset_run_id) ON DELETE CASCADE
) WITHOUT ROWID, STRICT;

CREATE INDEX demo_snapshot_items_pending
  ON demo_snapshot_items (organization_id, reset_run_id, state, item_type, item_key);
