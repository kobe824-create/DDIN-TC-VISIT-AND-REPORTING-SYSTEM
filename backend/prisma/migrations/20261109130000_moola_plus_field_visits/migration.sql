-- Keep the existing Irembo Agent roster and Visit rows intact. Moola Plus
-- identities live in externalAgentId and their field locations are overlays.
CREATE TYPE "VisitNetwork" AS ENUM ('IREMBO', 'MOOLA_PLUS');

ALTER TABLE "Visit"
  ADD COLUMN "network" "VisitNetwork" NOT NULL DEFAULT 'IREMBO',
  ADD COLUMN "externalAgentId" TEXT,
  ADD COLUMN "externalAgentName" TEXT,
  ADD COLUMN "externalAgentCode" TEXT,
  ALTER COLUMN "agentId" DROP NOT NULL;

CREATE INDEX "Visit_network_externalAgentId_visitDate_idx"
  ON "Visit"("network", "externalAgentId", "visitDate");
CREATE INDEX "Visit_network_countsForMetrics_visitDate_idx"
  ON "Visit"("network", "countsForMetrics", "visitDate");

CREATE TABLE "MoolaAgentLocation" (
  "externalAgentId" TEXT NOT NULL,
  "agentName" TEXT NOT NULL,
  "loginName" TEXT NOT NULL,
  "territoryId" UUID NOT NULL,
  "sectorName" TEXT,
  "cellName" TEXT,
  "villageName" TEXT,
  "venue" VARCHAR(200),
  "latitude" DOUBLE PRECISION,
  "longitude" DOUBLE PRECISION,
  "accuracy" DOUBLE PRECISION,
  "locationVerified" BOOLEAN NOT NULL DEFAULT FALSE,
  "firstLocationCapturedAt" TIMESTAMP(3),
  "firstVisitCompletedAt" TIMESTAMP(3),
  "updatedById" UUID NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MoolaAgentLocation_pkey" PRIMARY KEY ("externalAgentId"),
  CONSTRAINT "MoolaAgentLocation_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "MoolaAgentLocation_territoryId_locationVerified_idx"
  ON "MoolaAgentLocation"("territoryId", "locationVerified");

CREATE TABLE "MoolaRelocationRequest" (
  "id" UUID NOT NULL,
  "externalAgentId" TEXT NOT NULL,
  "agentName" TEXT NOT NULL,
  "loginName" TEXT NOT NULL,
  "fromTerritoryId" UUID NOT NULL,
  "toTerritoryId" UUID NOT NULL,
  "reason" VARCHAR(500),
  "requestedByTcId" UUID NOT NULL,
  "reviewedById" UUID,
  "status" "AgentRelocationRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "reviewNote" VARCHAR(500),
  CONSTRAINT "MoolaRelocationRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MoolaRelocationRequest_externalAgentId_fkey" FOREIGN KEY ("externalAgentId") REFERENCES "MoolaAgentLocation"("externalAgentId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MoolaRelocationRequest_fromTerritoryId_fkey" FOREIGN KEY ("fromTerritoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MoolaRelocationRequest_toTerritoryId_fkey" FOREIGN KEY ("toTerritoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MoolaRelocationRequest_requestedByTcId_fkey" FOREIGN KEY ("requestedByTcId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MoolaRelocationRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "MoolaRelocationRequest_status_requestedAt_idx"
  ON "MoolaRelocationRequest"("status", "requestedAt");
CREATE INDEX "MoolaRelocationRequest_externalAgentId_status_idx"
  ON "MoolaRelocationRequest"("externalAgentId", "status");
