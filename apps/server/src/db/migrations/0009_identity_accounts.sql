-- Member accounts, sessions, refresh tokens and single-use tokens (cahier des
-- charges §8, Table 18; IAM-02, IAM-04, IAM-07, IAM-10; phase B1b step 1).
-- Runs as nx_owner. Nothing here holds a workspace: memberships, which do,
-- come with the workspace step (TEN-02).

-- 1. Member accounts. The id is the account's principal (identity.principals),
--    the target of every actor column. E-mail addresses are stored lower case,
--    so uniqueness ignores case without an extension.
CREATE TABLE identity.users (
  id                uuid PRIMARY KEY REFERENCES identity.principals (id),
  email             text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254 AND email ~ '^[^@\s]+@[^@\s]+$'),
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  password_hash     text CHECK (password_hash ~ '^\$argon2id\$'),
  status            text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  failed_attempts   integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until      timestamptz,
  email_verified_at timestamptz,
  locale            text NOT NULL DEFAULT 'fr' CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- An active account can sign in, so it has a password.
  CHECK (status <> 'active' OR password_hash IS NOT NULL)
);

-- 2. Server-side sessions, one per signed-in browser, for the three realms (Table 6).
CREATE TABLE identity.sessions (
  id                  uuid PRIMARY KEY,
  principal_id        uuid NOT NULL REFERENCES identity.principals (id),
  realm               text NOT NULL CHECK (realm IN ('member', 'portal', 'staff')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_activity_at    timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  -- SHA-256 of the session's XSRF-TOKEN value: the double-submit check compares against it (SCR-16).
  xsrf_hash           text NOT NULL CHECK (xsrf_hash ~ '^[0-9a-f]{64}$'),
  revoked_at          timestamptz,
  revoked_reason      text CHECK (revoked_reason IN ('sign_out', 'expired', 'refresh_reuse', 'password_changed', 'admin', 'user', 'account_disabled')),
  ip                  inet,
  user_agent          text CHECK (length(user_agent) <= 400),
  country             text CHECK (country ~ '^[A-Z]{2}$'),
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX sessions_open ON identity.sessions (principal_id) WHERE revoked_at IS NULL;

-- 3. Refresh tokens: stored hashed, rotated on every use; a replaced token used
--    again revokes its session (IAM-07).
CREATE TABLE identity.refresh_tokens (
  id          uuid PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES identity.sessions (id),
  token_hash  text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES identity.refresh_tokens (id),
  CHECK (replaced_by IS NULL OR revoked_at IS NOT NULL)
);
CREATE INDEX refresh_tokens_by_session ON identity.refresh_tokens (session_id);

-- 4. Single-use tokens: invitations, verification, reset, portal links (IAM-10).
CREATE TABLE identity.sign_in_tokens (
  id           uuid PRIMARY KEY,
  purpose      text NOT NULL CHECK (purpose IN ('verify', 'reset', 'email_change', 'second_factor_reset', 'invite', 'portal_link', 'staff_invite')),
  email        text CHECK (email = lower(email)),
  principal_id uuid REFERENCES identity.principals (id),
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  context      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(context) = 'object'),
  CHECK (email IS NOT NULL OR principal_id IS NOT NULL),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days')
);

-- 5. Who may do what. The member realm (nx_app) signs in before any workspace
--    is known, so it reads and updates member accounts; it never deletes them
--    (Table 18: never hard-deleted while memberships exist). Console and portal
--    accounts come with their realms.
GRANT SELECT, INSERT, UPDATE ON identity.users, identity.sessions, identity.refresh_tokens, identity.sign_in_tokens TO nx_app;
