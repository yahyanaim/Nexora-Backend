-- The audit secret scan (cahier des charges TRL-04; B1a exit gate). The unit
-- of work masks secret fields before an event is written; this scan checks the
-- result in the trails themselves, so a field the mask missed, or a secret
-- written under an innocent name, is found. It returns where a secret is,
-- never the value. Runs as nx_owner.

-- Luhn check, so long digit runs such as timestamps are not taken for card numbers.
CREATE FUNCTION audit.luhn(p_digits text) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_sum integer := 0;
  v_d integer;
  v_double boolean := false;
BEGIN
  FOR i IN REVERSE length(p_digits)..1 LOOP
    v_d := substr(p_digits, i, 1)::integer;
    IF v_double THEN
      v_d := v_d * 2;
      IF v_d > 9 THEN v_d := v_d - 9; END IF;
    END IF;
    v_sum := v_sum + v_d;
    v_double := NOT v_double;
  END LOOP;
  RETURN v_sum % 10 = 0;
END $$;

-- What a secret looks like when it is a value. Kept short and specific: each
-- pattern must not match ordinary business text.
CREATE FUNCTION audit.secret_kind(p_value text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_compact text := regexp_replace(p_value, '[ -]', '', 'g');
BEGIN
  IF p_value ~ '^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.' THEN RETURN 'token (JWT)'; END IF;
  IF p_value ~ '-----BEGIN [A-Z ]*PRIVATE KEY-----' THEN RETURN 'private key'; END IF;
  IF p_value ~ '(sk|rk)_(live|test)_[A-Za-z0-9]{10,}' OR p_value ~ 'AKIA[0-9A-Z]{16}' OR p_value ~ 'gh[pousr]_[A-Za-z0-9]{30,}' OR p_value ~ 'xox[abprs]-[A-Za-z0-9-]{10,}' THEN
    RETURN 'API key';
  END IF;
  IF v_compact ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' THEN RETURN 'IBAN'; END IF;
  IF v_compact ~ '^[0-9]{24}$' THEN RETURN 'bank account (RIB)'; END IF;
  IF v_compact ~ '^[0-9]{13,19}$' AND audit.luhn(v_compact) AND p_value ~ '^[0-9 -]+$' AND length(v_compact) >= 15 THEN RETURN 'card number'; END IF;
  RETURN NULL;
END $$;

-- Every place in the before and after values of the workspace and console
-- trails where a secret field is not masked or a value looks like a secret.
-- The key pattern is the unit of work's (src/db/unit-of-work.ts, SECRET_KEY).
CREATE FUNCTION audit.secret_scan()
  RETURNS TABLE (trail text, event_id uuid, path text, kind text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  WITH RECURSIVE docs AS (
    SELECT 'workspace'::text AS trail, e.id, 'before'::text AS path, e.before AS val FROM audit.workspace_events e WHERE e.before IS NOT NULL
    UNION ALL SELECT 'workspace', e.id, 'after', e.after FROM audit.workspace_events e WHERE e.after IS NOT NULL
    UNION ALL SELECT 'console', e.id, 'before', e.before FROM audit.console_events e WHERE e.before IS NOT NULL
    UNION ALL SELECT 'console', e.id, 'after', e.after FROM audit.console_events e WHERE e.after IS NOT NULL
  ), walk (trail, event_id, path, key, val) AS (
    SELECT d.trail, d.id, d.path, NULL::text, d.val FROM docs d
    UNION ALL
    SELECT w.trail, w.event_id, w.path || c.step, c.key, c.val
    FROM walk w, LATERAL (
      SELECT '.' || o.key AS step, o.key, o.value AS val
      FROM jsonb_each(CASE WHEN jsonb_typeof(w.val) = 'object' THEN w.val ELSE '{}'::jsonb END) o
      UNION ALL
      SELECT '[' || (a.ord - 1) || ']', NULL, a.value
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.val) = 'array' THEN w.val ELSE '[]'::jsonb END) WITH ORDINALITY a (value, ord)
    ) c
  )
  SELECT w.trail, w.event_id, w.path,
         CASE WHEN w.key ~* 'pass(word)?|token|secret|otp|totp|mfa|api[-_]?key|iban|rib|card|cvv' AND w.val <> '"[redacted]"'::jsonb
              THEN 'secret field not masked'
              ELSE audit.secret_kind(w.val #>> '{}') END
  FROM walk w
  WHERE (w.key ~* 'pass(word)?|token|secret|otp|totp|mfa|api[-_]?key|iban|rib|card|cvv' AND w.val <> '"[redacted]"'::jsonb)
     OR (jsonb_typeof(w.val) = 'string' AND audit.secret_kind(w.val #>> '{}') IS NOT NULL)
  ORDER BY 1, 2, 3
$$;

REVOKE EXECUTE ON FUNCTION audit.luhn(text), audit.secret_kind(text), audit.secret_scan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.secret_scan() TO nx_jobs;
