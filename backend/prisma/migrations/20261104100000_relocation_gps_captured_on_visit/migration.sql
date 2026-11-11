ALTER TABLE "AgentRelocationRequest"
  ALTER COLUMN "latitude" DROP NOT NULL,
  ALTER COLUMN "longitude" DROP NOT NULL,
  ALTER COLUMN "accuracy" DROP NOT NULL;
