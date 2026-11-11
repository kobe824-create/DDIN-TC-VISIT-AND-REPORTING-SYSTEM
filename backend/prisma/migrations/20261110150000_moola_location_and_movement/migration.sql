-- Moola Plus check-ins may be submitted for review without GPS coordinates.
ALTER TABLE "Visit"
  ALTER COLUMN "agentLatitude" DROP NOT NULL,
  ALTER COLUMN "agentLongitude" DROP NOT NULL;

-- Keep the official sub-area selection with the upstream Moola Plus identity.
ALTER TABLE "MoolaAgentLocation"
  ADD COLUMN "sectorId" UUID,
  ADD COLUMN "cellId" UUID,
  ADD COLUMN "villageId" UUID,
  ADD COLUMN "isOnHold" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "MoolaAgentLocation"
  ADD CONSTRAINT "MoolaAgentLocation_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "Territory"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "MoolaAgentLocation_cellId_fkey" FOREIGN KEY ("cellId") REFERENCES "Territory"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "MoolaAgentLocation_villageId_fkey" FOREIGN KEY ("villageId") REFERENCES "Territory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "MoolaAgentLocation_sectorId_idx" ON "MoolaAgentLocation"("sectorId");
CREATE INDEX "MoolaAgentLocation_cellId_idx" ON "MoolaAgentLocation"("cellId");
CREATE INDEX "MoolaAgentLocation_villageId_idx" ON "MoolaAgentLocation"("villageId");

CREATE TYPE "MovementNoticeType" AS ENUM ('RELOCATED', 'TRANSFER_ROUTED');

CREATE TABLE "MoolaAgentTransfer" (
  "id" UUID NOT NULL,
  "externalAgentId" TEXT NOT NULL,
  "agentName" TEXT NOT NULL,
  "loginName" TEXT NOT NULL,
  "phoneNumber" TEXT,
  "fromTerritoryId" UUID NOT NULL,
  "toTerritoryId" UUID NOT NULL,
  "requestedByTcId" UUID NOT NULL,
  "recipientTcId" UUID NOT NULL,
  "reason" VARCHAR(500),
  "status" "AgentTransferStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" VARCHAR(500),
  "adminRoutedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "MoolaAgentTransfer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MoolaAgentTransfer_fromTerritoryId_fkey" FOREIGN KEY ("fromTerritoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MoolaAgentTransfer_toTerritoryId_fkey" FOREIGN KEY ("toTerritoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MoolaAgentTransfer_requestedByTcId_fkey" FOREIGN KEY ("requestedByTcId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MoolaAgentTransfer_recipientTcId_fkey" FOREIGN KEY ("recipientTcId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "MoolaAgentTransfer_externalAgentId_status_idx" ON "MoolaAgentTransfer"("externalAgentId", "status");
CREATE INDEX "MoolaAgentTransfer_recipientTcId_status_idx" ON "MoolaAgentTransfer"("recipientTcId", "status");
CREATE INDEX "MoolaAgentTransfer_requestedByTcId_requestedAt_idx" ON "MoolaAgentTransfer"("requestedByTcId", "requestedAt");

CREATE TABLE "AgentMovementNotice" (
  "id" UUID NOT NULL,
  "recipientTcId" UUID NOT NULL,
  "agentId" UUID,
  "network" "VisitNetwork" NOT NULL DEFAULT 'IREMBO',
  "externalAgentId" TEXT,
  "agentName" TEXT NOT NULL,
  "agentCode" TEXT,
  "noticeType" "MovementNoticeType" NOT NULL,
  "fromTerritoryName" TEXT,
  "toTerritoryName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  CONSTRAINT "AgentMovementNotice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentMovementNotice_recipientTcId_fkey" FOREIGN KEY ("recipientTcId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AgentMovementNotice_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AgentMovementNotice_recipientTcId_readAt_createdAt_idx" ON "AgentMovementNotice"("recipientTcId", "readAt", "createdAt");
CREATE INDEX "AgentMovementNotice_agentId_createdAt_idx" ON "AgentMovementNotice"("agentId", "createdAt");
CREATE INDEX "AgentMovementNotice_externalAgentId_createdAt_idx" ON "AgentMovementNotice"("externalAgentId", "createdAt");
