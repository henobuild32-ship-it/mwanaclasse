-- ============================================================================
--  MWANA CLASSE — 007 — Corrections détectées à l'exécution de l'API
-- ============================================================================
--  Deux écarts entre le schéma et le code applicatif ont été détectés sur une
--  base réellement alimentée (connexion école / connexion parent) :
--
--  1. sec.parent_credentials ne possédait pas la colonne totp_last_used_step
--     (anti-rejeu du code TOTP), alors que sec.staff_users l'avait. L'API
--     lit et écrit cette colonne lors de chaque vérification d'identité.
--
--  2. sec.register_login_attempt déclare ses résultats en RETURNS TABLE
--     (locked, locked_until, failures, wait_seconds) : ces noms sont donc
--     visibles dans le corps plpgsql. Toute référence NON QUALIFIÉE à
--     « locked_until » sur sec.lockouts devenait ambiguë (SQLSTATE 42702) et
--     la connexion échouait dès le premier succès. Les références sont donc
--     explicitement qualifiées ci-dessous.
--
--  Bonnes pratiques : ce fichier ne modifie PAS 003 (migration déjà appliquée,
--  empreinte verrouillée) ; il se contente de corriger l'état courant.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Colonne anti-rejeu TOTP manquante
-- ---------------------------------------------------------------------------
ALTER TABLE sec.parent_credentials
  ADD COLUMN IF NOT EXISTS totp_last_used_step bigint;

COMMENT ON COLUMN sec.parent_credentials.totp_last_used_step IS
  'Dernier pas (step) TOTP déjà consommé : interdit le rejeu d''un code valide';

-- ---------------------------------------------------------------------------
-- 2. sec.register_login_attempt — références qualifiées
-- ---------------------------------------------------------------------------
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

    -- « locked_until » est qualifié : il désigne la COLONNE de sec.lockouts,
    -- pas la colonne de sortie de cette fonction.
    UPDATE sec.lockouts SET released_at = now()
     WHERE released_at IS NULL AND sec.lockouts.locked_until < now()
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

COMMENT ON FUNCTION sec.register_login_attempt(text, text, uuid, uuid, uuid, boolean, text, inet, text, text) IS
  'Enregistre une tentative de connexion et applique la politique de verrouillage (5/8/12/20 échecs)';

COMMIT;
