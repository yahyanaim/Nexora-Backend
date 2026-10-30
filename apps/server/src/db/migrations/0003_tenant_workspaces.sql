-- The workspace of a company: the unit of isolation (Table 19).
-- workspace_id equals id, so the table follows the same rules as every tenant table.
CREATE TABLE tenant.workspaces (
  id            uuid PRIMARY KEY,
  workspace_id  uuid GENERATED ALWAYS AS (id) STORED,
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 60),
  country       char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  base_currency char(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  time_zone     text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  locale        text NOT NULL CHECK (locale IN ('en', 'fr', 'ar', 'de', 'es', 'hi', 'ru', 'ur', 'zh')),
  is_demo       boolean NOT NULL DEFAULT false,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL,
  created_by    uuid NOT NULL REFERENCES identity.principals (id),
  updated_at    timestamptz NOT NULL,
  updated_by    uuid NOT NULL REFERENCES identity.principals (id),
  version       integer NOT NULL CHECK (version > 0),
  UNIQUE (workspace_id, id)
);

SELECT ops.secure_tenant_table('tenant.workspaces');

-- Workspaces are created only by the provisioning function (§6.2) and never
-- deleted by the application (removal goes through the deletion job, RET-02).
REVOKE INSERT, DELETE ON tenant.workspaces FROM nx_app;
