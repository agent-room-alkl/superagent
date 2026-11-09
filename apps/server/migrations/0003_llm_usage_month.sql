-- T-51: each usage row records the budget month it reserved against, so settlement never depends on clocks.
ALTER TABLE llm_usage ADD COLUMN IF NOT EXISTS month text;
UPDATE llm_usage SET month = to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') WHERE month IS NULL;
ALTER TABLE llm_usage ALTER COLUMN month SET NOT NULL;
CREATE INDEX IF NOT EXISTS llm_usage_tenant_month ON llm_usage (tenant_id, month);
