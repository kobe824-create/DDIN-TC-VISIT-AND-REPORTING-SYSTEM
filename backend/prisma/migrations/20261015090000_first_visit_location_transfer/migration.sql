ALTER TYPE "TerritoryType" ADD VALUE IF NOT EXISTS 'CELL';
ALTER TYPE "TerritoryType" ADD VALUE IF NOT EXISTS 'VILLAGE';

CREATE TYPE "AgentTransferStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

ALTER TABLE "Agent"
  ADD COLUMN "cellId" UUID,
  ADD COLUMN "villageId" UUID,
  ADD COLUMN "firstVisitLocationCapturedAt" TIMESTAMP(3),
  ADD COLUMN "firstVisitCompletedAt" TIMESTAMP(3);

UPDATE "Agent" AS agent
SET "firstVisitCompletedAt" = first_visit."firstVisitAt"
FROM (
  SELECT "agentId", MIN("checkInTime") AS "firstVisitAt"
  FROM "Visit"
  GROUP BY "agentId"
) AS first_visit
WHERE agent."id" = first_visit."agentId";

CREATE TABLE "AgentTransfer" (
  "id" UUID NOT NULL,
  "agentId" UUID NOT NULL,
  "fromTerritoryId" UUID NOT NULL,
  "toTerritoryId" UUID NOT NULL,
  "requestedByTcId" UUID NOT NULL,
  "recipientTcId" UUID NOT NULL,
  "reason" TEXT,
  "status" "AgentTransferStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "AgentTransfer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Agent_cellId_idx" ON "Agent"("cellId");
CREATE INDEX "Agent_villageId_idx" ON "Agent"("villageId");
CREATE INDEX "AgentTransfer_agentId_status_idx" ON "AgentTransfer"("agentId", "status");
CREATE INDEX "AgentTransfer_recipientTcId_status_idx" ON "AgentTransfer"("recipientTcId", "status");
CREATE INDEX "AgentTransfer_requestedByTcId_requestedAt_idx" ON "AgentTransfer"("requestedByTcId", "requestedAt");
CREATE UNIQUE INDEX "AgentTransfer_one_pending_per_agent_key" ON "AgentTransfer"("agentId") WHERE "status" = 'PENDING';

ALTER TABLE "Agent" ADD CONSTRAINT "Agent_cellId_fkey"
  FOREIGN KEY ("cellId") REFERENCES "Territory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_villageId_fkey"
  FOREIGN KEY ("villageId") REFERENCES "Territory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AgentTransfer" ADD CONSTRAINT "AgentTransfer_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentTransfer" ADD CONSTRAINT "AgentTransfer_fromTerritoryId_fkey"
  FOREIGN KEY ("fromTerritoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentTransfer" ADD CONSTRAINT "AgentTransfer_toTerritoryId_fkey"
  FOREIGN KEY ("toTerritoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentTransfer" ADD CONSTRAINT "AgentTransfer_requestedByTcId_fkey"
  FOREIGN KEY ("requestedByTcId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentTransfer" ADD CONSTRAINT "AgentTransfer_recipientTcId_fkey"
  FOREIGN KEY ("recipientTcId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
