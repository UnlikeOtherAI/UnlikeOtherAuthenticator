BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
CREATE TABLE billing_nessie_admission_cutover (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  applied_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO billing_nessie_admission_cutover(singleton) VALUES(true);
CREATE TABLE billing_nessie_seat_transitions (
  org_id text PRIMARY KEY REFERENCES organisations(id) ON DELETE RESTRICT,
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3) NOT NULL,
  cohort_user_ids text[] NOT NULL,
  ended_at timestamptz(3),
  CHECK(ends_at=starts_at+interval '336 hours'),
  CHECK(ended_at IS NULL OR ended_at>=starts_at)
);

-- Freeze the pre-cutover default-plan cohort now, rather than extending it on their next login.
INSERT INTO billing_nessie_seat_transitions(org_id,starts_at,ends_at,cohort_user_ids)
SELECT o.id,c.applied_at,c.applied_at+interval '336 hours',
  ARRAY(SELECT DISTINCT e.user_id FROM billing_seat_eligible(o.id,NULL) e ORDER BY e.user_id)
FROM organisations o CROSS JOIN billing_nessie_admission_cutover c
WHERE o.lifecycle_status='ACTIVE' AND EXISTS (
  SELECT 1 FROM billing_services svc WHERE svc.identifier='nessie' AND (
    EXISTS(SELECT 1 FROM billing_app_keys k WHERE k.service_id=svc.id
      AND k.actor_issuer='https://'||o.domain AND k.purpose='CUSTOMER_LIFECYCLE')
    OR EXISTS(SELECT 1 FROM billing_service_accesses a WHERE a.service_id=svc.id AND a.org_id=o.id))
  AND NOT EXISTS(SELECT 1 FROM billing_tariff_assignments a WHERE a.service_id=svc.id AND a.org_id=o.id)
  AND NOT EXISTS(SELECT 1 FROM billing_contract_service_terms t JOIN billing_organisation_contract_versions v
    ON v.id=t.contract_version_id JOIN billing_organisation_contracts h ON h.id=v.contract_id
    WHERE t.service_id=svc.id AND h.org_id=o.id AND h.status='ACTIVE')
);

CREATE FUNCTION billing_nessie_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (OLD.org_id,OLD.starts_at,OLD.ends_at,OLD.cohort_user_ids)
    IS DISTINCT FROM (NEW.org_id,NEW.starts_at,NEW.ends_at,NEW.cohort_user_ids)
    OR (OLD.ended_at IS NOT NULL AND OLD.ended_at IS DISTINCT FROM NEW.ended_at) THEN
    RAISE EXCEPTION 'Nessie seat transition cannot restart or change its cohort' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_nessie_transition_immutable BEFORE UPDATE OR DELETE ON billing_nessie_seat_transitions
  FOR EACH ROW EXECUTE FUNCTION billing_nessie_transition_guard();
ALTER TABLE billing_nessie_admission_cutover ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_nessie_admission_cutover FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_nessie_seat_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_nessie_seat_transitions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON billing_nessie_admission_cutover,billing_nessie_seat_transitions FROM PUBLIC,uoa_app;
GRANT SELECT ON billing_nessie_admission_cutover TO uoa_admin;
GRANT SELECT,INSERT,UPDATE ON billing_nessie_seat_transitions TO uoa_admin;
COMMIT;
