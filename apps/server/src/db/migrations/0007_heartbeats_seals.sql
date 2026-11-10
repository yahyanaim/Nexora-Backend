-- Worker heartbeats and audit seals (cahier des charges §16, §17; JOB-07,
-- JOB-09, TRL-05; audit M-3, M-4). Runs as nx_owner.

-- 1. Worker heartbeats (JOB-09). Each worker writes its row at least every
--    minute with the queue metrics; a row whose beat is older than 2 minutes and
--    that was not stopped is a missing worker. No company data: no row-level security.
CREATE TABLE ops.worker_heartbeats (
  worker_id          text PRIMARY KEY CHECK (length(worker_id) BETWEEN 1 AND 200),
  started_at         timestamptz NOT NULL,
  beat_at            timestamptz NOT NULL,
  stopped_at         timestamptz,
  due                integer NOT NULL CHECK (due >= 0),
  oldest_due_seconds integer NOT NULL CHECK (oldest_due_seconds >= 0),
  running            integer NOT NULL CHECK (running >= 0),
  dead               integer NOT NULL CHECK (dead >= 0),
  outbox_pending     integer NOT NULL CHECK (outbox_pending >= 0),
  outbox_lag_seconds integer NOT NULL CHECK (outbox_lag_seconds >= 0)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.worker_heartbeats TO nx_jobs;
-- The console's operations page reads them (§17.1 visibility).
GRANT SELECT ON ops.worker_heartbeats TO nx_platform;

-- 2. Audit seals (TRL-05). One chain per trail, and per workspace for the
--    workspace trail. Each seal covers the events after the previous seal's last
--    event, by id, up to its own last event; it holds the hash of those events in
--    id order and the hash of the previous seal, so any later change, removal or
--    insertion inside a sealed range breaks the chain.
CREATE TABLE audit.seals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trail          text NOT NULL CHECK (trail IN ('workspace', 'identity', 'console')),
  workspace_id   uuid REFERENCES tenant.workspaces (id),
  first_event_id uuid NOT NULL,
  last_event_id  uuid NOT NULL,
  event_count    integer NOT NULL CHECK (event_count > 0),
  events_hash    text NOT NULL CHECK (events_hash ~ '^[0-9a-f]{64}$'),
  previous_hash  text CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  seal_hash      text NOT NULL UNIQUE CHECK (seal_hash ~ '^[0-9a-f]{64}$'),
  sealed_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((trail = 'workspace') = (workspace_id IS NOT NULL)),
  CHECK (first_event_id <= last_event_id)
);
-- A chain never forks: one seal per previous seal, one seal per last event.
CREATE UNIQUE INDEX seals_one_next ON audit.seals (trail, coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'), coalesce(previous_hash, ''));
CREATE UNIQUE INDEX seals_by_last  ON audit.seals (trail, coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'), last_event_id);

CREATE TRIGGER refuse_change BEFORE UPDATE OR DELETE ON audit.seals FOR EACH ROW EXECUTE FUNCTION audit.refuse_change();
CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON audit.seals FOR EACH STATEMENT EXECUTE FUNCTION audit.refuse_change();

-- Seals and events are read and written only by the two functions below, which
-- run as the owner. Row-level security is forced, so the owner gets policies of
-- its own; no running process logs in as the owner.
ALTER TABLE audit.seals ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.seals FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  EXECUTE format('CREATE POLICY seal_owner ON audit.seals FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY seal_read ON audit.workspace_events FOR SELECT TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY seal_read ON audit.console_events FOR SELECT TO %I USING (true)', current_user);
END $$;

-- 3. The hash of the events of one chain in (after, last], in id order. Each
--    event is hashed as its jsonb text, which has a canonical key order.
CREATE FUNCTION audit.range_hash(p_trail text, p_workspace uuid, p_after uuid, p_last uuid, OUT n integer, OUT first_id uuid, OUT hash text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  EXECUTE format(
    $q$SELECT count(*)::int, (array_agg(e.id ORDER BY e.id))[1],
              encode(sha256(convert_to(coalesce(string_agg(to_jsonb(e)::text, E'\n' ORDER BY e.id), ''), 'UTF8')), 'hex')
       FROM audit.%I e
       WHERE e.id > $1 AND e.id <= $2 %s$q$,
    p_trail || '_events',
    CASE WHEN p_trail = 'workspace' THEN 'AND e.workspace_id = $3' ELSE '' END)
  INTO n, first_id, hash
  USING coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid), p_last, p_workspace;
END $$;

CREATE FUNCTION audit.seal_hash(p_trail text, p_workspace uuid, p_first uuid, p_last uuid, p_count integer, p_events_hash text, p_previous text)
  RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT encode(sha256(convert_to(concat_ws('|', p_trail, coalesce(p_workspace::text, ''), p_first::text, p_last::text,
                                            p_count::text, p_events_hash, coalesce(p_previous, '')), 'UTF8')), 'hex')
$$;

-- 4. The sealing job (every 5 minutes). Events younger than the margin wait for
--    the next run, so a transaction still open when the job runs is not left
--    out of a sealed range. Returns the number of seals written.
CREATE FUNCTION audit.seal(p_margin interval DEFAULT interval '2 minutes') RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_cutoff timestamptz := now() - greatest(p_margin, interval '0');
  c record;
  v_prev audit.seals;
  v_last uuid;
  r record;
  v_written integer := 0;
BEGIN
  -- One sealing run at a time.
  PERFORM pg_advisory_xact_lock(hashtextextended('nexora.audit.seal', 0));
  FOR c IN
    SELECT 'workspace'::text AS trail, w.workspace_id FROM (SELECT DISTINCT workspace_id FROM audit.workspace_events) w
    UNION ALL SELECT 'identity', NULL::uuid
    UNION ALL SELECT 'console', NULL::uuid
  LOOP
    SELECT * INTO v_prev FROM audit.seals s
      WHERE s.trail = c.trail AND s.workspace_id IS NOT DISTINCT FROM c.workspace_id
      ORDER BY s.last_event_id DESC LIMIT 1;
    EXECUTE format('SELECT e.id FROM audit.%I e WHERE e.id > $1 AND e.at <= $2 %s ORDER BY e.id DESC LIMIT 1',
                   c.trail || '_events', CASE WHEN c.trail = 'workspace' THEN 'AND e.workspace_id = $3' ELSE '' END)
      INTO v_last USING coalesce(v_prev.last_event_id, '00000000-0000-0000-0000-000000000000'::uuid), v_cutoff, c.workspace_id;
    CONTINUE WHEN v_last IS NULL;
    r := audit.range_hash(c.trail, c.workspace_id, v_prev.last_event_id, v_last);
    INSERT INTO audit.seals (trail, workspace_id, first_event_id, last_event_id, event_count, events_hash, previous_hash, seal_hash)
    VALUES (c.trail, c.workspace_id, r.first_id, v_last, r.n, r.hash, v_prev.seal_hash,
            audit.seal_hash(c.trail, c.workspace_id, r.first_id, v_last, r.n, r.hash, v_prev.seal_hash));
    v_written := v_written + 1;
  END LOOP;
  RETURN v_written;
END $$;

-- 5. The verification job (daily). Recomputes every chain and lists each break:
--    a changed, removed or inserted event, an altered seal, or a broken link.
CREATE FUNCTION audit.verify()
  RETURNS TABLE (trail text, workspace_id uuid, seal_id uuid, problem text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  s audit.seals;
  v_chain text := NULL;
  v_prev audit.seals;
  r record;
BEGIN
  FOR s IN SELECT * FROM audit.seals x ORDER BY x.trail, x.workspace_id NULLS FIRST, x.last_event_id LOOP
    IF v_chain IS DISTINCT FROM s.trail || ':' || coalesce(s.workspace_id::text, '') THEN
      v_chain := s.trail || ':' || coalesce(s.workspace_id::text, '');
      v_prev := NULL;
    END IF;
    trail := s.trail; workspace_id := s.workspace_id; seal_id := s.id;
    IF s.previous_hash IS DISTINCT FROM v_prev.seal_hash THEN
      problem := 'broken link to the previous seal'; RETURN NEXT;
    END IF;
    r := audit.range_hash(s.trail, s.workspace_id, v_prev.last_event_id, s.last_event_id);
    IF r.n <> s.event_count OR r.hash <> s.events_hash OR r.first_id IS DISTINCT FROM s.first_event_id THEN
      problem := format('events changed: %s sealed, %s found', s.event_count, r.n); RETURN NEXT;
    END IF;
    IF s.seal_hash <> audit.seal_hash(s.trail, s.workspace_id, s.first_event_id, s.last_event_id, s.event_count, s.events_hash, s.previous_hash) THEN
      problem := 'seal altered'; RETURN NEXT;
    END IF;
    v_prev := s;
  END LOOP;
END $$;

-- Only the worker's queue role runs the jobs; nobody calls the helpers directly.
REVOKE EXECUTE ON FUNCTION audit.range_hash(text, uuid, uuid, uuid), audit.seal_hash(text, uuid, uuid, uuid, integer, text, text),
  audit.seal(interval), audit.verify() FROM PUBLIC;
GRANT USAGE ON SCHEMA audit TO nx_jobs;
GRANT EXECUTE ON FUNCTION audit.seal(interval), audit.verify() TO nx_jobs;

-- 6. The schedules of the two jobs (Table 56).
INSERT INTO ops.schedules (name, job_type, interval_seconds, next_run_at) VALUES
  ('audit.seal', 'audit.seal', 300, now()),
  ('audit.verify', 'audit.verify', 86400, now());
