-- Departments of a company (Table 20): the first business table, and the pattern
-- every tenant table follows: composite tenant key, common columns, secured.
CREATE TABLE tenant.departments (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES tenant.workspaces (id),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  created_at   timestamptz NOT NULL,
  created_by   uuid NOT NULL REFERENCES identity.principals (id),
  updated_at   timestamptz NOT NULL,
  updated_by   uuid NOT NULL REFERENCES identity.principals (id),
  version      integer NOT NULL CHECK (version > 0),
  UNIQUE (workspace_id, id)
);

-- A name is used once per company, whatever its case.
CREATE UNIQUE INDEX departments_name_per_workspace ON tenant.departments (workspace_id, lower(btrim(name)));

SELECT ops.secure_tenant_table('tenant.departments');
