-- Sign-in limits in PostgreSQL (cahier des charges IAM-04, IAM-09, SCR-05;
-- B1b step 2). Runs as nx_owner. No e-mail or client address is stored in
-- clear: only their SHA-256.

-- 1. Failed sign-ins and the 15-minute lock, per e-mail tried, whether an
--    account exists for it or not: the answers are the same for both (IAM-04).
CREATE TABLE identity.sign_in_failures (
  email_hash      text PRIMARY KEY CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  last_failure_at timestamptz,
  locked_until    timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.sign_in_failures TO nx_app;

-- 2. Fixed-window counters, e.g. failures per client address. Each row counts
--    the hits of one bucket (a purpose and a hash) in one window.

CREATE TABLE ops.rate_limits (
  bucket       text NOT NULL CHECK (bucket ~ '^[a-z_]+:[a-z_]+:[0-9a-f]{64}$'),
  window_start timestamptz NOT NULL,
  hits         integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX rate_limits_by_window ON ops.rate_limits (window_start);

-- Sign-in runs as the member realm before any workspace is known.
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.rate_limits TO nx_app;
