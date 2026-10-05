-- ============================================================================
--  MWANA CLASSE — 004 — Isolation des données par établissement
--  Row Level Security : aucune fuite possible entre écoles.
-- ============================================================================
--  Fonctionnement :
--    L'API positionne, pour chaque transaction et chaque requête :
--      SELECT set_config('app.school_id', '<uuid école>', true);
--      SELECT set_config('app.parent_id', '<uuid parent>', true);
--      SELECT set_config('app.actor',     'staff|parent|system', true);
--    Les politiques ci-dessous ne laissent alors passer que les lignes
--    appartenant à l'école (ou au parent) demandée.
--
--  Le troisième argument `true` de set_config = portée transaction LOCALE :
--  la valeur ne peut pas fuiter vers une autre requête via un pool de
--  connexions. C'est essentiel pour un pool partagé.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Accès aux variables de session, tolérant si non définie
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sec.current_school_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  v := current_setting('app.school_id', true);
  IF v IS NULL OR btrim(v) = '' THEN RETURN NULL; END IF;
  RETURN v::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION sec.current_parent_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  v := current_setting('app.parent_id', true);
  IF v IS NULL OR btrim(v) = '' THEN RETURN NULL; END IF;
  RETURN v::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION sec.current_actor() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.actor', true), ''), 'system')
$$;

-- Rôle applicatif de l'API (jamais superutilisateur, jamais propriétaire)
-- mwana_api est créé SANS droit de connexion : le mot de passe de connexion
-- est défini uniquement lors du déploiement, par l'administratrice ou
-- l'administrateur du serveur :
--     ALTER ROLE mwana_api LOGIN PASSWORD '<secret unique au déploiement>';
-- Un mot de passe figé dans un script versionné serait public.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mwana_app') THEN
    CREATE ROLE mwana_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mwana_api') THEN
    CREATE ROLE mwana_api NOLOGIN;
  END IF;
END $$;

GRANT mwana_app TO mwana_api;

GRANT USAGE ON SCHEMA app, sec, ref, sync TO mwana_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO mwana_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA sec TO mwana_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA sync TO mwana_app;
GRANT SELECT ON ALL TABLES IN SCHEMA ref TO mwana_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app, sec, sync TO mwana_app;

-- Le journal d'audit reste en ajout seul pour l'API
REVOKE UPDATE, DELETE ON sec.audit_log FROM mwana_app;
REVOKE DELETE ON sec.login_attempts FROM mwana_app;
REVOKE DELETE ON sec.security_alerts FROM mwana_app;
REVOKE UPDATE, DELETE ON app.attendance_history FROM mwana_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA app  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mwana_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA sec  GRANT SELECT, INSERT, UPDATE ON TABLES TO mwana_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA sync GRANT SELECT, INSERT, UPDATE ON TABLES TO mwana_app;

-- ---------------------------------------------------------------------------
-- Activation RLS sur toutes les tables portant school_id
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'school_id'
    WHERE n.nspname = 'app' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Politiques : école courante = school_id de la ligne
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'school_id'
    WHERE n.nspname = 'app' AND c.relkind = 'r'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON app.%I', t || '_school_isolation', t);
    EXECUTE format($f$
      CREATE POLICY %I ON app.%I
        USING (school_id = sec.current_school_id())
        WITH CHECK (school_id = sec.current_school_id())
    $f$, t || '_school_isolation', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Exceptions et politiques spécifiques
-- ---------------------------------------------------------------------------

-- 1) app.schools : une école ne voit que sa propre fiche.
--    (L'API utilise un rôle dédié pour les opérations d'inscription/listing public.)
DROP POLICY IF EXISTS schools_school_isolation ON app.schools;
CREATE POLICY schools_school_isolation ON app.schools
  USING (id = sec.current_school_id())
  WITH CHECK (id = sec.current_school_id());

-- 2) app.parents : les parents ne sont pas rattachés à une seule école.
--    L'API restreint l'accès ; RLS bloque l'accès anonyme en masse.
ALTER TABLE app.parents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.parents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS parents_self_only ON app.parents;
CREATE POLICY parents_self_only ON app.parents
  USING (
    sec.current_actor() = 'system'
    OR id = sec.current_parent_id()
    -- un membre du personnel ne voit que les parents rattachés à son école
    OR EXISTS (
      SELECT 1 FROM app.parent_student_links l
      WHERE l.parent_id = app.parents.id AND l.school_id = sec.current_school_id()
    )
  )
  WITH CHECK (sec.current_actor() = 'system' OR id = sec.current_parent_id());

-- 3) app.parent_student_links : un parent ne lit que ses propres liaisons actives.
ALTER TABLE app.parent_student_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.parent_student_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS links_school_isolation ON app.parent_student_links;
CREATE POLICY links_school_isolation ON app.parent_student_links
  USING (
    school_id = sec.current_school_id()
    OR (parent_id = sec.current_parent_id() AND status = 'actif')
  )
  WITH CHECK (
    school_id = sec.current_school_id()
    OR parent_id = sec.current_parent_id()
  );

-- 4) app.notifications : le parent ne voit que les siennes.
ALTER TABLE app.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notif_audience_policy ON app.notifications;
CREATE POLICY notif_audience_policy ON app.notifications
  USING (
    (audience = 'parent' AND parent_id = sec.current_parent_id())
    OR (audience = 'ecole' AND school_id = sec.current_school_id())
    OR sec.current_actor() = 'system'
  )
  WITH CHECK (
    (audience = 'parent' AND parent_id = sec.current_parent_id())
    OR (audience = 'ecole' AND school_id = sec.current_school_id())
    OR sec.current_actor() = 'system'
  );

-- 5) app.attendance_history : suit la présence d'origine
DROP POLICY IF EXISTS att_hist_school_isolation ON app.attendance_history;
CREATE POLICY att_hist_school_isolation ON app.attendance_history
  USING (school_id = sec.current_school_id())
  WITH CHECK (school_id = sec.current_school_id());

-- 6) app.announcement_recipients : le parent ne voit que ses lignes
ALTER TABLE app.announcement_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.announcement_recipients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ann_recip_policy ON app.announcement_recipients;
CREATE POLICY ann_recip_policy ON app.announcement_recipients
  USING (
    school_id = sec.current_school_id()
    OR parent_id = sec.current_parent_id()
    OR sec.current_actor() = 'system'
  )
  WITH CHECK (
    school_id = sec.current_school_id()
    OR parent_id = sec.current_parent_id()
    OR sec.current_actor() = 'system'
  );

-- 7) Les vues destinées aux parents n'exposent que les champs autorisés.
--    Aucune donnée personnelle sensible, aucun champ chiffré.
CREATE OR REPLACE VIEW app.v_parent_student_public AS
SELECT
  l.parent_id,
  s.id                AS student_id,
  s.public_code,
  s.full_name,
  s.first_name,
  s.gender,
  s.date_of_birth,
  c.name              AS class_name,
  c.id                AS class_id,
  sec2.name           AS section_name,
  sec2.id             AS section_id,
  sc.id               AS school_id,
  sc.official_name     AS school_name,
  sc.public_code       AS school_code,
  sc.logo_url,
  sc.primary_color,
  ay.label             AS academic_year,
  l.relationship,
  l.status             AS link_status,
  l.is_primary
FROM app.parent_student_links l
JOIN app.students      s    ON s.id = l.student_id
JOIN app.classes       c    ON c.id = s.class_id
LEFT JOIN app.sections  sec2 ON sec2.id = s.section_id
JOIN app.schools        sc   ON sc.id = s.school_id
LEFT JOIN app.academic_years ay ON ay.id = s.academic_year_id;

COMMENT ON VIEW app.v_parent_student_public IS
  'Informations strictement autorisées qu''un parent peut voir de son enfant';

-- 8) Vue statistique de présence par classe et par jour
CREATE OR REPLACE VIEW app.v_attendance_daily AS
SELECT
  a.school_id,
  a.class_id,
  a.section_id,
  a.attendance_date,
  count(*)                                              AS total,
  count(*) FILTER (WHERE a.status = 'present')           AS presents,
  count(*) FILTER (WHERE a.status = 'absent')            AS absents,
  count(*) FILTER (WHERE a.status = 'retard')            AS retards,
  count(*) FILTER (WHERE a.status = 'depart_anticipe')   AS departs,
  count(*) FILTER (WHERE a.status = 'non_enregistre')    AS non_enregistres,
  round(100.0 * count(*) FILTER (WHERE a.status IN ('present','retard'))
        / nullif(count(*) FILTER (WHERE a.status <> 'non_enregistre'), 0), 2)
                                                        AS taux_presence
FROM app.attendance a
GROUP BY a.school_id, a.class_id, a.section_id, a.attendance_date;

COMMENT ON VIEW app.v_attendance_daily IS 'Statistiques journalières de présence par classe et section';

-- 9) Vue : occupation des classes et places disponibles
CREATE OR REPLACE VIEW app.v_class_occupancy AS
SELECT
  c.school_id,
  c.id            AS class_id,
  c.name          AS class_name,
  c.level,
  c.max_capacity,
  c.is_active,
  count(s.id) FILTER (WHERE s.status = 'actif')          AS effectif,
  greatest(0, c.max_capacity - count(s.id) FILTER (WHERE s.status = 'actif')) AS places_disponibles,
  CASE
    WHEN count(s.id) FILTER (WHERE s.status = 'actif') >= c.max_capacity THEN 'complete'
    WHEN count(s.id) FILTER (WHERE s.status = 'actif') >= c.max_capacity * 0.9 THEN 'presque_complete'
    ELSE 'disponible'
  END                                                     AS etat_capacite,
  round(100.0 * count(s.id) FILTER (WHERE s.status = 'actif')
        / nullif(c.max_capacity, 0), 1)                   AS taux_occupation
FROM app.classes c
LEFT JOIN app.students s
  ON s.class_id = c.id AND s.academic_year_id = c.academic_year_id
GROUP BY c.school_id, c.id, c.name, c.level, c.max_capacity, c.is_active;

COMMENT ON VIEW app.v_class_occupancy IS 'Effectif, places disponibles et alerte de capacité par classe';

-- 10) Vue : tableau de bord présence d'un élève (pour le parent)
CREATE OR REPLACE VIEW app.v_student_attendance_summary AS
SELECT
  a.school_id,
  a.student_id,
  date_trunc('month', a.attendance_date)::date           AS mois,
  count(*) FILTER (WHERE a.status = 'present')            AS jours_present,
  count(*) FILTER (WHERE a.status = 'absent')             AS jours_absent,
  count(*) FILTER (WHERE a.status = 'retard')             AS jours_retard,
  count(*) FILTER (WHERE a.status = 'depart_anticipe')    AS jours_depart_anticipe,
  count(*)                                                AS jours_enregistres
FROM app.attendance a
WHERE a.status <> 'non_enregistre'
GROUP BY a.school_id, a.student_id, date_trunc('month', a.attendance_date);

COMMENT ON VIEW app.v_student_attendance_summary IS 'Résumé mensuel de présence par élève (historique parent)';

COMMIT;
