ALTER TABLE "VisitPlan"
  ADD COLUMN "network" "VisitNetwork" NOT NULL DEFAULT 'IREMBO';

DROP INDEX IF EXISTS "VisitPlan_tcId_planDate_territoryId_key";
CREATE UNIQUE INDEX "VisitPlan_tcId_network_planDate_territoryId_key"
  ON "VisitPlan"("tcId", "network", "planDate", "territoryId");

-- The old visit form rendered these questions in code. Remove matching legacy
-- entries from the saved template so admins can rebuild the form in Settings.
UPDATE "SystemConfig" AS config
SET "value" = (
  SELECT COALESCE(jsonb_agg(question ORDER BY ordinal), '[]'::jsonb)::text
  FROM jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(config."value"::jsonb) = 'array' THEN config."value"::jsonb
      WHEN jsonb_typeof(config."value"::jsonb -> 'questions') = 'array' THEN config."value"::jsonb -> 'questions'
      ELSE '[]'::jsonb
    END
  ) WITH ORDINALITY AS entries(question, ordinal)
  WHERE lower(regexp_replace(trim(COALESCE(question ->> 'text', '')), '[?.]+$', '')) NOT IN (
    'how many agents are in a shop',
    'is the agent the owner of the account/user name',
    'does the agent have the branding materials',
    'do you follow the irembo agents whatsapp channel for essential updates',
    'do you have any other difficulties/recommendation to irembo',
    'if yes, describe'
  )
),
"updatedAt" = CURRENT_TIMESTAMP
WHERE config."key" = 'VISIT_CHECKLIST_SCHEMA';
