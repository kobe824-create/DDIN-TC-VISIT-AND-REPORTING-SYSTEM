CREATE TYPE "IssueStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'WAITING', 'ESCALATED', 'RESOLVED', 'REJECTED', 'CLOSED');
CREATE TYPE "IssueCategory" AS ENUM ('REQUEST', 'MATERIALS', 'PAYMENT', 'DEVICE', 'ACCOUNT', 'TRAINING', 'COMPLAINT', 'OTHER');
CREATE TYPE "IssuePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

CREATE SEQUENCE issue_code_seq;

CREATE TABLE "Issue" (
  "id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "description" VARCHAR(5000) NOT NULL,
  "category" "IssueCategory" NOT NULL DEFAULT 'OTHER',
  "priority" "IssuePriority" NOT NULL DEFAULT 'NORMAL',
  "status" "IssueStatus" NOT NULL DEFAULT 'NEW',
  "network" "VisitNetwork" NOT NULL DEFAULT 'IREMBO',
  "reporterId" UUID NOT NULL,
  "assignedToId" UUID,
  "agentName" VARCHAR(200) NOT NULL DEFAULT '',
  "agentPhone" VARCHAR(32) NOT NULL DEFAULT '',
  "agentCode" VARCHAR(80) NOT NULL DEFAULT '',
  "province" VARCHAR(80) NOT NULL DEFAULT '',
  "district" VARCHAR(80) NOT NULL DEFAULT '',
  "sector" VARCHAR(80) NOT NULL DEFAULT '',
  "cell" VARCHAR(80) NOT NULL DEFAULT '',
  "village" VARCHAR(80) NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IssueComment" (
  "id" UUID NOT NULL,
  "issueId" UUID NOT NULL,
  "authorId" UUID,
  "body" VARCHAR(5000) NOT NULL DEFAULT '',
  "statusFrom" "IssueStatus",
  "statusTo" "IssueStatus",
  "assignedToId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueComment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Issue_code_key" ON "Issue"("code");
CREATE INDEX "Issue_reporterId_updatedAt_idx" ON "Issue"("reporterId", "updatedAt");
CREATE INDEX "Issue_assignedToId_status_updatedAt_idx" ON "Issue"("assignedToId", "status", "updatedAt");
CREATE INDEX "Issue_status_updatedAt_idx" ON "Issue"("status", "updatedAt");
CREATE INDEX "IssueComment_issueId_createdAt_idx" ON "IssueComment"("issueId", "createdAt");

ALTER TABLE "Issue" ADD CONSTRAINT "Issue_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IssueComment" ADD CONSTRAINT "IssueComment_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueComment" ADD CONSTRAINT "IssueComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IssueComment" ADD CONSTRAINT "IssueComment_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
