-- Grant ids are UUIDs in the issue/recover/renew contract. The former CUID
-- default created grants that neither Ledger nor the recipient routes could
-- accept. Recover their existing issue by changing only the unusable id:
-- ownership, secret digest, issue identity, expiry and revocation stay frozen.
DO $$
BEGIN
  UPDATE billing_job_compute_renewals
  SET id = gen_random_uuid()::text
  WHERE id !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';

  ALTER TABLE billing_job_compute_renewals
    ADD CONSTRAINT billing_job_compute_grant_id_uuid CHECK (
      id ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    );
END;
$$;
