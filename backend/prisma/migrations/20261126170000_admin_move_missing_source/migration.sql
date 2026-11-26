-- Administrator-routed Moola Plus transfers can be created without an upstream source district.
-- Existing source IDs and relations are preserved; only the column becomes nullable.
ALTER TABLE "MoolaAgentTransfer"
  ALTER COLUMN "fromTerritoryId" DROP NOT NULL;
