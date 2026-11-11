CREATE INDEX IF NOT EXISTS "Agent_name_id_idx"
ON "Agent" ("name", "id");

CREATE INDEX IF NOT EXISTS "Visit_visitDate_idx"
ON "Visit" ("visitDate");
