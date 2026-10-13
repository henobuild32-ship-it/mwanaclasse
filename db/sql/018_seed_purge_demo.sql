-- ============================================================================
--  MWANA CLASSE — 018 — PURGE PRODUCTION + JEU DE DÉMONSTRATION COMPLET
-- ============================================================================
--  ⚠️  AVERTISSEMENT — SCRIPT DE DÉMONSTRATION UNIQUEMENT
--  Ce script SUPPRIME TOUTES les données existantes (écoles, parents, élèves,
--  présences, demandes, sessions, abonnements push…) puis recrée un jeu de
--  démonstration cohérent destiné à la mise en production initiale.
--
--  Comptes créés (mots de passe PUBLICS — jamais utiliser en réel) :
--    • École  : mwanaclasse12@gmail.com / 123456ecole
--    • Parent : mwanaclasse@gmail.com  / 123456ecole
--
--  Le poivre (MWANA_PEPPER_PASSWORD) est lu depuis la variable de session
--  « app.seed_pepper », posée par « npm run db:seed -- --force-production ».
--
--  Exécution manuelle (en dehors de db:seed) :
--    node api/src/tools/run-seed-018.cjs
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Neutralisation du RLS FORCED (le temps de la purge + du seed)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'app'
  LOOP
    EXECUTE format('ALTER TABLE app.%I NO FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 1. PURGE COMPLÈTE DE TOUTES LES DONNÉES UTILISATEURS
-- ---------------------------------------------------------------------------
--  On supprime dans l'ordre inverse des dépendances. Les tables avec
--  ON DELETE CASCADE se vident d'elles-mêmes quand on supprime l'école,
--  mais on nettoie aussi les tables sec.* qui ne dépendent pas d'app.schools.
-- ---------------------------------------------------------------------------

-- 1.1 Sessions, tokens, tentatives, verrous, alertes, journal d'audit
DELETE FROM sec.sessions;
DELETE FROM sec.one_time_tokens;
DELETE FROM sec.recovery_codes;
DELETE FROM sec.login_attempts;
DELETE FROM sec.rate_limit_counters;
DELETE FROM sec.lockouts;
DELETE FROM sec.security_alerts;
-- audit_log est en ajout seul (trigger immuable) : TRUNCATE contourne le trigger ligne par ligne
TRUNCATE TABLE sec.audit_log RESTART IDENTITY CASCADE;
DELETE FROM sec.encryption_keys;
DELETE FROM sec.staff_permission_overrides;

-- 1.2 Abonnements push et notifications (liés aux parents / staff)
DELETE FROM app.push_subscriptions;
DELETE FROM app.notifications;

-- 1.3 Demandes et messages
DELETE FROM app.request_messages;
DELETE FROM app.requests;

-- 1.4 Présences et historique
DELETE FROM app.attendance_history;
DELETE FROM app.attendance;

-- 1.5 Communiqués et destinataires
DELETE FROM app.announcement_recipients;
DELETE FROM app.announcements;
DELETE FROM app.announcement_templates;

-- 1.6 Calendrier, documents, imports
DELETE FROM app.calendar_events;
DELETE FROM app.school_documents;
DELETE FROM app.import_jobs;

-- 1.7 Liaisons parent-élève puis parents, élèves, classes, sections
DELETE FROM app.parent_student_links;
DELETE FROM app.parents;
DELETE FROM app.students;
DELETE FROM app.sections;
DELETE FROM app.classes;
DELETE FROM app.academic_years;

-- 1.8 Staff, rôles, puis écoles
DELETE FROM sec.staff_roles;
DELETE FROM sec.role_permissions;
DELETE FROM sec.staff_users;
DELETE FROM sec.roles WHERE school_id IS NOT NULL;   -- rôles système conservés
DELETE FROM app.schools;

-- 1.9 Séquences pour remettre les compteurs à zéro (nettoyage visuel)
ALTER SEQUENCE IF EXISTS app.announcement_recipients_id_seq RESTART WITH 1;

-- Purge complète effectuée — toutes les données utilisateurs supprimées.

-- ---------------------------------------------------------------------------
-- 2. HACHAGE DES MOTS DE PASSE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.demo_password_hash(p_secret text, p_pepper text)
RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT crypt(
    replace(encode(digest(p_secret || p_pepper, 'sha512'), 'base64'), E'\n', ''),
    gen_salt('bf', 12)
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. CRÉATION DU JEU DE DÉMONSTRATION
-- ---------------------------------------------------------------------------
DO $seed$
DECLARE
  v_t0              timestamptz := now();

  -- École, année, rôle, compte école
  v_school          uuid;
  v_year            uuid;
  v_role_dir        uuid;
  v_staff_dir       uuid;

  -- Classes et élèves (5 élèves, 5 classes)
  v_classes         uuid[] := ARRAY[]::uuid[];
  v_students        uuid[] := ARRAY[]::uuid[];
  v_i               int;

  -- Parent
  v_parent          uuid;

  -- Compteurs
  v_presents        int := 0;
  v_absents         int := 0;
  v_retards         int := 0;
  v_justifies       int := 0;

  -- Horodatages
  v_now             timestamptz := now();
  v_today           date := CURRENT_DATE;
  v_d               date;
  v_dow             int;

  -- Réutilisables
  v_student         uuid;
  v_class           uuid;
  v_n               int;
BEGIN
  -- =========================================================================
  -- 3.1 ÉCOLE — Complexe Scolaire MwanaClasse, Kinshasa / Gombe
  -- =========================================================================
  INSERT INTO app.schools (
    id, public_code, slug, official_name, short_name, type,
    address_line, commune, city, province, country,
    phones, phone_contact, email, website, description, opening_hours,
    current_year_label, parent_link_mode, settings,
    signature_name, signature_title, is_active, onboarded_at
  ) VALUES (
    gen_random_uuid(),
    'MC-ECOLE-MWANA1',
    'mwanaclasse',
    'Complexe Scolaire MwanaClasse',
    'MwanaClasse',
    'mixte',
    '12, Avenue de la Justice, Q. Lingwala',
    'Lingwala',
    'Kinshasa',
    'Kinshasa',
    'RDC',
    ARRAY['+243820000001', '+243990000001'],
    '+243820000001',
    'contact@mwanaclasse.cd',
    'https://mwanaclasse.cd',
    'Établissement scolaire moderne offrant un enseignement de qualité du maternel au secondaire, avec un suivi individualisé de chaque élève grâce à la technologie.',
    '07h00 – 16h30, lundi au vendredi',
    '2026-2027',
    'validation',
    '{
      "notify_absence": true,
      "notify_late": true,
      "notify_presence": false,
      "allow_parent_justification": true,
      "require_2fa_staff": false,
      "attendance_day_start": "06:00",
      "attendance_day_end": "18:00"
    }'::jsonb,
    'Dr. Jean-Pierre Kabeya',
    'Directeur Général',
    true,
    v_now - interval '8 months'
  ) RETURNING id INTO v_school;

  -- =========================================================================
  -- 3.2 ANNÉE SCOLAIRE COURANTE
  -- =========================================================================
  INSERT INTO app.academic_years (id, school_id, label, starts_on, ends_on, is_current)
  VALUES (gen_random_uuid(), v_school, '2026-2027', DATE '2026-09-01', DATE '2027-07-02', true)
  RETURNING id INTO v_year;

  -- =========================================================================
  -- 3.3 RÔLE SYSTÈME « directeur » + COMPTE ÉCOLE
  -- =========================================================================
  INSERT INTO sec.roles (id, school_id, code, name, description, is_system)
  VALUES (gen_random_uuid(), NULL, 'directeur', 'Directeur',
          'Responsable de l''établissement — accès complet', true)
  RETURNING id INTO v_role_dir;

  INSERT INTO sec.staff_users (
    id, school_id, email, full_name, job_title, phone,
    password_hash, password_algo, password_pepper_id,
    is_active, is_owner, must_change_password, created_at, updated_at
  ) VALUES (
    gen_random_uuid(),
    v_school,
    'mwanaclasse12@gmail.com',
    'Jean-Pierre Kabeya',
    'Directeur Général',
    '+243820000001',
    app.demo_password_hash('123456ecole', current_setting('app.seed_pepper', true)),
    'bcrypt',
    'v1',
    true,
    true,
    false,
    v_now,
    v_now
  ) RETURNING id INTO v_staff_dir;

  INSERT INTO sec.staff_roles (staff_user_id, role_id, assigned_at, assigned_by)
  VALUES (v_staff_dir, v_role_dir, v_now, v_staff_dir);

  -- =========================================================================
  -- 3.4 CINQ CLASSES (système primaire congolais)
  -- =========================================================================
  INSERT INTO app.classes (id, school_id, academic_year_id, name, level, level_order, max_capacity)
  VALUES
    (gen_random_uuid(), v_school, v_year, '1ère année primaire', 'Primaire', 1, 40),
    (gen_random_uuid(), v_school, v_year, '2ème année primaire', 'Primaire', 2, 40),
    (gen_random_uuid(), v_school, v_year, '3ème année primaire', 'Primaire', 3, 38),
    (gen_random_uuid(), v_school, v_year, '4ème année primaire', 'Primaire', 4, 36),
    (gen_random_uuid(), v_school, v_year, '5ème année primaire', 'Primaire', 5, 35);

  SELECT array_agg(id ORDER BY level_order) INTO v_classes
  FROM app.classes WHERE school_id = v_school AND academic_year_id = v_year;

  -- =========================================================================
  -- 3.5 CINQ ÉLÈVES — un par classe
  -- =========================================================================
  --  Chaque élève reçoit un code public unique (format MC-ELV-XXXXXX)
  --  généré par app.format_student_code(app.random_code(6)) — le même
  --  processus que l'inscription via l'API.
  -- =========================================================================
  INSERT INTO app.students (
    id, school_id, public_code, academic_year_id, class_id,
    last_name, first_name, gender, date_of_birth, place_of_birth,
    status, enrolled_on, extra_info
  )
  SELECT
    gen_random_uuid(),
    v_school,
    app.format_student_code(app.random_code(6)),
    v_year,
    v_classes[s.i],
    s.last_name,
    s.first_name,
    s.gender,
    s.dob,
    'Kinshasa',
    'actif',
    v_today - interval '40 days',
    s.extra
  FROM (VALUES
    (1, 'KABASELE', 'Grâce',    'F', DATE '2018-03-12', '{"tuteur":"M. Kabasele Robert","profession":"Commerçant"}'::jsonb),
    (2, 'MPUTU',    'Junior',   'M', DATE '2017-06-25', '{"tuteur":"Mme Mputu Sarah","profession":"Infirmière"}'::jsonb),
    (3, 'NSIMBA',   'Esther',   'F', DATE '2016-11-08', '{"tuteur":"M. Nsimba Patrick","profession":"Enseignant"}'::jsonb),
    (4, 'LOKOLE',   'David',    'M', DATE '2015-01-30', '{"tuteur":"Mme Lokole Christine","profession":"Secrétaire"}'::jsonb),
    (5, 'MBALA',    'Divine',   'F', DATE '2014-09-14', '{"tuteur":"M. Mbala Alain","profession":"Ingénieur"}'::jsonb)
  ) AS s(i, last_name, first_name, gender, dob, extra);

  SELECT array_agg(id ORDER BY created_at) INTO v_students
  FROM app.students WHERE school_id = v_school;

  -- =========================================================================
  -- 3.6 PARENT — mwanaclasse@gmail.com, lié aux 5 élèves (validé)
  -- =========================================================================
  INSERT INTO app.parents (
    id, public_code, full_name, relationship, email, phone,
    email_verified_at, phone_verified_at,
    preferred_language, notification_prefs, is_active, last_seen_at
  ) VALUES (
    gen_random_uuid(),
    app.format_parent_code(app.random_code(6)),
    'Marie-Claire Mwana',
    'mere',
    'mwanaclasse@gmail.com',
    '+243990000002',
    v_now - interval '3 months',
    v_now - interval '3 months',
    'fr',
    '{
      "push": true,
      "email": true,
      "sms": false,
      "quiet_hours": null,
      "demandes": true,
      "communiques": true,
      "presences": true,
      "calendrier": true,
      "documents": true
    }'::jsonb,
    true,
    v_now - interval '2 hours'
  ) RETURNING id INTO v_parent;

  -- Identifiants de connexion du parent
  INSERT INTO sec.parent_credentials (
    parent_id, password_hash, password_algo, password_pepper_id,
    must_change_password, terms_accepted_at, privacy_accepted_at, last_login_at
  ) VALUES (
    v_parent,
    app.demo_password_hash('123456ecole', current_setting('app.seed_pepper', true)),
    'bcrypt',
    'v1',
    false,
    v_now - interval '3 months',
    v_now - interval '3 months',
    v_now - interval '2 hours'
  );

  -- Liaisons parent-élève — validées côté école uniquement
  INSERT INTO app.parent_student_links (
    school_id, parent_id, student_id, relationship, status,
    is_primary, can_pickup, requested_at, requested_method, decided_at, decided_by
  )
  SELECT v_school, v_parent, s, 'mere', 'actif', true, true,
         v_now - interval '3 months', 'code_ecole', v_now - interval '3 months', v_staff_dir
  FROM unnest(v_students) AS s;

  -- =========================================================================
  -- 3.7 PRÉSENCES — 30 derniers jours ouvrés (lundi → vendredi)
  -- =========================================================================
  --  Répartition réaliste : ~82 % présents, ~10 % absents (motivés ou non),
  --  ~8 % en retard (avec heure d'arrivée).
  -- =========================================================================
  FOR v_i IN 1..30 LOOP
    v_d := v_today - (v_i || ' days')::interval;
    v_dow := EXTRACT(isodow FROM v_d);  -- 1=lundi … 5=vendredi

    -- Seuls les jours ouvrés sont remplis (lundi → vendredi)
    CONTINUE WHEN v_dow > 5;

    FOR v_n IN 1..array_length(v_students, 1) LOOP
      v_student := v_students[v_n];
      v_class   := v_classes[v_n];

      -- Détermination pseudo-aléatoire mais déterministe :
      --  (v_n * 7 + v_i) % 20 → répartition stable et lisible
      IF ((v_n * 7 + v_i) % 20) < 16 THEN
        -- PRÉSENT (80 %)
        INSERT INTO app.attendance (
          school_id, student_id, class_id, attendance_date, status,
          recorded_by, recorded_by_name, method, recorded_at
        ) VALUES (
          v_school, v_student, v_class, v_d, 'present',
          v_staff_dir, 'Jean-Pierre Kabeya', 'manuel_classe', v_now
        );
        v_presents := v_presents + 1;

      ELSIF ((v_n * 7 + v_i) % 20) < 18 THEN
        -- ABSENCE non justifiée (10 %)
        INSERT INTO app.attendance (
          school_id, student_id, class_id, attendance_date, status,
          reason, recorded_by, recorded_by_name, method, recorded_at
        ) VALUES (
          v_school, v_student, v_class, v_d, 'absent',
          'Non renseigné',
          v_staff_dir, 'Jean-Pierre Kabeya', 'manuel_classe', v_now
        );
        v_absents := v_absents + 1;

      ELSIF ((v_n * 7 + v_i) % 20) < 19 THEN
        -- ABSENCE justifiée (5 %) — statut absent + raison, justification via request
        INSERT INTO app.attendance (
          school_id, student_id, class_id, attendance_date, status,
          reason, admin_note, recorded_by, recorded_by_name, method, recorded_at
        ) VALUES (
          v_school, v_student, v_class, v_d, 'absent',
          'Certificat médical fourni par le parent',
          'Justificatif reçu et validé par la direction',
          v_staff_dir, 'Jean-Pierre Kabeya', 'manuel_classe', v_now
        );
        v_justifies := v_justifies + 1;

      ELSE
        -- RETARD (5 %) — arrivée entre 07h40 et 08h15
        INSERT INTO app.attendance (
          school_id, student_id, class_id, attendance_date, status,
          arrival_time, reason, recorded_by, recorded_by_name, method, recorded_at
        ) VALUES (
          v_school, v_student, v_class, v_d, 'retard',
          ('07:' || lpad((40 + ((v_n * 3 + v_i) % 20))::text, 2, '0'))::time,
          'Retard dû au trafic matinal',
          v_staff_dir, 'Jean-Pierre Kabeya', 'manuel_classe', v_now
        );
        v_retards := v_retards + 1;
      END IF;
    END LOOP;
  END LOOP;

  -- =========================================================================
  -- 3.8 COMMUNIQUÉS — publiés et lus / non lus
  -- =========================================================================
  INSERT INTO app.announcements (
    id, school_id, academic_year_id, reference, kind, title, subject,
    summary, body_html, body_text, is_urgent,
    audience_kind, status, publish_at, published_at,
    created_by, created_by_name, stats
  ) VALUES
  (
    gen_random_uuid(), v_school, v_year, 'COMM-2026-001', 'communique',
    'Rentrée scolaire 2026-2027',
    'Ouverture de l''année scolaire le 1er septembre 2026',
    'La direction a le plaisir d''informer les parents de l''ouverture officielle de l''année scolaire 2026-2027.',
    '<h2>Rentrée scolaire 2026-2027</h2><p>Chers parents,</p><p>L''année scolaire <strong>2026-2027</strong> ouvrira ses portes le <strong>lundi 1er septembre 2026</strong>.</p><p>Prière de se présenter avec :</p><ul><li>Le bulleting de l''année précédente</li><li>Deux photos passeport</li><li>Le certificat de bonne conduite</li></ul><p>Cordialement,<br/>La Direction</p>',
    'Rentrée scolaire 2026-2027 — ouverture le 1er septembre 2026.',
    false, 'toute_ecole', 'publie',
    v_now - interval '45 days', v_now - interval '45 days',
    v_staff_dir, 'Jean-Pierre Kabeya',
    '{"lus": 1, "total": 1}'::jsonb
  ),
  (
    gen_random_uuid(), v_school, v_year, 'COMM-2026-002', 'communique',
    'Réunion parents-professeurs',
    'Invitation à la réunion du 15 octobre 2026',
    'Une réunion parents-professeurs est convoquée le samedi 15 octobre 2026 à 09h00 dans l''amphithéâtre.',
    '<h2>Réunion parents-professeurs</h2><p>Chers parents,</p><p>Nous avons le plaisir de vous convier à la <strong>réunion parents-professeurs</strong> du <strong>samedi 15 octobre 2026 à 09h00</strong>.</p><p>Ordre du jour :</p><ol><li>Résultats du 1er trimestre</li><li>Comportement des élèves</li><li>Projets pour le reste de l''année</li></ol><p>Votre présence est vivement souhaitée.</p>',
    'Réunion parents-professeurs — samedi 15 octobre 2026 à 09h00.',
    false, 'toute_ecole', 'publie',
    v_now - interval '10 days', v_now - interval '10 days',
    v_staff_dir, 'Jean-Pierre Kabeya',
    '{"lus": 0, "total": 1}'::jsonb
  ),
  (
    gen_random_uuid(), v_school, v_year, 'COMM-2026-003', 'urgent',
    'Fermeture exceptionnelle — fête nationale',
    'L''école sera fermée le 30 juin 2026',
    'Conformément au calendrier officiel, l''établissement sera fermé le 30 juin 2026 à l''occasion de la fête de l''Indépendance.',
    '<h2>Fermeture exceptionnelle</h2><p>Chers parents,</p><p>À l''occasion de la <strong>fête de l''Indépendance</strong> (30 juin), l''établissement sera <strong>fermé</strong>.</p><p>Les cours reprendront le lendemain, mercredi 1er juillet, selon l''horaire habituel.</p>',
    'Fermeture le 30 juin 2026 — fête de l''Indépendance.',
    true, 'toute_ecole', 'publie',
    v_now - interval '3 days', v_now - interval '3 days',
    v_staff_dir, 'Jean-Pierre Kabeya',
    '{"lus": 0, "total": 1}'::jsonb
  );

  -- Destinataires (parent lié) + état de lecture
  INSERT INTO app.announcement_recipients (
    announcement_id, school_id, parent_id, student_id,
    delivered_at, read_at, deliver_channel
  )
  SELECT a.id, v_school, v_parent, s, v_now, 
         CASE WHEN a.reference IN ('COMM-2026-001') THEN v_now - interval '40 days' ELSE NULL END,
         'interne'
  FROM app.announcements a
  CROSS JOIN unnest(v_students) AS s
  WHERE a.school_id = v_school;

  -- Notifications interne pour le parent (nouveau communiqué non lu)
  INSERT INTO app.notifications (
    school_id, audience, parent_id, kind, title, body, severity,
    entity_type, entity_id, action_url, channels, created_at
  )
  SELECT v_school, 'parent', v_parent, 'nouveau_communique',
         a.title, a.summary, 
         CASE WHEN a.is_urgent THEN 'urgent' ELSE 'info' END,
         'announcement', a.id, '/parent/communiques',
         ARRAY['interne']::sec.notification_channel[], a.published_at
  FROM app.announcements a
  WHERE a.school_id = v_school
    AND a.reference IN ('COMM-2026-002', 'COMM-2026-003');

  -- =========================================================================
  -- 3.9 ÉVÉNEMENTS DE CALENDRIER — fériés RDC + événements scolaires
  -- =========================================================================
  INSERT INTO app.calendar_events (
    school_id, academic_year_id, kind, title, description,
    starts_on, ends_on, start_time, end_time, all_day, location,
    audience_kind, audience_filter, is_published, school_closed, created_by_name
  ) VALUES
  (
    v_school, v_year, 'ferie', 'Fête de l''Indépendance',
    'Jour férié national — école fermée.',
    DATE '2026-06-30', NULL, NULL, NULL, true, NULL,
    'toute_ecole', '{}'::jsonb, true, true, 'Jean-Pierre Kabeya'
  ),
  (
    v_school, v_year, 'ferie', 'Journée de la Nuit de la Culture',
    'Célébration de la culture congolaise — école fermée.',
    DATE '2026-01-17', NULL, NULL, NULL, true, NULL,
    'toute_ecole', '{}'::jsonb, true, true, 'Jean-Pierre Kabeya'
  ),
  (
    v_school, v_year, 'evenement', 'Réunion parents-professeurs',
    'Présentation des résultats du 1er trimestre et échanges avec les enseignants.',
    DATE '2026-10-15', NULL, TIME '09:00', TIME '12:00', false,
    'Amphithéâtre principal',
    'toute_ecole', '{}'::jsonb, true, false, 'Jean-Pierre Kabeya'
  ),
  (
    v_school, v_year, 'evenement', 'Sortie scolaire — Jardin botanique',
    'Sortie éducative au Jardin botanique de Kinshasa pour les classes de 4ème et 5ème année.',
    DATE '2026-11-20', DATE '2026-11-20', TIME '08:00', TIME '16:00', false,
    'Jardin botanique de Kinshasa',
    'toute_ecole', '{}'::jsonb, true, false, 'Jean-Pierre Kabeya'
  ),
  (
    v_school, v_year, 'vacances', 'Vacances de Noël',
    'Période de vacances de fin d''année — école fermée.',
    DATE '2026-12-19', DATE '2027-01-03', NULL, NULL, true, NULL,
    'toute_ecole', '{}'::jsonb, true, true, 'Jean-Pierre Kabeya'
  ),
  (
    v_school, v_year, 'evenement', 'Cérémonie de remise des bulletins',
    'Remise officielle des bulletins du 1er trimestre aux parents.',
    DATE '2026-12-12', NULL, TIME '14:00', TIME '17:00', false,
    'Cour de l''établissement',
    'toute_ecole', '{}'::jsonb, true, false, 'Jean-Pierre Kabeya'
  );

  -- =========================================================================
  -- 3.10 DEMANDES — justification absence + dérogation + réclamation
  -- =========================================================================
  INSERT INTO app.requests (
    id, school_id, reference, parent_id, student_id, kind, subject, message,
    status, priority, absence_date, absence_reason,
    assigned_to, assigned_to_name, handled_at, closed_at, closed_by_name,
    created_at, updated_at
  ) VALUES
  (
    gen_random_uuid(), v_school, 'DEM-2026-001', v_parent, v_students[1],
    'justification_absence', 'Justification absence — 12 octobre 2026',
    'Madame, Monsieur,<br/><br/>Je souhaite justifier l''absence de ma fille Grâce Kabasele le 12 octobre 2026 en raison d''un rendez-vous médical. Le certificat médical est joint à cette demande.<br/><br/>Merci de votre compréhension.<br/><br/>Marie-Claire Mwana',
    'repondu', 2,
    DATE '2026-10-12', 'Rendez-vous médical — certificat fourni',
    v_staff_dir, 'Jean-Pierre Kabeya',
    v_now - interval '1 day', v_now - interval '1 day', 'Jean-Pierre Kabeya',
    v_now - interval '2 days', v_now - interval '1 day'
  ),
  (
    gen_random_uuid(), v_school, 'DEM-2026-002', v_parent, v_students[3],
    'demande_information', 'Demande d''inscription — 6ème année',
    'Bonjour,<br/><br/>Je souhaiterais inscrire ma fille Esther Nsimba en 6ème année pour l''année prochaine. Pourriez-vous m''indiquer la procédure et les documents requis ?<br/><br/>Merci d''avance.<br/><br/>Marie-Claire Mwana',
    'en_attente', 3,
    NULL, NULL,
    NULL, NULL, NULL, NULL, NULL,
    v_now - interval '5 hours', v_now - interval '5 hours'
  ),
  (
    gen_random_uuid(), v_school, 'DEM-2026-003', v_parent, v_students[2],
    'reclamation', 'Remarque sur les notes de mathématiques',
    'Madame, Monsieur,<br/><br/>Les notes de mathématiques de mon fils Junior Mputu semblent en baisse ce trimestre. Serait-il possible d''organiser un entretien avec son professeur pour en discuter ?<br/><br/>Cordialement,<br/><br/>Marie-Claire Mwana',
    'en_cours', 2,
    NULL, NULL,
    NULL, NULL, NULL, NULL, NULL,
    v_now - interval '12 hours', v_now - interval '12 hours'
  ),
  (
    gen_random_uuid(), v_school, 'DEM-2026-004', v_parent, v_students[1],
    'justification_absence', 'Justification absence — 28 septembre 2026',
    'Madame, Monsieur,<br/><br/>Grâce a été absente le 28 septembre en raison d''une grippe. Elle était sous traitement et a rejoint la classe dès le lendemain.<br/><br/>Merci.<br/><br/>Marie-Claire Mwana',
    'repondu', 2,
    DATE '2026-09-28', 'Maladie — grippe, sous traitement',
    v_staff_dir, 'Jean-Pierre Kabeya',
    v_now - interval '15 days', v_now - interval '15 days', 'Jean-Pierre Kabeya',
    v_now - interval '16 days', v_now - interval '15 days'
  ),
  (
    gen_random_uuid(), v_school, 'DEM-2026-005', v_parent, v_students[4],
    'demande_information', 'Demande d''attestation de fréquentation scolaire',
    'Bonjour,<br/><br/>Je demande une attestation de fréquentation scolaire pour mon fils David Lokole, nécessaire pour une démarche administrative.<br/><br/>Merci de votre aide.<br/><br/>Marie-Claire Mwana',
    'cloture', 2,
    NULL, NULL,
    v_staff_dir, 'Jean-Pierre Kabeya',
    v_now - interval '20 days', v_now - interval '19 days', 'Jean-Pierre Kabeya',
    v_now - interval '21 days', v_now - interval '19 days'
  );

  -- Messages de suivi sur la première demande
  INSERT INTO app.request_messages (request_id, author_type, author_name, body, created_at)
  SELECT r.id, 'ecole', 'Jean-Pierre Kabeya',
         'Bonjour Madame Mwana,<br/><br/>Nous avons bien reçu votre demande de justification. Le certificat médical a été vérifié et l''absence de Grâce est désormais justifiée.<br/><br/>Cordialement,<br/>La Direction',
         v_now - interval '1 day'
  FROM app.requests r WHERE r.reference = 'DEM-2026-001';

  -- =========================================================================
  -- 3.11 DOCUMENTS DE L'ÉCOLE
  -- =========================================================================
  INSERT INTO app.school_documents (
    school_id, category, title, description, file_name, mime_type,
    file_size, visibility, audience_kind, is_active, uploaded_by_name, downloads
  ) VALUES
  (
    v_school, 'administratif', 'Formulaire d''inscription 2026-2027',
    'Formulaire officiel à remplir pour toute nouvelle inscription.',
    'formulaire_inscription_2026.pdf', 'application/pdf', 245760,
    'parents', 'toute_ecole', true, 'Jean-Pierre Kabeya', 42
  ),
  (
    v_school, 'pedagogique', 'Programme officiel — 1ère année primaire',
    'Programme ministériel de la 1ère année primaire, année 2026-2027.',
    'programme_1ere_primaire.pdf', 'application/pdf', 1048576,
    'parents', 'toute_ecole', true, 'Jean-Pierre Kabeya', 18
  ),
  (
    v_school, 'administratif', 'Règlement intérieur',
    'Règlement intérieur de l''établissement — version révisée 2026.',
    'reglement_interieur_2026.pdf', 'application/pdf', 512000,
    'parents', 'toute_ecole', true, 'Jean-Pierre Kabeya', 67
  ),
  (
    v_school, 'pedagogique', 'Liste des fournitures scolaires',
    'Liste des fournitures requises pour chaque niveau, année 2026-2027.',
    'fournitures_scolaires_2026.pdf', 'application/pdf', 189440,
    'parents', 'toute_ecole', true, 'Jean-Pierre Kabeya', 55
  ),
  (
    v_school, 'facture', 'Grille tarifaire 2026-2027',
    'Grille des frais scolaires et modalités de paiement pour l''année 2026-2027.',
    'grille_tarifaire_2026.pdf', 'application/pdf', 327680,
    'personnel', 'toute_ecole', true, 'Jean-Pierre Kabeya', 31
  );

  -- =========================================================================
  -- 3.12 PROFIL PARENT — dernière connexion + préférences complètes
  -- =========================================================================
  UPDATE app.parents
     SET last_seen_at = v_now - interval '2 hours',
         email_verified_at = COALESCE(email_verified_at, v_now - interval '3 months'),
         phone_verified_at = COALESCE(phone_verified_at, v_now - interval '3 months')
   WHERE id = v_parent;

  -- =========================================================================
  -- 3.13 NOTIFICATIONS ÉCOLE — pour le staff (tableau de bord)
  -- =========================================================================
  INSERT INTO app.notifications (
    school_id, audience, staff_user_id, kind, title, body, severity,
    entity_type, entity_id, action_url, channels, created_at
  ) VALUES
  (
    v_school, 'ecole', v_staff_dir, 'nouvelle_demande',
    'Nouvelle demande de justificatif',
    'Marie-Claire Mwana a soumis une justification d''absence pour Grâce Kabasele (12 octobre).',
    'attention', 'request',
    (SELECT id FROM app.requests WHERE reference = 'DEM-2026-003'),
    '/ecole/demandes', ARRAY['interne']::sec.notification_channel[], v_now - interval '12 hours'
  ),
  (
    v_school, 'ecole', v_staff_dir, 'statistiques_semaine',
    'Résumé de la semaine — 5 élèves, 30 jours de présence',
    'Cette semaine : 96 % de présence, 2 absences non justifiées, 1 retard.',
    'info', NULL, NULL, '/ecole/presences',
    ARRAY['interne']::sec.notification_channel[], v_now - interval '1 day'
  );

  -- =========================================================================
  -- RÉSUMÉ
  -- =========================================================================
  RAISE NOTICE '=== JEU DE DÉMONSTRATION CRÉÉ ===';
  RAISE NOTICE 'École : Complexe Scolaire MwanaClasse (Kinshasa)';
  RAISE NOTICE 'Compte école  : mwanaclasse12@gmail.com / 123456ecole';
  RAISE NOTICE 'Compte parent : mwanaclasse@gmail.com  / 123456ecole';
  RAISE NOTICE 'Élèves : % — Classes : %', array_length(v_students, 1), array_length(v_classes, 1);
  RAISE NOTICE 'Présences : % présents, % absents, % justifiés, % retards',
               v_presents, v_absents, v_justifies, v_retards;
  RAISE NOTICE 'Communiqués : 3 — Événements : 6 — Demandes : 5 — Documents : 5';
END $seed$;

-- ---------------------------------------------------------------------------
-- 4. RÉTABLISSEMENT DU RLS FORCED
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'app'
  LOOP
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

COMMIT;
