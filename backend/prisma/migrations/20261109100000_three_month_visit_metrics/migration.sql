ALTER TABLE "Visit"
  ADD COLUMN "countsForMetrics" BOOLEAN NOT NULL DEFAULT TRUE;

-- Keep the earliest visit in each rolling three-month window eligible for
-- performance metrics. Existing visit records remain visible in visit history.
WITH RECURSIVE ordered_visits AS (
  SELECT
    "id",
    "agentId",
    "visitDate",
    ROW_NUMBER() OVER (
      PARTITION BY "agentId"
      ORDER BY "visitDate", "createdAt", "id"
    ) AS sequence
  FROM "Visit"
  WHERE "visitStatus" <> 'REJECTED'
),
eligible_visits ("id", "agentId", "visitDate", sequence) AS (
  SELECT "id", "agentId", "visitDate", sequence
  FROM ordered_visits
  WHERE sequence = 1

  UNION ALL

  SELECT next_visit."id", next_visit."agentId", next_visit."visitDate", next_visit.sequence
  FROM eligible_visits previous_visit
  CROSS JOIN LATERAL (
    SELECT candidate."id", candidate."agentId", candidate."visitDate", candidate.sequence
    FROM ordered_visits candidate
    WHERE candidate."agentId" = previous_visit."agentId"
      AND candidate.sequence > previous_visit.sequence
      AND candidate."visitDate" >= previous_visit."visitDate" + INTERVAL '3 months'
    ORDER BY candidate.sequence
    LIMIT 1
  ) next_visit
)
UPDATE "Visit" visit
SET "countsForMetrics" = EXISTS (
  SELECT 1
  FROM eligible_visits eligible
  WHERE eligible."id" = visit."id"
);

CREATE INDEX "Visit_agentId_countsForMetrics_visitDate_idx"
  ON "Visit"("agentId", "countsForMetrics", "visitDate");
