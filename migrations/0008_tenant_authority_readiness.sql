ALTER TABLE tenant_registry ADD COLUMN authority_roster_version INTEGER NOT NULL
  DEFAULT 1 CHECK (authority_roster_version > 0);

ALTER TABLE tenant_registry ADD COLUMN authority_ready_at TEXT;

CREATE TRIGGER tenant_authority_roster_insert
AFTER INSERT ON tenant_registry
WHEN NEW.status = 'active'
BEGIN
  UPDATE airtable_webhooks
  SET full_scan_required = 1, updated_at = NEW.updated_at
  WHERE base_key = NEW.base_key;
END;

CREATE TRIGGER tenant_authority_roster_update
AFTER UPDATE OF status, base_key, source_record_id ON tenant_registry
WHEN OLD.status != NEW.status
  OR OLD.base_key != NEW.base_key
  OR OLD.source_record_id != NEW.source_record_id
BEGIN
  UPDATE tenant_registry
  SET authority_roster_version = OLD.authority_roster_version + 1,
      authority_ready_at = NULL
  WHERE organization_id = NEW.organization_id;

  UPDATE airtable_webhooks
  SET full_scan_required = 1, updated_at = NEW.updated_at
  WHERE base_key IN (OLD.base_key, NEW.base_key);
END;

CREATE TRIGGER tenant_authority_roster_delete
AFTER DELETE ON tenant_registry
BEGIN
  UPDATE airtable_webhooks
  SET full_scan_required = 1, updated_at = OLD.updated_at
  WHERE base_key = OLD.base_key;
END;
