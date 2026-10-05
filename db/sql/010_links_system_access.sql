-- =====================================================================
-- Migration 010 — Liens parent-élève : lecture pour le contexte « system »
--
-- Constat : la connexion parent calcule `children_count` par une
-- sous-requête SQL exécutée sous l'identité « system » (route
-- anonyme). La politique des liens ne laissait voir ni l'école (GUC
-- vide) ni le parent (identité inconnue avant la requête) : le
-- compteur renvoyait toujours 0 alors que l'enfant existait.
--
-- Correction : le contexte système (code applicatif de confiance,
-- jamais alimenté par la saisie utilisateur) lit et écrit les liens
-- comme le ferait l'école ; les contextes staff/parent ne sont pas
-- modifiés.
-- =====================================================================

BEGIN;

DROP POLICY IF EXISTS links_school_isolation ON app.parent_student_links;

CREATE POLICY links_school_isolation ON app.parent_student_links
  AS PERMISSIVE FOR ALL
  USING (
    school_id = sec.current_school_id()
    OR sec.current_actor() = 'system'
    OR (
      sec.current_parent_id() IS NOT NULL
      AND parent_id = sec.current_parent_id()
      AND status IN ('actif', 'en_attente')
    )
  )
  WITH CHECK (
    school_id = sec.current_school_id()
    OR sec.current_actor() = 'system'
    OR (sec.current_parent_id() IS NOT NULL AND parent_id = sec.current_parent_id())
  );

COMMIT;
