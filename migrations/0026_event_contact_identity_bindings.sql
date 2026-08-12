CREATE TABLE event_contact_identity_bindings (
  organization_id TEXT NOT NULL REFERENCES tenant_registry(organization_id),
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  relationship_role TEXT NOT NULL CHECK (relationship_role = 'speaker'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (organization_id, event_id, user_id, relationship_role),
  UNIQUE (organization_id, event_id, contact_id, relationship_role),
  FOREIGN KEY (organization_id, event_id)
    REFERENCES p_events(organization_id, id),
  FOREIGN KEY (organization_id, contact_id)
    REFERENCES p_contacts(organization_id, id)
) WITHOUT ROWID, STRICT;

CREATE INDEX idx_event_contact_identity_bindings_user
  ON event_contact_identity_bindings(user_id, organization_id, event_id)
  WHERE revoked_at IS NULL;
