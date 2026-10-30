-- One row per account or job: the target of every "who did it" column (§6.4, Table 18).
-- Accounts of the three realms reference it; jobs are system:<name>.
CREATE TABLE identity.principals (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('member', 'portal', 'staff', 'system')),
  reference    text NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, reference)
);

GRANT SELECT, INSERT ON identity.principals TO nx_app, nx_portal, nx_platform;
GRANT SELECT ON identity.principals TO nx_support, nx_dataops, nx_readonly;
