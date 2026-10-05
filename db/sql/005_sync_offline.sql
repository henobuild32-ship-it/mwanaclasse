-- ============================================================================
--  MWANA CLASSE — 005 — Synchronisation Offline First
--  Terminaux identifiés · lots idempotents · résolution de conflits · delta
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Appareils / terminaux (tablette d'entrée, téléphone de l'administration)
-- ---------------------------------------------------------------------------
CREATE TABLE sync.clients (
  id              uuid PRIMARY KEY,                 -- généré par le terminal (UUIDv4)
  school_id       uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  audience        text NOT NULL CHECK (audience IN ('parent','ecole')),
  staff_user_id   uuid REFERENCES sec.staff_users(id) ON DELETE SET NULL,
  parent_id       uuid REFERENCES app.parents(id) ON DELETE SET NULL,
  label           text NOT NULL,                    -- 'Tablette entrée', 'Téléphone secrétariat'
  platform        text,                             -- 'android','ios','windows','web'
  app_version     text,
  user_agent      text,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_sync_at    timestamptz,
  last_pull_cursor timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  pending_count   integer NOT NULL DEFAULT 0,
  is_blocked      boolean NOT NULL DEFAULT false,
  blocked_reason  text
);

CREATE INDEX clients_school_idx ON sync.clients (school_id, last_seen_at DESC);
CREATE INDEX clients_staff_idx  ON sync.clients (staff_user_id);
CREATE INDEX clients_parent_idx ON sync.clients (parent_id);

-- ---------------------------------------------------------------------------
-- Lots de synchronisation (un envoi = un lot)
-- ---------------------------------------------------------------------------
CREATE TABLE sync.batches (
  id             uuid PRIMARY KEY,                  -- UUID du lot, généré hors ligne
  school_id      uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  client_id      uuid NOT NULL REFERENCES sync.clients(id) ON DELETE CASCADE,
  audience       text NOT NULL CHECK (audience IN ('parent','ecole')),
  operation_count integer NOT NULL DEFAULT 0,
  applied_count  integer NOT NULL DEFAULT 0,
  conflict_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'recu'
                   CHECK (status IN ('recu','applique','partiel','rejete')),
  client_created_at timestamptz,
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  duration_ms    integer,
  summary        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX batches_school_idx ON sync.batches (school_id, received_at DESC);
CREATE INDEX batches_client_idx ON sync.batches (client_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- Opérations unitaires — idempotentes et historisées
-- ---------------------------------------------------------------------------
CREATE TABLE sync.operations (
  id              bigserial PRIMARY KEY,
  op_uuid         uuid NOT NULL,                    -- identifiant d'opération côté terminal
  batch_id        uuid REFERENCES sync.batches(id) ON DELETE CASCADE,
  client_id       uuid NOT NULL REFERENCES sync.clients(id) ON DELETE CASCADE,
  school_id       uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  audience        text NOT NULL CHECK (audience IN ('parent','ecole')),
  actor_staff_id  uuid REFERENCES sec.staff_users(id) ON DELETE SET NULL,
  actor_parent_id uuid REFERENCES app.parents(id) ON DELETE SET NULL,
  entity_type     text NOT NULL,                    -- 'attendance','attendance.bulk','request'…
  entity_id       uuid,
  op_type         text NOT NULL CHECK (op_type IN ('create','update','delete','upsert','action')),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  base_version    integer,                          -- version connue du terminal (détection conflit)
  client_time     timestamptz,                      -- horodatage réel du terminal (hors ligne)
  device_id       text,
  status          sync.op_status NOT NULL DEFAULT 'pending',
  applied_at      timestamptz,
  server_version  integer,
  message         text,
  conflict_detail jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ops_uuid_client_unique UNIQUE (client_id, op_uuid)
);

COMMENT ON TABLE  sync.operations IS 'Chaque opération hors ligne, rejouée côté serveur de façon idempotente';
COMMENT ON COLUMN sync.operations.base_version IS 'Version que le terminal croyait à jour : détecte les conflits d''écriture simultanée';
COMMENT ON COLUMN sync.operations.client_time IS 'Heure réelle du terminal au moment de l''action (les présences hors ligne gardent l''heure juste)';

CREATE INDEX ops_pending_idx  ON sync.operations (school_id, status)
  WHERE status IN ('pending','conflict','failed');
CREATE INDEX ops_client_idx   ON sync.operations (client_id, created_at DESC);
CREATE INDEX ops_entity_idx   ON sync.operations (entity_type, entity_id);
CREATE INDEX ops_batch_idx    ON sync.operations (batch_id);

-- ---------------------------------------------------------------------------
-- Journal des conflits : aucune écrasement silencieux
-- ---------------------------------------------------------------------------
CREATE TABLE sync.conflicts (
  id              bigserial PRIMARY KEY,
  school_id       uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  entity_type     text NOT NULL,
  entity_id       uuid,
  client_id       uuid REFERENCES sync.clients(id) ON DELETE SET NULL,
  op_uuid         uuid,
  resolution      text NOT NULL CHECK (resolution IN
                    ('serveur_gagne','terminal_gagne','fusion','reporte','manuel')),
  field_diffs     jsonb NOT NULL DEFAULT '[]'::jsonb,
  server_value    jsonb,
  client_value    jsonb,
  resolved_value  jsonb,
  resolved_by_name text,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

CREATE INDEX conflicts_school_idx ON sync.conflicts (school_id, detected_at DESC);
CREATE INDEX conflicts_open_idx   ON sync.conflicts (school_id)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- Journal de changement : permet au terminal de tirer uniquement le delta
-- ---------------------------------------------------------------------------
CREATE TABLE sync.change_log (
  seq          bigserial PRIMARY KEY,
  school_id    uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  operation    text NOT NULL CHECK (operation IN ('insert','update','delete')),
  row_version  integer,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  changed_by_name text,
  device_id    text,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX change_log_school_seq ON sync.change_log (school_id, seq);
CREATE INDEX change_log_entity_idx ON sync.change_log (entity_type, entity_id, seq DESC);

-- ---------------------------------------------------------------------------
-- Purge des données anciennes (appelée par une tâche planifiée)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync.purge_old(p_keep_days integer DEFAULT 90)
RETURNS TABLE(table_name text, deleted bigint)
LANGUAGE plpgsql AS $$
DECLARE
  v_cut  timestamptz := now() - make_interval(days => p_keep_days);
  v_n    bigint;
BEGIN
  DELETE FROM sync.change_log WHERE changed_at < v_cut;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  table_name := 'sync.change_log'; deleted := v_n; RETURN NEXT;

  DELETE FROM sync.operations
   WHERE status IN ('applied','rejected') AND created_at < v_cut;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  table_name := 'sync.operations'; deleted := v_n; RETURN NEXT;

  DELETE FROM sync.batches WHERE received_at < v_cut;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  table_name := 'sync.batches'; deleted := v_n; RETURN NEXT;

  DELETE FROM sec.login_attempts WHERE created_at < now() - interval '180 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  table_name := 'sec.login_attempts'; deleted := v_n; RETURN NEXT;

  DELETE FROM sec.rate_limit_counters WHERE window_start < now() - interval '2 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  table_name := 'sec.rate_limit_counters'; deleted := v_n; RETURN NEXT;

  DELETE FROM sec.sessions
   WHERE (expires_at < now() OR revoked_at IS NOT NULL)
     AND last_used_at < v_cut;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  table_name := 'sec.sessions'; deleted := v_n; RETURN NEXT;

  UPDATE sec.lockouts SET released_at = now()
   WHERE released_at IS NULL AND locked_until < now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  table_name := 'sec.lockouts'; deleted := v_n; RETURN NEXT;
END $$;

COMMIT;
