-- Outbox, job queue and schedules (cahier des charges §15.1, §17, Table 28;
-- TRX-05, JOB-01 to JOB-04). A command writes outbox events and jobs in its own
-- transaction; the worker relays and runs them after commit. Everything lives
-- in PostgreSQL: no second store.

-- 1. The worker's queue role. It sees every row of the queue tables and nothing
--    else; tenant work inside a job runs under nx_app with the job's workspace (JOB-03).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nx_jobs') THEN
    BEGIN
      CREATE ROLE nx_jobs NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL;
    END;
  END IF;
END $$;
GRANT USAGE ON SCHEMA ops, identity TO nx_jobs;
GRANT EXECUTE ON FUNCTION ops.current_workspace(), ops.current_principal() TO nx_jobs;
-- Jobs act as system:<job> principals (JOB-03).
GRANT SELECT, INSERT ON identity.principals TO nx_jobs;

-- 2. Outbox: events written by a command, relayed after commit, at least once (TRX-05).
CREATE TABLE ops.outbox (
  id             uuid PRIMARY KEY,
  workspace_id   uuid REFERENCES tenant.workspaces (id),
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z_]*$'),
  aggregate_id   text NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 100),
  event_type     text NOT NULL CHECK (event_type ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  payload        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'dead')),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at   timestamptz NOT NULL DEFAULT now(),
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz
);
CREATE INDEX outbox_pending ON ops.outbox (available_at, created_at) WHERE status = 'pending';

-- 3. Jobs: claimed with FOR UPDATE SKIP LOCKED under a lease (JOB-01).
CREATE TABLE ops.jobs (
  id           uuid PRIMARY KEY,
  type         text NOT NULL CHECK (type ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  payload      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
  workspace_id uuid REFERENCES tenant.workspaces (id),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'dead')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 25),
  locked_by    text,
  locked_until timestamptz,
  last_error   text,
  -- One job per key, whoever enqueues it and however often: idempotent enqueue (JOB-02, JOB-04).
  dedupe_key   text UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  CHECK ((status = 'running') = (locked_until IS NOT NULL))
);
CREATE INDEX jobs_due     ON ops.jobs (run_at) WHERE status = 'queued';
CREATE INDEX jobs_leases  ON ops.jobs (locked_until) WHERE status = 'running';
CREATE INDEX jobs_running ON ops.jobs (type, workspace_id) WHERE status = 'running';
CREATE INDEX jobs_dead    ON ops.jobs (finished_at) WHERE status = 'dead';

-- 4. Schedules: recurring jobs, enqueued by one scheduler at a time (JOB-04).
CREATE TABLE ops.schedules (
  name             text PRIMARY KEY CHECK (name ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  job_type         text NOT NULL CHECK (job_type ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  interval_seconds integer NOT NULL CHECK (interval_seconds >= 60),
  next_run_at      timestamptz NOT NULL,
  last_run_at      timestamptz,
  enabled          boolean NOT NULL DEFAULT true
);

-- 5. Who writes what. A company command adds events and jobs of its own
--    workspace; a console command adds platform ones (no workspace); only the
--    worker reads and changes them.
ALTER TABLE ops.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_events   ON ops.outbox FOR INSERT TO nx_app      WITH CHECK (workspace_id = ops.current_workspace());
CREATE POLICY platform_events ON ops.outbox FOR INSERT TO nx_platform WITH CHECK (workspace_id IS NULL);
CREATE POLICY worker_events   ON ops.outbox FOR ALL    TO nx_jobs     USING (true) WITH CHECK (true);
GRANT INSERT ON ops.outbox TO nx_app, nx_platform;
GRANT SELECT, INSERT, UPDATE ON ops.outbox TO nx_jobs;

ALTER TABLE ops.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_jobs   ON ops.jobs FOR INSERT TO nx_app      WITH CHECK (workspace_id = ops.current_workspace());
CREATE POLICY platform_jobs ON ops.jobs FOR INSERT TO nx_platform WITH CHECK (workspace_id IS NULL);
CREATE POLICY worker_jobs   ON ops.jobs FOR ALL    TO nx_jobs     USING (true) WITH CHECK (true);
GRANT INSERT ON ops.jobs TO nx_app, nx_platform;
GRANT SELECT, INSERT, UPDATE ON ops.jobs TO nx_jobs;

GRANT SELECT, UPDATE ON ops.schedules TO nx_jobs;
GRANT SELECT ON ops.schema_migrations TO nx_jobs;
