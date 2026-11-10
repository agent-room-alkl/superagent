-- T-41: the work inbox and SOP execution runs survive a process restart.
-- 0009 is left for the long-work SOP start registration.
-- A waiting approval is useless without the run it resumes, so both tables land together.

CREATE TABLE IF NOT EXISTS work_inbox (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  items jsonb NOT NULL,
  seq integer NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_runs (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  runs jsonb NOT NULL,
  seq integer NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON work_inbox, execution_runs TO superagent_app;
