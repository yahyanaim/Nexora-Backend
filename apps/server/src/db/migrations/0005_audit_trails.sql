-- The three audit trails (cahier des charges §16, Table 28; TRL-01 to TRL-03).
-- Written by the unit of work in the same transaction as the change they
-- describe. Application roles may insert and read, never change: a trigger
-- refuses UPDATE, DELETE and TRUNCATE for every role, the owner included. The
-- retention function (TRL-06) and the sealing job (TRL-05) come in later steps.

-- 1. Nothing in an audit trail ever changes.
CREATE FUNCTION audit.refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_IMMUTABLE: %.% accepts inserts only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- 2. Workspace trail: every action inside a company. Read by the company under
--    row-level security; the console has no privilege on it.
CREATE TABLE audit.workspace_events (
  id                 uuid PRIMARY KEY,
  workspace_id       uuid NOT NULL REFERENCES tenant.workspaces (id),
  at                 timestamptz NOT NULL DEFAULT now(),
  actor_id           uuid NOT NULL REFERENCES identity.principals (id),
  actor_role         text NOT NULL CHECK (length(actor_role) BETWEEN 1 AND 40),
  action             text NOT NULL CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  target_type        text NOT NULL CHECK (target_type ~ '^[a-z][a-z_]*$'),
  target_id          text,
  target_label       text CHECK (length(target_label) <= 200),
  before             jsonb,
  after              jsonb,
  reason             text CHECK (length(reason) <= 1000),
  ip                 inet,
  user_agent         text CHECK (length(user_agent) <= 400),
  request_id         text CHECK (length(request_id) <= 100),
  session_id         text CHECK (length(session_id) <= 100),
  support_session_id uuid
);
CREATE INDEX workspace_events_by_time   ON audit.workspace_events (workspace_id, at DESC);
CREATE INDEX workspace_events_by_actor  ON audit.workspace_events (workspace_id, actor_id, at DESC);
CREATE INDEX workspace_events_by_target ON audit.workspace_events (workspace_id, target_type, target_id);

ALTER TABLE audit.workspace_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.workspace_events FORCE ROW LEVEL SECURITY;
-- Rows of the request's workspace only; the actor is the request's principal (TRL-03).
CREATE POLICY workspace_read ON audit.workspace_events FOR SELECT TO nx_app, nx_dataops
  USING (workspace_id = ops.current_workspace());
CREATE POLICY workspace_write ON audit.workspace_events FOR INSERT TO nx_app
  WITH CHECK (workspace_id = ops.current_workspace() AND actor_id = ops.current_principal());
GRANT SELECT, INSERT ON audit.workspace_events TO nx_app;
GRANT SELECT ON audit.workspace_events TO nx_dataops;

-- 3. Identity trail: sign-in and account events, before any workspace is known (IAM-16).
CREATE TABLE audit.identity_events (
  id           uuid PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  principal_id uuid REFERENCES identity.principals (id),
  email_hash   text CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  realm        text NOT NULL CHECK (realm IN ('member', 'portal', 'staff')),
  action       text NOT NULL CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  ip           inet,
  user_agent   text CHECK (length(user_agent) <= 400),
  request_id   text CHECK (length(request_id) <= 100),
  session_id   text CHECK (length(session_id) <= 100),
  CHECK (principal_id IS NOT NULL OR email_hash IS NOT NULL)
);
CREATE INDEX identity_events_by_principal ON audit.identity_events (principal_id, at DESC);
-- Who reads it (a person their own events, staff the staff events) comes with identity (B1b).
GRANT INSERT ON audit.identity_events TO nx_app, nx_portal, nx_platform;

-- 4. Console trail: every staff action (AUD-01). Company roles have no privilege on it.
CREATE TABLE audit.console_events (
  id           uuid PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid NOT NULL REFERENCES identity.principals (id),
  actor_role   text NOT NULL CHECK (length(actor_role) BETWEEN 1 AND 40),
  action       text NOT NULL CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  customer_id  uuid,
  target_type  text NOT NULL CHECK (target_type ~ '^[a-z][a-z_]*$'),
  target_id    text,
  target_label text CHECK (length(target_label) <= 200),
  before       jsonb,
  after        jsonb,
  reason       text CHECK (length(reason) <= 1000),
  ip           inet,
  user_agent   text CHECK (length(user_agent) <= 400),
  request_id   text CHECK (length(request_id) <= 100),
  session_id   text CHECK (length(session_id) <= 100)
);
CREATE INDEX console_events_by_time     ON audit.console_events (at DESC);
CREATE INDEX console_events_by_customer ON audit.console_events (customer_id, at DESC);

ALTER TABLE audit.console_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.console_events FORCE ROW LEVEL SECURITY;
CREATE POLICY console_read ON audit.console_events FOR SELECT TO nx_platform USING (true);
CREATE POLICY console_write ON audit.console_events FOR INSERT TO nx_platform
  WITH CHECK (actor_id = ops.current_principal());
GRANT SELECT, INSERT ON audit.console_events TO nx_platform;

-- 5. Insert-only for everyone (TRL-02).
CREATE TRIGGER refuse_change BEFORE UPDATE OR DELETE ON audit.workspace_events FOR EACH ROW EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER refuse_change BEFORE UPDATE OR DELETE ON audit.identity_events  FOR EACH ROW EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER refuse_change BEFORE UPDATE OR DELETE ON audit.console_events   FOR EACH ROW EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON audit.workspace_events FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON audit.identity_events  FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON audit.console_events   FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();
