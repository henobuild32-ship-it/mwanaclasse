-- ============================================================================
--  MWANA CLASSE — Plateforme numérique de gestion scolaire
--  001 — Extensions, schémas logiques et fonctions utilitaires
--  PostgreSQL 13+ (testé sur PostgreSQL 18)
-- ============================================================================
--  Principe d'isolation : TOUTES les données métier portent un school_id.
--  Les vues et requêtes filtrent systématiquement par school_id et
--  l'API applique le Row Level Security applicatif (voir 003_rls.sql).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid(), digest(), hmac()
CREATE EXTENSION IF NOT EXISTS "citext";     -- e-mails insensibles à la casse
CREATE EXTENSION IF NOT EXISTS "unaccent";   -- recherche sans accents

-- ---------------------------------------------------------------------------
-- 2. Schémas logiques
--    - app     : données métier MwanaClasse
--    - sec     : sécurité, sessions, audit, anti-bruteforce
--    - ref     : tables de référence / dictionnaires
--    - sync    : file de synchronisation offline
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS sec;
CREATE SCHEMA IF NOT EXISTS ref;
CREATE SCHEMA IF NOT EXISTS sync;

COMMENT ON SCHEMA app  IS 'Données métier MwanaClasse (écoles, élèves, présences, communiqués)';
COMMENT ON SCHEMA sec  IS 'Sécurité : comptes, sessions, 2FA, audit chaîné, anti-bruteforce';
COMMENT ON SCHEMA ref  IS 'Tables de référence (types, motifs, permissions)';
COMMENT ON SCHEMA sync IS 'Synchronisation offline-first : lots et opérations idempotentes';

-- ---------------------------------------------------------------------------
-- 3. Types énumérés
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE app.school_type AS ENUM (
    'maternelle', 'primaire', 'secondaire', 'humanites',
    'technique', 'professionnel', 'mixte', 'autre');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app.attendance_status AS ENUM (
    'present', 'absent', 'retard', 'depart_anticipe', 'non_enregistre');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app.attendance_method AS ENUM (
    'manuel_classe', 'tout_present', 'qr_code', 'badge', 'tablette_entree',
    'import_fichier', 'correction_admin', 'sync_offline');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app.link_status AS ENUM (
    'en_attente', 'actif', 'revoque', 'refuse');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app.announcement_status AS ENUM (
    'brouillon', 'programme', 'publie', 'archive', 'supprime');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app.announcement_kind AS ENUM (
    'communique', 'note_parents', 'rappel', 'annonce', 'invitation',
    'urgent', 'changement_horaire', 'reunion', 'calendrier', 'administratif');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app.audience_kind AS ENUM (
    'toute_ecole', 'niveau', 'classe', 'section', 'eleve', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL; end $$;

DO $$ BEGIN
  CREATE TYPE app.request_kind AS ENUM (
    'reclamation', 'demande_information', 'demande_derogation',
    'correction_information', 'question_presence', 'justification_absence', 'autre');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app.request_status AS ENUM (
    'en_attente', 'en_cours', 'repondu', 'cloture', 'annule');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app.justification_decision AS ENUM (
    'acceptee', 'refusee', 'a_verifier');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app.calendar_event_kind AS ENUM (
    'rentree', 'cours', 'conge', 'vacances', 'examen', 'reunion',
    'evenement', 'journee_speciale', 'ferie', 'autre');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app.template_kind AS ENUM (
    'communique_officiel', 'reunion_parents', 'rentree_scolaire',
    'absence_exceptionnelle', 'paiement', 'vacances', 'examens',
    'urgence', 'information_generale', 'autre');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app.document_visibility AS ENUM ('parents', 'personnel', 'public');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sec.staff_role AS ENUM (
    'directeur', 'administrateur', 'secretaire', 'responsable_presence',
    'titulaire', 'lecteur');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sec.notification_channel AS ENUM ('push', 'interne', 'email', 'sms');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sync.op_status AS ENUM ('pending', 'applied', 'conflict', 'rejected', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 4. Fonctions utilitaires
-- ---------------------------------------------------------------------------

-- Mot de passe interne jamais présent dans les journaux
CREATE OR REPLACE FUNCTION sec.noop_redact() RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT '***redacted***'::text $$;

-- Horodatage de modification automatique
CREATE OR REPLACE FUNCTION app.tg_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Nom complet canonique : NOM Postnom Prénom
CREATE OR REPLACE FUNCTION app.build_full_name(
  p_last text, p_middle text, p_first text
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(
    regexp_replace(
      concat_ws(' ',
        nullif(btrim(coalesce(p_last,   '')), ''),
        nullif(btrim(coalesce(p_middle, '')), ''),
        nullif(btrim(coalesce(p_first,  '')), '')
      ), '\s+', ' ', 'g')
  );
$$;

-- Suppression des accents : la fonction unaccent() fournie par l'extension est
-- STABLE, donc interdite dans une expression d'index. Deux contraintes sont
-- donc prises en compte ici :
--   1. le wrapper est déclaré IMMUTABLE (plpgsql : son corps n'est pas inliné,
--      la vérification d'immutabilité porte sur le wrapper lui-même) ;
--   2. le schéma est qualifié (public.unaccent) car une expression d'index est
--      replanifiée avec un search_path restreint à pg_catalog : un nom non
--      qualifié y serait introuvable.
CREATE OR REPLACE FUNCTION app.unaccent_imm(p_text text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF p_text IS NULL OR p_text = '' THEN
    RETURN '';
  END IF;
  RETURN public.unaccent(p_text);
END;
$$;

-- Clé de recherche normalisée (sans accents, minuscules, sans espaces superflus)
CREATE OR REPLACE FUNCTION app.search_key(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(regexp_replace(app.unaccent_imm(coalesce(p_text, '')), '\s+', ' ', 'g'));
$$;

-- Générateur de code lisible, non ambigu.
-- Alphabet sans caractères confondables : pas de I, O, 0, 1, L, S, 5, 2, Z
-- => 29 symboles, 6 positions ≈ 5.9e8 combinaisons par préfixe.
CREATE OR REPLACE FUNCTION app.random_code(p_length int DEFAULT 6)
RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKMNPQRTUVWXY346789';
  result   text := '';
  i        int;
BEGIN
  IF p_length IS NULL OR p_length < 4 OR p_length > 24 THEN
    RAISE EXCEPTION 'Longueur de code invalide: %', p_length
      USING ERRCODE = '22023';
  END IF;

  FOR i IN 1..p_length LOOP
    result := result || substr(
      alphabet,
      -- random() n'est pas cryptographiquement sûr : on utilise gen_random_bytes
      1 + (get_byte(gen_random_bytes(1), 0) % length(alphabet)),
      1
    );
  END LOOP;

  RETURN result;
END $$;

-- Formatage des codes : MC-ECOLE-XXXXXX / MC-ELV-XXXXXX / MC-PAR-XXXXXX
CREATE OR REPLACE FUNCTION app.format_school_code(p_raw text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT 'MC-ECOLE-' || upper(p_raw) $$;

CREATE OR REPLACE FUNCTION app.format_student_code(p_raw text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT 'MC-ELV-' || upper(p_raw) $$;

CREATE OR REPLACE FUNCTION app.format_parent_code(p_raw text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT 'MC-PAR-' || upper(p_raw) $$;

-- Normalisation d'un code saisi par un parent (tolérance de saisie)
CREATE OR REPLACE FUNCTION app.normalize_code(p_code text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- Année scolaire : libellé "2026-2027" -> bornes de dates
CREATE OR REPLACE FUNCTION app.school_year_start(p_label text) RETURNS date
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE y int;
BEGIN
  y := nullif(regexp_replace(p_label, '^(\d{4}).*$', '\1'), '')::int;
  IF y IS NULL THEN
    RAISE EXCEPTION 'Année scolaire illisible: %', p_label USING ERRCODE = '22023';
  END IF;
  RETURN make_date(y, 9, 1);   -- rentrée : 1er septembre (Afrique centrale)
END $$;

CREATE OR REPLACE FUNCTION app.school_year_end(p_label text) RETURNS date
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE y int;
BEGIN
  y := nullif(regexp_replace(p_label, '^(\d{4}).*$', '\1'), '')::int;
  IF y IS NULL THEN
    RAISE EXCEPTION 'Année scolaire illisible: %', p_label USING ERRCODE = '22023';
  END IF;
  RETURN make_date(y + 1, 7, 15);  -- fin : 15 juillet
END $$;

-- Validation basique d'adresse e-mail
CREATE OR REPLACE FUNCTION app.is_valid_email(p_email text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_email ~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$', false);
$$;

-- Validation d'un numéro de téléphone (RDC / international tolérant)
CREATE OR REPLACE FUNCTION app.is_valid_phone(p_phone text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    length(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g')) BETWEEN 8 AND 17,
    false);
$$;

-- Distance approximative pour recherche floue (trigramme simplifié)
CREATE OR REPLACE FUNCTION app.similarity_score(p_a text, p_b text) RETURNS real
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN app.search_key(p_a) = app.search_key(p_b) THEN 1.0::real
    WHEN app.search_key(p_a) LIKE '%' || app.search_key(p_b) || '%' THEN 0.75::real
    ELSE 0.0::real
  END;
$$;

-- Concatène un tableau de textes avec dédoublonnage
CREATE OR REPLACE FUNCTION app.array_unique_join(p_values text[], p_sep text DEFAULT ', ')
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg(DISTINCT v, p_sep ORDER BY v)
  FROM unnest(coalesce(p_values, ARRAY[]::text[])) AS v
  WHERE v IS NOT NULL AND btrim(v) <> '';
$$;

COMMIT;
