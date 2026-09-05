-- Slugs become DNS labels in tenant hostnames, so they adopt DNS's limits.
--
-- Two rules move from "a slug is a URL segment" to "a slug is a label":
-- 63 octets rather than 120, and no doubled hyphen (which is also how every
-- xn-- A-label is refused). All-numeric labels go too: legal DNS, but
-- `12.34.example.com` reads as an address and some resolvers special-case it.
--
-- Reserved words are deliberately NOT a CHECK constraint. The list is extended
-- per product through the signed config claim, so freezing today's copy into
-- the schema would mean a product could never reserve another hostname without
-- a migration. Structure is checked here; vocabulary is checked in the service.

-- ---------------------------------------------------------------------------
-- 1. Rewrite team slugs the new rules would refuse.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  team_row RECORD;
  next_slug TEXT;
  candidate_slug TEXT;
  attempt INTEGER;
BEGIN
  FOR team_row IN
    SELECT "id", "org_id", "slug"
    FROM "teams"
    WHERE length("slug") > 63
       OR "slug" LIKE '%--%'
       OR "slug" ~ '^[0-9]+$'
       OR "slug" !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
       OR length("slug") < 2
    ORDER BY "org_id", "created_at", "id"
  LOOP
    next_slug := lower(team_row."slug");
    next_slug := regexp_replace(next_slug, '[^a-z0-9-]+', '-', 'g');
    next_slug := regexp_replace(next_slug, '-+', '-', 'g');
    next_slug := regexp_replace(next_slug, '(^-+|-+$)', '', 'g');

    IF length(next_slug) > 63 THEN
      next_slug := regexp_replace(left(next_slug, 63), '-+$', '', 'g');
    END IF;

    -- Keep the digits rather than discarding what the person named it.
    IF next_slug ~ '^[0-9]+$' THEN
      next_slug := left('team-' || next_slug, 63);
    END IF;

    IF next_slug IS NULL OR length(next_slug) < 2 THEN
      next_slug := 'team';
    END IF;

    candidate_slug := next_slug;
    attempt := 0;

    WHILE EXISTS (
      SELECT 1 FROM "teams"
      WHERE "org_id" = team_row."org_id"
        AND "slug" = candidate_slug
        AND "id" <> team_row."id"
    ) LOOP
      attempt := attempt + 1;
      candidate_slug :=
        regexp_replace(left(next_slug, 58), '-+$', '', 'g')
        || '-'
        || substr(md5(team_row."id" || attempt::text), 1, 4);
    END LOOP;

    UPDATE "teams" SET "slug" = candidate_slug WHERE "id" = team_row."id";
    RAISE NOTICE 'team % slug rewritten: % -> %', team_row."id", team_row."slug", candidate_slug;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The same for organisation slugs, scoped per client domain.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  org_row RECORD;
  next_slug TEXT;
  candidate_slug TEXT;
  attempt INTEGER;
BEGIN
  FOR org_row IN
    SELECT "id", "domain", "slug"
    FROM "organisations"
    WHERE length("slug") > 63
       OR "slug" LIKE '%--%'
       OR "slug" ~ '^[0-9]+$'
       OR "slug" !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
       OR length("slug") < 2
    ORDER BY "domain", "created_at", "id"
  LOOP
    next_slug := lower(org_row."slug");
    next_slug := regexp_replace(next_slug, '[^a-z0-9-]+', '-', 'g');
    next_slug := regexp_replace(next_slug, '-+', '-', 'g');
    next_slug := regexp_replace(next_slug, '(^-+|-+$)', '', 'g');

    IF length(next_slug) > 63 THEN
      next_slug := regexp_replace(left(next_slug, 63), '-+$', '', 'g');
    END IF;

    IF next_slug ~ '^[0-9]+$' THEN
      next_slug := left('org-' || next_slug, 63);
    END IF;

    IF next_slug IS NULL OR length(next_slug) < 2 THEN
      next_slug := 'org';
    END IF;

    candidate_slug := next_slug;
    attempt := 0;

    WHILE EXISTS (
      SELECT 1 FROM "organisations"
      WHERE "domain" = org_row."domain"
        AND "slug" = candidate_slug
        AND "id" <> org_row."id"
    ) LOOP
      attempt := attempt + 1;
      candidate_slug :=
        regexp_replace(left(next_slug, 58), '-+$', '', 'g')
        || '-'
        || substr(md5(org_row."id" || attempt::text), 1, 4);
    END LOOP;

    UPDATE "organisations" SET "slug" = candidate_slug WHERE "id" = org_row."id";
    RAISE NOTICE 'organisation % slug rewritten: % -> %', org_row."id", org_row."slug", candidate_slug;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Narrow the columns and pin the shape.
-- ---------------------------------------------------------------------------
ALTER TABLE "teams" ALTER COLUMN "slug" TYPE VARCHAR(63);
ALTER TABLE "organisations" ALTER COLUMN "slug" TYPE VARCHAR(63);

ALTER TABLE "teams"
  ADD CONSTRAINT "teams_slug_dns_label"
  CHECK (
    length("slug") BETWEEN 2 AND 63
    AND "slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
    AND "slug" NOT LIKE '%--%'
    AND "slug" !~ '^[0-9]+$'
  );

ALTER TABLE "organisations"
  ADD CONSTRAINT "organisations_slug_dns_label"
  CHECK (
    length("slug") BETWEEN 2 AND 63
    AND "slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
    AND "slug" NOT LIKE '%--%'
    AND "slug" !~ '^[0-9]+$'
  );
