-- Workspaces, memberships and roles (cahier §3.3, §7.2 Table 19, §10; TEN-01,
-- TEN-02, AUZ-02, AUZ-10, AUZ-11, AUZ-14). B1b step 3.

-- 1. The permission catalogue: the values of AdminPermissionsPlatform shared
--    with the web application (§10.1). A test compares this table with the
--    shared enum, so a value added on one side and not the other fails CI.
--    Staff permissions belong to the console; member roles cannot hold them.
CREATE TABLE identity.permissions (
  key   text NOT NULL PRIMARY KEY CHECK (key = '*' OR key ~ '^[a-z][a-zA-Z]*:[a-z][a-zA-Z]*$'),
  realm text NOT NULL CHECK (realm IN ('member', 'staff')),
  UNIQUE (key, realm)
);

INSERT INTO identity.permissions (key, realm) VALUES
  ('*', 'member'),
  ('users:create', 'member'), ('users:read', 'member'), ('users:update', 'member'), ('users:delete', 'member'),
  ('roles:create', 'member'), ('roles:read', 'member'), ('roles:update', 'member'), ('roles:delete', 'member'),
  ('sessions:read', 'member'), ('sessions:delete', 'member'),
  ('transactions:create', 'member'), ('transactions:read', 'member'), ('transactions:update', 'member'), ('transactions:delete', 'member'),
  ('invoices:create', 'member'), ('invoices:read', 'member'), ('invoices:update', 'member'), ('invoices:delete', 'member'),
  ('projects:create', 'member'), ('projects:read', 'member'), ('projects:update', 'member'), ('projects:delete', 'member'),
  ('files:create', 'member'), ('files:read', 'member'), ('files:update', 'member'), ('files:delete', 'member'),
  ('reports:read', 'member'), ('reports:update', 'member'), ('reports:delete', 'member'),
  ('employees:create', 'member'), ('employees:read', 'member'), ('employees:update', 'member'), ('employees:delete', 'member'),
  ('clients:create', 'member'), ('clients:read', 'member'), ('clients:update', 'member'), ('clients:delete', 'member'),
  ('clients:import', 'member'), ('clients:export', 'member'),
  ('time:track', 'member'), ('time:approve', 'member'),
  ('analytics:view', 'member'), ('costs:read', 'member'),
  ('staffs:create', 'staff'), ('staffs:read', 'staff'), ('staffs:update', 'staff'), ('staffs:delete', 'staff'),
  ('bannedUsers:read', 'staff'), ('bannedUsers:create', 'staff'), ('bannedUsers:delete', 'staff'),
  ('systemIssues:read', 'staff'), ('systemIssues:update', 'staff'), ('systemIssues:delete', 'staff'),
  ('plans:create', 'staff'), ('plans:read', 'staff'), ('plans:update', 'staff'), ('plans:delete', 'staff'),
  ('subscriptions:create', 'staff'), ('subscriptions:read', 'staff'), ('subscriptions:update', 'staff'), ('subscriptions:delete', 'staff');

GRANT SELECT ON identity.permissions TO nx_app;

-- 2. Roles of a company. The four default roles are created with the workspace
--    and keep their key; an administrator adds custom roles (key NULL).
CREATE TABLE tenant.roles (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenant.workspaces (id),
  key          text CHECK (key IN ('admin', 'manager', 'accountant', 'employee')),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  is_default   boolean GENERATED ALWAYS AS (key IS NOT NULL) STORED,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at   timestamptz NOT NULL,
  created_by   uuid NOT NULL REFERENCES identity.principals (id),
  updated_at   timestamptz NOT NULL,
  updated_by   uuid NOT NULL REFERENCES identity.principals (id),
  version      integer NOT NULL CHECK (version > 0),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, key)
);
CREATE UNIQUE INDEX roles_name_per_workspace ON tenant.roles (workspace_id, lower(btrim(name)));
SELECT ops.secure_tenant_table('tenant.roles');

-- 3. The permissions of a role: member permissions of the catalogue only.
CREATE TABLE tenant.role_permissions (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenant.workspaces (id),
  role_id      uuid NOT NULL,
  permission   text NOT NULL,
  realm        text GENERATED ALWAYS AS ('member') STORED,
  created_at   timestamptz NOT NULL,
  created_by   uuid NOT NULL REFERENCES identity.principals (id),
  updated_at   timestamptz NOT NULL,
  updated_by   uuid NOT NULL REFERENCES identity.principals (id),
  version      integer NOT NULL CHECK (version > 0),
  UNIQUE (workspace_id, id),
  UNIQUE (role_id, permission),
  FOREIGN KEY (workspace_id, role_id) REFERENCES tenant.roles (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (permission, realm) REFERENCES identity.permissions (key, realm)
);
CREATE INDEX role_permissions_by_workspace ON tenant.role_permissions (workspace_id, role_id);
SELECT ops.secure_tenant_table('tenant.role_permissions');

-- 4. Memberships: the only link between a person and a company (TEN-02). One
--    role each; an owner holds the administrator role; a company always keeps
--    one active owner (AUZ-11).
CREATE TABLE tenant.memberships (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES tenant.workspaces (id),
  user_id       uuid NOT NULL REFERENCES identity.users (id),
  role_id       uuid NOT NULL,
  is_owner      boolean NOT NULL DEFAULT false,
  -- The employee record comes with the people module (B3); unique per workspace already.
  employee_id   uuid,
  status        text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  invited_at    timestamptz NOT NULL DEFAULT now(),
  activated_at  timestamptz,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL,
  created_by    uuid NOT NULL REFERENCES identity.principals (id),
  updated_at    timestamptz NOT NULL,
  updated_by    uuid NOT NULL REFERENCES identity.principals (id),
  version       integer NOT NULL CHECK (version > 0),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, user_id),
  UNIQUE (workspace_id, employee_id),
  FOREIGN KEY (workspace_id, role_id) REFERENCES tenant.roles (workspace_id, id),
  CHECK (status <> 'active' OR activated_at IS NOT NULL)
);
CREATE INDEX memberships_by_user ON tenant.memberships (user_id) WHERE status = 'active';
SELECT ops.secure_tenant_table('tenant.memberships');

-- A membership is never deleted: it is disabled, so the history keeps its actor.
REVOKE DELETE ON tenant.memberships FROM nx_app;

-- An owner holds the administrator role.
CREATE FUNCTION tenant.owner_is_admin() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.is_owner AND NOT EXISTS (
    SELECT 1 FROM tenant.roles r WHERE r.workspace_id = NEW.workspace_id AND r.id = NEW.role_id AND r.key = 'admin'
  ) THEN
    RAISE EXCEPTION 'OWNER_NEEDS_ADMIN: an owner holds the administrator role' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owner_is_admin BEFORE INSERT OR UPDATE ON tenant.memberships
  FOR EACH ROW EXECUTE FUNCTION tenant.owner_is_admin();

-- Both checks run as the caller, inside the workspace of the request.
-- At commit, a company that had an active owner still has one (AUZ-11). Checked
-- at the end of the transaction, so an ownership transfer can run in two steps.
CREATE FUNCTION tenant.keep_an_owner() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF OLD.is_owner AND OLD.status = 'active' AND NOT EXISTS (
    SELECT 1 FROM tenant.memberships m WHERE m.workspace_id = OLD.workspace_id AND m.is_owner AND m.status = 'active'
  ) AND EXISTS (
    SELECT 1 FROM tenant.workspaces w WHERE w.id = OLD.workspace_id AND w.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'LAST_OWNER: a company keeps at least one active owner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER keep_an_owner AFTER UPDATE OR DELETE ON tenant.memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenant.keep_an_owner();

-- The functions below run as the owner of the schema (SECURITY DEFINER), which
-- is subject to row-level security like everyone (FORCE): it gets its own
-- policy on these four tables. Only migrations sign in as the owner.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant.workspaces', 'tenant.roles', 'tenant.role_permissions', 'tenant.memberships'] LOOP
    EXECUTE format('CREATE POLICY owner_rows ON %s FOR ALL TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;

-- 5. The workspaces of the person signed in, before a workspace is chosen. The
--    only read across workspaces: rows of the current principal, active
--    memberships of workspaces not deleted.
CREATE FUNCTION tenant.my_memberships()
  RETURNS TABLE (workspace_id uuid, name text, slug text, currency text, membership_id uuid, role_key text, role_name text, is_owner boolean, last_seen_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT w.id, w.name, w.slug, w.base_currency::text, m.id, r.key, r.name, m.is_owner, m.last_seen_at
  FROM tenant.memberships m
  JOIN tenant.workspaces w ON w.id = m.workspace_id
  JOIN tenant.roles r ON r.workspace_id = m.workspace_id AND r.id = m.role_id
  WHERE m.user_id = nullif(current_setting('app.principal_id', true), '')::uuid
    AND m.status = 'active' AND w.deleted_at IS NULL
  ORDER BY m.last_seen_at DESC NULLS LAST, w.name
$$;
GRANT EXECUTE ON FUNCTION tenant.my_memberships() TO nx_app;

-- 6. A new company: the workspace, its four default roles with their
--    permissions (given by the application from the shared role table) and the
--    owner's membership, in one call. Run by the provisioning role (§6.2).
CREATE FUNCTION tenant.provision_workspace(
  p_id uuid, p_name text, p_slug text, p_country text, p_currency text, p_time_zone text, p_locale text,
  p_owner uuid, p_roles jsonb
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  r record;
  v_role uuid;
  v_admin uuid;
BEGIN
  IF ops.current_principal() IS NULL THEN
    RAISE EXCEPTION 'NO_PRINCIPAL: provisioning needs app.principal_id' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.workspace_id', p_id::text, true);
  INSERT INTO tenant.workspaces (id, name, slug, country, base_currency, time_zone, locale)
    VALUES (p_id, p_name, p_slug, p_country, p_currency, p_time_zone, p_locale);
  FOR r IN SELECT key, value FROM jsonb_each(p_roles) LOOP
    v_role := gen_random_uuid();
    INSERT INTO tenant.roles (id, workspace_id, key, name) VALUES (v_role, p_id, r.key, r.value ->> 'name');
    INSERT INTO tenant.role_permissions (id, workspace_id, role_id, permission)
      SELECT gen_random_uuid(), p_id, v_role, p FROM jsonb_array_elements_text(r.value -> 'permissions') p;
    IF r.key = 'admin' THEN v_admin := v_role; END IF;
  END LOOP;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'NO_ADMIN_ROLE: the default roles include admin' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO tenant.memberships (id, workspace_id, user_id, role_id, is_owner, status, activated_at)
    VALUES (gen_random_uuid(), p_id, p_owner, v_admin, true, 'active', now());
END $$;
GRANT EXECUTE ON FUNCTION tenant.provision_workspace(uuid, text, text, text, text, text, text, uuid, jsonb) TO nx_provision;
GRANT USAGE ON SCHEMA tenant TO nx_provision;

-- 7. The workspace a member session works in when the path names none (§5.5 step 4).
ALTER TABLE identity.sessions ADD COLUMN active_workspace_id uuid REFERENCES tenant.workspaces (id);

-- 8. A refused workspace is recorded in the identity trail with the workspace asked for (TEN-01).
-- Not named workspace_id: the trail is not a tenant table and the workspace may not exist.
ALTER TABLE audit.identity_events ADD COLUMN requested_workspace uuid;
