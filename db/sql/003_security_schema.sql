-- ============================================================================
--  MWANA CLASSE — 003 — Sécurité, comptes, sessions, 2FA, audit chaîné
--  Chiffrement AES-256-GCM · hachage + pepper · anti-bruteforce · journal signé
-- ============================================================================

BEGIN;

-- ===========================================================================
--  A. RÔLES ET PERMISSIONS (catalogue en base, appliqué côté serveur)
-- ===========================================================================

CREATE TABLE ref.permissions (
  code        text PRIMARY KEY,
  module      text NOT NULL,
  label       text NOT NULL,
  description text,
  is_dangerous boolean NOT NULL DEFAULT false,
  CONSTRAINT perm_code_fmt CHECK (code ~ '^[a-z_]+\.[a-z_]+$')
);

CREATE TABLE sec.staff_users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  email               citext NOT NULL,
  username            citext,
  full_name           text NOT NULL,
  job_title           text,                         -- 'Directeur', 'Secrétaire'…
  phone               text,
  -- Authentification : Argon2id/bcrypt + pepper serveur (jamais en clair)
  password_hash       text NOT NULL,
  password_algo       text NOT NULL DEFAULT 'argon2id',
  password_pepper_id  text NOT NULL DEFAULT 'v1',
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  must_change_password boolean NOT NULL DEFAULT false,
  password_history    text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- 2FA TOTP
  totp_secret_enc     bytea,                        -- secret chiffré AES-256-GCM
  totp_enabled        boolean NOT NULL DEFAULT false,
  totp_confirmed_at   timestamptz,
  totp_last_used_step bigint,
  -- Verrouillage temporaire
  failed_attempts     integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_failed_at      timestamptz,
  last_login_at       timestamptz,
  last_login_ip       inet,
  -- Cycle de vie
  is_active           boolean NOT NULL DEFAULT true,
  is_owner            boolean NOT NULL DEFAULT false,
  disabled_reason     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1,
  CONSTRAINT staff_name_len  CHECK (char_length(btrim(full_name)) BETWEEN 2 AND 160),
  CONSTRAINT staff_email_ok  CHECK (app.is_valid_email(email)),
  CONSTRAINT staff_email_uni UNIQUE (school_id, email),
  CONSTRAINT staff_user_uni  UNIQUE (school_id, username)
);

COMMENT ON TABLE  sec.staff_users IS 'Comptes administratifs d''une école (directeur, secrétaire, responsable présence…)';
COMMENT ON COLUMN sec.staff_users.password_hash IS 'Hachage Argon2id du mot de passe combiné au pepper serveur — jamais de mot de passe en clair';
COMMENT ON COLUMN sec.staff_users.totp_secret_enc IS 'Secret TOTP chiffré AES-256-GCM au repos';

CREATE INDEX staff_school_idx ON sec.staff_users (school_id, is_active);
CREATE INDEX staff_email_idx  ON sec.staff_users (email);
CREATE INDEX staff_locked_idx ON sec.staff_users (locked_until) WHERE locked_until IS NOT NULL;

CREATE TABLE sec.roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid REFERENCES app.schools(id) ON DELETE CASCADE,   -- NULL = rôle système
  code        text NOT NULL,
  name        text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_code_fmt CHECK (code ~ '^[a-z_]+$'),
  CONSTRAINT roles_unique   UNIQUE (school_id, code)
);

CREATE UNIQUE INDEX roles_system_unique ON sec.roles (code) WHERE school_id IS NULL;

CREATE TABLE sec.role_permissions (
  role_id         uuid NOT NULL REFERENCES sec.roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES ref.permissions(code) ON DELETE CASCADE,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE sec.staff_roles (
  staff_user_id uuid NOT NULL REFERENCES sec.staff_users(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES sec.roles(id) ON DELETE CASCADE,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  assigned_by   uuid REFERENCES sec.staff_users(id) ON DELETE SET NULL,
  PRIMARY KEY (staff_user_id, role_id)
);

-- Permissions additionnelles / retirées au niveau d'un utilisateur
CREATE TABLE sec.staff_permission_overrides (
  staff_user_id   uuid NOT NULL REFERENCES sec.staff_users(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES ref.permissions(code) ON DELETE CASCADE,
  allowed         boolean NOT NULL,
  reason          text,
  PRIMARY KEY (staff_user_id, permission_code)
);

-- ---------------------------------------------------------------------------
--  Résolution effective des permissions d'un utilisateur (rôles + overrides)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sec.effective_permissions(p_staff uuid)
RETURNS TABLE(permission_code text)
LANGUAGE sql STABLE AS $$
  WITH via_roles AS (
    SELECT DISTINCT rp.permission_code
    FROM sec.staff_roles sr
    JOIN sec.role_permissions rp ON rp.role_id = sr.role_id
    WHERE sr.staff_user_id = p_staff
  ),
  o AS (
    SELECT permission_code, allowed
    FROM sec.staff_permission_overrides
    WHERE staff_user_id = p_staff
  )
  SELECT DISTINCT v.permission_code
  FROM via_roles v
  LEFT JOIN o ON o.permission_code = v.permission_code
  WHERE coalesce(o.allowed, true)
  UNION
  SELECT o.permission_code FROM o WHERE o.allowed
$$;

CREATE OR REPLACE FUNCTION sec.has_permission(p_staff uuid, p_permission text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM sec.effective_permissions(p_staff) p
                 WHERE p.permission_code = p_permission)
$$;

-- Permission « joker » : propriétaire = accès total
CREATE OR REPLACE FUNCTION sec.is_owner(p_staff uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT is_owner FROM sec.staff_users WHERE id = p_staff), false)
$$;

CREATE OR REPLACE FUNCTION sec.can(p_staff uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT sec.is_owner(p_staff) OR sec.has_permission(p_staff, p_permission)
$$;

-- ===========================================================================
--  A bis. IDENTIFIANTS DES COMPTES PARENTS
--  Le profil public vit dans app.parents ; les éléments d'authentification
--  sont isolés ici, dans le schéma de sécurité : une requête métier ne peut
--  donc pas exposer accidentellement un hachage de mot de passe.
-- ===========================================================================

CREATE TABLE sec.parent_credentials (
  parent_id           uuid PRIMARY KEY REFERENCES app.parents(id) ON DELETE CASCADE,
  password_hash       text NOT NULL,
  password_algo       text NOT NULL DEFAULT 'argon2id',
  password_pepper_id  text NOT NULL DEFAULT 'v1',
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  must_change_password boolean NOT NULL DEFAULT false,
  password_history    text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- 2FA facultative pour les parents (recommandée, non imposée)
  totp_secret_enc     bytea,
  totp_enabled        boolean NOT NULL DEFAULT false,
  totp_confirmed_at   timestamptz,
  -- Verrouillage temporaire
  failed_attempts     integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_failed_at      timestamptz,
  last_login_at       timestamptz,
  last_login_ip       inet,
  -- Consentement RGPD explicite et horodaté
  terms_accepted_at   timestamptz,
  privacy_accepted_at timestamptz,
  marketing_opt_in    boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE sec.parent_credentials IS
  'Identifiants des comptes parents, isolés du profil public ; hachage + pepper, jamais de mot de passe en clair';

CREATE INDEX parent_creds_locked_idx ON sec.parent_credentials (locked_until)
  WHERE locked_until IS NOT NULL;

CREATE TRIGGER parent_creds_touch BEFORE UPDATE ON sec.parent_credentials
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

-- ===========================================================================
--  B. SESSIONS ET JETONS
-- ===========================================================================

CREATE TABLE sec.sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience          text NOT NULL CHECK (audience IN ('parent','ecole')),
  parent_id         uuid REFERENCES app.parents(id) ON DELETE CASCADE,
  staff_user_id     uuid REFERENCES sec.staff_users(id) ON DELETE CASCADE,
  school_id         uuid REFERENCES app.schools(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,          -- SHA-256 du jeton (jamais en clair)
  token_family      uuid NOT NULL DEFAULT gen_random_uuid(),
  ip                inet,
  user_agent        text,
  device_id         text,
  device_label      text,
  mfa_satisfied     boolean NOT NULL DEFAULT false,
  mfa_method        text CHECK (mfa_method IN ('totp','sms','recovery','none')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at        timestamptz,
  revoked_reason    text,
  CONSTRAINT session_owner CHECK (
    (audience = 'parent' AND parent_id IS NOT NULL AND staff_user_id IS NULL)
    OR (audience = 'ecole' AND staff_user_id IS NOT NULL AND parent_id IS NULL))
);

CREATE INDEX sessions_parent_idx  ON sec.sessions (parent_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_staff_idx   ON sec.sessions (staff_user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family_idx  ON sec.sessions (token_family);
CREATE INDEX sessions_expiry_idx  ON sec.sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE sec.one_time_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose       text NOT NULL CHECK (purpose IN
                  ('verif_email','verif_phone','reset_password','invitation_staff','2fa_sms')),
  audience      text NOT NULL CHECK (audience IN ('parent','ecole')),
  parent_id     uuid REFERENCES app.parents(id) ON DELETE CASCADE,
  staff_user_id uuid REFERENCES sec.staff_users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  ip            inet,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ott_lookup_idx ON sec.one_time_tokens (token_hash) WHERE consumed_at IS NULL;

-- Codes de secours 2FA (hachés, usage unique)
CREATE TABLE sec.recovery_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id uuid NOT NULL REFERENCES sec.staff_users(id) ON DELETE CASCADE,
  code_hash     text NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recovery_unique UNIQUE (staff_user_id, code_hash)
);

-- ===========================================================================
--  C. ANTI-BRUTEFORCE : limitation de débit et verrouillage progressif
-- ===========================================================================

CREATE TABLE sec.login_attempts (
  id            bigserial PRIMARY KEY,
  audience      text NOT NULL CHECK (audience IN ('parent','ecole')),
  identifier    citext,                       -- e-mail / identifiant tenté
  identifier_key text,                        -- clé normalisée (jamais de secret en clair)
  parent_id     uuid REFERENCES app.parents(id) ON DELETE SET NULL,
  staff_user_id uuid REFERENCES sec.staff_users(id) ON DELETE SET NULL,
  school_id     uuid REFERENCES app.schools(id) ON DELETE SET NULL,
  success       boolean NOT NULL,
  failure_reason text CHECK (failure_reason IN
                  ('mot_de_passe','utilisateur_inconnu','compte_desactive',
                   'compte_verrouille','2fa_invalide','2fa_requis','token_invalide','ok')),
  ip            inet,
  country       text,
  user_agent    text,
  device_fingerprint text,
  risk_score    smallint NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX la_identifier_idx ON sec.login_attempts (identifier_key, created_at DESC);
CREATE INDEX la_ip_idx         ON sec.login_attempts (ip, created_at DESC);
CREATE INDEX la_fail_idx       ON sec.login_attempts (success, created_at DESC)
  WHERE success = false;
CREATE INDEX la_parent_idx     ON sec.login_attempts (parent_id, created_at DESC);

-- Compteurs glissants (fenêtre 15 min / 1 h / 24 h) par clé et par IP
CREATE TABLE sec.rate_limit_counters (
  bucket       text NOT NULL,                 -- 'login','code_lookup','api','2fa','otp'
  subject_kind text NOT NULL CHECK (subject_kind IN ('ip','identifier','parent','staff','school','device')),
  subject_key  text NOT NULL,
  window_start timestamptz NOT NULL,
  window_seconds integer NOT NULL,
  hits         integer NOT NULL DEFAULT 0,
  blocked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, subject_kind, subject_key, window_start, window_seconds)
);

CREATE INDEX rlc_blocked_idx ON sec.rate_limit_counters (blocked_until)
  WHERE blocked_until IS NOT NULL;

-- Verrouillages explicites (compte, IP, appareil)
CREATE TABLE sec.lockouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope        text NOT NULL CHECK (scope IN ('compte','ip','appareil','ecole')),
  subject_key  text NOT NULL,
  reason       text NOT NULL,
  failed_count integer NOT NULL DEFAULT 0,
  locked_at    timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz NOT NULL,
  released_at  timestamptz,
  released_by_name text,
  UNIQUE (scope, subject_key, locked_until)
);

CREATE INDEX lockouts_active_idx ON sec.lockouts (scope, subject_key)
  WHERE released_at IS NULL;

-- Fonction d'enregistrement d'une tentative + calcul du verrouillage
-- Politique : 5 échecs -> 1 min, 8 -> 5 min, 12 -> 30 min, 20 -> 24 h
CREATE OR REPLACE FUNCTION sec.register_login_attempt(
  p_audience     text,
  p_identifier   text,
  p_parent_id    uuid,
  p_staff_id     uuid,
  p_school_id    uuid,
  p_success      boolean,
  p_reason       text,
  p_ip           inet,
  p_user_agent   text,
  p_fingerprint  text
) RETURNS TABLE(locked boolean, locked_until timestamptz, failures integer, wait_seconds integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_key      text;
  v_failures integer;
  v_lock     timestamptz;
  v_seconds  integer;
BEGIN
  v_key := app.search_key(coalesce(p_identifier, '')) || '|' || coalesce(p_ip::text, '0.0.0.0');

  INSERT INTO sec.login_attempts(
    audience, identifier, identifier_key, parent_id, staff_user_id, school_id,
    success, failure_reason, ip, user_agent, device_fingerprint)
  VALUES (p_audience, p_identifier, v_key, p_parent_id, p_staff_id, p_school_id,
    p_success, p_reason, p_ip, p_user_agent, p_fingerprint);

  IF p_success THEN
    -- Succès : on efface les compteurs d'échec
    UPDATE sec.staff_users
       SET failed_attempts = 0, locked_until = NULL, last_failed_at = NULL
     WHERE id = p_staff_id;

    UPDATE sec.lockouts SET released_at = now()
     WHERE released_at IS NULL AND locked_until < now()
       AND scope = 'compte' AND subject_key = v_key;

    RETURN QUERY SELECT false, NULL::timestamptz, 0, 0;
    RETURN;
  END IF;

  -- Nombre d'échecs sur les 24 dernières heures
  SELECT count(*)::int INTO v_failures
  FROM sec.login_attempts
  WHERE success = false AND identifier_key = v_key
    AND created_at > now() - interval '24 hours';

  IF p_staff_id IS NOT NULL THEN
    UPDATE sec.staff_users
       SET failed_attempts = v_failures, last_failed_at = now()
     WHERE id = p_staff_id;
  END IF;

  v_seconds := CASE
    WHEN v_failures >= 20 THEN 86400
    WHEN v_failures >= 12 THEN 1800
    WHEN v_failures >= 8  THEN 300
    WHEN v_failures >= 5  THEN 60
    ELSE 0 END;

  IF v_seconds > 0 THEN
    v_lock := now() + make_interval(secs => v_seconds);

    INSERT INTO sec.lockouts(scope, subject_key, reason, failed_count, locked_until)
    VALUES (CASE WHEN p_staff_id IS NOT NULL THEN 'compte' ELSE 'ip' END,
            v_key, 'Echecs de connexion repetes', v_failures, v_lock)
    ON CONFLICT (scope, subject_key, locked_until) DO NOTHING;

    IF p_staff_id IS NOT NULL THEN
      UPDATE sec.staff_users SET locked_until = v_lock WHERE id = p_staff_id;
    END IF;
  END IF;

  RETURN QUERY SELECT v_seconds > 0, v_lock, v_failures, v_seconds;
END $$;

-- Vérifie si un sujet est actuellement bloqué
CREATE OR REPLACE FUNCTION sec.is_locked_out(
  p_scope text, p_key text, OUT locked boolean, OUT until timestamptz
)
LANGUAGE sql STABLE AS $$
  SELECT true, max(locked_until)
  FROM sec.lockouts
  WHERE scope = p_scope AND subject_key = p_key
    AND released_at IS NULL AND locked_until > now()
  HAVING count(*) > 0
$$;

-- Consommation d'un quota générique (rate limiting applicatif)
CREATE OR REPLACE FUNCTION sec.consume_quota(
  p_bucket       text,
  p_subject_kind text,
  p_subject_key  text,
  p_limit        integer,
  p_window_secs  integer DEFAULT 60,
  p_block_secs   integer DEFAULT 60
) RETURNS TABLE(allowed boolean, remaining integer, retry_after integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_start timestamptz;
  v_hits  integer;
  v_block timestamptz;
BEGIN
  v_start := to_timestamp(
    floor(extract(epoch FROM now()) / p_window_secs) * p_window_secs);

  INSERT INTO sec.rate_limit_counters(
    bucket, subject_kind, subject_key, window_start, window_seconds, hits)
  VALUES (p_bucket, p_subject_kind, p_subject_key, v_start, p_window_secs, 1)
  ON CONFLICT (bucket, subject_kind, subject_key, window_start, window_seconds)
  DO UPDATE SET hits = sec.rate_limit_counters.hits + 1, updated_at = now()
  RETURNING hits, blocked_until INTO v_hits, v_block;

  IF v_block IS NOT NULL AND v_block > now() THEN
    RETURN QUERY SELECT false, 0, ceil(extract(epoch FROM (v_block - now())))::int;
    RETURN;
  END IF;

  IF v_hits > p_limit THEN
    v_block := now() + make_interval(secs => p_block_secs);
    UPDATE sec.rate_limit_counters
       SET blocked_until = v_block
     WHERE bucket = p_bucket AND subject_kind = p_subject_kind
       AND subject_key = p_subject_key AND window_start = v_start
       AND window_seconds = p_window_secs;
    RETURN QUERY SELECT false, 0, p_block_secs;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, greatest(0, p_limit - v_hits), 0;
END $$;

-- ===========================================================================
--  D. JOURNAL D'AUDIT INVIOLABLE (chaînage + signature HMAC)
-- ===========================================================================

CREATE TABLE sec.audit_log (
  id             bigserial PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  school_id      uuid,
  actor_kind     text NOT NULL CHECK (actor_kind IN
                   ('parent','staff','systeme','api','integration','anonyme')),
  actor_id       uuid,
  actor_label    text,
  actor_ip       inet,
  actor_device   text,
  action         text NOT NULL,             -- 'student.create', 'attendance.update'…
  entity_type    text,
  entity_id      uuid,
  entity_label   text,
  severity       text NOT NULL DEFAULT 'info'
                   CHECK (severity IN ('debug','info','notice','warning','error','critique')),
  result         text NOT NULL DEFAULT 'succes'
                   CHECK (result IN ('succes','echec','refuse','erreur')),
  -- Charge utile chiffrée AES-256-GCM (aucune donnée sensible en clair)
  payload_enc    bytea,
  payload_hash   text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Chaînage cryptographique
  prev_hash      text,
  entry_hash     text NOT NULL,
  signature      text,                       -- HMAC-SHA256 clé serveur (pepper audit)
  key_id         text NOT NULL DEFAULT 'audit-v1'
);

COMMENT ON TABLE  sec.audit_log IS 'Journal d''audit en ajout seul : chaque entrée chaîne la précédente (prev_hash/entry_hash) et porte une signature HMAC';
COMMENT ON COLUMN sec.audit_log.payload_enc IS 'Détail chiffré AES-256-GCM : le contenu reste confidentiel même en cas de fuite de la base';

CREATE INDEX audit_school_time_idx ON sec.audit_log (school_id, occurred_at DESC);
CREATE INDEX audit_actor_idx       ON sec.audit_log (actor_kind, actor_id, occurred_at DESC);
CREATE INDEX audit_action_idx      ON sec.audit_log (action, occurred_at DESC);
CREATE INDEX audit_entity_idx      ON sec.audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_severity_idx    ON sec.audit_log (severity, occurred_at DESC)
  WHERE severity IN ('warning','error','critique');
CREATE INDEX audit_ip_idx          ON sec.audit_log (actor_ip, occurred_at DESC);

-- Chaînage automatique : chaque insertion reprend le hash de la dernière entrée
CREATE OR REPLACE FUNCTION sec.tg_audit_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prev text;
  v_canon text;
BEGIN
  SELECT entry_hash INTO v_prev
  FROM sec.audit_log
  ORDER BY id DESC
  LIMIT 1;

  NEW.prev_hash := v_prev;

  v_canon := concat_ws('|',
    coalesce(v_prev, 'GENESE'),
    NEW.occurred_at::text,
    coalesce(NEW.school_id::text, ''),
    NEW.actor_kind,
    coalesce(NEW.actor_id::text, ''),
    coalesce(NEW.actor_ip::text, ''),
    NEW.action,
    coalesce(NEW.entity_type, ''),
    coalesce(NEW.entity_id::text, ''),
    NEW.severity,
    NEW.result,
    coalesce(NEW.payload_hash, ''));

  NEW.entry_hash := encode(digest(v_canon, 'sha256'), 'hex');
  RETURN NEW;
END $$;

CREATE TRIGGER audit_chain_trg
  BEFORE INSERT ON sec.audit_log
  FOR EACH ROW EXECUTE FUNCTION sec.tg_audit_chain();

-- Le journal est en ajout seul : aucune modification ni suppression tolérée
CREATE OR REPLACE FUNCTION sec.tg_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Le journal d''audit est en ajout seul : modification interdite (entrée %)', OLD.id
    USING ERRCODE = '42501';
END $$;

CREATE TRIGGER audit_no_update
  BEFORE UPDATE OR DELETE ON sec.audit_log
  FOR EACH ROW EXECUTE FUNCTION sec.tg_audit_immutable();

-- Vérification d'intégrité de la chaîne complète
CREATE OR REPLACE FUNCTION sec.verify_audit_chain(
  p_from_id bigint DEFAULT 0,
  OUT total bigint,
  OUT broken bigint,
  OUT first_broken_id bigint
)
LANGUAGE plpgsql AS $$
DECLARE
  r        record;
  v_prev   text := NULL;
  v_canon  text;
  v_hash   text;
BEGIN
  total := 0; broken := 0; first_broken_id := NULL;

  FOR r IN SELECT * FROM sec.audit_log WHERE id > p_from_id ORDER BY id LOOP
    total := total + 1;

    v_canon := concat_ws('|',
      coalesce(v_prev, 'GENESE'),
      r.occurred_at::text,
      coalesce(r.school_id::text, ''),
      r.actor_kind,
      coalesce(r.actor_id::text, ''),
      coalesce(r.actor_ip::text, ''),
      r.action,
      coalesce(r.entity_type, ''),
      coalesce(r.entity_id::text, ''),
      r.severity,
      r.result,
      coalesce(r.payload_hash, ''));

    v_hash := encode(digest(v_canon, 'sha256'), 'hex');

    IF v_hash <> r.entry_hash
       OR (r.prev_hash IS DISTINCT FROM v_prev) THEN
      broken := broken + 1;
      IF first_broken_id IS NULL THEN first_broken_id := r.id; END IF;
    END IF;

    v_prev := r.entry_hash;
  END LOOP;
END $$;

-- ===========================================================================
--  E. GESTION DES CLÉS DE CHIFFREMENT (référence ; les clés vivent dans un
--     gestionnaire de secrets — ici seule l'empreinte est stockée)
-- ===========================================================================

CREATE TABLE sec.encryption_keys (
  key_id        text PRIMARY KEY,
  purpose       text NOT NULL CHECK (purpose IN
                  ('donnees','jetons','audit','pepper','totp','documents','transport')),
  algorithm     text NOT NULL DEFAULT 'aes-256-gcm',
  key_fingerprint text NOT NULL,          -- SHA-256 tronqué de la clé (jamais la clé)
  provider      text NOT NULL DEFAULT 'env'
                  CHECK (provider IN ('env','vault','aws_kms','azure_keyvault','gcp_kms','hsm','file')),
  provider_ref  text,                     -- chemin/ARN dans le gestionnaire de secrets
  rotated_from  text REFERENCES sec.encryption_keys(key_id),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  activated_at  timestamptz,
  retired_at    timestamptz,
  rotate_after_days integer NOT NULL DEFAULT 90
);

CREATE INDEX enc_keys_purpose_idx ON sec.encryption_keys (purpose, is_active);

-- Actions sensibles nécessitant une trace explicite
CREATE TABLE ref.sensitive_actions (
  action        text PRIMARY KEY,
  label         text NOT NULL,
  severity      text NOT NULL DEFAULT 'notice'
                  CHECK (severity IN ('info','notice','warning','error','critique')),
  requires_reason boolean NOT NULL DEFAULT false
);

-- ===========================================================================
--  F. SURVEILLANCE / DÉTECTION D'ANOMALIES
-- ===========================================================================

CREATE TABLE sec.security_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid REFERENCES app.schools(id) ON DELETE CASCADE,
  rule_code    text NOT NULL,        -- 'bruteforce','acces_hors_horaire','fuite_donnees'…
  severity     text NOT NULL CHECK (severity IN ('info','attention','grave','critique')),
  title        text NOT NULL,
  detail       text,
  subject_kind text CHECK (subject_kind IN ('ip','parent','staff','school','device')),
  subject_key  text,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurrences  integer NOT NULL DEFAULT 1,
  status       text NOT NULL DEFAULT 'ouverte'
                 CHECK (status IN ('ouverte','en_cours','traitee','ignoree','faux_positif')),
  handled_by_name text,
  handled_at   timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX alerts_open_idx ON sec.security_alerts (status, severity, last_seen_at DESC);
CREATE INDEX alerts_school_idx ON sec.security_alerts (school_id, status, last_seen_at DESC);

-- ---------------------------------------------------------------------------
--  Règles de détection exécutables par tâche planifiée (cron / pg_cron)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sec.detect_anomalies(p_window_minutes int DEFAULT 15)
RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_inserted integer := 0;
  r record;
BEGIN
  -- Règle 1 : force brute — plus de 10 échecs depuis une même IP
  FOR r IN
    SELECT ip, count(*) AS n, count(DISTINCT identifier_key) AS cibles, min(school_id) AS school_id
    FROM sec.login_attempts
    WHERE success = false AND created_at > now() - make_interval(mins => p_window_minutes)
      AND ip IS NOT NULL
    GROUP BY ip
    HAVING count(*) >= 10
  LOOP
    INSERT INTO sec.security_alerts(school_id, rule_code, severity, title, detail,
                                    subject_kind, subject_key, evidence)
    VALUES (r.school_id, 'bruteforce_ip', 'grave',
      'Tentatives de connexion massives depuis une même adresse',
      format('%s échecs en %s minutes sur %s comptes distincts', r.n, p_window_minutes, r.cibles),
      'ip', r.ip::text,
      jsonb_build_object('echecs', r.n, 'comptes_cibles', r.cibles, 'fenetre_minutes', p_window_minutes));
    v_inserted := v_inserted + 1;
  END LOOP;

  -- Règle 2 : bourrage d'identifiants — un même identifiant attaqué depuis plusieurs IP
  FOR r IN
    SELECT identifier_key, count(DISTINCT ip) AS ips, count(*) AS n
    FROM sec.login_attempts
    WHERE success = false AND created_at > now() - make_interval(mins => p_window_minutes)
      AND identifier_key IS NOT NULL
    GROUP BY identifier_key
    HAVING count(DISTINCT ip) >= 5
  LOOP
    INSERT INTO sec.security_alerts(rule_code, severity, title, detail,
                                    subject_kind, subject_key, evidence)
    VALUES ('bourrage_identifiants', 'critique',
      'Bourrage d''identifiants détecté',
      format('Un même identifiant ciblé depuis %s adresses différentes', r.ips),
      'identifier', r.identifier_key,
      jsonb_build_object('adresses_distinctes', r.ips, 'tentatives', r.n));
    v_inserted := v_inserted + 1;
  END LOOP;

  -- Règle 3 : consultation massive de codes élèves (énumération)
  FOR r IN
    SELECT actor_ip, count(*) AS n
    FROM sec.audit_log
    WHERE action = 'student.code_lookup' AND result = 'echec'
      AND occurred_at > now() - make_interval(mins => p_window_minutes)
      AND actor_ip IS NOT NULL
    GROUP BY actor_ip
    HAVING count(*) >= 15
  LOOP
    INSERT INTO sec.security_alerts(rule_code, severity, title, detail,
                                    subject_kind, subject_key, evidence)
    VALUES ('enumeration_codes', 'grave',
      'Énumération de codes élèves suspectée',
      format('%s recherches de code infructueuses depuis une même adresse', r.n),
      'ip', r.actor_ip::text,
      jsonb_build_object('recherches', r.n));
    v_inserted := v_inserted + 1;
  END LOOP;

  -- Règle 4 : accès à des données sensibles hors horaires scolaires
  FOR r IN
    SELECT actor_id, actor_label, count(*) AS n, max(occurred_at) AS dernier
    FROM sec.audit_log
    WHERE severity IN ('warning','critique')
      AND actor_kind = 'staff'
      AND occurred_at > now() - interval '24 hours'
      AND (extract(hour FROM occurred_at) < 5 OR extract(hour FROM occurred_at) > 21)
    GROUP BY actor_id, actor_label
    HAVING count(*) >= 5
  LOOP
    INSERT INTO sec.security_alerts(rule_code, severity, title, detail,
                                    subject_kind, subject_key, evidence)
    VALUES ('acces_hors_horaires', 'attention',
      'Accès sensibles en dehors des horaires habituels',
      format('%s actions sensibles pour %s', r.n, coalesce(r.actor_label, 'un compte')),
      'staff', r.actor_id::text,
      jsonb_build_object('actions', r.n, 'dernier_acces', r.dernier));
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN v_inserted;
END $$;

-- ===========================================================================
--  G. TRIGGERS ET CONTRAINTES DIFFÉRÉES
-- ===========================================================================

CREATE TRIGGER staff_touch BEFORE UPDATE ON sec.staff_users
  FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at();

-- Les colonnes d'approbation pointent vers sec.staff_users, table créée après
-- app.parent_student_links : la contrainte est ajoutée ici.
ALTER TABLE app.parent_student_links
  ADD CONSTRAINT links_decided_by_fk
  FOREIGN KEY (decided_by) REFERENCES sec.staff_users(id) ON DELETE SET NULL;

-- Un compte parent ou personnel ne peut pas voir les données d'une autre école :
-- la contrainte est appliquée par les politiques de 004_rls.sql et par l'API.

COMMIT;
