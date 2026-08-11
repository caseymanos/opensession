ALTER TABLE p_contacts ADD COLUMN headshot_alt_text TEXT;

ALTER TABLE p_contacts ADD COLUMN profile_publication_state TEXT NOT NULL
  DEFAULT 'draft'
  CHECK (profile_publication_state IN ('draft', 'approved', 'published'));

ALTER TABLE p_contacts ADD COLUMN profile_approved_at TEXT;
ALTER TABLE p_contacts ADD COLUMN profile_approved_by TEXT;

CREATE INDEX idx_p_contacts_public_profile
  ON p_contacts(organization_id, profile_publication_state, id)
  WHERE source_deleted_at IS NULL AND profile_publication_state = 'published';
