-- ============================================================================
--  MWANA CLASSE — 013 — Verrouillage progressif assoupli
-- ============================================================================
--  Objectif : le produit vise des milliers de connexions et d'inscriptions
--  par jour. Les paliers d'origine (5/8/12/20 échecs → 1 min/5 min/30 min/
--  24 H) verrouillaient un compte partagé par tout un établissement dès la
--  cinquième saisie erronée, et le dernier palier interdisait l'accès pendant
--  24 heures : « ça refuse trop de connexions ».
--
--  Nouveaux paliers (toujours sur une fenêtre glissante de 24 h) :
--
--       10 échecs → 1 minute
--       20 échecs → 5 minutes
--       40 échecs → 30 minutes
--       80 échecs → 1 heure   (au maximum : jamais 24 h)
--
--  L'anti-force-brute reste efficace : 80 échecs en 24 h correspondent à
--  ~1 essai toutes les 18 minutes pour un moteur automatisé, et la limitation
--  de débit par identifiant (sec.consume_quota, quota « login ») protège déjà
--  contre les rafales.
--
--  Comme 007 et 012, ce fichier recrée la fonction dans son état corrigé sans
--  modifier les migrations déjà appliquées, et conserve la cible d'« ON
--  CONFLICT » désignée par sa contrainte (voir 012) : aucun identifiant ne
--  peut entrer en collision avec les variables de sortie de la fonction.
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
    WHEN v_failures >= 80 THEN 3600
    WHEN v_failures >= 40 THEN 1800
    WHEN v_failures >= 20 THEN 300
    WHEN v_failures >= 10 THEN 60
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
  'Enregistre une tentative de connexion et applique la politique de verrouillage (10/20/40/80 échecs, maximum 1 heure)';

COMMIT;
