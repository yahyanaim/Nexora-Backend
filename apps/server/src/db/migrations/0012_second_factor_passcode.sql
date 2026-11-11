-- Second factor, step-up, sessions and the lock-screen passcode (cahier §8,
-- Table 18; IAM-05, IAM-06, IAM-16, IAM-18, SCR-07). B1b step 4.

-- 1. The TOTP second factor of a principal. The secret is encrypted by the
--    application (AES-256-GCM, SCR-07); the database never sees it in clear.
--    A row without enabled_at is a set-up waiting for its first code.
CREATE TABLE identity.second_factors (
  principal_id uuid PRIMARY KEY REFERENCES identity.principals (id),
  kind         text NOT NULL DEFAULT 'totp' CHECK (kind = 'totp'),
  secret_enc   text NOT NULL CHECK (secret_enc ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  enabled_at   timestamptz,
  -- The last 30-second step accepted: a code is never accepted twice.
  last_step    bigint NOT NULL DEFAULT 0 CHECK (last_step >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 2. Recovery codes: ten per principal, stored as SHA-256, each usable once.
CREATE TABLE identity.recovery_codes (
  id           uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES identity.principals (id),
  code_hash    text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_by_principal ON identity.recovery_codes (principal_id) WHERE used_at IS NULL;

-- 3. The second step of a sign-in: the password was right, the code is awaited.
--    No session exists yet; the challenge lasts 5 minutes and allows 5 codes.
CREATE TABLE identity.sign_in_challenges (
  id           uuid PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id      uuid NOT NULL REFERENCES identity.users (id),
  realm        text NOT NULL CHECK (realm IN ('member', 'portal', 'staff')),
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  ip           inet,
  user_agent   text CHECK (length(user_agent) <= 400),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes')
);

-- 4. The lock-screen passcode of a member (IAM-18): 4 to 8 digits, Argon2id.
CREATE TABLE identity.passcodes (
  user_id         uuid PRIMARY KEY REFERENCES identity.users (id),
  passcode_hash   text NOT NULL CHECK (passcode_hash ~ '^\$argon2id\$'),
  set_at          timestamptz NOT NULL DEFAULT now(),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0)
);

-- 5. Sessions: when the second factor was last given (sign-in or step-up), and
--    a passcode that failed five times as a reason to end a session.
ALTER TABLE identity.sessions ADD COLUMN second_factor_at timestamptz;
ALTER TABLE identity.sessions DROP CONSTRAINT sessions_revoked_reason_check;
ALTER TABLE identity.sessions ADD CONSTRAINT sessions_revoked_reason_check
  CHECK (revoked_reason IN ('sign_out', 'expired', 'refresh_reuse', 'password_changed', 'admin', 'user', 'account_disabled', 'passcode_failed'));

-- 6. The member realm signs in and manages these before any workspace is known.
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.second_factors, identity.recovery_codes, identity.passcodes TO nx_app;
GRANT SELECT, INSERT, UPDATE ON identity.sign_in_challenges TO nx_app;
