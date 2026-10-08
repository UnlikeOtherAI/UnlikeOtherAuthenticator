ALTER TABLE billing_job_compute_renewals
  ADD COLUMN parent_sales_job_grant_id UUID,
  ADD CONSTRAINT billing_job_compute_parent_sales_grant_fk
    FOREIGN KEY (parent_sales_job_grant_id)
    REFERENCES sales_research_job_grants(id) ON DELETE RESTRICT;

CREATE INDEX billing_job_compute_parent_sales_grant_idx
  ON billing_job_compute_renewals (parent_sales_job_grant_id)
  WHERE parent_sales_job_grant_id IS NOT NULL;
