ALTER TYPE "LocationStatus" ADD VALUE IF NOT EXISTS 'MANUAL_REVIEW_APPROVED';

CREATE TYPE "LocationMethod" AS ENUM ('GPS', 'MANUAL_EVIDENCE');
CREATE TYPE "VisitPlanPeriod" AS ENUM ('DAY', 'WEEK', 'MONTH', 'CUSTOM');
CREATE TYPE "FieldFollowUpStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

ALTER TABLE "Visit"
  ALTER COLUMN "tcLatitude" DROP NOT NULL,
  ALTER COLUMN "tcLongitude" DROP NOT NULL,
  ALTER COLUMN "distanceMeters" DROP NOT NULL,
  ALTER COLUMN "gpsAccuracyMeters" DROP NOT NULL,
  ADD COLUMN "locationMethod" "LocationMethod" NOT NULL DEFAULT 'GPS',
  ADD COLUMN "locationReviewNote" VARCHAR(500),
  ADD COLUMN "locationReviewedAt" TIMESTAMP(3),
  ADD COLUMN "locationReviewedById" UUID;

ALTER TABLE "Visit"
  ADD CONSTRAINT "Visit_locationReviewedById_fkey"
  FOREIGN KEY ("locationReviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VisitPlan"
  ADD COLUMN "endDate" DATE,
  ADD COLUMN "periodType" "VisitPlanPeriod" NOT NULL DEFAULT 'DAY',
  ADD COLUMN "minimumAgents" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "estimatedWorkingDays" INTEGER NOT NULL DEFAULT 1;

UPDATE "VisitPlan" SET "endDate" = "planDate" WHERE "endDate" IS NULL;
ALTER TABLE "VisitPlan" ALTER COLUMN "endDate" SET NOT NULL;
CREATE INDEX "VisitPlan_tcId_endDate_idx" ON "VisitPlan"("tcId", "endDate");

CREATE TABLE "FieldWorkdayFollowUp" (
  "id" UUID NOT NULL,
  "tcId" UUID NOT NULL,
  "workDate" DATE NOT NULL,
  "requiredAgents" INTEGER NOT NULL,
  "completedAgents" INTEGER NOT NULL,
  "missedAgents" INTEGER NOT NULL,
  "status" "FieldFollowUpStatus" NOT NULL DEFAULT 'OPEN',
  "reviewNote" VARCHAR(500),
  "reviewedById" UUID,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FieldWorkdayFollowUp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FieldWorkdayFollowUp_tcId_workDate_key" ON "FieldWorkdayFollowUp"("tcId", "workDate");
CREATE INDEX "FieldWorkdayFollowUp_status_workDate_idx" ON "FieldWorkdayFollowUp"("status", "workDate");

ALTER TABLE "FieldWorkdayFollowUp"
  ADD CONSTRAINT "FieldWorkdayFollowUp_tcId_fkey"
  FOREIGN KEY ("tcId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FieldWorkdayFollowUp"
  ADD CONSTRAINT "FieldWorkdayFollowUp_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
