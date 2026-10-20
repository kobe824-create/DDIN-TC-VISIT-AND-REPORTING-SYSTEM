CREATE INDEX IF NOT EXISTS "Territory_type_parentId_idx"
  ON "Territory" ("type", "parentId");

CREATE INDEX IF NOT EXISTS "TcTerritoryAssignment_tcId_isActive_idx"
  ON "TcTerritoryAssignment" ("tcId", "isActive");

CREATE INDEX IF NOT EXISTS "TcTerritoryAssignment_territoryId_isActive_idx"
  ON "TcTerritoryAssignment" ("territoryId", "isActive");

CREATE INDEX IF NOT EXISTS "Agent_territoryId_status_idx"
  ON "Agent" ("territoryId", "status");

CREATE INDEX IF NOT EXISTS "Agent_sectorId_idx"
  ON "Agent" ("sectorId");

CREATE INDEX IF NOT EXISTS "Agent_championId_status_idx"
  ON "Agent" ("championId", "status");

CREATE INDEX IF NOT EXISTS "AgentLocation_agentId_recordedAt_idx"
  ON "AgentLocation" ("agentId", "recordedAt");

CREATE INDEX IF NOT EXISTS "Visit_tcId_visitDate_idx"
  ON "Visit" ("tcId", "visitDate");

CREATE INDEX IF NOT EXISTS "Visit_agentId_visitDate_idx"
  ON "Visit" ("agentId", "visitDate");

CREATE INDEX IF NOT EXISTS "Visit_territoryId_visitDate_idx"
  ON "Visit" ("territoryId", "visitDate");

CREATE INDEX IF NOT EXISTS "VisitPhoto_visitId_idx"
  ON "VisitPhoto" ("visitId");

CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx"
  ON "AuditLog" ("createdAt");

CREATE INDEX IF NOT EXISTS "AuditLog_userId_createdAt_idx"
  ON "AuditLog" ("userId", "createdAt");
