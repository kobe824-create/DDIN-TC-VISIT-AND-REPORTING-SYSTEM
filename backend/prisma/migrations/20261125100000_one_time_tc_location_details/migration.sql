ALTER TABLE "Agent"
  ADD COLUMN "tcLocationDetailsCompletedAt" TIMESTAMP(3);

ALTER TABLE "AgentRelocationRequest"
  ADD COLUMN "toVenue" VARCHAR(200);

ALTER TABLE "MoolaAgentLocation"
  ADD COLUMN "tcLocationDetailsCompletedAt" TIMESTAMP(3);

ALTER TABLE "MoolaRelocationRequest"
  ADD COLUMN "toSectorId" UUID,
  ADD COLUMN "toCellId" UUID,
  ADD COLUMN "toVillageId" UUID,
  ADD COLUMN "toVenue" VARCHAR(200);

UPDATE "Agent"
SET "tcLocationDetailsCompletedAt" = COALESCE("firstVisitLocationCapturedAt", "updatedAt")
WHERE "sectorId" IS NOT NULL
  AND "cellId" IS NOT NULL
  AND "villageId" IS NOT NULL
  AND NULLIF(BTRIM("venue"), '') IS NOT NULL;

UPDATE "MoolaAgentLocation"
SET "tcLocationDetailsCompletedAt" = COALESCE("firstLocationCapturedAt", "updatedAt")
WHERE "sectorId" IS NOT NULL
  AND "cellId" IS NOT NULL
  AND "villageId" IS NOT NULL
  AND NULLIF(BTRIM("venue"), '') IS NOT NULL;

UPDATE "Agent" AS agent
SET "tcLocationDetailsCompletedAt" = COALESCE(
  (SELECT MAX(request."reviewedAt") FROM "AgentRelocationRequest" AS request WHERE request."agentId" = agent."id" AND request."status" = 'APPROVED'),
  agent."updatedAt"
)
WHERE agent."tcLocationDetailsCompletedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "AgentRelocationRequest" AS request WHERE request."agentId" = agent."id" AND request."status" = 'APPROVED');

UPDATE "MoolaAgentLocation" AS location
SET "tcLocationDetailsCompletedAt" = COALESCE(
  (SELECT MAX(request."reviewedAt") FROM "MoolaRelocationRequest" AS request WHERE request."externalAgentId" = location."externalAgentId" AND request."status" = 'APPROVED'),
  location."updatedAt"
)
WHERE location."tcLocationDetailsCompletedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "MoolaRelocationRequest" AS request WHERE request."externalAgentId" = location."externalAgentId" AND request."status" = 'APPROVED');
