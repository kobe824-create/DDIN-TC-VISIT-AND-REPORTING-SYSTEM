CREATE TABLE "AdminInboxRequestState" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "requestKey" VARCHAR(220) NOT NULL,
    "readAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminInboxRequestState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminInboxRequestState_adminId_requestKey_key"
ON "AdminInboxRequestState"("adminId", "requestKey");

CREATE INDEX "AdminInboxRequestState_adminId_acknowledgedAt_idx"
ON "AdminInboxRequestState"("adminId", "acknowledgedAt");

ALTER TABLE "AdminInboxRequestState"
ADD CONSTRAINT "AdminInboxRequestState_adminId_fkey"
FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
