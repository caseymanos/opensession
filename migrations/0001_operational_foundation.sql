CREATE TABLE tenant_registry (
  organization_id TEXT PRIMARY KEY,
  base_key TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (base_key, source_record_id)
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  UNIQUE (email_normalized)
) STRICT;

CREATE TABLE organization_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'organizer', 'viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (organization_id, user_id)
) STRICT;

CREATE TABLE event_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('organizer', 'reviewer', 'viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (event_id, user_id, role),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id),
  FOREIGN KEY (organization_id, contact_id) REFERENCES p_contacts(organization_id, id)
) STRICT;

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  rotated_at TEXT,
  revoked_at TEXT,
  ip_hash TEXT CHECK (ip_hash IS NULL OR length(ip_hash) = 64),
  user_agent_hash TEXT CHECK (user_agent_hash IS NULL OR length(user_agent_hash) = 64)
) STRICT;

CREATE TABLE magic_link_tokens (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL COLLATE NOCASE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('sign_in', 'invite', 'portal')),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  redirect_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  request_ip_hash TEXT CHECK (request_ip_hash IS NULL OR length(request_ip_hash) = 64)
) STRICT;

CREATE TABLE portal_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id),
  FOREIGN KEY (organization_id, contact_id) REFERENCES p_contacts(organization_id, id)
) STRICT;

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  scopes_json TEXT NOT NULL CHECK (
    json_valid(scopes_json) AND json_type(scopes_json) = 'array'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  UNIQUE (organization_id, token_prefix),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE idempotency_keys (
  tenant_key TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  operation TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'committed', 'committed_with_repair', 'unknown', 'failed')
  ),
  entity_type TEXT,
  entity_id TEXT,
  original_response_status INTEGER CHECK (
    original_response_status IS NULL OR original_response_status BETWEEN 100 AND 599
  ),
  original_response_json TEXT CHECK (
    original_response_json IS NULL OR json_valid(original_response_json)
  ),
  error_code TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant_key, operation, command_id),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
) WITHOUT ROWID, STRICT;

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'leased', 'published', 'failed', 'dead')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  last_error_code TEXT,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
) STRICT;

CREATE TABLE projection_repairs (
  id TEXT PRIMARY KEY,
  repair_key TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT,
  provider TEXT NOT NULL,
  base_key TEXT NOT NULL,
  command_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'full_scan')),
  provider_table_key TEXT NOT NULL,
  provider_record_id TEXT,
  entity_id TEXT,
  reason_code TEXT NOT NULL,
  source_content_hash TEXT CHECK (source_content_hash IS NULL OR length(source_content_hash) = 64),
  webhook_cursor INTEGER CHECK (webhook_cursor IS NULL OR webhook_cursor >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'leased', 'complete', 'failed', 'dead')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  last_error_code TEXT,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (operation = 'full_scan' OR provider_record_id IS NOT NULL)
) STRICT;

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT,
  workflow_type TEXT NOT NULL,
  provider_instance_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'sleeping', 'complete', 'failed', 'canceled')
  ),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  checkpoint_json TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE provider_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  idempotency_key TEXT NOT NULL,
  recipient_hash TEXT NOT NULL CHECK (length(recipient_hash) = 64),
  template_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  delivered_at TEXT,
  error_code TEXT,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (provider, provider_message_id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT,
  url TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_nonce TEXT NOT NULL,
  secret_key_version INTEGER NOT NULL CHECK (secret_key_version > 0),
  event_types_json TEXT NOT NULL CHECK (
    json_valid(event_types_json) AND json_type(event_types_json) = 'array'
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  endpoint_id TEXT NOT NULL,
  outbox_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
  ),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'sending', 'delivered', 'retry', 'failed', 'dead')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  last_error_code TEXT,
  UNIQUE (organization_id, id),
  UNIQUE (endpoint_id, outbox_event_id),
  FOREIGN KEY (organization_id, endpoint_id) REFERENCES webhook_endpoints(organization_id, id),
  FOREIGN KEY (organization_id, outbox_event_id) REFERENCES outbox_events(organization_id, id)
) STRICT;

CREATE TABLE webhook_delivery_attempts (
  delivery_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  request_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  response_status INTEGER CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'retry', 'failed')),
  error_code TEXT,
  response_body_hash TEXT CHECK (response_body_hash IS NULL OR length(response_body_hash) = 64),
  PRIMARY KEY (delivery_id, attempt_number),
  FOREIGN KEY (organization_id, delivery_id) REFERENCES webhook_deliveries(organization_id, id)
) WITHOUT ROWID, STRICT;

CREATE TABLE integration_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'apply')),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'complete', 'failed', 'canceled')
  ),
  cursor TEXT,
  counts_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(counts_json) AND json_type(counts_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE external_mappings (
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  integration_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  last_synced_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (organization_id, integration_id, entity_type, source_id),
  UNIQUE (organization_id, integration_id, entity_type, external_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE projection_watermarks (
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  provider TEXT NOT NULL,
  base_key TEXT NOT NULL,
  table_key TEXT NOT NULL,
  committed_cursor INTEGER CHECK (committed_cursor IS NULL OR committed_cursor >= 0),
  last_transaction_number INTEGER,
  last_provider_time TEXT,
  last_full_scan_id TEXT,
  last_full_scan_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, provider, base_key, table_key)
) WITHOUT ROWID, STRICT;

CREATE TABLE airtable_webhooks (
  base_key TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL UNIQUE,
  mac_secret_ciphertext TEXT NOT NULL,
  mac_secret_nonce TEXT NOT NULL,
  mac_secret_key_version INTEGER NOT NULL CHECK (mac_secret_key_version > 0),
  committed_cursor INTEGER NOT NULL DEFAULT 1 CHECK (committed_cursor >= 1),
  in_flight_cursor INTEGER CHECK (in_flight_cursor IS NULL OR in_flight_cursor >= committed_cursor),
  last_transaction_number INTEGER,
  notification_url TEXT NOT NULL,
  expiration_time TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'refreshing', 'expired', 'disabled')),
  full_scan_required INTEGER NOT NULL DEFAULT 0 CHECK (full_scan_required IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_notification_at TEXT,
  last_payload_at TEXT,
  last_error_code TEXT
) STRICT;

CREATE TABLE projection_scan_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  provider TEXT NOT NULL,
  base_key TEXT NOT NULL,
  table_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'canceled')),
  start_cursor INTEGER CHECK (start_cursor IS NULL OR start_cursor >= 0),
  end_cursor INTEGER CHECK (end_cursor IS NULL OR end_cursor >= 0),
  seen_count INTEGER NOT NULL DEFAULT 0 CHECK (seen_count >= 0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  UNIQUE (organization_id, id)
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'api_key', 'portal', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  command_id TEXT,
  redaction_version INTEGER NOT NULL CHECK (redaction_version > 0),
  safe_diff_json TEXT NOT NULL CHECK (
    json_valid(safe_diff_json) AND json_type(safe_diff_json) = 'object'
  ),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id),
  CHECK (
    (actor_type = 'system' AND actor_id IS NULL) OR
    (actor_type <> 'system' AND actor_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE file_objects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT,
  owner_contact_id TEXT,
  uploaded_by_user_id TEXT REFERENCES users(id),
  object_key TEXT NOT NULL UNIQUE,
  display_filename TEXT NOT NULL,
  declared_mime_type TEXT NOT NULL,
  detected_mime_type TEXT,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  checksum_sha256 TEXT CHECK (checksum_sha256 IS NULL OR length(checksum_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'quarantined', 'deleted')),
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  deleted_at TEXT,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id),
  FOREIGN KEY (organization_id, owner_contact_id) REFERENCES p_contacts(organization_id, id)
) STRICT;

CREATE TABLE p_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  timezone TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  venue TEXT,
  cfp_opens_at TEXT,
  cfp_closes_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'closed', 'published', 'archived')),
  brand_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(brand_json) AND json_type(brand_json) = 'object'),
  published_version INTEGER NOT NULL DEFAULT 0 CHECK (published_version >= 0),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, id)
) STRICT;

CREATE TABLE p_forms (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'closed', 'archived')),
  version INTEGER NOT NULL CHECK (version >= 1),
  welcome_content TEXT,
  submission_limit INTEGER CHECK (submission_limit IS NULL OR submission_limit > 0),
  edit_after_close INTEGER NOT NULL DEFAULT 0 CHECK (edit_after_close IN (0, 1)),
  published_at TEXT,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE p_form_fields (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  block_type TEXT NOT NULL CHECK (
    block_type IN ('text', 'textarea', 'select', 'multiselect', 'checkbox', 'file', 'participant')
  ),
  label TEXT NOT NULL,
  help_text TEXT,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  options_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options_json) AND json_type(options_json) = 'array'),
  validation_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(validation_json) AND json_type(validation_json) = 'object'),
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, form_id, id),
  UNIQUE (form_id, stable_key),
  FOREIGN KEY (organization_id, event_id, form_id) REFERENCES p_forms(organization_id, event_id, id)
) STRICT;

CREATE TABLE p_form_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  target_field_id TEXT NOT NULL,
  source_field_id TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('show', 'require')),
  operator TEXT NOT NULL CHECK (
    operator IN ('equals', 'not_equals', 'contains', 'not_contains', 'is_empty', 'is_not_empty')
  ),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  sort_order INTEGER NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, form_id) REFERENCES p_forms(organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, form_id, target_field_id) REFERENCES p_form_fields(organization_id, event_id, form_id, id),
  FOREIGN KEY (organization_id, event_id, form_id, source_field_id) REFERENCES p_form_fields(organization_id, event_id, form_id, id)
) STRICT;

CREATE TABLE p_contacts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  email_normalized TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  pronouns TEXT,
  title TEXT,
  company TEXT,
  bio TEXT,
  headshot_object_key TEXT,
  social_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(social_json) AND json_type(social_json) = 'object'),
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, id)
) STRICT;

CREATE TABLE p_event_contacts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  roles_json TEXT NOT NULL CHECK (json_valid(roles_json) AND json_type(roles_json) = 'array'),
  portal_state TEXT NOT NULL CHECK (portal_state IN ('not_invited', 'invited', 'active', 'revoked')),
  invitation_at TEXT,
  last_active_at TEXT,
  readiness_projection_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(readiness_projection_json) AND json_type(readiness_projection_json) = 'object'
  ),
  required_total INTEGER NOT NULL DEFAULT 0 CHECK (required_total >= 0),
  required_complete INTEGER NOT NULL DEFAULT 0 CHECK (required_complete >= 0),
  overdue_count INTEGER NOT NULL DEFAULT 0 CHECK (overdue_count >= 0),
  next_due_at TEXT,
  speaker_ready INTEGER NOT NULL DEFAULT 0 CHECK (speaker_ready IN (0, 1)),
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  UNIQUE (event_id, contact_id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id),
  FOREIGN KEY (organization_id, contact_id) REFERENCES p_contacts(organization_id, id)
) STRICT;

CREATE TABLE p_submissions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  form_version INTEGER NOT NULL CHECK (form_version >= 1),
  friendly_id TEXT NOT NULL,
  submitter_contact_id TEXT NOT NULL,
  title TEXT NOT NULL,
  track_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'submitted', 'in_review', 'accepted', 'waitlisted', 'declined', 'withdrawn')
  ),
  route_key TEXT,
  submitted_at TEXT,
  decision_note TEXT,
  updated_at TEXT NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id),
  FOREIGN KEY (organization_id, event_id, form_id) REFERENCES p_forms(organization_id, event_id, id),
  FOREIGN KEY (organization_id, submitter_contact_id) REFERENCES p_contacts(organization_id, id),
  FOREIGN KEY (organization_id, event_id, track_id) REFERENCES p_tracks(organization_id, event_id, id)
) STRICT;

CREATE TABLE p_submission_answers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  field_stable_key TEXT NOT NULL,
  field_label_snapshot TEXT NOT NULL,
  answer_type TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  sort_order INTEGER NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (submission_id, field_stable_key),
  FOREIGN KEY (organization_id, event_id, submission_id) REFERENCES p_submissions(organization_id, event_id, id)
) STRICT;

CREATE TABLE p_submission_participants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  role TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (submission_id, contact_id, role),
  FOREIGN KEY (organization_id, event_id, submission_id) REFERENCES p_submissions(organization_id, event_id, id),
  FOREIGN KEY (organization_id, contact_id) REFERENCES p_contacts(organization_id, id)
) STRICT;

CREATE TABLE p_rubrics (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE p_criteria (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  rubric_id TEXT NOT NULL,
  label TEXT NOT NULL,
  guidance TEXT,
  minimum_score REAL NOT NULL,
  maximum_score REAL NOT NULL,
  weight REAL NOT NULL CHECK (weight > 0),
  sort_order INTEGER NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, rubric_id) REFERENCES p_rubrics(organization_id, event_id, id),
  CHECK (minimum_score <= maximum_score)
) STRICT;

CREATE TABLE p_reviews (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('assigned', 'draft', 'submitted', 'withdrawn')),
  conflict INTEGER NOT NULL CHECK (conflict IN (0, 1)),
  conflict_note TEXT,
  submitted_at TEXT,
  updated_at TEXT NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  UNIQUE (submission_id, reviewer_id),
  FOREIGN KEY (organization_id, event_id, submission_id) REFERENCES p_submissions(organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, reviewer_id) REFERENCES p_event_contacts(organization_id, event_id, id)
) STRICT;

CREATE TABLE p_review_scores (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  criterion_id TEXT NOT NULL,
  numeric_score REAL,
  comment TEXT,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (review_id, criterion_id),
  FOREIGN KEY (organization_id, event_id, review_id) REFERENCES p_reviews(organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, criterion_id) REFERENCES p_criteria(organization_id, event_id, id)
) STRICT;

CREATE TABLE p_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  source_submission_id TEXT,
  friendly_id TEXT NOT NULL,
  title TEXT NOT NULL,
  abstract TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'accepted', 'scheduled', 'published', 'canceled')),
  track_id TEXT,
  format_id TEXT,
  expected_attendance INTEGER CHECK (expected_attendance IS NULL OR expected_attendance >= 0),
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  external_mapping_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(external_mapping_json) AND json_type(external_mapping_json) = 'object'
  ),
  updated_at TEXT NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id),
  FOREIGN KEY (organization_id, event_id, source_submission_id) REFERENCES p_submissions(organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, track_id) REFERENCES p_tracks(organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, format_id) REFERENCES p_formats(organization_id, event_id, id)
) STRICT;

CREATE TABLE p_session_participants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('speaker', 'moderator', 'chair')),
  sort_order INTEGER NOT NULL,
  confirmed_state TEXT NOT NULL CHECK (confirmed_state IN ('pending', 'confirmed', 'declined')),
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (session_id, contact_id, role),
  FOREIGN KEY (organization_id, event_id, session_id) REFERENCES p_sessions(organization_id, event_id, id),
  FOREIGN KEY (organization_id, contact_id) REFERENCES p_contacts(organization_id, id)
) STRICT;

CREATE TABLE p_rooms (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  capacity INTEGER CHECK (capacity IS NULL OR capacity >= 0),
  sort_order INTEGER NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE p_tracks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  description TEXT,
  sort_order INTEGER NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE p_formats (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  default_duration_minutes INTEGER CHECK (default_duration_minutes IS NULL OR default_duration_minutes > 0),
  sort_order INTEGER NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE p_schedule_slots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  published_version INTEGER NOT NULL DEFAULT 0 CHECK (published_version >= 0),
  override_reason TEXT,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  UNIQUE (event_id, session_id),
  FOREIGN KEY (organization_id, event_id, session_id) REFERENCES p_sessions(organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, room_id) REFERENCES p_rooms(organization_id, event_id, id),
  CHECK (starts_at < ends_at)
) STRICT;

CREATE TABLE p_task_definitions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('link', 'form', 'file', 'ack')),
  description TEXT,
  required_default INTEGER NOT NULL CHECK (required_default IN (0, 1)),
  approval_required INTEGER NOT NULL CHECK (approval_required IN (0, 1)),
  target_rule_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(target_rule_json) AND json_type(target_rule_json) = 'object'),
  form_schema_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(form_schema_json) AND json_type(form_schema_json) = 'object'),
  file_policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(file_policy_json) AND json_type(file_policy_json) = 'object'),
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE TABLE p_task_assignments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  session_id TEXT,
  due_at TEXT,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  status TEXT NOT NULL CHECK (
    status IN ('not_started', 'in_progress', 'submitted', 'complete', 'rejected', 'waived')
  ),
  completed_at TEXT,
  approved_at TEXT,
  approved_by_id TEXT,
  response_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(response_json)),
  file_object_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(file_object_ids_json) AND json_type(file_object_ids_json) = 'array'
  ),
  updated_at TEXT NOT NULL,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, definition_id) REFERENCES p_task_definitions(organization_id, event_id, id),
  FOREIGN KEY (organization_id, contact_id) REFERENCES p_contacts(organization_id, id),
  FOREIGN KEY (organization_id, event_id, session_id) REFERENCES p_sessions(organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, approved_by_id) REFERENCES p_event_contacts(organization_id, event_id, id)
) STRICT;

CREATE TABLE p_resources (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  sanitized_html TEXT NOT NULL,
  target_rule_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(target_rule_json) AND json_type(target_rule_json) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  published_at TEXT,
  source_record_id TEXT NOT NULL UNIQUE,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  source_cursor INTEGER CHECK (source_cursor IS NULL OR source_cursor >= 0),
  source_changed_at TEXT,
  projected_at TEXT NOT NULL,
  last_seen_scan_id TEXT,
  source_deleted_at TEXT,
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES p_events(organization_id, id)
) STRICT;

CREATE UNIQUE INDEX ux_portal_grants_active
  ON portal_grants(organization_id, event_id, contact_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX ux_p_events_slug_active
  ON p_events(organization_id, slug)
  WHERE source_deleted_at IS NULL;
CREATE UNIQUE INDEX ux_p_contacts_email_active
  ON p_contacts(organization_id, email_normalized)
  WHERE source_deleted_at IS NULL;
CREATE UNIQUE INDEX ux_p_rooms_name_active
  ON p_rooms(organization_id, event_id, name)
  WHERE source_deleted_at IS NULL;
CREATE UNIQUE INDEX ux_p_tracks_name_active
  ON p_tracks(organization_id, event_id, name)
  WHERE source_deleted_at IS NULL;
CREATE UNIQUE INDEX ux_p_formats_name_active
  ON p_formats(organization_id, event_id, name)
  WHERE source_deleted_at IS NULL;
CREATE UNIQUE INDEX ux_p_submissions_friendly_active
  ON p_submissions(organization_id, event_id, friendly_id)
  WHERE source_deleted_at IS NULL;
CREATE UNIQUE INDEX ux_p_sessions_friendly_active
  ON p_sessions(organization_id, event_id, friendly_id)
  WHERE source_deleted_at IS NULL;
CREATE UNIQUE INDEX ux_p_task_assignment_scope
  ON p_task_assignments(organization_id, event_id, definition_id, contact_id, COALESCE(session_id, ''));

CREATE INDEX idx_organization_memberships_user ON organization_memberships(user_id, revoked_at);
CREATE INDEX idx_event_memberships_user ON event_memberships(user_id, organization_id, event_id, revoked_at);
CREATE INDEX idx_auth_sessions_user_active ON auth_sessions(user_id, expires_at, revoked_at);
CREATE INDEX idx_magic_link_lookup ON magic_link_tokens(token_hash, expires_at, consumed_at, revoked_at);
CREATE INDEX idx_portal_grants_lookup ON portal_grants(token_hash, expires_at, revoked_at);
CREATE INDEX idx_api_keys_prefix ON api_keys(organization_id, token_prefix, revoked_at);
CREATE INDEX idx_idempotency_expiry ON idempotency_keys(expires_at, status);
CREATE INDEX idx_idempotency_lease ON idempotency_keys(status, lease_expires_at);
CREATE INDEX idx_outbox_drain ON outbox_events(status, available_at, created_at, id);
CREATE INDEX idx_projection_repairs_drain ON projection_repairs(status, available_at, created_at, id);
CREATE INDEX idx_workflow_runs_event ON workflow_runs(organization_id, event_id, workflow_type, status, created_at);
CREATE INDEX idx_provider_messages_event ON provider_messages(organization_id, event_id, status, created_at);
CREATE INDEX idx_webhook_endpoints_event ON webhook_endpoints(organization_id, event_id, status);
CREATE INDEX idx_webhook_deliveries_drain ON webhook_deliveries(status, available_at, id);
CREATE INDEX idx_integration_runs_event ON integration_runs(organization_id, event_id, provider, status, created_at);
CREATE INDEX idx_external_mappings_external ON external_mappings(organization_id, provider, external_id);
CREATE INDEX idx_projection_scans_status ON projection_scan_runs(organization_id, status, created_at);
CREATE INDEX idx_audit_event_time ON audit_events(organization_id, event_id, created_at DESC, id DESC);
CREATE INDEX idx_audit_entity_time ON audit_events(organization_id, entity_type, entity_id, created_at DESC, id DESC);
CREATE INDEX idx_file_objects_owner ON file_objects(organization_id, event_id, owner_contact_id, status);
CREATE INDEX idx_p_forms_event_status ON p_forms(organization_id, event_id, status) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_form_fields_order ON p_form_fields(organization_id, event_id, form_id, sort_order) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_form_rules_order ON p_form_rules(organization_id, event_id, form_id, sort_order) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_event_contacts_roles ON p_event_contacts(organization_id, event_id, portal_state, contact_id) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_submissions_status_time ON p_submissions(organization_id, event_id, status, submitted_at DESC, id DESC) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_submissions_track_status ON p_submissions(organization_id, event_id, track_id, status, submitted_at DESC, id DESC) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_submission_answers_order ON p_submission_answers(organization_id, event_id, submission_id, sort_order) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_submission_participants_contact ON p_submission_participants(organization_id, event_id, contact_id, submission_id) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_criteria_rubric_order ON p_criteria(organization_id, event_id, rubric_id, sort_order) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_reviews_reviewer_queue ON p_reviews(organization_id, event_id, reviewer_id, status, updated_at DESC, id DESC) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_review_scores_review ON p_review_scores(organization_id, event_id, review_id, criterion_id) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_sessions_status ON p_sessions(organization_id, event_id, status, id) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_sessions_track ON p_sessions(organization_id, event_id, track_id, status, id) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_session_participants_contact ON p_session_participants(organization_id, event_id, contact_id, session_id) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_schedule_event_time ON p_schedule_slots(organization_id, event_id, starts_at, ends_at, id) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_schedule_room_time ON p_schedule_slots(organization_id, event_id, room_id, starts_at, ends_at, id) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_task_assignments_contact ON p_task_assignments(organization_id, event_id, contact_id, status, due_at, id) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_task_assignments_required ON p_task_assignments(organization_id, event_id, required, status, due_at, id) WHERE source_deleted_at IS NULL;
CREATE INDEX idx_p_resources_status ON p_resources(organization_id, event_id, status, published_at, id) WHERE source_deleted_at IS NULL;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE TRIGGER webhook_delivery_attempts_no_update
BEFORE UPDATE ON webhook_delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'webhook delivery attempts are append-only');
END;

CREATE TRIGGER webhook_delivery_attempts_no_delete
BEFORE DELETE ON webhook_delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'webhook delivery attempts are append-only');
END;
