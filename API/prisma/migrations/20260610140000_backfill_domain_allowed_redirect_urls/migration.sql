-- Backfill ClientDomain.allowed_redirect_urls from each domain's onboarding config snapshot.
--
-- Redirect URLs were never stored on client_domains before; for auto-onboarded domains the only
-- persisted copy is the redirect_urls captured in the accepted integration request's
-- config_summary. Seed the new admin allowlist from there so existing domains carry their current
-- redirect URL(s) as list entries.
--
-- Rules:
--   * Most recently reviewed ACCEPTED request per domain wins.
--   * Only rows whose allowed_redirect_urls is still empty are touched, so any value an admin has
--     already entered is preserved (and the migration is safe to treat as idempotent).
--   * Admin-created domains (no integration request / no snapshot) are left empty.
WITH latest_accepted AS (
  SELECT DISTINCT ON (ir.client_domain_id)
    ir.client_domain_id AS domain_id,
    ir.config_summary AS config_summary
  FROM client_domain_integration_requests ir
  WHERE ir.status::text = 'ACCEPTED'
    AND ir.client_domain_id IS NOT NULL
    AND ir.config_summary IS NOT NULL
    AND jsonb_typeof(ir.config_summary -> 'redirect_urls') = 'array'
  ORDER BY ir.client_domain_id, ir.reviewed_at DESC NULLS LAST
),
urls AS (
  SELECT
    la.domain_id,
    array_agg(DISTINCT btrim(u.url)) AS redirect_urls
  FROM latest_accepted la
  CROSS JOIN LATERAL jsonb_array_elements_text(la.config_summary -> 'redirect_urls') AS u(url)
  WHERE length(btrim(u.url)) > 0
  GROUP BY la.domain_id
)
UPDATE client_domains cd
SET allowed_redirect_urls = urls.redirect_urls
FROM urls
WHERE cd.id = urls.domain_id
  AND cardinality(cd.allowed_redirect_urls) = 0;
