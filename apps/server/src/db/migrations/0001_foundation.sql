-- Foundation: group roles, the six schemas, privileges and the helpers every
-- tenant table uses (cahier des charges §6.1, §6.4, §6.6; DAT-02, DAT-09, DAT-10).
-- Runs as nx_owner, which owns every object and is never used by a running process.

-- 1. Group roles. Cluster-wide, so created only when missing. None can sign in
--    or bypass row-level security; login users (one per process, created at
--    bootstrap, see docs/DATABASE.md) are members and SET LOCAL ROLE per transaction.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['nx_app', 'nx_portal', 'nx_platform', 'nx_support', 'nx_dataops', 'nx_provision', 'nx_readonly'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', r);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL; -- created at the same moment by a migration of another database
      END;
    END IF;
  END LOOP;
END $$;

-- 2. Schemas (Table 14).
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS tenant;
CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS ops;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS archive;

-- Nothing is created in public, and nobody but the owner creates anything anywhere.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 3. Who may look into which schema (Table 15). The console role (nx_platform)
--    gets no usage on tenant: the database itself keeps it away from company data (SEC-02, TEN-10).
GRANT USAGE ON SCHEMA identity TO nx_app, nx_portal, nx_platform, nx_support, nx_dataops, nx_readonly;
GRANT USAGE ON SCHEMA tenant   TO nx_app, nx_portal, nx_support, nx_dataops, nx_readonly;
GRANT USAGE ON SCHEMA platform TO nx_platform;
GRANT USAGE ON SCHEMA ops      TO nx_app, nx_portal, nx_platform, nx_support, nx_dataops, nx_readonly;
GRANT USAGE ON SCHEMA audit    TO nx_app, nx_portal, nx_platform, nx_support, nx_dataops;
GRANT USAGE ON SCHEMA archive  TO nx_dataops;

-- Tenant tables created from now on get these grants; row-level security then limits the rows.
ALTER DEFAULT PRIVILEGES IN SCHEMA tenant GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nx_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA tenant GRANT SELECT, DELETE ON TABLES TO nx_dataops;
ALTER DEFAULT PRIVILEGES IN SCHEMA tenant GRANT SELECT ON TABLES TO nx_readonly;

-- The readiness check reads which migrations ran (QAL-05).
GRANT SELECT ON ops.schema_migrations TO nx_app, nx_platform, nx_readonly;

-- 4. Request context. The unit of work sets these with SET LOCAL at the start of
--    every transaction; they vanish at commit, so a pooled connection keeps nothing (TEN-05).
CREATE FUNCTION ops.current_workspace() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;

CREATE FUNCTION ops.current_principal() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.principal_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION ops.current_workspace(), ops.current_principal()
  TO nx_app, nx_portal, nx_platform, nx_support, nx_dataops, nx_readonly;

-- 5. Common columns (§6.4, DAT-10, DAT-11): the actor comes from the request
--    context, never from the row sent (IAM-01, TRL-03); every update bumps the version.
CREATE FUNCTION ops.stamp_row() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  who uuid := ops.current_principal();
BEGIN
  IF who IS NULL THEN
    RAISE EXCEPTION 'NO_PRINCIPAL: % on %.% needs app.principal_id', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.created_by := who;
    NEW.version := 1;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
      RAISE EXCEPTION 'IMMUTABLE_KEY: the id and workspace of %.% never change', TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.version := OLD.version + 1;
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := who;
  RETURN NEW;
END $$;

-- 6. One call secures a tenant table: row-level security enabled and forced,
--    rows limited to the workspace of the request, actor and version stamped
--    (DAT-09). Without app.workspace_id no row is visible and none can be written.
--    nx_support gets no policy here: its policy comes with support sessions (B1f).
CREATE FUNCTION ops.secure_tenant_table(target regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_rows ON %s FOR ALL TO nx_app, nx_dataops, nx_readonly '
    'USING (workspace_id = ops.current_workspace()) WITH CHECK (workspace_id = ops.current_workspace())',
    target);
  EXECUTE format('CREATE TRIGGER stamp_row BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION ops.stamp_row()', target);
END $$;
