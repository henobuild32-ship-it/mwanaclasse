-- ============================================================================
--  MWANA CLASSE — 012 — Verrouillage : « ON CONFLICT » non ambigu
-- ============================================================================
--  Symptôme en production (POST /api/auth/ecole/connexion → 500 ERREUR_BASE) :
--
--    SQLSTATE 42702  column reference "locked_until" is ambiguous
--    (It could refer to either a PL/pgSQL variable or a table column.)
--
--  sec.register_login_attempt déclare ses résultats en RETURNS TABLE
--  (locked, locked_until, failures, wait_seconds) : ces noms sont donc des
--  variables plpgsql visibles dans tout le corps. La clause
--
--      ON CONFLICT (scope, subject_key, locked_until) DO NOTHING
--
--  référence « locked_until » sans qualification : PostgreSQL ne peut plus
--  décider entre la COLONNE de sec.lockouts et la VARIABLE de sortie, et
--  renvoie 42702. 007 avait qualifié la branche « succès »
--  (sec.lockouts.locked_until) mais avait oublié la cible de ce ON CONFLICT.
--
--  Conséquence observée : le plantage n'a lieu QUE lorsque le palier de
--  verrouillage est atteint (5 échecs en 24 h → v_seconds > 0). En dessous,
--  la fonction renvoie correctement 401 ; au-delà, CHAQUE tentative échoue en
--  500 — ce qui donne l'impression que « ça ne passe plus jamais ».
--
--  Correction : la cible est désignée par sa contrainte (nom stable
--  lockouts_scope_subject_key_locked_until_key), qui ne contient aucun
--  identifiant pouvant entrer en collision avec une variable plpgsql.
--  Le comportement est strictement identique : seules les doublons de
--  (scope, subject_key, locked_until) sont ignorés.
--
--  Comme 007, ce fichier ne modifie PAS 003 ni 007 (migrations déjà appliquées
--  sur l'état courant) : il recrée la fonction dans son état corrigé.
-- ============================================================================

BEGIN;

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

    -- « locked_until » qualifié : COLONNE de sec.lockouts, pas la variable.
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

    -- Cible désignée par la contrainte : aucun identifiant à résoudre, donc
    -- aucune ambiguïté possible avec les colonnes de sortie de la fonction.
    INSERT INTO sec.lockouts(scope, subject_key, reason, failed_count, locked_until)
    VALUES (CASE WHEN p_staff_id IS NOT NULL THEN 'compte' ELSE 'ip' END,
            v_key, 'Echecs de connexion repetes', v_failures, v_lock)
    ON CONFLICT ON CONSTRAINT lockouts_scope_subject_key_locked_until_key DO NOTHING;

    IF p_staff_id IS NOT NULL THEN
      UPDATE sec.staff_users SET locked_until = v_lock WHERE id = p_staff_id;
    END IF;
  END IF;

  RETURN QUERY SELECT v_seconds > 0, v_lock, v_failures, v_seconds;
END $$;

COMMENT ON FUNCTION sec.register_login_attempt(text, text, uuid, uuid, uuid, boolean, text, inet, text, text) IS
  'Enregistre une tentative de connexion et applique la politique de verrouillage (5/8/12/20 échecs)';

COMMIT;
