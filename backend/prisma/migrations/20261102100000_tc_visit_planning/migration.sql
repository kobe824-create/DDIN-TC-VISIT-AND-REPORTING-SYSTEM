CREATE TABLE "VisitPlan" (
    "id" UUID NOT NULL,
    "tcId" UUID NOT NULL,
    "planDate" DATE NOT NULL,
    "territoryId" UUID NOT NULL,
    "targetAgents" INTEGER NOT NULL,
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisitPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VisitPlan_tcId_planDate_territoryId_key"
ON "VisitPlan"("tcId", "planDate", "territoryId");

CREATE INDEX "VisitPlan_tcId_planDate_idx"
ON "VisitPlan"("tcId", "planDate");

ALTER TABLE "VisitPlan"
ADD CONSTRAINT "VisitPlan_tcId_fkey"
FOREIGN KEY ("tcId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VisitPlan"
ADD CONSTRAINT "VisitPlan_territoryId_fkey"
FOREIGN KEY ("territoryId") REFERENCES "Territory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
