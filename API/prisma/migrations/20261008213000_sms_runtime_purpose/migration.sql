SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TABLE billing_app_keys DROP CONSTRAINT billing_app_keys_purpose_origins_check;
ALTER TABLE billing_app_keys ADD CONSTRAINT billing_app_keys_purpose_origins_check CHECK (
  (purpose IN ('ENTITLEMENT','SMS_RUNTIME') AND cardinality(checkout_return_origins) = 0)
  OR (purpose = 'CUSTOMER_LIFECYCLE' AND cardinality(checkout_return_origins) > 0)
);
