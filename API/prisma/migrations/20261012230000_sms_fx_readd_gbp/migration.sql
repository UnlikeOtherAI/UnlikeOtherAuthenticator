SET lock_timeout = '5s';
SET statement_timeout = '120s';

-- A dated ECB document may be accepted once more, as a new version, when its
-- earlier acceptance recorded no GBP rate (accepted before GBP was read). At most
-- one acceptance without GBP and one with GBP exist per document.
DROP INDEX billing_sms_fx_snapshots_policy_source_digest_key;
CREATE UNIQUE INDEX billing_sms_fx_snapshots_policy_source_digest_gbp_key
  ON billing_sms_fx_snapshots(policy, source_digest, (gbp_per_eur IS NOT NULL));
CREATE INDEX billing_sms_fx_snapshots_policy_source_digest_idx ON billing_sms_fx_snapshots(policy, source_digest);
