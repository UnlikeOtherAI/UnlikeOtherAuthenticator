SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- An organisation's billing region is chosen once and never changes. The region
-- sets the currency of its SMS prices, balance and number subscriptions. No row
-- means not yet chosen; existing organisations choose on first use.
CREATE TABLE billing_organisation_regions (
  org_id TEXT NOT NULL,
  region VARCHAR(10) NOT NULL,
  currency CHAR(3) NOT NULL,
  set_by_user_id TEXT NOT NULL,
  set_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT billing_organisation_regions_pkey PRIMARY KEY (org_id),
  CONSTRAINT billing_organisation_regions_org_fk FOREIGN KEY (org_id)
    REFERENCES organisations(id) ON DELETE CASCADE,
  CONSTRAINT billing_organisation_region_shape CHECK (
    (region = 'UK' AND currency = 'GBP') OR (region = 'US' AND currency = 'USD')
    OR (region = 'EUROPE' AND currency = 'EUR')),
  CONSTRAINT billing_organisation_region_setter CHECK (length(btrim(set_by_user_id)) > 0)
);

CREATE FUNCTION billing_organisation_region_set_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'BILLING_REGION_IMMUTABLE' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER billing_organisation_region_set_once BEFORE UPDATE ON billing_organisation_regions
  FOR EACH ROW EXECUTE FUNCTION billing_organisation_region_set_once();

ALTER TABLE billing_organisation_regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_organisation_regions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_organisation_regions FROM PUBLIC, uoa_app;
GRANT SELECT, INSERT ON billing_organisation_regions TO uoa_admin;
