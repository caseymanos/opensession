ALTER TABLE p_events ADD COLUMN schedule_days_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(schedule_days_json) AND json_type(schedule_days_json) = 'array');

ALTER TABLE p_events ADD COLUMN schedule_snap_minutes INTEGER NOT NULL DEFAULT 15
  CHECK (schedule_snap_minutes IN (5, 10, 15, 20, 30, 60));

ALTER TABLE p_events ADD COLUMN schedule_version INTEGER NOT NULL DEFAULT 0
  CHECK (schedule_version >= 0);

CREATE TABLE schedule_command_receipts (
  event_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_hash TEXT NOT NULL CHECK (
    length(command_hash) = 64 AND command_hash NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('applying', 'complete')),
  operations_json TEXT NOT NULL CHECK (
    json_valid(operations_json) AND json_type(operations_json) = 'array'
  ),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND json_type(result_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, command_id)
) WITHOUT ROWID, STRICT;
