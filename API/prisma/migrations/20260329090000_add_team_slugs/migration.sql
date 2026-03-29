ALTER TABLE "teams"
ADD COLUMN "slug" VARCHAR(120);

DO $$
DECLARE
  team_row RECORD;
  base_slug TEXT;
  candidate_slug TEXT;
  suffix_number INTEGER;
BEGIN
  FOR team_row IN
    SELECT "id", "org_id", "name"
    FROM "teams"
    ORDER BY "org_id", "created_at", "id"
  LOOP
    base_slug := lower(team_row."name");
    base_slug := regexp_replace(base_slug, '[^a-z0-9]+', '-', 'g');
    base_slug := regexp_replace(base_slug, '(^-+|-+$)', '', 'g');

    IF base_slug = '' OR base_slug IS NULL THEN
      base_slug := 'team';
    END IF;

    IF length(base_slug) > 120 THEN
      base_slug := regexp_replace(left(base_slug, 120), '-+$', '', 'g');
    END IF;

    IF base_slug = '' OR length(base_slug) < 2 THEN
      base_slug := 'team';
    END IF;

    candidate_slug := base_slug;
    suffix_number := 2;

    WHILE EXISTS (
      SELECT 1
      FROM "teams"
      WHERE "org_id" = team_row."org_id"
        AND "slug" = candidate_slug
        AND "id" <> team_row."id"
    ) LOOP
      candidate_slug := regexp_replace(
        left(base_slug, GREATEST(1, 120 - length('-' || suffix_number::TEXT))) || '-' || suffix_number::TEXT,
        '-+$',
        '',
        'g'
      );
      suffix_number := suffix_number + 1;
    END LOOP;

    UPDATE "teams"
    SET "slug" = candidate_slug
    WHERE "id" = team_row."id";
  END LOOP;
END $$;

ALTER TABLE "teams"
ALTER COLUMN "slug" SET NOT NULL;

CREATE UNIQUE INDEX "teams_org_id_slug_key" ON "teams"("org_id", "slug");
