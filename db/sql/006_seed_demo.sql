-- ============================================================================
--  MWANA CLASSE — 006 — JEU DE DÉMONSTRATION (données de développement)
--  PostgreSQL 18 — exécution : psql -v ON_ERROR_STOP=1 -f 006_seed_demo.sql
-- ============================================================================
--
--  ############################################################################
--  #  AVERTISSEMENT — DONNÉES DE DÉMONSTRATION UNIQUEMENT                     #
--  #                                                                          #
--  #  Ce script crée une école fictive et des comptes fictifs dont le mot de   #
--  #  passe est PUBLIC (il figure ci-dessous dans le code).                   #
--  #                                                                          #
--  #  * NE JAMAIS exécuter ce fichier sur une base de PRODUCTION.              #
--  #  * NE JAMAIS charger ce fichier dans une base contenant de vraies        #
--  #    données d'élèves ou de parents.                                        #
--  #  * Les comptes créés ici (mot de passe « MotDePasseDemo2026! ») DOIVENT   #
--  #    être SUPPRIMÉS ou voir leur mot de passe CHANGÉ avant toute           #
--  #    utilisation réelle, même en recette ou en démonstration publique.      #
--  #  * Le poivre (pepper) est celui de MWANA_PEPPER_PASSWORD, transmis par     #
--  #    « npm run db:seed » : les identifiants de démonstration fonctionnent   #
--  #    sur l'instance locale, mais ce mot de passe PUBLIC reste PUBLIC.       #
--  #                                                                          #
--  #  Les mots de passe sont hachés PAR LA BASE elle-même (pgcrypto, bcrypt) :  #
--  #  ce fichier ne contient aucun mot de passe lisible enregistré en base.    #
--  ############################################################################
--
--  Contenu : données de référence, 1 école de démonstration (MC-ECOLE-DEMO01),
--  2 années scolaires, 6 rôles + permissions, 3 comptes du personnel,
--  8 classes / 14 sections, 60 élèves, 28 parents + liaisons,
--  ~1200 lignes de présence, communiqués, demandes, calendrier, documents,
--  notifications, journal d'audit chaîné et données de synchronisation.
--
--  IDEMPOTENCE : le bloc principal sort immédiatement si l'école de
--  démonstration existe déjà (RAISE NOTICE). Rejouer le script est sans effet.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Neutralisation TEMPORAIRE du RLS « FORCED »
-- ---------------------------------------------------------------------------
--  Les tables de app.* sont en ROW LEVEL SECURITY ... FORCE (voir 004) : même
--  le propriétaire des tables est alors soumis aux politiques. Or ces
--  politiques comparent school_id à sec.current_school_id(), qui vaut NULL
--  dans une session psql ordinaire : AUCUNE insertion ne passerait, pas même
--  celle de l'école elle-même (politique app.schools : id = current_school_id()).
--
--  On retire donc FORCE (et non ENABLE) pour la durée de la transaction : le
--  propriétaire des tables contourne le RLS, exactement comme le ferait une
--  tâche d'administration. FORCE est rétabli explicitement à la fin du script
--  (section 19). Si une erreur survient, la transaction est annulée et le
--  rétablissement est donc automatique : l'état initial ne peut pas être perdu.
--
--  Remarque : cette section doit précéder le contrôle d'idempotence, sinon
--  l'école déjà présente serait invisible (masquée par la politique) et le
--  script tenterait de l'insérer une seconde fois.
-- ---------------------------------------------------------------------------
ALTER TABLE app.schools                NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.academic_years         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.classes                NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.sections               NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.students               NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.parents                NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.parent_student_links   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.attendance             NO FORCE ROW LEVEL SECURITY;
-- attendance_history est alimentée par le trigger app.tg_attendance_history()
-- lors de chaque INSERT dans app.attendance : elle doit donc être neutralisée
-- elle aussi, sans quoi l'historique des présences serait refusé.
ALTER TABLE app.attendance_history     NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.announcement_templates NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.announcements          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.announcement_recipients NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.requests               NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.calendar_events        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.school_documents       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.notifications          NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Hachage des mots de passe de démonstration
-- ---------------------------------------------------------------------------
--  Format identique à celui que vérifie l'API (api/src/security/crypto.ts) :
--     bcrypt( base64( sha512(mot de passe || poivre) ), coût 12 )
--
--  Détails importants :
--    * le poivre vient de la variable de session « app.seed_pepper », posée par
--      « npm run db:seed » à partir de MWANA_PEPPER_PASSWORD : sans cela, le
--      poivre aléatoire régénéré à chaque démarrage de l'API rendrait les
--      comptes de démonstration inutilisables ;
--    * encode(..., 'base64') insère des retours à la ligne tous les 76
--      caractères : ils sont retirés, Node.js n'en produit pas ;
--    * bcrypt stocke son propre sel dans la chaîne produite.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.demo_password_hash(p_secret text, p_pepper text)
RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT crypt(
    replace(encode(digest(p_secret || p_pepper, 'sha512'), 'base64'), E'\n', ''),
    gen_salt('bf', 12)
  );
$$;

-- ===========================================================================
--  BLOC PRINCIPAL — tout le jeu de démonstration
-- ===========================================================================
DO $seed$
DECLARE
  -- Horodatage de référence du jeu de données (stabilité relative des dates)
  v_t0              timestamptz := now();

  -- École, années, rôles, comptes
  v_school          uuid;
  v_y1              uuid;         -- 2025-2026 (archivée)
  v_y2              uuid;         -- 2026-2027 (courante)
  v_role_dir        uuid;
  v_role_adm        uuid;
  v_role_sec        uuid;
  v_role_pres       uuid;
  v_role_tit        uuid;
  v_role_lec        uuid;
  v_staff_dir       uuid;
  v_staff_sec       uuid;
  v_staff_pres      uuid;

  -- Mot de passe de démonstration : haché par la base, jamais stocké en clair
  v_pwd      text := 'MotDePasseDemo2026!';
  v_pepper   text := coalesce(
                       nullif(current_setting('app.seed_pepper', true), ''),
                       'PEPPER_DEMO_A_REMPLACER');
  v_hash     text;

  -- Classes / sections
  v_class_id        uuid;
  v_prev_class      uuid;
  v_section_id      uuid;

  -- Élèves / parents / liaisons
  v_k               int := 0;
  v_n               int := 0;
  v_i               int;
  v_p               int;
  v_parent_id       uuid;
  v_parent_ids      uuid[] := ARRAY[]::uuid[];
  v_student_ids     uuid[] := ARRAY[]::uuid[];
  v_link_id         uuid;
  v_link_pending    uuid;
  v_nb_parents      int := 28;

  -- Communiqués, demandes, sync
  v_tmpl_off        uuid;
  v_tmpl_reu        uuid;
  v_tmpl_exa        uuid;
  v_ann_gen         uuid;
  v_ann_urg         uuid;
  v_ann_cls         uuid;
  v_ann_bro         uuid;
  v_ann_prog        uuid;
  v_ann_arc         uuid;
  v_req1            uuid;
  v_req2            uuid;
  v_req3            uuid;
  v_req4            uuid;
  v_req5            uuid;
  v_req6            uuid;
  v_req7            uuid;
  v_att_id          uuid;
  v_att_id2         uuid;
  v_client_tab      uuid := '11111111-1111-4111-8111-111111111111';
  v_client_tel      uuid := '22222222-2222-4222-8222-222222222222';
  v_batch           uuid := '33333333-3333-4333-8333-333333333333';

  v_cnt             bigint;

  r                 record;
BEGIN
  -- =========================================================================
  --  CONTRÔLE D'IDEMPOTENCE
  -- =========================================================================
  IF EXISTS (SELECT 1 FROM app.schools WHERE public_code = 'MC-ECOLE-DEMO01') THEN
    RAISE NOTICE 'Jeu de démonstration déjà présent : rien à faire.';
    RETURN;
  END IF;

  RAISE NOTICE 'Démonstration MwanaClasse : démarrage du chargement...';

  -- =========================================================================
  -- 1. DONNÉES DE RÉFÉRENCE — catalogue des permissions
  -- =========================================================================
  RAISE NOTICE '1/18 — Catalogue des permissions...';

  INSERT INTO ref.permissions (code, module, label, description, is_dangerous) VALUES
    ('eleves.creer',      'eleves',      'Créer un élève',
     'Inscrire un nouvel élève dans une classe de l''école.', false),
    ('eleves.modifier',   'eleves',      'Modifier un élève',
     'Corriger la fiche d''un élève (identité, classe, section).', false),
    ('eleves.archiver',   'eleves',      'Archiver un élève',
     'Archiver, transférer ou diplômer un élève : la fiche sort des listes actives.', true),
    ('classes.gerer',     'classes',     'Gérer les classes',
     'Créer, renommer et paramétrer les classes d''une année scolaire.', false),
    ('sections.gerer',    'sections',    'Gérer les sections',
     'Configurer les sections (A, B, Unique…) classe par classe.', false),
    ('presences.enregistrer', 'presences', 'Enregistrer les présences',
     'Faire l''appel du jour pour une classe ou une section.', false),
    ('presences.modifier',    'presences', 'Corriger les présences',
     'Modifier une présence déjà enregistrée (correction administrative tracée).', true),
    ('presences.consulter',   'presences', 'Consulter les présences',
     'Lire les feuilles de présence et les statistiques journalières.', false),
    ('communiques.creer',   'communiques', 'Rédiger un communiqué',
     'Créer un brouillon de communiqué officiel destiné aux parents.', false),
    ('communiques.publier', 'communiques', 'Publier un communiqué',
     'Publier ou programmer un communiqué : il part immédiatement vers les parents.', true),
    ('parents.gerer',     'parents',     'Gérer les comptes parents',
     'Créer, corriger ou désactiver un compte parent.', false),
    ('liens.valider',     'liens',       'Valider une liaison parent-enfant',
     'Approuver le rattachement d''un parent à un élève.', false),
    ('liens.revoquer',    'liens',       'Révoquer une liaison parent-enfant',
     'Retirer à un parent l''accès aux données d''un élève.', true),
    ('demandes.traiter',  'demandes',    'Traiter les demandes',
     'Répondre aux réclamations, questions et justifications d''absence.', false),
    ('rapports.consulter','rapports',    'Consulter les rapports',
     'Accéder aux tableaux de bord, statistiques et exports de synthèse.', false),
    ('documents.gerer',   'documents',   'Gérer les documents',
     'Publier, remplacer ou retirer les documents mis à disposition des parents.', false),
    ('calendrier.gerer',  'calendrier',  'Gérer le calendrier scolaire',
     'Créer et publier les événements du calendrier (rentrée, examens, vacances).', false),
    ('personnel.gerer',   'personnel',   'Gérer le personnel',
     'Créer des comptes du personnel, attribuer des rôles et des permissions.', true),
    ('parametres.modifier','parametres', 'Modifier les paramètres de l''école',
     'Modifier l''identité, les couleurs et les réglages de l''établissement.', false),
    ('audit.consulter',   'audit',       'Consulter le journal d''audit',
     'Lire le journal d''audit chaîné et vérifier son intégrité.', true),
    ('securite.gerer',    'securite',    'Gérer la sécurité',
     'Gérer les verrous, les alertes de sécurité et les clés de chiffrement.', true),
    ('imports.executer',  'imports',     'Exécuter les importations',
     'Importer des élèves, des parents ou des classes depuis un fichier Excel/CSV.', false)
  ON CONFLICT (code) DO NOTHING;

  -- Actions sensibles : toute occurrence doit laisser une trace explicite.
  INSERT INTO ref.sensitive_actions (action, label, severity, requires_reason) VALUES
    ('staff.create',            'Création d''un compte du personnel',        'warning',  true),
    ('staff.disable',           'Désactivation d''un compte du personnel',   'warning',  true),
    ('permission.grant',        'Attribution de permissions',                'notice',   false),
    ('parent_link.revoke',      'Révocation d''une liaison parent-enfant',   'warning',  true),
    ('attendance.bulk_correct', 'Correction massive de présences',           'warning',  true),
    ('announcement.publish',    'Publication d''un communiqué officiel',     'notice',   false),
    ('export.eleves',           'Export de la liste des élèves',             'warning',  true),
    ('audit.verify',            'Vérification de la chaîne d''audit',        'info',     false)
  ON CONFLICT (action) DO NOTHING;

  -- =========================================================================
  -- 2. L'ÉCOLE DE DÉMONSTRATION
  -- =========================================================================
  RAISE NOTICE '2/18 — École de démonstration...';

  INSERT INTO app.schools (
    public_code, slug, official_name, short_name, type,
    primary_color, secondary_color, address_line, commune, city, province, country,
    phones, email, website, description, opening_hours,
    current_year_label, parent_link_mode, settings,
    signature_name, signature_title, is_active, onboarded_at, extra_info)
  VALUES (
    'MC-ECOLE-DEMO01',
    'ecole-demo-mwana',
    'École Demonstration MwanaClasse',
    'EDM',
    'mixte',
    '#7C3AED',                       -- violet distinctif : école de démonstration
    '#FACC15',
    '12, avenue de la Paix',
    'Gombe',
    'Kinshasa',
    'Kinshasa',
    'RDC',
    ARRAY['+243810000001', '+243990000002'],
    'contact@ecole-demo.cd',
    'https://ecole-demo.mwanaclasse.cd',
    'Établissement fictif de démonstration : primaire et secondaire, 8 classes.',
    'Lundi - Vendredi : 06h30 - 17h30',
    '2026-2027',
    'automatique',                   -- les liaisons parent-enfant sont immédiates
    '{"notify_absence": true, "notify_late": true, "notify_presence": true,
      "allow_parent_justification": true, "require_2fa_staff": false,
      "attendance_day_start": "06:00", "attendance_day_end": "18:00",
      "demo": true}'::jsonb,
    'Joseph Mukendi',
    'Directeur',
    true,
    v_t0 - interval '400 days',
    '{"jeu_de_donnees": "demonstration", "a_supprimer_avant_production": true}'::jsonb
  )
  RETURNING id INTO v_school;

  -- =========================================================================
  -- 3. LES DEUX ANNÉES SCOLAIRES
  -- =========================================================================
  RAISE NOTICE '3/18 — Années scolaires 2025-2026 (archivée) et 2026-2027...';

  INSERT INTO app.academic_years (school_id, label, starts_on, ends_on, is_current, is_archived, notes)
  VALUES (v_school, '2025-2026',
          app.school_year_start('2025-2026'), app.school_year_end('2025-2026'),
          false, true, 'Année clôturée et archivée — conservée pour l''historique.')
  RETURNING id INTO v_y1;

  INSERT INTO app.academic_years (school_id, label, starts_on, ends_on, is_current, is_archived, notes)
  VALUES (v_school, '2026-2027',
          app.school_year_start('2026-2027'), app.school_year_end('2026-2027'),
          true, false, 'Année scolaire en cours.')
  RETURNING id INTO v_y2;

  -- =========================================================================
  -- 4. LES SIX RÔLES DE L'ÉCOLE
  -- =========================================================================
  RAISE NOTICE '4/18 — Rôles et permissions...';

  INSERT INTO sec.roles (school_id, code, name, description, is_system) VALUES
    (v_school, 'directeur',            'Directeur',
     'Accès complet : toutes les permissions de l''école.', true),
    (v_school, 'administrateur',       'Administrateur',
     'Gestion quotidienne de l''école, sans les actions les plus sensibles.', true),
    (v_school, 'secretaire',           'Secrétaire',
     'Élèves, parents, communiqués, demandes, rapports et importations.', true),
    (v_school, 'responsable_presence', 'Responsable présence',
     'Saisie et correction des présences uniquement.', true),
    (v_school, 'titulaire',            'Titulaire de classe',
     'Enseignant titulaire : appel de sa classe et consultation.', true),
    (v_school, 'lecteur',              'Lecteur',
     'Consultation seule : présences, rapports et journal d''audit.', true);

  -- Relecture explicite des identifiants (un RETURNING multi-lignes ne peut pas
  -- alimenter une variable scalaire).
  SELECT id INTO v_role_dir  FROM sec.roles WHERE school_id = v_school AND code = 'directeur';
  SELECT id INTO v_role_adm  FROM sec.roles WHERE school_id = v_school AND code = 'administrateur';
  SELECT id INTO v_role_sec  FROM sec.roles WHERE school_id = v_school AND code = 'secretaire';
  SELECT id INTO v_role_pres FROM sec.roles WHERE school_id = v_school AND code = 'responsable_presence';
  SELECT id INTO v_role_tit  FROM sec.roles WHERE school_id = v_school AND code = 'titulaire';
  SELECT id INTO v_role_lec  FROM sec.roles WHERE school_id = v_school AND code = 'lecteur';

  -- Directeur : toutes les permissions du catalogue
  INSERT INTO sec.role_permissions (role_id, permission_code)
  SELECT v_role_dir, p.code FROM ref.permissions p
  ON CONFLICT DO NOTHING;

  -- Administrateur : tout sauf le personnel, la sécurité et l'audit
  INSERT INTO sec.role_permissions (role_id, permission_code)
  SELECT v_role_adm, p.code FROM ref.permissions p
  WHERE split_part(p.code, '.', 1) NOT IN ('personnel', 'securite', 'audit')
  ON CONFLICT DO NOTHING;

  -- Secrétaire : élèves, parents, communiqués, demandes, rapports, importations
  INSERT INTO sec.role_permissions (role_id, permission_code)
  SELECT v_role_sec, p.code FROM ref.permissions p
  WHERE split_part(p.code, '.', 1) IN
        ('eleves', 'parents', 'communiques', 'demandes', 'rapports', 'imports')
  ON CONFLICT DO NOTHING;

  -- Responsable présence : uniquement le module presences
  INSERT INTO sec.role_permissions (role_id, permission_code)
  SELECT v_role_pres, p.code FROM ref.permissions p
  WHERE split_part(p.code, '.', 1) = 'presences'
  ON CONFLICT DO NOTHING;

  -- Titulaire : appel de sa classe + consultation
  INSERT INTO sec.role_permissions (role_id, permission_code)
  SELECT v_role_tit, p.code FROM ref.permissions p
  WHERE p.code IN ('presences.enregistrer', 'presences.consulter', 'rapports.consulter')
  ON CONFLICT DO NOTHING;

  -- Lecteur : uniquement les permissions de consultation
  INSERT INTO sec.role_permissions (role_id, permission_code)
  SELECT v_role_lec, p.code FROM ref.permissions p
  WHERE p.code LIKE '%.consulter'
  ON CONFLICT DO NOTHING;

  -- =========================================================================
  -- 5. LES TROIS COMPTES DU PERSONNEL
  -- =========================================================================
  --  Le hachage est produit ICI par la base (pgcrypto) au format attendu par
  --  l'API : bcrypt(base64(sha512(mot de passe || poivre)), coût 12),
  --  le poivre étant celui de MWANA_PEPPER_PASSWORD (transmis par db:seed).
  --  Aucun mot de passe en clair n'est donc écrit dans une table.
  RAISE NOTICE '5/18 — Comptes du personnel (hachage bcrypt calculé par la base)...';

  v_hash := app.demo_password_hash(v_pwd, v_pepper);

  INSERT INTO sec.staff_users (
    school_id, email, username, full_name, job_title, phone,
    password_hash, password_algo, password_pepper_id,
    is_active, is_owner, last_login_at, last_login_ip)
  VALUES (
    v_school, 'directeur@ecole-demo.cd', 'jmukendi', 'Joseph Mukendi', 'Directeur',
    '+243810000011',
    v_hash, 'bcrypt', 'DEMO',
    true, true, v_t0 - interval '3 hours', '41.243.10.11'::inet)
  RETURNING id INTO v_staff_dir;

  v_hash := app.demo_password_hash(v_pwd, v_pepper);

  INSERT INTO sec.staff_users (
    school_id, email, username, full_name, job_title, phone,
    password_hash, password_algo, password_pepper_id,
    is_active, is_owner, last_login_at, last_login_ip)
  VALUES (
    v_school, 'secretaire@ecole-demo.cd', 'mkabeya', 'Marie Kabeya', 'Secrétaire',
    '+243810000022',
    v_hash, 'bcrypt', 'DEMO',
    true, false, v_t0 - interval '5 hours', '41.243.10.42'::inet)
  RETURNING id INTO v_staff_sec;

  v_hash := app.demo_password_hash(v_pwd, v_pepper);

  INSERT INTO sec.staff_users (
    school_id, email, username, full_name, job_title, phone,
    password_hash, password_algo, password_pepper_id,
    is_active, is_owner, last_login_at, last_login_ip)
  VALUES (
    v_school, 'presence@ecole-demo.cd', 'pilunga', 'Paul Ilunga', 'Responsable présence',
    '+243810000033',
    v_hash, 'bcrypt', 'DEMO',
    true, false, v_t0 - interval '2 hours', '41.243.10.57'::inet)
  RETURNING id INTO v_staff_pres;

  -- Attribution des rôles
  INSERT INTO sec.staff_roles (staff_user_id, role_id, assigned_by) VALUES
    (v_staff_dir,  v_role_dir,  v_staff_dir),
    (v_staff_sec,  v_role_sec,  v_staff_dir),
    (v_staff_pres, v_role_pres, v_staff_dir)
  ON CONFLICT DO NOTHING;

  -- =========================================================================
  -- 6. LES HUIT CLASSES DE 2026-2027
  -- =========================================================================
  --  level_order sert au tri et à la promotion : la classe suivante créée
  --  devient la cible de promotion (promotion_target_id) de la précédente.
  RAISE NOTICE '6/18 — Classes de 2026-2027...';

  v_prev_class := NULL;

  FOR r IN
    SELECT t.name, t.level, t.level_order, t.max_capacity
    FROM (VALUES
      ('1ère Primaire',   'Primaire',   1, 45),
      ('2ème Primaire',   'Primaire',   2, 45),
      ('3ème Primaire',   'Primaire',   3, 50),
      ('4ème Primaire',   'Primaire',   4, 50),
      ('5ème Primaire',   'Primaire',   5, 50),
      ('6ème Primaire',   'Primaire',   6, 50),
      ('1ère Secondaire', 'Secondaire', 7, 55),
      ('2ème Secondaire', 'Secondaire', 8, 55)
    ) AS t(name, level, level_order, max_capacity)
    ORDER BY t.level_order
  LOOP
    INSERT INTO app.classes (
      school_id, academic_year_id, name, level, level_order,
      max_capacity, room, notes, is_active)
    VALUES (
      v_school, v_y2, r.name, r.level, r.level_order,
      r.max_capacity, format('Salle %s', r.level_order),
      'Classe de démonstration.', true)
    RETURNING id INTO v_class_id;

    IF v_prev_class IS NOT NULL THEN
      UPDATE app.classes SET promotion_target_id = v_class_id WHERE id = v_prev_class;
    END IF;

    v_prev_class := v_class_id;
  END LOOP;

  -- 2ème Secondaire n'a pas de classe supérieure dans cette école :
  -- sa cible de promotion reste NULL (fin du cursus actuel).

  -- =========================================================================
  -- 7. LES SECTIONS, CONFIGURABLES CLASSE PAR CLASSE
  -- =========================================================================
  --  Deux sections A/B pour les quatre plus grandes primaires (50 places) et
  --  pour les deux secondaires ; une section unique pour 1ère et 2ème Primaire.
  RAISE NOTICE '7/18 — Sections (A/B ou Unique, classe par classe)...';

  FOR r IN
    SELECT t.class_name, t.section_name, t.short_code, t.max_capacity
    FROM (VALUES
      ('3ème Primaire',   'A',      'A'::text, 25),
      ('3ème Primaire',   'B',      'B',       25),
      ('4ème Primaire',   'A',      'A',       25),
      ('4ème Primaire',   'B',      'B',       25),
      ('5ème Primaire',   'A',      'A',       25),
      ('5ème Primaire',   'B',      'B',       25),
      ('6ème Primaire',   'A',      'A',       25),
      ('6ème Primaire',   'B',      'B',       25),
      ('1ère Secondaire', 'A',      'A',       28),
      ('1ère Secondaire', 'B',      'B',       27),
      ('2ème Secondaire', 'A',      'A',       28),
      ('2ème Secondaire', 'B',      'B',       27),
      ('1ère Primaire',   'Unique', NULL,      45),
      ('2ème Primaire',   'Unique', NULL,      45)
    ) AS t(class_name, section_name, short_code, max_capacity)
  LOOP
    SELECT c.id INTO v_class_id
    FROM app.classes c
    WHERE c.school_id = v_school AND c.academic_year_id = v_y2 AND c.name = r.class_name;

    IF v_class_id IS NULL THEN
      RAISE EXCEPTION 'Classe introuvable : %', r.class_name USING ERRCODE = '23503';
    END IF;

    INSERT INTO app.sections (school_id, class_id, name, short_code, max_capacity, notes)
    VALUES (v_school, v_class_id, r.section_name, r.short_code, r.max_capacity,
            CASE WHEN r.short_code IS NULL
                 THEN 'Section unique : pas de code court.'
                 ELSE 'Section parallèle de la classe.' END);
  END LOOP;

  -- =========================================================================
  -- 8. LES 60 ÉLÈVES
  -- =========================================================================
  --  Répartition volontairement inégale (de 3 à 7 élèves par section) :
  --  1P 3 · 2P 3 · 3P 6+5 · 4P 4+3 · 5P 4+5 · 6P 7+4 · 1S 4+3 · 2S 4+5 = 60.
  --  Les dates de naissance sont cohérentes avec le niveau (un élève de
  --  1ère Primaire est né vers 2019-2020, un élève de 2ème Secondaire vers
  --  2012-2013). Le code public n'est JAMAIS écrit en dur : il est produit par
  --  app.format_student_code(app.random_code(6)) ; en cas de collision
  --  (probabilité infime), la contrainte d'unicité ferait échouer le script
  --  plutôt que de créer un doublon silencieux.
  --
  --  À SAVOIR — alerte de capacité : les capacités imposées (45 à 55 places)
  --  sont très supérieures à l'effectif de démonstration (60 élèves au total),
  --  donc app.v_class_occupancy renverra toujours 'disponible'. Pour voir
  --  apparaître les états 'presque_complete' / 'complete' du tableau de bord,
  --  il faut soit augmenter fortement le nombre d'élèves, soit abaisser
  --  max_capacity sur une classe de test (par ex. 12 pour la 3ème Primaire).
  RAISE NOTICE '8/18 — 60 élèves répartis dans les 14 sections...';

  FOR r IN
    SELECT t.class_name, t.section_name, t.last_name, t.middle_name,
           t.first_name, t.gender::char(1) AS gender, t.dob::date AS dob
    FROM (VALUES
      -- 1ère Primaire / Unique (3)
      ('1ère Primaire', 'Unique', 'KABENGELE',    'MUTOMBO',    'Josué',      'M', '2019-03-14'),
      ('1ère Primaire', 'Unique', 'NSIMBA',       'LUKOKI',     'Grâce',      'F', '2019-07-22'),
      ('1ère Primaire', 'Unique', 'MWAMBA',       'KAZADI',     'Emmanuel',   'M', '2020-01-19'),
      -- 2ème Primaire / Unique (3)
      ('2ème Primaire', 'Unique', 'ILUNGA',       'KABUYA',     'Esther',     'F', '2018-05-06'),
      ('2ème Primaire', 'Unique', 'BOKAMBA',      'NSENGA',     'Fiston',     'M', '2018-09-27'),
      ('2ème Primaire', 'Unique', 'MUTEBA',       'KALONJI',    'Divine',     'F', '2019-02-11'),
      -- 3ème Primaire / A (6)
      ('3ème Primaire', 'A',      'NGOY',         'TSHIBANGU',  'Christian',  'M', '2017-03-22'),
      ('3ème Primaire', 'A',      'KALALA',       'MPOYI',      'Merveille',  'F', '2017-07-14'),
      ('3ème Primaire', 'A',      'MUJINGA',      'BOLENGE',    'Gédéon',     'M', '2017-10-05'),
      ('3ème Primaire', 'A',      'MAKIESE',      'LOKOLE',     'Bénédicte',  'F', '2018-01-09'),
      ('3ème Primaire', 'A',      'KAYEMBE',      'BAKALA',     'Espoir',     'M', '2017-05-27'),
      ('3ème Primaire', 'A',      'TSIMBA',       'MABIALA',    'Gloria',     'F', '2018-03-11'),
      -- 3ème Primaire / B (5)
      ('3ème Primaire', 'B',      'LUWENYEMA',    'KASONGO',    'Patrick',    'M', '2017-06-18'),
      ('3ème Primaire', 'B',      'BOFANDO',      'NGALULA',    'Naomi',      'F', '2017-12-02'),
      ('3ème Primaire', 'B',      'MUKENDI',      'KABEMBA',    'Blaise',     'M', '2018-02-26'),
      ('3ème Primaire', 'B',      'DIANGITUKULU', 'MAVUNGU',    'Chantal',    'F', '2017-09-13'),
      ('3ème Primaire', 'B',      'NKONGOLO',     'KIBWE',      'Serge',      'M', '2018-04-30'),
      -- 4ème Primaire / A (4)
      ('4ème Primaire', 'A',      'MULUMBA',      'KABILA',     'Rachelle',   'F', '2016-05-08'),
      ('4ème Primaire', 'A',      'NTUMBA',       'KANKU',      'Dieudonné',  'M', '2016-09-19'),
      ('4ème Primaire', 'A',      'BASHIGE',      'MURHULA',    'Bijoux',     'F', '2017-01-25'),
      ('4ème Primaire', 'A',      'KISIMBA',      'MWENZE',     'Alain',      'M', '2016-11-11'),
      -- 4ème Primaire / B (3)
      ('4ème Primaire', 'B',      'SAMBA',        'MOPPERT',    'Espérance',  'F', '2016-07-03'),
      ('4ème Primaire', 'B',      'MASUDI',       'NZUZI',      'Didier',     'M', '2016-12-15'),
      ('4ème Primaire', 'B',      'KHOJANE',      'LEMBA',      'Ruth',       'F', '2017-02-07'),
      -- 5ème Primaire / A (4)
      ('5ème Primaire', 'A',      'BOLENGE',      'IKOLI',      'Trésor',     'M', '2015-06-21'),
      ('5ème Primaire', 'A',      'MPUTU',        'LOSALA',     'Déborah',    'F', '2015-10-14'),
      ('5ème Primaire', 'A',      'NZINGA',       'MAYELE',     'Junior',     'M', '2016-02-18'),
      ('5ème Primaire', 'A',      'LOFEMBE',      'BONGONGO',   'Charlotte',  'F', '2015-08-05'),
      -- 5ème Primaire / B (5)
      ('5ème Primaire', 'B',      'KABONGO',      'MUKUNA',     'Augustin',   'M', '2015-04-27'),
      ('5ème Primaire', 'B',      'TSHILOMBO',    'KADIMA',     'Nadine',     'F', '2015-11-30'),
      ('5ème Primaire', 'B',      'NGALAMULUME',  'KAZEMBE',    'Moïse',      'M', '2016-03-16'),
      ('5ème Primaire', 'B',      'MABIKA',       'NTOMO',      'Syntiche',   'F', '2015-07-22'),
      ('5ème Primaire', 'B',      'KAPINGA',      'MULONGO',    'Bienvenu',   'M', '2016-01-08'),
      -- 6ème Primaire / A (7)
      ('6ème Primaire', 'A',      'BOSCO',        'KAMBALE',    'Prisca',     'F', '2014-05-19'),
      ('6ème Primaire', 'A',      'NDAYA',        'KABUYI',     'Thierry',    'M', '2014-09-02'),
      ('6ème Primaire', 'A',      'MUKALAY',      'KABALA',     'Cécile',     'F', '2015-01-13'),
      ('6ème Primaire', 'A',      'LUBAMBA',      'KISWA',      'Cédric',     'M', '2014-11-26'),
      ('6ème Primaire', 'A',      'TSHIBANDA',    'MUTEBA',     'Léonie',     'F', '2015-02-28'),
      ('6ème Primaire', 'A',      'LUKOKI',       'MUKONKOLE',  'Innocent',   'M', '2014-07-17'),
      ('6ème Primaire', 'A',      'NGANDU',       'KABASELE',   'Rebecca',    'F', '2014-10-09'),
      -- 6ème Primaire / B (4)
      ('6ème Primaire', 'B',      'MUTOMBO',      'LUMU',       'Fabrice',    'M', '2015-03-25'),
      ('6ème Primaire', 'B',      'MPIANA',       'KAMANDA',    'Sylvie',     'F', '2014-06-12'),
      ('6ème Primaire', 'B',      'BUKASA',       'NSENGA',     'Héritier',   'M', '2015-05-02'),
      ('6ème Primaire', 'B',      'KABUYA',       'MANDA',      'Bernadette', 'F', '2014-08-24'),
      -- 1ère Secondaire / A (4)
      ('1ère Secondaire', 'A',    'TAMBWE',       'LOBO',       'Pascal',     'M', '2013-04-15'),
      ('1ère Secondaire', 'A',    'IYOLO',        'BONGONGO',   'Faveur',     'F', '2013-09-08'),
      ('1ère Secondaire', 'A',    'KALONJI',      'MULONGO',    'Chance',     'M', '2014-01-30'),
      ('1ère Secondaire', 'A',    'KABEMBA',      'NYEMBO',     'Anastasie',  'F', '2013-11-21'),
      -- 1ère Secondaire / B (3)
      ('1ère Secondaire', 'B',    'MANDA',        'KISIMBA',    'Rigobert',   'M', '2013-06-04'),
      ('1ère Secondaire', 'B',    'LUMU',         'TSHIBANGU',  'Clarisse',   'F', '2014-02-13'),
      ('1ère Secondaire', 'B',    'KASONGO',      'BADIBANGA',  'Élysée',     'M', '2013-10-27'),
      -- 2ème Secondaire / A (4)
      ('2ème Secondaire', 'A',    'MULONGO',      'KABEYA',     'Larissa',    'F', '2012-05-29'),
      ('2ème Secondaire', 'A',    'NGANDU',       'MBUYI',      'Merveil',    'M', '2012-10-16'),
      ('2ème Secondaire', 'A',    'LOKOLE',       'MUKENDI',    'Jolie',      'F', '2013-03-03'),
      ('2ème Secondaire', 'A',    'BADIBANGA',    'KALALA',     'Armand',     'M', '2012-12-08'),
      -- 2ème Secondaire / B (5)
      ('2ème Secondaire', 'B',    'KIBWE',        'NSIMBA',     'Sarah',      'F', '2012-07-11'),
      ('2ème Secondaire', 'B',    'MPOYI',        'LUWENYEMA',  'Olivier',    'M', '2013-01-24'),
      ('2ème Secondaire', 'B',    'BAKALA',       'MWAMBA',     'Mireille',   'F', '2012-09-30'),
      ('2ème Secondaire', 'B',    'MUKUNA',       'ILUNGA',     'Franck',     'M', '2013-02-06'),
      ('2ème Secondaire', 'B',    'KAZADI',       'BOKAMBA',    'Noëlla',     'F', '2012-11-18')
    ) AS t(class_name, section_name, last_name, middle_name, first_name, gender, dob)
  LOOP
    SELECT c.id INTO v_class_id
    FROM app.classes c
    WHERE c.school_id = v_school AND c.academic_year_id = v_y2 AND c.name = r.class_name;

    IF v_class_id IS NULL THEN
      RAISE EXCEPTION 'Classe introuvable pour l''élève % : %', r.last_name, r.class_name
        USING ERRCODE = '23503';
    END IF;

    SELECT s.id INTO v_section_id
    FROM app.sections s
    WHERE s.class_id = v_class_id AND s.name = r.section_name;

    IF v_section_id IS NULL THEN
      RAISE EXCEPTION 'Section introuvable : % / %', r.class_name, r.section_name
        USING ERRCODE = '23503';
    END IF;

    v_k := v_k + 1;

    INSERT INTO app.students (
      school_id, public_code, academic_year_id, class_id, section_id,
      last_name, middle_name, first_name, gender, date_of_birth,
      place_of_birth, internal_number, status, enrolled_on, extra_info)
    VALUES (
      v_school,
      app.format_student_code(app.random_code(6)),   -- code unique généré
      v_y2, v_class_id, v_section_id,
      r.last_name, r.middle_name, r.first_name, r.gender, r.dob,
      'Kinshasa',
      lpad(v_k::text, 4, '0'),                       -- numéro interne séquentiel
      'actif',
      app.school_year_start('2026-2027'),
      jsonb_build_object('demonstration', true));
  END LOOP;

  RAISE NOTICE '     % élèves créés.', v_k;

  -- Liste ordonnée des élèves : sert aux liaisons, aux présences et aux stats
  SELECT array_agg(s.id ORDER BY s.internal_number) INTO v_student_ids
  FROM app.students s
  WHERE s.school_id = v_school AND s.academic_year_id = v_y2;

  -- =========================================================================
  -- 9. LES 28 PARENTS ET LEURS IDENTIFIANTS
  -- =========================================================================
  --  Même technique de hachage que pour le personnel : produit par la base,
  --  poivre de démonstration, consentements RGPD horodatés.
  RAISE NOTICE '9/18 — % comptes parents...', v_nb_parents;

  FOR r IN
    SELECT t.full_name, t.relationship
    FROM (VALUES
      ('MUKENDI Joseph',        'pere'),
      ('KABEYA Marie',          'mere'),
      ('ILUNGA Patrick',        'pere'),
      ('NSIMBA Chantal',        'mere'),
      ('BOKAMBA Georges',       'pere'),
      ('MUTEBA Angèle',         'mere'),
      ('NGOY Alphonse',         'pere'),
      ('KALALA Joséphine',      'mere'),
      ('MUJINGA Toussaint',     'tuteur'),
      ('MAKIESE Bernadette',    'mere'),
      ('KAYEMBE Stanislas',     'pere'),
      ('TSIMBA Honorine',       'mere'),
      ('LUWENYEMA Célestin',    'pere'),
      ('BOFANDO Séraphine',     'mere'),
      ('MUKENDI Léon',          'oncle'),
      ('DIANGITUKULU Madeleine','mere'),
      ('NKONGOLO Félix',        'pere'),
      ('MULUMBA Espérance',     'tante'),
      ('NTUMBA Prosper',        'pere'),
      ('BASHIGE Véronique',     'mere'),
      ('KISIMBA Édouard',       'pere'),
      ('SAMBA Colette',         'mere'),
      ('MASUDI Théodore',       'pere'),
      ('KHOJANE Albertine',     'mere'),
      ('BOLENGE Sébastien',     'pere'),
      ('MPUTU Joséphine',       'mere'),
      ('NZINGA Ferdinand',      'pere'),
      ('LOFEMBE Marthe',        'mere')
    ) AS t(full_name, relationship)
  LOOP
    v_n := v_n + 1;

    INSERT INTO app.parents (
      public_code, full_name, relationship, email, phone,
      email_verified_at, phone_verified_at, preferred_language,
      notification_prefs, is_active, last_seen_at)
    VALUES (
      app.format_parent_code(app.random_code(6)),
      r.full_name,
      r.relationship,
      'parent' || v_n || '@example.cd',
      '+24381' || lpad((1000000 + v_n * 37)::text, 7, '0'),
      v_t0 - interval '30 days',
      v_t0 - interval '30 days',
      'fr',
      '{"push": true, "email": true, "sms": false, "quiet_hours": null}'::jsonb,
      true,
      v_t0 - make_interval(hours => v_n))
    RETURNING id INTO v_parent_id;

    v_parent_ids := v_parent_ids || v_parent_id;

    -- Identifiants du parent, isolés dans le schéma de sécurité
    v_hash := app.demo_password_hash(v_pwd, v_pepper);

    INSERT INTO sec.parent_credentials (
      parent_id, password_hash, password_algo, password_pepper_id,
      terms_accepted_at, privacy_accepted_at, marketing_opt_in, last_login_at)
    VALUES (
      v_parent_id, v_hash, 'bcrypt', 'DEMO',
      v_t0 - interval '30 days', v_t0 - interval '30 days', false,
      v_t0 - interval '2 days');
  END LOOP;

  -- =========================================================================
  -- 10. LIAISONS PARENT ↔ ÉLÈVE
  -- =========================================================================
  --  Répartition tournante : chaque parent est responsable principal de 2 ou
  --  3 enfants (60 élèves / 28 parents), systématiquement dans des classes
  --  différentes — c'est ce qui alimente la fonctionnalité « plusieurs enfants ».
  RAISE NOTICE '10/18 — Liaisons parent-enfant...';

  FOR v_i IN 1..coalesce(array_length(v_student_ids, 1), 0) LOOP
    v_p := 1 + ((v_i - 1) % v_nb_parents);

    INSERT INTO app.parent_student_links (
      school_id, parent_id, student_id, relationship, status, is_primary,
      requested_at, requested_method, decided_at, decided_by, decision_note)
    SELECT
      v_school,
      v_parent_ids[v_p],
      v_student_ids[v_i],
      p.relationship,
      'actif',
      true,                                   -- responsable principal de l'enfant
      v_t0 - interval '45 days',
      'code_enfant',
      v_t0 - interval '44 days',
      v_staff_dir,
      'Liaison validée par la direction (mode automatique).'
    FROM app.parents p
    WHERE p.id = v_parent_ids[v_p];
  END LOOP;

  -- Seconds responsables (père et mère pour le même enfant), non principaux
  FOR v_i IN 1..12 LOOP
    v_p := 1 + ((v_i + 13) % v_nb_parents);

    INSERT INTO app.parent_student_links (
      school_id, parent_id, student_id, relationship, status, is_primary,
      requested_at, requested_method, decided_at, decided_by, decision_note)
    SELECT
      v_school, v_parent_ids[v_p], v_student_ids[v_i],
      p.relationship, 'actif', false,
      v_t0 - interval '40 days', 'code_enfant', v_t0 - interval '39 days',
      v_staff_sec, 'Second responsable, sans rattachement principal.'
    FROM app.parents p
    WHERE p.id = v_parent_ids[v_p]
      AND NOT EXISTS (
        SELECT 1 FROM app.parent_student_links l
        WHERE l.parent_id = v_parent_ids[v_p] AND l.student_id = v_student_ids[v_i]);
  END LOOP;

  -- Une liaison laissée EN ATTENTE : l'administration a une demande à valider
  INSERT INTO app.parent_student_links (
    school_id, parent_id, student_id, relationship, status, is_primary,
    requested_at, requested_ip, requested_device, requested_method)
  VALUES (
    v_school, v_parent_ids[v_nb_parents], v_student_ids[7], 'oncle', 'en_attente', false,
    v_t0 - interval '2 days', '41.243.55.87'::inet, 'Téléphone secrétariat', 'code_ecole')
  RETURNING id INTO v_link_pending;

  SELECT l.id INTO v_link_id
  FROM app.parent_student_links l
  WHERE l.school_id = v_school AND l.status = 'actif' AND l.is_primary
  ORDER BY l.created_at, l.id
  LIMIT 1;

  -- =========================================================================
  -- 11. PRÉSENCES DES 20 DERNIERS JOURS OUVRÉS
  -- =========================================================================
  --  Une ligne par élève et par jour (contrainte UNIQUE (student_id,
  --  attendance_date)) : le produit cartésien élèves × jours garantit
  --  l'unicité. Pondération réaliste : ~88 % présent, 6 % absent, 4 % retard,
  --  1 % départ anticipé, le solde restant « présent ». Les deux jours les plus
  --  récents laissent volontairement des élèves « non_enregistre » pour que
  --  l'alerte « présence non enregistrée » du tableau de bord soit visible.
  --  Un retard a TOUJOURS une heure d'arrivée (contrainte att_late_needs_time).
  RAISE NOTICE '11/18 — Présences des 20 derniers jours ouvrés...';

  INSERT INTO app.attendance (
    school_id, student_id, class_id, section_id, attendance_date,
    status, arrival_time, departure_time,
    recorded_by, recorded_by_name, method, client_uuid, recorded_at)
  SELECT
    v_school,
    x.student_id,
    x.class_id,
    x.section_id,
    x.day,
    x.statut,
    -- Heure d'arrivée : 07:45-08:40 pour un retard, 07:15-07:45 sinon
    CASE
      WHEN x.statut = 'retard'
        THEN time '07:45' + make_interval(mins =>
               mod(abs(hashtext(x.student_id::text || x.day::text || 'a')::bigint), 56)::int)
      WHEN x.statut IN ('present', 'depart_anticipe')
        THEN time '07:15' + make_interval(mins =>
               mod(abs(hashtext(x.student_id::text || x.day::text || 'a')::bigint), 31)::int)
    END,
    -- Départ anticipé : sortie en milieu de matinée
    CASE
      WHEN x.statut = 'depart_anticipe'
        THEN time '10:30' + make_interval(mins =>
               mod(abs(hashtext(x.student_id::text || x.day::text || 'd')::bigint), 31)::int)
    END,
    CASE mod(abs(hashtext(x.student_id::text || x.day::text || 's')::bigint), 3)
      WHEN 0 THEN v_staff_dir WHEN 1 THEN v_staff_sec ELSE v_staff_pres END,
    CASE mod(abs(hashtext(x.student_id::text || x.day::text || 's')::bigint), 3)
      WHEN 0 THEN 'Joseph Mukendi' WHEN 1 THEN 'Marie Kabeya' ELSE 'Paul Ilunga' END,
    CASE WHEN x.statut = 'present'
              AND mod(abs(hashtext(x.student_id::text || x.day::text || 'm')::bigint), 4) = 0
         THEN 'tout_present'::app.attendance_method
         ELSE 'manuel_classe'::app.attendance_method END,
    gen_random_uuid(),                       -- idempotence de synchronisation
    x.day::timestamp + time '08:05'
  FROM (
    SELECT
      s.id          AS student_id,
      s.class_id,
      s.section_id,
      d.day,
      d.rn,
      CASE
        -- Deux jours les plus récents : ~1 élève sur 8 non enregistré
        WHEN d.rn <= 2
             AND mod(abs(hashtext(s.id::text || 'nonenr')::bigint), 8) = 0
          THEN 'non_enregistre'::app.attendance_status
        WHEN mod(abs(hashtext(s.id::text || d.day::text)::bigint), 100) <= 87
          OR mod(abs(hashtext(s.id::text || d.day::text)::bigint), 100) = 99
          THEN 'present'::app.attendance_status
        WHEN mod(abs(hashtext(s.id::text || d.day::text)::bigint), 100) <= 93
          THEN 'absent'::app.attendance_status
        WHEN mod(abs(hashtext(s.id::text || d.day::text)::bigint), 100) <= 97
          THEN 'retard'::app.attendance_status
        ELSE 'depart_anticipe'::app.attendance_status
      END AS statut
    FROM app.students s
    CROSS JOIN (
      -- Les 20 derniers jours OUVRÉS (samedis et dimanches exclus)
      SELECT g::date AS day,
             row_number() OVER (ORDER BY g::date DESC) AS rn
      FROM generate_series(current_date - 34, current_date, interval '1 day') AS g
      WHERE extract(isodow FROM g) < 6
    ) d
    WHERE s.school_id = v_school
      AND s.status = 'actif'
      AND d.rn <= 20
  ) x;

  -- =========================================================================
  -- 12. MODÈLES ET COMMUNIQUÉS
  -- =========================================================================
  RAISE NOTICE '12/18 — Modèles et communiqués...';

  -- Modèles réutilisables : les variables entre crochets sont résolues à la
  -- publication par l'API ([NOM_ECOLE], [DATE], [OBJET], [MESSAGE], [SIGNATURE]).
  INSERT INTO app.announcement_templates (
    school_id, name, kind, source_format, body_html, variables, is_default, is_active)
  VALUES (
    v_school, 'Communiqué officiel', 'communique_officiel', 'html',
    $html$<div class="communique">
  <p class="entete"><strong>[NOM_ECOLE]</strong></p>
  <p>Kinshasa, le [DATE]</p>
  <p><strong>Objet : [OBJET]</strong></p>
  <p>[MESSAGE]</p>
  <p class="signature">[SIGNATURE]</p>
</div>$html$,
    '["NOM_ECOLE","DATE","OBJET","MESSAGE","SIGNATURE"]'::jsonb, true, true)
  RETURNING id INTO v_tmpl_off;

  INSERT INTO app.announcement_templates (
    school_id, name, kind, source_format, body_html, variables, is_default, is_active)
  VALUES (
    v_school, 'Convocation réunion de parents', 'reunion_parents', 'html',
    $html$<div class="communique">
  <p><strong>[NOM_ECOLE]</strong></p>
  <p>Kinshasa, le [DATE]</p>
  <p><strong>Objet : [OBJET]</strong></p>
  <p>[MESSAGE]</p>
  <p>Votre présence est indispensable. Merci de vous présenter avec la carte de l'élève.</p>
  <p class="signature">[SIGNATURE]</p>
</div>$html$,
    '["NOM_ECOLE","DATE","OBJET","MESSAGE","SIGNATURE"]'::jsonb, false, true)
  RETURNING id INTO v_tmpl_reu;

  INSERT INTO app.announcement_templates (
    school_id, name, kind, source_format, body_html, variables, is_default, is_active)
  VALUES (
    v_school, 'Calendrier des examens', 'examens', 'html',
    $html$<div class="communique">
  <p><strong>[NOM_ECOLE]</strong></p>
  <p>Kinshasa, le [DATE]</p>
  <p><strong>Objet : [OBJET]</strong></p>
  <p>[MESSAGE]</p>
  <p>Les élèves doivent se présenter 30 minutes avant le début de chaque épreuve,
     munis de leur carte et de leur matériel.</p>
  <p class="signature">[SIGNATURE]</p>
</div>$html$,
    '["NOM_ECOLE","DATE","OBJET","MESSAGE","SIGNATURE"]'::jsonb, false, true)
  RETURNING id INTO v_tmpl_exa;

  -- 1) Communiqué général publié
  INSERT INTO app.announcements (
    school_id, academic_year_id, template_id, reference, kind, title, subject,
    summary, body_html, body_text, is_urgent, audience_kind, audience_filter,
    status, published_at, created_by, created_by_name, updated_by, updated_by_name)
  VALUES (
    v_school, v_y2, v_tmpl_off, 'COMM-2026-001', 'communique',
    'Rentrée scolaire 2026-2027', 'Organisation de la rentrée',
    'Modalités pratiques de la rentrée du 1er septembre 2026.',
    $html$<div class="communique">
  <p><strong>École Demonstration MwanaClasse</strong></p>
  <p>Kinshasa, le 25/08/2026</p>
  <p><strong>Objet : Organisation de la rentrée</strong></p>
  <p>La rentrée scolaire 2026-2027 est fixée au mardi 1er septembre 2026 à 07h15.
     Les listes de classe seront affichées à l'entrée principale et disponibles
     dans l'application pour chaque parent.</p>
  <p>Joseph Mukendi — Directeur</p>
</div>$html$,
    'Rentrée scolaire 2026-2027 fixée au 1er septembre 2026 à 07h15.',
    false, 'toute_ecole', '{}'::jsonb,
    'publie', v_t0 - interval '10 days', v_staff_dir, 'Joseph Mukendi',
    v_staff_dir, 'Joseph Mukendi')
  RETURNING id INTO v_ann_gen;

  -- 2) Communiqué URGENT publié
  INSERT INTO app.announcements (
    school_id, academic_year_id, template_id, reference, kind, title, subject,
    summary, body_html, body_text, is_urgent, audience_kind, audience_filter,
    status, published_at, created_by, created_by_name, updated_by, updated_by_name)
  VALUES (
    v_school, v_y2, v_tmpl_off, 'COMM-2026-002', 'urgent',
    'Modification exceptionnelle des horaires', 'Fermeture anticipée vendredi',
    'Les cours s''arrêtent à 11h00 vendredi en raison de travaux dans la commune.',
    $html$<div class="communique urgent">
  <p><strong>École Demonstration MwanaClasse</strong></p>
  <p>Kinshasa, le 29/09/2026</p>
  <p><strong>Objet : Fermeture anticipée vendredi</strong></p>
  <p>En raison de travaux sur l'avenue de la Paix, les cours s'arrêteront
     exceptionnellement à 11h00 vendredi. Les enfants seront remis aux parents
     ou aux personnes autorisées à la sortie de 11h00.</p>
  <p>Joseph Mukendi — Directeur</p>
</div>$html$,
    'Sortie exceptionnelle à 11h00 vendredi — travaux avenue de la Paix.',
    true, 'toute_ecole', '{}'::jsonb,
    'publie', v_t0 - interval '3 days', v_staff_dir, 'Joseph Mukendi',
    v_staff_sec, 'Marie Kabeya')
  RETURNING id INTO v_ann_urg;

  -- 3) Communiqué ciblé sur des classes précises (audience_filter.class_ids)
  INSERT INTO app.announcements (
    school_id, academic_year_id, template_id, reference, kind, title, subject,
    summary, body_html, body_text, is_urgent, audience_kind, audience_filter,
    status, published_at, created_by, created_by_name, updated_by, updated_by_name)
  SELECT
    v_school, v_y2, v_tmpl_exa, 'COMM-2026-003', 'invitation',
    'Réunion des parents de 6ème Primaire et 1ère Secondaire',
    'Préparation des examens de fin de cycle',
    'Réunion le samedi 10 octobre 2026 à 09h00 en salle polyvalente.',
    $html$<div class="communique">
  <p><strong>École Demonstration MwanaClasse</strong></p>
  <p>Kinshasa, le 01/10/2026</p>
  <p><strong>Objet : Préparation des examens de fin de cycle</strong></p>
  <p>Les parents des élèves de 6ème Primaire et de 1ère Secondaire sont conviés
     à une réunion d'information le samedi 10 octobre 2026 à 09h00.</p>
  <p>Joseph Mukendi — Directeur</p>
</div>$html$,
    'Réunion des parents de 6ème Primaire et 1ère Secondaire le 10/10/2026.',
    false, 'classe',
    jsonb_build_object('class_ids', to_jsonb(ARRAY(
      SELECT c.id FROM app.classes c
       WHERE c.school_id = v_school AND c.academic_year_id = v_y2
         AND c.name IN ('6ème Primaire', '1ère Secondaire')))),
    'publie', v_t0 - interval '2 days', v_staff_sec, 'Marie Kabeya',
    v_staff_sec, 'Marie Kabeya'
  RETURNING id INTO v_ann_cls;

  -- 4) Brouillon (jamais publié)
  INSERT INTO app.announcements (
    school_id, academic_year_id, template_id, reference, kind, title, subject,
    summary, body_html, is_urgent, audience_kind, status,
    created_by, created_by_name, updated_by, updated_by_name)
  VALUES (
    v_school, v_y2, v_tmpl_reu, 'COMM-2026-004', 'reunion',
    'Projet — Journée portes ouvertes', 'Journée portes ouvertes',
    'Brouillon en relecture avant diffusion.',
    $html$<div class="communique">
  <p><strong>École Demonstration MwanaClasse</strong></p>
  <p>Kinshasa, le [DATE]</p>
  <p><strong>Objet : Journée portes ouvertes</strong></p>
  <p>[MESSAGE]</p>
  <p>[SIGNATURE]</p>
</div>$html$,
    false, 'toute_ecole', 'brouillon',
    v_staff_sec, 'Marie Kabeya', v_staff_sec, 'Marie Kabeya')
  RETURNING id INTO v_ann_bro;

  -- 5) Communiqué programmé (publish_at dans quatre jours)
  INSERT INTO app.announcements (
    school_id, academic_year_id, template_id, reference, kind, title, subject,
    summary, body_html, is_urgent, audience_kind, status, publish_at,
    created_by, created_by_name, updated_by, updated_by_name)
  VALUES (
    v_school, v_y2, v_tmpl_reu, 'COMM-2026-005', 'reunion',
    'Réunion générale des parents — 1er trimestre', 'Réunion trimestrielle',
    'Diffusion programmée : convocation à la réunion du premier trimestre.',
    $html$<div class="communique">
  <p><strong>École Demonstration MwanaClasse</strong></p>
  <p><strong>Objet : Réunion trimestrielle des parents</strong></p>
  <p>La réunion du premier trimestre se tiendra le samedi 17 octobre 2026 à 09h00.
     La présence de chaque responsable est souhaitée.</p>
  <p>Joseph Mukendi — Directeur</p>
</div>$html$,
    false, 'toute_ecole', 'programme', v_t0 + interval '4 days',
    v_staff_dir, 'Joseph Mukendi', v_staff_dir, 'Joseph Mukendi')
  RETURNING id INTO v_ann_prog;

  -- 6) Communiqué archivé (année précédente)
  INSERT INTO app.announcements (
    school_id, academic_year_id, template_id, reference, kind, title, subject,
    summary, body_html, is_urgent, audience_kind, status,
    published_at, archived_at, created_by, created_by_name, updated_by, updated_by_name)
  VALUES (
    v_school, v_y1, v_tmpl_off, 'COMM-2025-014', 'administratif',
    'Remise des bulletins de fin d''année 2025-2026', 'Remise des bulletins',
    'Communiqué de fin d''année, conservé pour l''historique.',
    $html$<div class="communique">
  <p><strong>École Demonstration MwanaClasse</strong></p>
  <p>Kinshasa, le 10/07/2026</p>
  <p><strong>Objet : Remise des bulletins</strong></p>
  <p>Les bulletins de fin d'année sont retirés par les parents au secrétariat
     jusqu'au 20 juillet 2026.</p>
  <p>Joseph Mukendi — Directeur</p>
</div>$html$,
    false, 'toute_ecole', 'archive',
    v_t0 - interval '80 days', v_t0 - interval '70 days',
    v_staff_dir, 'Joseph Mukendi', v_staff_dir, 'Joseph Mukendi')
  RETURNING id INTO v_ann_arc;

  -- Destinataires et accusés de lecture (~2/3 lus, 1/3 non lus)
  RAISE NOTICE '12/18 — Destinataires et accusés de lecture...';

  INSERT INTO app.announcement_recipients (
    announcement_id, school_id, parent_id, student_id,
    delivered_at, read_at, deliver_channel, push_sent_at)
  SELECT
    v_ann_gen, v_school, l.parent_id, l.student_id,
    v_t0 - interval '10 days',
    CASE WHEN mod(abs(hashtext(l.id::text)::bigint), 3) <> 0
         THEN v_t0 - interval '10 days' + interval '4 hours' END,
    'interne',
    v_t0 - interval '10 days' + interval '1 minute'
  FROM app.parent_student_links l
  WHERE l.school_id = v_school AND l.status = 'actif';

  INSERT INTO app.announcement_recipients (
    announcement_id, school_id, parent_id, student_id,
    delivered_at, read_at, deliver_channel, push_sent_at)
  SELECT
    v_ann_urg, v_school, l.parent_id, l.student_id,
    v_t0 - interval '3 days',
    CASE WHEN mod(abs(hashtext(l.id::text || 'u')::bigint), 2) = 0
         THEN v_t0 - interval '3 days' + interval '35 minutes' END,
    'push',
    v_t0 - interval '3 days' + interval '1 minute'
  FROM app.parent_student_links l
  WHERE l.school_id = v_school AND l.status = 'actif';

  INSERT INTO app.announcement_recipients (
    announcement_id, school_id, parent_id, student_id,
    delivered_at, read_at, deliver_channel, push_sent_at)
  SELECT
    v_ann_cls, v_school, l.parent_id, l.student_id,
    v_t0 - interval '2 days',
    CASE WHEN mod(abs(hashtext(l.id::text || 'c')::bigint), 3) <> 0
         THEN v_t0 - interval '2 days' + interval '6 hours' END,
    'interne',
    v_t0 - interval '2 days' + interval '1 minute'
  FROM app.parent_student_links l
  JOIN app.students s ON s.id = l.student_id
  JOIN app.classes  c ON c.id = s.class_id
  WHERE l.school_id = v_school
    AND l.status = 'actif'
    AND c.name IN ('6ème Primaire', '1ère Secondaire');

  -- =========================================================================
  -- 13. DEMANDES DES PARENTS ET FILS DE DISCUSSION
  -- =========================================================================
  RAISE NOTICE '13/18 — Demandes des parents...';

  INSERT INTO app.requests (
    school_id, reference, parent_id, student_id, kind, subject, message, status,
    priority, assigned_to, assigned_to_name, handled_at, client_uuid, created_at)
  VALUES (
    v_school, 'REQ-2026-0001', v_parent_ids[1], v_student_ids[1],
    'reclamation', 'Erreur sur le nom de famille de mon enfant',
    'Bonjour, le nom de famille de mon enfant est orthographié différemment sur la liste affichée. Pourriez-vous corriger ?',
    'en_cours', 2, v_staff_sec, 'Marie Kabeya', NULL, gen_random_uuid(),
    v_t0 - interval '6 days')
  RETURNING id INTO v_req1;

  INSERT INTO app.requests (
    school_id, reference, parent_id, student_id, kind, subject, message, status,
    priority, assigned_to, assigned_to_name, handled_at, client_uuid, created_at)
  VALUES (
    v_school, 'REQ-2026-0002', v_parent_ids[4], v_student_ids[4],
    'demande_information', 'Fournitures scolaires pour la 2ème Primaire',
    'Bonjour, pourriez-vous me communiquer la liste des fournitures demandées pour la 2ème Primaire ?',
    'repondu', 3, v_staff_sec, 'Marie Kabeya', v_t0 - interval '4 days',
    gen_random_uuid(), v_t0 - interval '5 days')
  RETURNING id INTO v_req2;

  INSERT INTO app.requests (
    school_id, reference, parent_id, student_id, kind, subject, message, status,
    priority, absence_date, absence_reason, justification_decision,
    assigned_to, assigned_to_name, handled_at, client_uuid, created_at)
  VALUES (
    v_school, 'REQ-2026-0003', v_parent_ids[3], v_student_ids[3],
    'justification_absence', 'Justification d''absence pour consultation médicale',
    'Bonjour, mon enfant était absent le 24 septembre : il était en consultation à l''hôpital. Le certificat est joint.',
    'repondu', 2, current_date - 8, 'Consultation médicale à l''hôpital (certificat joint)',
    'acceptee', v_staff_dir, 'Joseph Mukendi', v_t0 - interval '2 days',
    gen_random_uuid(), v_t0 - interval '3 days')
  RETURNING id INTO v_req3;

  INSERT INTO app.requests (
    school_id, reference, parent_id, student_id, kind, subject, message, status,
    priority, client_uuid, created_at)
  VALUES (
    v_school, 'REQ-2026-0004', v_parent_ids[6], v_student_ids[6],
    'question_presence', 'Présence du 29 septembre non enregistrée',
    'Bonjour, mon enfant était bien présent le 29 septembre mais l''application indique « non enregistré ». Pouvez-vous vérifier ?',
    'en_attente', 2, gen_random_uuid(), v_t0 - interval '1 day')
  RETURNING id INTO v_req4;

  INSERT INTO app.requests (
    school_id, reference, parent_id, student_id, kind, subject, message, status,
    priority, assigned_to, assigned_to_name, handled_at, closed_at, closed_by_name,
    client_uuid, created_at)
  VALUES (
    v_school, 'REQ-2026-0005', v_parent_ids[9], v_student_ids[9],
    'demande_derogation', 'Demande de dérogation pour la sortie de 12h00',
    'Bonjour, je souhaite que mon enfant puisse sortir à 12h00 le mercredi pour un suivi orthophonique.',
    'cloture', 3, v_staff_dir, 'Joseph Mukendi', v_t0 - interval '15 days',
    v_t0 - interval '12 days', 'Joseph Mukendi', gen_random_uuid(), v_t0 - interval '18 days')
  RETURNING id INTO v_req5;

  INSERT INTO app.requests (
    school_id, reference, parent_id, student_id, kind, subject, message, status,
    priority, client_uuid, created_at)
  VALUES (
    v_school, 'REQ-2026-0006', v_parent_ids[12], v_student_ids[12],
    'correction_information', 'Mise à jour du numéro de téléphone',
    'Bonjour, merci de mettre à jour mon numéro de téléphone dans le dossier de mon enfant.',
    'en_attente', 4, gen_random_uuid(), v_t0 - interval '10 hours')
  RETURNING id INTO v_req6;

  INSERT INTO app.requests (
    school_id, reference, parent_id, student_id, kind, subject, message, status,
    priority, client_uuid, created_at, closed_at, closed_by_name)
  VALUES (
    v_school, 'REQ-2026-0007', v_parent_ids[15], v_student_ids[15],
    'autre', 'Demande retirée par le parent',
    'Bonjour, finalement je n''ai plus besoin de cette démarche. Merci d''annuler ma demande.',
    'annule', 4, gen_random_uuid(), v_t0 - interval '8 days',
    v_t0 - interval '7 days', 'Marie Kabeya')
  RETURNING id INTO v_req7;

  -- Fils de discussion : message du parent puis réponse de l'administration
  INSERT INTO app.request_messages (request_id, author_type, author_id, author_name, body, created_at)
  VALUES
    (v_req1, 'parent', v_parent_ids[1], 'MUKENDI Joseph',
     'Bonjour, le nom de famille de mon enfant est orthographié différemment sur la liste affichée. Pourriez-vous corriger ?',
     v_t0 - interval '6 days'),
    (v_req1, 'ecole', v_staff_sec, 'Marie Kabeya',
     'Bonjour, nous vérifions le dossier avec l''état civil et revenons vers vous avant vendredi.',
     v_t0 - interval '5 days'),
    (v_req2, 'parent', v_parent_ids[4], 'NSIMBA Chantal',
     'Bonjour, pourriez-vous me communiquer la liste des fournitures demandées pour la 2ème Primaire ?',
     v_t0 - interval '5 days'),
    (v_req2, 'ecole', v_staff_sec, 'Marie Kabeya',
     'Bonjour, la liste est disponible dans « Documents » de l''application et au secrétariat.',
     v_t0 - interval '4 days'),
    (v_req3, 'parent', v_parent_ids[3], 'ILUNGA Patrick',
     'Bonjour, mon enfant était absent le 24 septembre : il était en consultation à l''hôpital. Le certificat est joint.',
     v_t0 - interval '3 days'),
    (v_req3, 'ecole', v_staff_dir, 'Joseph Mukendi',
     'Justification acceptée : l''absence sera régularisée et n''apparaîtra plus comme injustifiée.',
     v_t0 - interval '2 days'),
    (v_req4, 'parent', v_parent_ids[6], 'NGOY Alphonse',
     'Bonjour, mon enfant était bien présent le 29 septembre mais l''application indique « non enregistré ».',
     v_t0 - interval '1 day'),
    (v_req5, 'parent', v_parent_ids[9], 'MAKIESE Bernadette',
     'Bonjour, je souhaite une dérogation pour une sortie à 12h00 le mercredi.',
     v_t0 - interval '18 days'),
    (v_req5, 'ecole', v_staff_dir, 'Joseph Mukendi',
     'Dérogation accordée pour le mercredi jusqu''à la fin du premier trimestre.',
     v_t0 - interval '15 days'),
    (v_req5, 'ecole', v_staff_dir, 'Joseph Mukendi',
     'Dossier clôturé : la dérogation a été transmise aux surveillants.',
     v_t0 - interval '12 days');

  -- =========================================================================
  -- 14. CALENDRIER SCOLAIRE 2026-2027
  -- =========================================================================
  RAISE NOTICE '14/18 — Calendrier scolaire...';

  INSERT INTO app.calendar_events (
    school_id, academic_year_id, kind, title, description, starts_on, ends_on,
    start_time, end_time, all_day, location, audience_kind, audience_filter,
    is_published, created_by_name)
  SELECT
    v_school, v_y2, t.kind::app.calendar_event_kind, t.title, t.description,
    t.starts_on::date, t.ends_on::date, t.start_time::time, t.end_time::time,
    t.all_day::boolean, t.location, t.audience_kind::app.audience_kind,
    coalesce(t.audience_filter, '{}'::jsonb), true, t.created_by
  FROM (VALUES
    ('rentree', 'Rentrée scolaire 2026-2027',
     'Accueil des élèves à partir de 07h15, présentation des titulaires.',
     '2026-09-01', NULL, '07:15', '12:00', false, 'Cour principale',
     'toute_ecole', NULL::jsonb, 'Joseph Mukendi'),
    ('reunion', 'Réunion des parents du 1er trimestre',
     'Rencontre entre les parents et les titulaires de classe.',
     '2026-10-17', NULL, '09:00', '12:00', false, 'Salle polyvalente',
     'toute_ecole', NULL, 'Joseph Mukendi'),
    ('examen', 'Examens du premier trimestre',
     'Épreuves de fin de premier trimestre pour toutes les classes.',
     '2026-12-07', '2026-12-11', '07:30', '12:00', false, 'Salles de classe',
     'toute_ecole', NULL, 'Marie Kabeya'),
    ('vacances', 'Vacances de Noël',
     'Fermeture de l''établissement pour les vacances de fin d''année.',
     '2026-12-19', '2027-01-04', NULL, NULL, true, NULL,
     'toute_ecole', NULL, 'Marie Kabeya'),
    ('reunion', 'Remise des bulletins du 1er trimestre',
     'Remise des bulletins aux parents, classe par classe.',
     '2027-01-16', NULL, '09:00', '13:00', false, 'Salle polyvalente',
     'toute_ecole', NULL, 'Marie Kabeya'),
    ('journee_speciale', 'Journée de la femme',
     'Activités culturelles et exposés préparés par les élèves.',
     '2027-03-08', NULL, '08:00', '12:00', false, 'Cour principale',
     'toute_ecole', NULL, 'Joseph Mukendi'),
    ('evenement', 'Sortie scolaire — Musée national',
     'Sortie pédagogique réservée aux classes de 5ème et 6ème Primaire.',
     '2027-04-24', NULL, '08:00', '15:00', false, 'Musée national de Kinshasa',
     'classe', jsonb_build_object('class_ids', to_jsonb(ARRAY(
       SELECT c.id FROM app.classes c
        WHERE c.school_id = v_school AND c.academic_year_id = v_y2
          AND c.name IN ('5ème Primaire', '6ème Primaire')))),
     'Joseph Mukendi'),
    ('conge', 'Fête du Travail',
     'Établissement fermé.',
     '2027-05-01', NULL, NULL, NULL, true, NULL,
     'toute_ecole', NULL, 'Marie Kabeya'),
    ('examen', 'Examens de fin d''année (TENAFEP et EXETAT)',
     'Épreuves nationales de fin de cycle primaire et secondaire.',
     '2027-06-01', '2027-06-20', '07:30', '13:00', false, 'Salles de classe',
     'classe', jsonb_build_object('class_ids', to_jsonb(ARRAY(
       SELECT c.id FROM app.classes c
        WHERE c.school_id = v_school AND c.academic_year_id = v_y2
          AND c.name IN ('6ème Primaire', '2ème Secondaire')))),
     'Joseph Mukendi'),
    ('ferie', 'Fête de l''Indépendance',
     'Établissement fermé — fête nationale.',
     '2027-06-30', NULL, NULL, NULL, true, NULL,
     'toute_ecole', NULL, 'Marie Kabeya'),
    ('autre', 'Clôture de l''année scolaire 2026-2027',
     'Dernier jour de cours et proclamation des résultats.',
     '2027-07-15', NULL, '08:00', '12:00', false, 'Cour principale',
     'toute_ecole', NULL, 'Joseph Mukendi')
  ) AS t(kind, title, description, starts_on, ends_on, start_time, end_time,
         all_day, location, audience_kind, audience_filter, created_by);

  -- =========================================================================
  -- 15. DOCUMENTS DE L'ÉCOLE
  -- =========================================================================
  RAISE NOTICE '15/18 — Documents mis à disposition des parents...';

  INSERT INTO app.school_documents (
    school_id, category, title, description, file_url, file_name, mime_type,
    file_size, sha256, visibility, downloads, is_active, uploaded_by_name)
  VALUES
    (v_school, 'reglement', 'Règlement intérieur 2026-2027',
     'Règles de vie scolaire, discipline, tenue et assiduité.',
     'https://ecole-demo.mwanaclasse.cd/docs/reglement-interieur-2026-2027.pdf',
     'reglement-interieur-2026-2027.pdf', 'application/pdf', 284133,
     encode(digest('reglement-interieur-2026-2027', 'sha256'), 'hex'),
     'parents', 42, true, 'Joseph Mukendi'),
    (v_school, 'calendrier', 'Calendrier scolaire 2026-2027',
     'Dates de rentrée, examens, vacances et réunions de parents.',
     'https://ecole-demo.mwanaclasse.cd/docs/calendrier-scolaire-2026-2027.pdf',
     'calendrier-scolaire-2026-2027.pdf', 'application/pdf', 152480,
     encode(digest('calendrier-scolaire-2026-2027', 'sha256'), 'hex'),
     'parents', 57, true, 'Marie Kabeya'),
    (v_school, 'inscription', 'Formulaire d''inscription 2026-2027',
     'Formulaire à compléter pour toute nouvelle inscription.',
     'https://ecole-demo.mwanaclasse.cd/docs/formulaire-inscription-2026-2027.docx',
     'formulaire-inscription-2026-2027.docx',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 64120,
     encode(digest('formulaire-inscription-2026-2027', 'sha256'), 'hex'),
     'parents', 23, true, 'Marie Kabeya'),
    (v_school, 'circulaire', 'Circulaire n°3 — Fournitures scolaires',
     'Liste des fournitures demandées par niveau pour l''année en cours.',
     'https://ecole-demo.mwanaclasse.cd/docs/circulaire-003-fournitures.pdf',
     'circulaire-003-fournitures.pdf', 'application/pdf', 98640,
     encode(digest('circulaire-003-fournitures', 'sha256'), 'hex'),
     'parents', 31, true, 'Marie Kabeya');

  -- =========================================================================
  -- 16. NOTIFICATIONS
  -- =========================================================================
  RAISE NOTICE '16/18 — Notifications parents et école...';

  -- 6 notifications de présence (les plus récentes, parents principaux)
  INSERT INTO app.notifications (
    school_id, audience, parent_id, kind, title, body, severity,
    entity_type, entity_id, action_url, channels, read_at, pushed_at, created_at)
  SELECT
    v_school, 'parent', l.parent_id, 'presence_enregistree',
    'Présence enregistrée',
    format('La présence de %s a été enregistrée le %s (%s).',
           s.full_name, to_char(a.attendance_date, 'DD/MM/YYYY'), a.status::text),
    CASE WHEN a.status = 'absent' THEN 'attention' ELSE 'info' END,
    'attendance', a.id, '/parent/presences',
    ARRAY['interne', 'push']::sec.notification_channel[],
    CASE WHEN mod(abs(hashtext(a.id::text)::bigint), 2) = 0
         THEN a.recorded_at + interval '3 hours' END,
    a.recorded_at + interval '5 minutes',
    a.recorded_at + interval '5 minutes'
  FROM app.attendance a
  JOIN app.parent_student_links l
    ON l.student_id = a.student_id AND l.is_primary AND l.status = 'actif'
  JOIN app.students s ON s.id = a.student_id
  WHERE a.school_id = v_school
    AND a.status <> 'non_enregistre'
    AND a.attendance_date >= current_date - 3
  ORDER BY a.attendance_date DESC, a.recorded_at DESC
  LIMIT 6;

  -- 3 notifications de nouveau communiqué
  INSERT INTO app.notifications (
    school_id, audience, parent_id, kind, title, body, severity,
    entity_type, entity_id, action_url, channels, read_at, pushed_at, created_at)
  SELECT
    v_school, 'parent', ar.parent_id, 'nouveau_communique',
    'Nouveau communiqué : ' || an.title,
    coalesce(an.summary, 'Un nouveau communiqué est disponible dans l''application.'),
    CASE WHEN an.is_urgent THEN 'urgent' ELSE 'info' END,
    'announcement', an.id, '/parent/communiques',
    ARRAY['interne', 'push']::sec.notification_channel[],
    CASE WHEN mod(abs(hashtext(ar.id::text)::bigint), 3) <> 0
         THEN ar.delivered_at + interval '2 hours' END,
    ar.push_sent_at, ar.delivered_at
  FROM app.announcement_recipients ar
  JOIN app.announcements an ON an.id = ar.announcement_id
  WHERE ar.school_id = v_school AND an.status = 'publie'
  ORDER BY an.published_at DESC
  LIMIT 3;

  -- 3 notifications de réponse de l'administration
  INSERT INTO app.notifications (
    school_id, audience, parent_id, kind, title, body, severity,
    entity_type, entity_id, action_url, channels, read_at, created_at)
  SELECT
    v_school, 'parent', req.parent_id, 'reponse_administration',
    'Réponse de l''administration',
    format('Votre demande « %s » a reçu une réponse.', req.subject),
    'info', 'request', req.id, '/parent/demandes',
    ARRAY['interne']::sec.notification_channel[],
    CASE WHEN mod(abs(hashtext(req.id::text)::bigint), 3) <> 0
         THEN req.handled_at + interval '4 hours' END,
    req.handled_at
  FROM app.requests req
  WHERE req.school_id = v_school AND req.handled_at IS NOT NULL
  ORDER BY req.handled_at DESC
  LIMIT 3;

  -- 3 notifications côté école (centre de notifications de l'administration)
  INSERT INTO app.notifications (
    school_id, audience, kind, title, body, severity,
    entity_type, entity_id, action_url, channels, created_at)
  VALUES
    (v_school, 'ecole', 'lien_a_valider',
     'Nouvelle demande de liaison parent-enfant',
     'Une demande de rattachement attend la validation de l''administration.',
     'attention', 'parent_link', v_link_pending, '/ecole/liens',
     ARRAY['interne']::sec.notification_channel[], v_t0 - interval '2 days'),
    (v_school, 'ecole', 'demande_a_traiter',
     'Demandes en attente de traitement',
     'Des demandes de parents sont en attente : réclamations, questions de présence et corrections.',
     'attention', 'request', v_req4, '/ecole/demandes',
     ARRAY['interne']::sec.notification_channel[], v_t0 - interval '1 day'),
    (v_school, 'ecole', 'alerte_capacite',
     'Capacité des classes à surveiller',
     'Les 3ème Primaire et 6ème Primaire concentrent le plus d''élèves : vérifiez la répartition des sections A et B.',
     'info', 'class', NULL, '/ecole/classes',
     ARRAY['interne']::sec.notification_channel[], v_t0 - interval '6 hours');

  -- =========================================================================
  -- 17. JOURNAL D'AUDIT CHAÎNÉ
  -- =========================================================================
  --  IMPORTANT — deux points sur sec.audit_log :
  --   * `prev_hash` et `entry_hash` sont calculés par le trigger
  --     sec.tg_audit_chain() : la colonne `entry_hash` est NOT NULL et n'est
  --     jamais fournie ici.
  --   * la colonne `signature` n'est PAS calculée par la base : la clé de
  --     signature (poivre d'audit) n'existe volontairement pas dans la base de
  --     données. Les signatures HMAC-SHA256 sont produites par la couche API.
  --     Les entrées ci-dessous laissent donc `signature` à NULL.
  --   * `payload_enc` reste NULL également : en production le détail est
  --     chiffré en AES-256-GCM par l'API avant insertion ; seul `payload_hash`
  --     (empreinte SHA-256) est écrit ici.
  --
  --  Le chaînage impose l'ordre : chaque INSERT est une instruction distincte
  --  d'une seule ligne, afin que le trigger voie le hash de la ligne
  --  précédente. Un INSERT multi-lignes unique casserait la chaîne.
  RAISE NOTICE '17/18 — Journal d''audit chaîné...';

  -- Deux présences réelles servent de références aux entrées d'audit et aux
  -- opérations de synchronisation ci-dessous.
  SELECT a.id INTO v_att_id
  FROM app.attendance a
  WHERE a.school_id = v_school AND a.status <> 'non_enregistre'
  ORDER BY a.attendance_date DESC, a.id
  LIMIT 1;

  SELECT a.id INTO v_att_id2
  FROM app.attendance a
  WHERE a.school_id = v_school AND a.status = 'absent'
  ORDER BY a.attendance_date DESC, a.id
  LIMIT 1;

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '400 days', v_school, 'staff', v_staff_dir, 'Joseph Mukendi',
    '41.243.10.11'::inet, 'Navigateur — secrétariat',
    'school.create', 'school', v_school, 'École Demonstration MwanaClasse',
    'notice', 'succes',
    encode(digest('school.create|MC-ECOLE-DEMO01', 'sha256'), 'hex'),
    '{"canal": "api", "jeu_de_donnees": "demonstration"}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '395 days', v_school, 'staff', v_staff_dir, 'Joseph Mukendi',
    '41.243.10.11'::inet, 'Navigateur — secrétariat',
    'academic_year.create', 'academic_year', v_y2, '2026-2027',
    'info', 'succes',
    encode(digest('academic_year.create|2026-2027', 'sha256'), 'hex'),
    '{"starts_on": "2026-09-01", "ends_on": "2027-07-15"}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '390 days', v_school, 'staff', v_staff_dir, 'Joseph Mukendi',
    '41.243.10.11'::inet, 'Navigateur — secrétariat',
    'class.create', 'class', v_prev_class, '2ème Secondaire',
    'info', 'succes',
    encode(digest('class.create|2ème Secondaire', 'sha256'), 'hex'),
    '{"classe": "2ème Secondaire", "max_capacity": 55}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '380 days', v_school, 'staff', v_staff_dir, 'Joseph Mukendi',
    '41.243.10.11'::inet, 'Navigateur — secrétariat',
    'staff.create', 'staff_user', v_staff_sec, 'Marie Kabeya',
    'warning', 'succes',
    encode(digest('staff.create|secretaire@ecole-demo.cd', 'sha256'), 'hex'),
    '{"action_sensible": "staff.create", "role": "secretaire"}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '120 days', v_school, 'staff', v_staff_sec, 'Marie Kabeya',
    '41.243.10.42'::inet, 'Téléphone secrétariat',
    'student.create', 'student', v_student_ids[1], 'Premier élève inscrit',
    'info', 'succes',
    encode(digest('student.create|' || v_student_ids[1]::text, 'sha256'), 'hex'),
    '{"classe": "1ère Primaire", "section": "Unique"}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '110 days', v_school, 'staff', v_staff_sec, 'Marie Kabeya',
    '41.243.10.42'::inet, 'Navigateur — secrétariat',
    'import.eleves', 'import_job', NULL, 'eleves-2026-2027.xlsx',
    'notice', 'succes',
    encode(digest('import.eleves|eleves-2026-2027.xlsx', 'sha256'), 'hex'),
    '{"lignes": 60, "importees": 60, "erreurs": 0}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '20 days', v_school, 'staff', v_staff_pres, 'Paul Ilunga',
    '41.243.10.57'::inet, 'Tablette entrée',
    'attendance.bulk_create', 'class', v_class_id, 'Appel du jour',
    'info', 'succes',
    encode(digest('attendance.bulk_create|appel-du-jour', 'sha256'), 'hex'),
    '{"methode": "tout_present", "eleves": 11}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '9 days', v_school, 'staff', v_staff_pres, 'Paul Ilunga',
    '41.243.10.57'::inet, 'Tablette entrée',
    'attendance.update', 'attendance', v_att_id, 'Correction de présence',
    'notice', 'succes',
    encode(digest('attendance.update|correction', 'sha256'), 'hex'),
    '{"motif": "erreur de saisie", "nouveau_statut": "present"}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '10 days', v_school, 'staff', v_staff_dir, 'Joseph Mukendi',
    '41.243.10.11'::inet, 'Navigateur — direction',
    'announcement.publish', 'announcement', v_ann_gen, 'Rentrée scolaire 2026-2027',
    'notice', 'succes',
    encode(digest('announcement.publish|COMM-2026-001', 'sha256'), 'hex'),
    '{"audience": "toute_ecole", "canal": "push"}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '3 days', v_school, 'staff', v_staff_dir, 'Joseph Mukendi',
    '41.243.10.11'::inet, 'Navigateur — direction',
    'announcement.publish', 'announcement', v_ann_urg, 'Modification exceptionnelle des horaires',
    'warning', 'succes',
    encode(digest('announcement.publish|COMM-2026-002', 'sha256'), 'hex'),
    '{"audience": "toute_ecole", "urgent": true}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '44 days', v_school, 'staff', v_staff_dir, 'Joseph Mukendi',
    '41.243.10.11'::inet, 'Navigateur — direction',
    'parent_link.validate', 'parent_link', v_link_id, 'Liaison parent-enfant validée',
    'notice', 'succes',
    encode(digest('parent_link.validate|' || coalesce(v_link_id::text, ''), 'sha256'), 'hex'),
    '{"mode": "automatique", "decision": "validee"}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '2 days', v_school, 'parent', v_parent_ids[v_nb_parents], 'LOFEMBE Marthe',
    '41.243.55.87'::inet, 'Téléphone secrétariat',
    'parent_link.request', 'parent_link', v_link_pending, 'Demande de liaison en attente',
    'info', 'succes',
    encode(digest('parent_link.request|' || coalesce(v_link_pending::text, ''), 'sha256'), 'hex'),
    '{"methode": "code_ecole"}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '3 hours', v_school, 'staff', v_staff_dir, 'Joseph Mukendi',
    '41.243.10.11'::inet, 'Navigateur — direction',
    'auth.login', 'staff_user', v_staff_dir, 'Joseph Mukendi',
    'debug', 'succes',
    encode(digest('auth.login|directeur@ecole-demo.cd', 'sha256'), 'hex'),
    '{"mfa": false, "resultat": "succes"}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_label, actor_ip, actor_device,
    action, entity_type, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '26 hours', v_school, 'anonyme', 'Identifiant inconnu',
    '196.25.14.203'::inet, 'Navigateur inconnu',
    'auth.login_failed', 'staff_user',
    'warning', 'echec',
    encode(digest('auth.login_failed|196.25.14.203', 'sha256'), 'hex'),
    '{"motif": "mot_de_passe", "tentatives_24h": 3}'::jsonb);

  INSERT INTO sec.audit_log (
    occurred_at, school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
    action, entity_type, entity_id, entity_label, severity, result, payload_hash, metadata)
  VALUES (
    v_t0 - interval '30 hours', v_school, 'staff', v_staff_dir, 'Joseph Mukendi',
    '41.243.10.11'::inet, 'Navigateur — direction',
    'export.eleves', 'school', v_school, 'Liste des élèves 2026-2027',
    'warning', 'succes',
    encode(digest('export.eleves|2026-2027', 'sha256'), 'hex'),
    '{"format": "xlsx", "lignes": 60, "motif": "rapport de direction"}'::jsonb);

  -- =========================================================================
  -- 18. DONNÉES DE SYNCHRONISATION OFFLINE
  -- =========================================================================
  RAISE NOTICE '18/18 — Synchronisation hors ligne (terminaux, lot, conflit)...';

  -- Terminaux : identifiants générés par les appareils eux-mêmes
  INSERT INTO sync.clients (
    id, school_id, audience, staff_user_id, label, platform, app_version,
    user_agent, first_seen_at, last_seen_at, last_sync_at, pending_count)
  VALUES
    (v_client_tab, v_school, 'ecole', v_staff_pres, 'Tablette entrée', 'android',
     '1.4.0', 'MwanaClasse-Android/1.4.0', v_t0 - interval '90 days',
     v_t0 - interval '20 minutes', v_t0 - interval '20 minutes', 0),
    (v_client_tel, v_school, 'ecole', v_staff_sec, 'Téléphone secrétariat', 'android',
     '1.4.0', 'MwanaClasse-Android/1.4.0', v_t0 - interval '120 days',
     v_t0 - interval '2 hours', v_t0 - interval '2 hours', 0);

  -- Lot reçu puis appliqué : un appel fait hors ligne sur la tablette d'entrée
  INSERT INTO sync.batches (
    id, school_id, client_id, audience, operation_count, applied_count,
    conflict_count, rejected_count, status, client_created_at, received_at,
    processed_at, duration_ms, summary)
  VALUES (
    v_batch, v_school, v_client_tab, 'ecole', 3, 2, 0, 1, 'partiel',
    v_t0 - interval '2 days' - interval '9 hours',
    v_t0 - interval '2 days' - interval '7 hours',
    v_t0 - interval '2 days' - interval '7 hours' + interval '4 seconds',
    4120,
    '{"source": "tablette_entree", "classe": "3ème Primaire", "methode": "manuel_classe",
      "hors_ligne": true, "rejetees": ["opération sur un élève archivé"]}'::jsonb);

  -- Opérations unitaires : deux appliquées, une rejetée
  INSERT INTO sync.operations (
    op_uuid, batch_id, client_id, school_id, audience, actor_staff_id,
    entity_type, entity_id, op_type, payload, base_version, client_time,
    device_id, status, applied_at, server_version, message)
  VALUES
    (gen_random_uuid(), v_batch, v_client_tab, v_school, 'ecole', v_staff_pres,
     'attendance', v_att_id, 'upsert',
     jsonb_build_object('student_id', v_student_ids[1], 'attendance_date', (current_date - 2)::text,
                        'status', 'present', 'arrival_time', '07:22'),
     0, v_t0 - interval '2 days' - interval '9 hours', 'tablette-entree-01',
     'applied', v_t0 - interval '2 days' - interval '7 hours', 1, 'Présence appliquée.'),
    (gen_random_uuid(), v_batch, v_client_tab, v_school, 'ecole', v_staff_pres,
     'attendance', v_att_id2, 'upsert',
     jsonb_build_object('student_id', v_student_ids[4], 'attendance_date', (current_date - 2)::text,
                        'status', 'retard', 'arrival_time', '08:05'),
     0, v_t0 - interval '2 days' - interval '9 hours' + interval '2 minutes',
     'tablette-entree-01',
     'applied', v_t0 - interval '2 days' - interval '7 hours', 1, 'Retard appliqué après arbitrage.'),
    (gen_random_uuid(), v_batch, v_client_tab, v_school, 'ecole', v_staff_pres,
     'attendance', v_att_id, 'update',
     jsonb_build_object('student_id', v_student_ids[7], 'attendance_date', (current_date - 6)::text,
                        'status', 'present'),
     0, v_t0 - interval '2 days' - interval '9 hours' + interval '4 minutes',
     'tablette-entree-01',
     'rejected', v_t0 - interval '2 days' - interval '7 hours', NULL,
     'Opération rejetée : la ligne visée appartenait déjà à un lot synchronisé plus récent.');

  -- Conflit détecté puis résolu : la version serveur a été conservée et tracée
  INSERT INTO sync.conflicts (
    school_id, entity_type, entity_id, client_id, op_uuid, resolution,
    field_diffs, server_value, client_value, resolved_value,
    resolved_by_name, detected_at, resolved_at)
  VALUES (
    v_school, 'attendance', v_att_id2, v_client_tab, gen_random_uuid(), 'serveur_gagne',
    jsonb_build_array(
      jsonb_build_object('champ', 'status', 'serveur', 'present', 'terminal', 'retard'),
      jsonb_build_object('champ', 'arrival_time', 'serveur', '07:28', 'terminal', '08:05')),
    jsonb_build_object('status', 'present', 'arrival_time', '07:28', 'version', 2),
    jsonb_build_object('status', 'retard', 'arrival_time', '08:05', 'version', 1),
    jsonb_build_object('status', 'present', 'arrival_time', '07:28', 'version', 2),
    'Paul Ilunga',
    v_t0 - interval '2 days' - interval '8 hours',
    v_t0 - interval '2 days' - interval '7 hours');

  -- Journal de changement : ce que les terminaux tirent en delta
  INSERT INTO sync.change_log (
    school_id, entity_type, entity_id, operation, row_version, changed_at,
    changed_by_name, device_id, payload)
  VALUES
    (v_school, 'attendance', v_att_id, 'update', 2,
     v_t0 - interval '2 days' - interval '7 hours', 'Paul Ilunga', 'tablette-entree-01',
     jsonb_build_object('status', 'present', 'arrival_time', '07:22')),
    (v_school, 'announcement', v_ann_cls, 'insert', 1,
     v_t0 - interval '2 days', 'Marie Kabeya', 'navigateur-secretariat',
     jsonb_build_object('titre', 'Réunion des parents de 6ème Primaire et 1ère Secondaire'));

  -- =========================================================================
  --  RÉCAPITULATIF
  -- =========================================================================
  RAISE NOTICE 'Jeu de démonstration chargé avec succès.';
  RAISE NOTICE '  École          : MC-ECOLE-DEMO01 (École Demonstration MwanaClasse)';

  SELECT count(*) INTO v_cnt FROM app.students WHERE school_id = v_school;
  RAISE NOTICE '  Élèves          : %', v_cnt;

  SELECT count(*) INTO v_cnt FROM app.parents;
  RAISE NOTICE '  Parents         : %', v_cnt;

  SELECT count(*) INTO v_cnt FROM app.parent_student_links WHERE school_id = v_school;
  RAISE NOTICE '  Liaisons        : %', v_cnt;

  SELECT count(*) INTO v_cnt FROM app.attendance WHERE school_id = v_school;
  RAISE NOTICE '  Présences       : %', v_cnt;

  SELECT count(*) INTO v_cnt FROM app.announcements WHERE school_id = v_school;
  RAISE NOTICE '  Communiqués     : %', v_cnt;

  SELECT count(*) INTO v_cnt FROM sec.audit_log WHERE school_id = v_school;
  RAISE NOTICE '  Entrées d''audit : %', v_cnt;

  RAISE NOTICE '  Comptes de démonstration (mot de passe : MotDePasseDemo2026!) :';
  RAISE NOTICE '    directeur@ecole-demo.cd / secretaire@ecole-demo.cd / presence@ecole-demo.cd';
  RAISE NOTICE '  >>> À SUPPRIMER OU À CHANGER AVANT TOUTE UTILISATION RÉELLE <<<';
END
$seed$;

-- ---------------------------------------------------------------------------
-- 19. Rétablissement du RLS « FORCED » (état initial de 004_rls_views.sql)
-- ---------------------------------------------------------------------------
--  Indispensable : sans ce rétablissement, le propriétaire des tables
--  contournerait durablement l'isolation par école. En cas d'erreur dans le
--  bloc précédent, la transaction est annulée et ces ALTER ne sont même pas
--  nécessaires : l'état d'origine est restauré par le ROLLBACK.
ALTER TABLE app.schools                 FORCE ROW LEVEL SECURITY;
ALTER TABLE app.academic_years          FORCE ROW LEVEL SECURITY;
ALTER TABLE app.classes                 FORCE ROW LEVEL SECURITY;
ALTER TABLE app.sections                FORCE ROW LEVEL SECURITY;
ALTER TABLE app.students                FORCE ROW LEVEL SECURITY;
ALTER TABLE app.parents                 FORCE ROW LEVEL SECURITY;
ALTER TABLE app.parent_student_links    FORCE ROW LEVEL SECURITY;
ALTER TABLE app.attendance              FORCE ROW LEVEL SECURITY;
ALTER TABLE app.attendance_history      FORCE ROW LEVEL SECURITY;
ALTER TABLE app.announcement_templates  FORCE ROW LEVEL SECURITY;
ALTER TABLE app.announcements           FORCE ROW LEVEL SECURITY;
ALTER TABLE app.announcement_recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE app.requests                FORCE ROW LEVEL SECURITY;
ALTER TABLE app.calendar_events         FORCE ROW LEVEL SECURITY;
ALTER TABLE app.school_documents        FORCE ROW LEVEL SECURITY;
ALTER TABLE app.notifications           FORCE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================================
--  FIN — 006_seed_demo.sql
--  Rappel : données de DÉMONSTRATION. Ne jamais charger en production.
--  Pour supprimer le jeu : voir la note de bas de fichier du projet, ou
--    DELETE FROM app.schools WHERE public_code = 'MC-ECOLE-DEMO01';
--  (les parents de démonstration, non rattachés à une école, sont à supprimer
--   explicitement : DELETE FROM app.parents WHERE email LIKE 'parent%@example.cd';)
-- ============================================================================
