-- =====================================================================
-- Migration 009 — Portée « parent » des politiques RLS
--
-- Constat : les sessions parent ne portent aucun identifiant d'école
-- (un parent peut avoir des enfants dans plusieurs écoles). Les
-- politiques génériques « school_id = sec.current_school_id() »
-- masquaient donc TOUTES les tables scolarisées aux parents
-- (élèves, présences, classes, communiqués, documents, demandes...).
-- Résultat observable : tableau de bord parent vide (enfants = []).
--
-- Correction : chaque politique reçoit une branche « parent » :
--   * tables rattachées à un élève  -> lien actif/en attente sur CET élève ;
--   * tables de structure/contenu  -> au moins un lien actif/en attente
--                                     dans l'école concernée ;
--   * demandes                     -> lignes dont le parent est l'auteur ;
--   * notifications                -> un parent lié peut prévenir l'école
--                                     (écriture seule, sans lecture élargie).
-- La branche « écriture » (WITH CHECK) reste réservée aux rôles école/
-- système pour les tables que les parents ne créent jamais.
-- =====================================================================

BEGIN;

/* ---------------------------------------------------------------------
 * 1. Helpers de portée (STABLE, appelés depuis les politiques)
 * ------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION sec.is_linked_school(p_school_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT sec.current_actor() = 'parent'
     AND sec.current_parent_id() IS NOT NULL
     AND p_school_id IS NOT NULL
     AND EXISTS (
           SELECT 1
             FROM app.parent_student_links l
            WHERE l.parent_id = sec.current_parent_id()
              AND l.school_id = p_school_id
              AND l.status IN ('actif', 'en_attente')
         );
$$;

CREATE OR REPLACE FUNCTION sec.is_linked_student(p_student_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT sec.current_actor() = 'parent'
     AND sec.current_parent_id() IS NOT NULL
     AND p_student_id IS NOT NULL
     AND EXISTS (
           SELECT 1
             FROM app.parent_student_links l
            WHERE l.parent_id = sec.current_parent_id()
              AND l.student_id = p_student_id
              AND l.status IN ('actif', 'en_attente')
         );
$$;

COMMENT ON FUNCTION sec.is_linked_school(uuid) IS
  'Vrai si le contexte est un parent ayant au moins un lien actif ou en attente dans cette école.';
COMMENT ON FUNCTION sec.is_linked_student(uuid) IS
  'Vrai si le contexte est un parent ayant au moins un lien actif ou en attente avec cet élève.';

/* ---------------------------------------------------------------------
 * 2. Liens parent-élève : le parent doit voir aussi ses demandes
 *    « en_attente » (sinon une demande qu'il vient de créer disparaît
 *    immédiatement de son interface).
 * ------------------------------------------------------------------- */
DROP POLICY IF EXISTS links_school_isolation ON app.parent_student_links;
CREATE POLICY links_school_isolation ON app.parent_student_links
  AS PERMISSIVE FOR ALL
  USING (
    school_id = sec.current_school_id()
    OR (
      sec.current_parent_id() IS NOT NULL
      AND parent_id = sec.current_parent_id()
      AND status IN ('actif', 'en_attente')
    )
  )
  WITH CHECK (
    school_id = sec.current_school_id()
    OR (sec.current_parent_id() IS NOT NULL AND parent_id = sec.current_parent_id())
  );

/* ---------------------------------------------------------------------
 * 3. Politiques génériques « school_isolation » réécrites avec branche
 *    parent. Lecture : parent lié. Écriture : rôle école/système seul.
 * ------------------------------------------------------------------- */
DO $$
DECLARE
  t text;
BEGIN
  -- 3a. Tables de structure / contenu de l'école (portée école)
  FOREACH t IN ARRAY ARRAY[
    'classes', 'sections', 'academic_years',
    'announcements', 'calendar_events', 'school_documents'
  ] LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON app.%I', t || '_school_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I AS PERMISSIVE FOR ALL '
      'USING (school_id = sec.current_school_id() OR sec.is_linked_school(school_id)) '
      'WITH CHECK (school_id = sec.current_school_id())',
      t || '_school_isolation', t);
  END LOOP;

  -- 3b. Élève lui-même (portée élève : les autres élèves de l''école
  --     restent invisibles pour le parent)
  EXECUTE 'DROP POLICY IF EXISTS students_school_isolation ON app.students';
  EXECUTE
    'CREATE POLICY students_school_isolation ON app.students AS PERMISSIVE FOR ALL '
    'USING (school_id = sec.current_school_id() OR sec.is_linked_student(id)) '
    'WITH CHECK (school_id = sec.current_school_id())';

  -- 3c. Présences et historique (portée élève)
  FOREACH t IN ARRAY ARRAY['attendance', 'attendance_history'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON app.%I', t || '_school_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I AS PERMISSIVE FOR ALL '
      'USING (school_id = sec.current_school_id() OR sec.is_linked_student(student_id)) '
      'WITH CHECK (school_id = sec.current_school_id())',
      t || '_school_isolation', t);
  END LOOP;

  -- 3d. Demandes : le parent lit et écrit ses propres demandes
  EXECUTE 'DROP POLICY IF EXISTS requests_school_isolation ON app.requests';
  EXECUTE
    'CREATE POLICY requests_school_isolation ON app.requests AS PERMISSIVE FOR ALL '
    'USING (
        school_id = sec.current_school_id()
        OR (sec.current_actor() = ''parent''
            AND sec.current_parent_id() IS NOT NULL
            AND parent_id = sec.current_parent_id())
     )
     WITH CHECK (
        school_id = sec.current_school_id()
        OR (sec.current_actor() = ''parent''
            AND sec.current_parent_id() IS NOT NULL
            AND parent_id = sec.current_parent_id())
     )';
END $$;

/* ---------------------------------------------------------------------
 * 4. Notifications : un parent lié à l'école peut lui adresser un
 *    message (INSERT), sans ouvrir la lecture des notifs « ecole ».
 * ------------------------------------------------------------------- */
DROP POLICY IF EXISTS notif_audience_policy ON app.notifications;
CREATE POLICY notif_audience_policy ON app.notifications
  AS PERMISSIVE FOR ALL
  USING (
    (audience = 'parent' AND parent_id = sec.current_parent_id())
    OR (audience = 'ecole' AND school_id = sec.current_school_id())
    OR sec.current_actor() = 'system'
  )
  WITH CHECK (
    (audience = 'parent' AND parent_id = sec.current_parent_id())
    OR (audience = 'ecole' AND school_id = sec.current_school_id())
    OR sec.current_actor() = 'system'
    OR (sec.current_actor() = 'parent' AND sec.is_linked_school(school_id))
  );

COMMIT;
