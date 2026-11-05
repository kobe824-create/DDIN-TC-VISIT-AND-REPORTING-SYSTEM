CREATE TYPE "AgentRelocationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "AgentTransfer"
ADD COLUMN "acceptedAt" TIMESTAMP(3),
ADD COLUMN "reviewedAt" TIMESTAMP(3),
ADD COLUMN "reviewNote" VARCHAR(500);

CREATE TABLE "AgentRelocationRequest" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "fromTerritoryId" UUID NOT NULL,
    "toTerritoryId" UUID NOT NULL,
    "toSectorId" UUID NOT NULL,
    "toCellId" UUID NOT NULL,
    "toVillageId" UUID NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "reason" VARCHAR(500),
    "requestedByTcId" UUID NOT NULL,
    "reviewedById" UUID,
    "status" "AgentRelocationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" VARCHAR(500),

    CONSTRAINT "AgentRelocationRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentRelocationRequest_requestedByTcId_status_requestedAt_idx"
ON "AgentRelocationRequest"("requestedByTcId", "status", "requestedAt");

CREATE INDEX "AgentRelocationRequest_status_requestedAt_idx"
ON "AgentRelocationRequest"("status", "requestedAt");

CREATE UNIQUE INDEX "AgentRelocationRequest_one_pending_per_agent_key"
ON "AgentRelocationRequest"("agentId") WHERE "status" = 'PENDING';

ALTER TABLE "AgentRelocationRequest"
ADD CONSTRAINT "AgentRelocationRequest_agentId_fkey"
FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "AgentRelocationRequest_fromTerritoryId_fkey"
FOREIGN KEY ("fromTerritoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "AgentRelocationRequest_toTerritoryId_fkey"
FOREIGN KEY ("toTerritoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "AgentRelocationRequest_requestedByTcId_fkey"
FOREIGN KEY ("requestedByTcId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "AgentRelocationRequest_reviewedById_fkey"
FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
