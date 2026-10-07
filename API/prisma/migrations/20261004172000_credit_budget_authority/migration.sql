BEGIN;

CREATE TABLE billing_paid_rating_buckets (
  rating_scope_key varchar(220) PRIMARY KEY,
  org_id text NOT NULL,
  currency char(3) NOT NULL,
  cumulative_rated_quanta decimal(80,0) NOT NULL DEFAULT 0,
  rated_microcredits bigint NOT NULL DEFAULT 0,
  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT billing_paid_rating_nonnegative CHECK (
    cumulative_rated_quanta >= 0 AND rated_microcredits >= 0
  )
);

CREATE TABLE billing_paid_usage_liabilities (
  dispatch_id varchar(160) PRIMARY KEY,
  receipt_id varchar(160) NOT NULL UNIQUE,
  service_id text NOT NULL,
  provider_service_id varchar(160) NOT NULL,
  org_id text NOT NULL,
  team_id text NOT NULL,
  user_id text NOT NULL,
  billing_month char(7) NOT NULL,
  currency char(3) NOT NULL,
  tariff_id text NOT NULL,
  frozen_markup_bps integer NOT NULL,
  payment_mode varchar(24) NOT NULL,
  credit_account_id text,
  raw_cost_actual decimal(38,18) NOT NULL,
  rated_quanta decimal(80,0) NOT NULL,
  rated_microcredits bigint NOT NULL,
  settled_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT billing_paid_liability_nonnegative CHECK (
    raw_cost_actual >= 0 AND rated_quanta >= 0 AND rated_microcredits >= 0
  ),
  CONSTRAINT billing_paid_liability_month CHECK (
    billing_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  ),
  CONSTRAINT billing_paid_liability_mode CHECK (payment_mode IN ('PREPAID', 'PAY_AS_YOU_GO'))
);
CREATE INDEX billing_paid_liability_scope_month_idx
  ON billing_paid_usage_liabilities (service_id, org_id, team_id, billing_month);

CREATE TABLE billing_credit_budget_policies (
  id text PRIMARY KEY,
  product varchar(100) NOT NULL,
  org_id text NOT NULL,
  team_id text,
  scope_type varchar(24) NOT NULL,
  scope_id varchar(256) NOT NULL,
  period varchar(24) NOT NULL,
  mode varchar(24) NOT NULL,
  limit_microcredits bigint,
  warn_threshold_percent integer NOT NULL,
  block_humans_when_over boolean NOT NULL,
  degrade_model varchar(256),
  degrade_provider varchar(256),
  owner_user_id text,
  version integer NOT NULL DEFAULT 1,
  disabled_at timestamp(3),
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT billing_credit_budget_scope CHECK (scope_type IN ('organization','team','project','run')),
  CONSTRAINT billing_credit_budget_period CHECK (period IN ('weekly','monthly','yearly','per_run')),
  CONSTRAINT billing_credit_budget_mode CHECK (mode IN ('off','warn','enforce','degrade','unlimited')),
  CONSTRAINT billing_credit_budget_limit CHECK (
    (limit_microcredits IS NULL OR limit_microcredits >= 0)
    AND (mode NOT IN ('enforce','degrade') OR limit_microcredits IS NOT NULL)
  ),
  CONSTRAINT billing_credit_budget_warn CHECK (warn_threshold_percent BETWEEN 0 AND 100),
  CONSTRAINT billing_credit_budget_version CHECK (version >= 1),
  CONSTRAINT billing_credit_budget_scope_identity CHECK (
    (scope_type = 'organization' AND team_id IS NULL AND scope_id = org_id)
    OR (scope_type = 'team' AND team_id = scope_id)
    OR (scope_type IN ('project','run') AND team_id IS NOT NULL)
  ),
  CONSTRAINT billing_credit_budget_run_period CHECK (
    (scope_type = 'run' AND period = 'per_run') OR
    (scope_type <> 'run' AND period <> 'per_run')
  ),
  UNIQUE (product, org_id, scope_type, scope_id, period)
);
CREATE INDEX billing_credit_budget_policies_org_team_idx
  ON billing_credit_budget_policies (org_id, team_id, disabled_at);

CREATE TABLE billing_credit_budget_native_scopes (
  product varchar(100) NOT NULL,
  org_id text NOT NULL,
  team_id text NOT NULL,
  scope_type varchar(24) NOT NULL,
  scope_id varchar(256) NOT NULL,
  source_created_at timestamp(3) NOT NULL,
  owner_user_id text,
  source_actor_jti varchar(256) NOT NULL,
  registered_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product, org_id, scope_type, scope_id),
  CONSTRAINT billing_credit_budget_native_scope_type CHECK (scope_type IN ('project','run')),
  CONSTRAINT billing_credit_budget_native_owner CHECK
    ((scope_type = 'project' AND owner_user_id IS NULL)
      OR (scope_type = 'run' AND owner_user_id IS NOT NULL))
);
CREATE INDEX billing_credit_budget_native_scopes_team_idx
  ON billing_credit_budget_native_scopes (product, org_id, team_id, scope_type);

CREATE TABLE billing_credit_budget_dispatches (
  dispatch_id varchar(160) PRIMARY KEY,
  context_digest char(64) NOT NULL,
  reserved_microcredits bigint,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  terminal_at timestamp(3),
  CONSTRAINT billing_credit_budget_dispatch_digest CHECK (context_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT billing_credit_budget_dispatch_amount CHECK (reserved_microcredits IS NULL OR reserved_microcredits >= 0),
  CONSTRAINT billing_credit_budget_dispatch_status CHECK (status IN ('ACTIVE','SETTLED','RELEASED'))
);
CREATE INDEX billing_credit_budget_dispatches_status_idx
  ON billing_credit_budget_dispatches (status, created_at);

CREATE TABLE billing_credit_budget_dispatch_scopes (
  dispatch_id varchar(160) NOT NULL REFERENCES billing_credit_budget_dispatches(dispatch_id) ON DELETE RESTRICT,
  product varchar(100) NOT NULL,
  org_id text NOT NULL,
  team_id text NOT NULL,
  scope_type varchar(24) NOT NULL,
  scope_id varchar(256) NOT NULL,
  occurred_at timestamp(3) NOT NULL,
  PRIMARY KEY (dispatch_id, product, scope_type, scope_id),
  CONSTRAINT billing_credit_budget_dispatch_scope CHECK (scope_type IN ('organization','team','project','run'))
);
CREATE INDEX billing_credit_budget_dispatch_scope_period_idx
  ON billing_credit_budget_dispatch_scopes (product, org_id, scope_type, scope_id, occurred_at);

CREATE TABLE billing_credit_budget_cutover (
  id integer PRIMARY KEY CHECK (id = 1),
  occurred_at timestamp(3) NOT NULL
);
INSERT INTO billing_credit_budget_cutover (id, occurred_at) VALUES (1, CURRENT_TIMESTAMP);

CREATE FUNCTION billing_paid_usage_liability_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'paid usage liability is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER billing_paid_usage_liability_immutable
BEFORE UPDATE OR DELETE ON billing_paid_usage_liabilities
FOR EACH ROW EXECUTE FUNCTION billing_paid_usage_liability_immutable();

COMMIT;
