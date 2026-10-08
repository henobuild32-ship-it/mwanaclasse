-- ============================================================================
--  MWANA CLASSE — 014 — Demandes et communiqués : références uniques et
--                       terminal parent enregistrable
-- ============================================================================
--  Deux défauts constatés en production :
--
--  1. POST /api/ecole/demandes/:id/repondre et la publication de communiqués
--     renvoyaient 500 « inconsistent types deduced for parameter » : le même
--     paramètre $N servait à la fois d'uuid (entity_id) et de texte
--     (action_url). Corrigé côté code, pas ici.
--
--  2. La référence « DEM/AAAA/0001 » était calculée par un comptage qui, sous
--     RLS, ne voit que les demandes du parent connecté : tous les parents
--     généraient DEM/AAAA/0001 et la contrainte req_ref_unique rejetait la
--     demande du deuxième parent (409 DOUBLON). Même risque pour COMM/AAAA.
--     On remplace le comptage par deux fonctions qui prennent un verrou
--     d'advisory par école et lisent le comptage dans le contexte RLS de
--     l'école (restauré aussitôt).
--
--  3. sync.clients.school_id était NOT NULL : un parent sans enfant rattaché
--     ne pouvait pas déclarer son terminal (400 en boucle toutes les
--     minutes). La colonne devient nullable.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  Référence d'une demande, unique par école et par année
-- ---------------------------------------------------------------------------
--  L'API parle français : fonctions nommées en français (nouvelle_reference_*
--  au lieu de new_* qui rappelle le mot réservé NEW de plpgsql).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.nouvelle_reference_demande(p_school_id uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev_school  text := current_setting('app.school_id', true);
  v_prev_actor   text := current_setting('app.actor', true);
  v_n            bigint;
BEGIN
  IF p_school_id IS NULL THEN
    RETURN 'DEM/' || to_char(now(), 'YYYY') || '/0000';
  END IF;

  -- Sérialise la génération : deux parents simultanés attendent le verrou
  -- et voient le décompte déjà incrémenté par le premier.
  PERFORM pg_advisory_xact_lock(hashtext('app.requests.ref:' || p_school_id::text)::bigint);

  -- Le comptage doit voir toutes les demandes de l'école, y compris celles
  -- des autres parents : on adopte brièvement le contexte RLS de l'école.
  PERFORM set_config('app.school_id', p_school_id::text, true);
  PERFORM set_config('app.actor', 'staff', true);

  SELECT count(*) + 1 INTO v_n
    FROM app.requests
   WHERE school_id = p_school_id
     AND created_at >= date_trunc('year', now());

  PERFORM set_config('app.school_id', coalesce(v_prev_school, ''), true);
  PERFORM set_config('app.actor', coalesce(v_prev_actor, ''), true);

  RETURN 'DEM/' || to_char(now(), 'YYYY') || '/' || lpad(v_n::text, 4, '0');
END $$;

COMMENT ON FUNCTION app.nouvelle_reference_demande(uuid) IS
  'Référence lisible et unique d''une demande, calculée sous verrou par école (RLS neutralisée pour le comptage)';

-- ---------------------------------------------------------------------------
--  Référence d'un communiqué, unique par école et par année
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.nouvelle_reference_communique(p_school_id uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev_school  text := current_setting('app.school_id', true);
  v_prev_actor   text := current_setting('app.actor', true);
  v_n            bigint;
BEGIN
  IF p_school_id IS NULL THEN
    RETURN 'COMM/' || to_char(now(), 'YYYY') || '/0000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('app.announcements.ref:' || p_school_id::text)::bigint);

  PERFORM set_config('app.school_id', p_school_id::text, true);
  PERFORM set_config('app.actor', 'staff', true);

  SELECT count(*) + 1 INTO v_n
    FROM app.announcements
   WHERE school_id = p_school_id
     AND created_at >= date_trunc('year', now());

  PERFORM set_config('app.school_id', coalesce(v_prev_school, ''), true);
  PERFORM set_config('app.actor', coalesce(v_prev_actor, ''), true);

  RETURN 'COMM/' || to_char(now(), 'YYYY') || '/' || lpad(v_n::text, 4, '0');
END $$;

COMMENT ON FUNCTION app.nouvelle_reference_communique(uuid) IS
  'Référence lisible et unique d''un communiqué, calculée sous verrou par école';

-- ---------------------------------------------------------------------------
--  Terminal parent : l'école n'est pas toujours connue (parent sans enfant)
-- ---------------------------------------------------------------------------
ALTER TABLE sync.clients ALTER COLUMN school_id DROP NOT NULL;

COMMIT;
