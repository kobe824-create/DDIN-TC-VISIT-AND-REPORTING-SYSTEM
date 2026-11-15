CREATE TABLE "FieldOperationsSettings" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "fieldStartDate" DATE NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FieldOperationsSettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FieldOperationsSettings_singleton_check" CHECK ("id" = 1)
);

INSERT INTO "FieldOperationsSettings" ("id", "fieldStartDate", "updatedAt")
VALUES (1, (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Kigali')::date, CURRENT_TIMESTAMP);
