ALTER TABLE sales_research_job_grants
  DROP CONSTRAINT sales_research_job_grants_job_key;

CREATE INDEX sales_research_job_grants_job_lineage_idx
  ON sales_research_job_grants (product, job_id, purpose, created_at);
