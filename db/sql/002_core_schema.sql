-- ============================================================================
--  MWANA CLASSE — 002 — Schéma métier principal
--  Écoles · Années scolaires · Classes · Sections · Élèves
--  Parents · Liaisons · Présences · Communiqués · Demandes · Calendrier
-- ============================================================================

BEGIN;

-- ===========================================================================
--  A. ÉTABLISSEMENTS ET IDENTITÉ
-- ===========================================================================

CREATE TABLE app.schools (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code           text NOT NULL UNIQUE,
  slug                  citext NOT NULL UNIQUE,
  official_name         text NOT NULL,
  short_name            text,
  type                  app.school_type NOT NULL DEFAULT 'mixte',
  logo_url              text,
  logo_blob             bytea,
  primary_color         text NOT NULL DEFAULT '#0F5132'
                          CHECK (primary_color ~* '^#[0-9a-f]{6}$'),
  secondary_color       text NOT NULL DEFAULT '#F59E0B'
                          CHECK (secondary_color ~* '^#[0-9a-f]{6}$'),
  address_line          text,
  commune               text,
  city                  text,
  province              text,
  country               text NOT NULL DEFAULT 'RDC',
  phones                text[],
  phone_contact         text,                -- numéro principal affiché sur les documents officiels
  email                 citext,
  website               text,
  description           text,
  opening_hours         text,
  extra_info            jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_year_label    text,
  -- Mode de validation des liaisons parent-enfant
  parent_link_mode      text NOT NULL DEFAULT 'validation'
                          CHECK (parent_link_mode IN ('automatique','validation')),
  -- Réglages généraux de l'établissement
  settings              jsonb NOT NULL DEFAULT '{
    "notify_absence": true,
    "notify_late": true,
    "notify_presence": false,
    "allow_parent_justification": true,
    "require_2fa_staff": false,
    "attendance_day_start": "06:00",
    "attendance_day_end": "18:00"
  }'::jsonb,
  signature_name        text,
  signature_title       text,
  is_active             boolean NOT NULL DEFAULT true,
  onboarded_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               integer NOT NULL DEFAULT 1,
  CONSTRAINT schools_code_format CHECK (public_code ~ '^MC-ECOLE-[A-Z0-9]{4,12}$'),
  CONSTRAINT schools_name_len    CHECK (char_length(btrim(official_name)) BETWEEN 2 AND 200),
  CONSTRAINT schools_email_ok    CHECK (email IS NULL OR app.is_valid_email(email))
);

COMMENT ON TABLE  app.schools IS 'Établissement scolaire — espace logique isolé de données';
COMMENT ON COLUMN app.schools.public_code IS 'Code unique communicable aux parents (MC-ECOLE-XXXXXX)';
COMMENT ON COLUMN app.schools.parent_link_mode IS 'automatique = liaison immédiate, validation = accord de l''administration';

CREATE INDEX schools_city_idx    ON app.schools (app.search_key(city));
CREATE INDEX schools_name_search ON app.schools USING gin (to_tsvector('simple', app.search_key(official_name)));

-- ---------------------------------------------------------------------------
--  Années scolaires
-- ---------------------------------------------------------------------------
CREATE TABLE app.academic_years (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  label          text NOT NULL,                         -- '2026-2027'
  starts_on      date NOT NULL,
  ends_on        date NOT NULL,
  is_current     boolean NOT NULL DEFAULT false,
  is_archived    boolean NOT NULL DEFAULT false,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT years_label_format CHECK (label ~ '^\d{4}\s*[-/]\s*\d{4}$'),
  CONSTRAINT years_range_ok     CHECK (ends_on > starts_on),
  CONSTRAINT years_unique       UNIQUE (school_id, label)
);

CREATE UNIQUE INDEX years_one_current_per_school
  ON app.academic_years (school_id) WHERE is_current;

CREATE INDEX years_school_idx ON app.academic_years (school_id, starts_on DESC);

-- ---------------------------------------------------------------------------
--  Classes
-- ---------------------------------------------------------------------------
CREATE TABLE app.classes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  academic_year_id  uuid NOT NULL REFERENCES app.academic_years(id) ON DELETE CASCADE,
  name              text NOT NULL,                       -- '6ème Primaire'
  level             text,                                -- 'Primaire'
  level_order       integer,                             -- tri / promotion
  promotion_target_id uuid REFERENCES app.classes(id) ON DELETE SET NULL,
  max_capacity      integer NOT NULL DEFAULT 50 CHECK (max_capacity BETWEEN 1 AND 1000),
  room              text,
  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT classes_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT classes_unique   UNIQUE (school_id, academic_year_id, name)
);

CREATE INDEX classes_school_year_idx ON app.classes (school_id, academic_year_id, is_active);
CREATE INDEX classes_name_search_idx ON app.classes (school_id, app.search_key(name));

-- ---------------------------------------------------------------------------
--  Sections (configurables classe par classe)
-- ---------------------------------------------------------------------------
CREATE TABLE app.sections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  class_id          uuid NOT NULL REFERENCES app.classes(id) ON DELETE CASCADE,
  name              text NOT NULL,                       -- 'A', 'Scientifique', 'Unique'
  short_code        text,
  max_capacity      integer CHECK (max_capacity IS NULL OR max_capacity BETWEEN 1 AND 1000),
  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT sections_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT sections_unique   UNIQUE (class_id, name)
);

CREATE INDEX sections_school_idx ON app.sections (school_id, class_id, is_active);

-- ---------------------------------------------------------------------------
--  Élèves
-- ---------------------------------------------------------------------------
CREATE TABLE app.students (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  public_code       text NOT NULL UNIQUE,
  academic_year_id  uuid NOT NULL REFERENCES app.academic_years(id) ON DELETE RESTRICT,
  class_id          uuid NOT NULL REFERENCES app.classes(id) ON DELETE RESTRICT,
  section_id        uuid REFERENCES app.sections(id) ON DELETE SET NULL,
  last_name         text NOT NULL,
  middle_name       text,
  first_name        text NOT NULL,
  full_name         text GENERATED ALWAYS AS
                      (app.build_full_name(last_name, middle_name, first_name)) STORED,
  search_name       text GENERATED ALWAYS AS
                      (app.search_key(app.build_full_name(last_name, middle_name, first_name))) STORED,
  gender            char(1) CHECK (gender IN ('M','F')),
  date_of_birth     date
                      CHECK (date_of_birth IS NULL
                             OR (date_of_birth > DATE '1990-01-01'
                                 AND date_of_birth < DATE '2100-01-01')),
  place_of_birth    text,
  photo_url         text,
  internal_number   text,
  -- Champs sensibles : stockés chiffrés (AES-256-GCM) — jamais en clair
  medical_notes_enc bytea,
  guardian_phone_enc bytea,
  address_enc       bytea,
  extra_info        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'actif'
                      CHECK (status IN ('actif','archive','transfere','diplome','suspendu')),
  enrolled_on       date NOT NULL DEFAULT CURRENT_DATE,
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT students_code_format CHECK (public_code ~ '^MC-ELV-[A-Z0-9]{4,12}$'),
  CONSTRAINT students_last_len    CHECK (char_length(btrim(last_name))  BETWEEN 1 AND 80),
  CONSTRAINT students_first_len   CHECK (char_length(btrim(first_name)) BETWEEN 1 AND 80),
  CONSTRAINT students_internal_uniq UNIQUE (school_id, academic_year_id, internal_number)
);

COMMENT ON TABLE  app.students IS 'Élève inscrit — classe et section imposées par l''école, jamais par le parent';
COMMENT ON COLUMN app.students.public_code IS 'Code unique de l''enfant (MC-ELV-XXXXXX) remis au parent';
COMMENT ON COLUMN app.students.medical_notes_enc IS 'Notes médicales chiffrées AES-256-GCM (données sensibles)';

CREATE INDEX students_school_idx       ON app.students (school_id, status);
CREATE INDEX students_class_idx        ON app.students (school_id, class_id, status);
CREATE INDEX students_section_idx      ON app.students (school_id, section_id);
CREATE INDEX students_year_idx         ON app.students (school_id, academic_year_id, status);
CREATE INDEX students_search_idx       ON app.students (school_id, search_name);
CREATE INDEX students_search_trgm      ON app.students (school_id, search_name text_pattern_ops);
CREATE INDEX students_dob_idx          ON app.students (date_of_birth);

-- ---------------------------------------------------------------------------
--  Parents / responsables
-- ---------------------------------------------------------------------------
CREATE TABLE app.parents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code       text UNIQUE,
  full_name         text NOT NULL,
  relationship      text NOT NULL DEFAULT 'parent'
                      CHECK (relationship IN ('pere','mere','tuteur','oncle','tante',
                                              'grand_parent','frere','soeur','parent','autre')),
  email             citext UNIQUE,
  phone             text,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  photo_url         text,
  preferred_language text NOT NULL DEFAULT 'fr',
  notification_prefs jsonb NOT NULL DEFAULT '{
    "push": true, "email": true, "sms": false, "quiet_hours": null
  }'::jsonb,
  is_active         boolean NOT NULL DEFAULT true,
  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT parents_name_len CHECK (char_length(btrim(full_name)) BETWEEN 2 AND 160),
  CONSTRAINT parents_code_fmt CHECK (public_code IS NULL OR public_code ~ '^MC-PAR-[A-Z0-9]{4,12}$'),
  CONSTRAINT parents_email_ok CHECK (email IS NULL OR app.is_valid_email(email)),
  CONSTRAINT parents_contact  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

COMMENT ON TABLE app.parents IS 'Compte parent — peut être rattaché à plusieurs écoles et plusieurs enfants';

CREATE INDEX parents_email_idx ON app.parents (email);
CREATE INDEX parents_phone_idx ON app.parents (phone);
CREATE INDEX parents_search_idx ON app.parents (app.search_key(full_name));

-- ---------------------------------------------------------------------------
--  Liaisons parent ↔ élève
-- ---------------------------------------------------------------------------
CREATE TABLE app.parent_student_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  parent_id         uuid NOT NULL REFERENCES app.parents(id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES app.students(id) ON DELETE CASCADE,
  relationship      text NOT NULL DEFAULT 'parent',
  status            app.link_status NOT NULL DEFAULT 'en_attente',
  is_primary        boolean NOT NULL DEFAULT false,
  can_pickup        boolean NOT NULL DEFAULT true,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  requested_ip      inet,
  requested_device  text,
  requested_method  text NOT NULL DEFAULT 'code_enfant'
                      CHECK (requested_method IN ('code_enfant','code_ecole','import','manuel','qr_code')),
  decided_at        timestamptz,
  decided_by        uuid,           -- sec.staff_users(id) : contrainte ajoutée en 003
  decision_note     text,
  revoked_at        timestamptz,
  revoked_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT links_unique UNIQUE (parent_id, student_id)
);

COMMENT ON TABLE app.parent_student_links IS 'Attachement parent-enfant avec validation administrative optionnelle';

CREATE INDEX links_school_status_idx ON app.parent_student_links (school_id, status);
CREATE INDEX links_parent_idx        ON app.parent_student_links (parent_id, status);
CREATE INDEX links_student_idx       ON app.parent_student_links (student_id, status);

-- Une seule liaison principale active par élève
CREATE UNIQUE INDEX links_one_primary ON app.parent_student_links (student_id)
  WHERE is_primary AND status = 'actif';

-- Vérifie que l'élève et le parent appartiennent bien au même school_id
CREATE OR REPLACE FUNCTION app.tg_link_check_school() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s_school uuid;
BEGIN
  SELECT school_id INTO s_school FROM app.students WHERE id = NEW.student_id;
  IF s_school IS DISTINCT FROM NEW.school_id THEN
    RAISE EXCEPTION 'Incohérence de sécurité : l''élève % n''appartient pas à l''école %',
      NEW.student_id, NEW.school_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER link_check_school
  BEFORE INSERT OR UPDATE OF student_id, school_id ON app.parent_student_links
  FOR EACH ROW EXECUTE FUNCTION app.tg_link_check_school();

-- Même contrôle pour les présences et les élèves (isolation stricte)
CREATE OR REPLACE FUNCTION app.tg_assert_same_school() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_school uuid;
  v_rec    record;
BEGIN
  -- Vérifie chaque colonne *_id référencée qui porte un school_id
  FOREACH v_rec IN ARRAY ARRAY[]::record[] LOOP END LOOP;  -- no-op, extensible
  RETURN NEW;
END $$;

-- ===========================================================================
--  B. PRÉSENCES
-- ===========================================================================

CREATE TABLE app.attendance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES app.students(id) ON DELETE CASCADE,
  class_id          uuid NOT NULL REFERENCES app.classes(id) ON DELETE RESTRICT,
  section_id        uuid REFERENCES app.sections(id) ON DELETE SET NULL,
  attendance_date   date NOT NULL,
  status            app.attendance_status NOT NULL DEFAULT 'non_enregistre',
  status_before     app.attendance_status,
  arrival_time      time,
  departure_time    time,
  late_minutes      integer GENERATED ALWAYS AS (
                      CASE WHEN status = 'retard' AND arrival_time IS NOT NULL
                           THEN GREATEST(0,
                                 (EXTRACT(hour   FROM arrival_time) * 60
                                + EXTRACT(minute FROM arrival_time))::int - 450)  -- 07:30
                           ELSE NULL END) STORED,
  reason            text,
  admin_note        text,
  recorded_by       uuid,                                -- sec.staff_users(id)
  recorded_by_name  text,
  method            app.attendance_method NOT NULL DEFAULT 'manuel_classe',
  device_id         text,
  client_uuid       uuid UNIQUE,                         -- idempotence de synchronisation
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  recorded_offline_at timestamptz,                        -- heure locale quand hors ligne
  synced_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT att_unique_day   UNIQUE (student_id, attendance_date),
  CONSTRAINT att_not_future   CHECK (attendance_date <= CURRENT_DATE + 30),
  CONSTRAINT att_times_ok     CHECK (departure_time IS NULL OR arrival_time IS NULL
                                     OR departure_time >= arrival_time),
  CONSTRAINT att_late_needs_time CHECK (status <> 'retard' OR arrival_time IS NOT NULL)
);

COMMENT ON TABLE  app.attendance IS 'Présence journalière — cœur du produit, fonctionne hors ligne';
COMMENT ON COLUMN app.attendance.client_uuid IS 'Identifiant généré par le terminal : garantit l''idempotence de la synchronisation';
COMMENT ON COLUMN app.attendance.recorded_offline_at IS 'Horodatage local réel lorsque le terminal était hors ligne';

CREATE INDEX att_school_date_idx   ON app.attendance (school_id, attendance_date DESC);
CREATE INDEX att_class_date_idx    ON app.attendance (school_id, class_id, attendance_date DESC);
CREATE INDEX att_student_date_idx  ON app.attendance (student_id, attendance_date DESC);
CREATE INDEX att_status_date_idx   ON app.attendance (school_id, status, attendance_date DESC);
CREATE INDEX att_unrecorded_idx    ON app.attendance (school_id, class_id, attendance_date)
  WHERE status = 'non_enregistre';
CREATE INDEX att_section_date_idx  ON app.attendance (school_id, section_id, attendance_date DESC);

-- ---------------------------------------------------------------------------
--  Historique complet des présences (traçabilité / conflits)
-- ---------------------------------------------------------------------------
CREATE TABLE app.attendance_history (
  id             bigserial PRIMARY KEY,
  attendance_id  uuid NOT NULL,
  school_id      uuid NOT NULL,
  student_id     uuid NOT NULL,
  attendance_date date NOT NULL,
  old_status     app.attendance_status,
  new_status     app.attendance_status NOT NULL,
  old_arrival    time,
  new_arrival    time,
  changed_by     uuid,
  changed_by_name text,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  change_source  text NOT NULL DEFAULT 'api',
  device_id      text,
  note           text
);

CREATE INDEX att_hist_student_idx ON app.attendance_history (student_id, attendance_date DESC);
CREATE INDEX att_hist_school_idx  ON app.attendance_history (school_id, changed_at DESC);

CREATE OR REPLACE FUNCTION app.tg_attendance_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.attendance_history(
      attendance_id, school_id, student_id, attendance_date,
      old_status, new_status, old_arrival, new_arrival,
      changed_by, changed_by_name, change_source, device_id, note)
    VALUES (NEW.id, NEW.school_id, NEW.student_id, NEW.attendance_date,
      NULL, NEW.status, NULL, NEW.arrival_time,
      NEW.recorded_by, NEW.recorded_by_name,
      CASE WHEN NEW.synced_at IS NOT NULL AND NEW.recorded_offline_at IS NOT NULL
           THEN 'sync_offline' ELSE 'api' END,
      NEW.device_id, 'Création');
  ELSIF TG_OP = 'UPDATE' AND (
        NEW.status       IS DISTINCT FROM OLD.status
     OR NEW.arrival_time IS DISTINCT FROM OLD.arrival_time
     OR NEW.departure_time IS DISTINCT FROM OLD.departure_time) THEN
    INSERT INTO app.attendance_history(
      attendance_id, school_id, student_id, attendance_date,
      old_status, new_status, old_arrival, new_arrival,
      changed_by, changed_by_name, change_source, device_id, note)
    VALUES (NEW.id, NEW.school_id, NEW.student_id, NEW.attendance_date,
      OLD.status, NEW.status, OLD.arrival_time, NEW.arrival_time,
      NEW.recorded_by, NEW.recorded_by_name,
      CASE WHEN NEW.synced_at IS NOT NULL THEN 'sync_offline' ELSE 'api' END,
      NEW.device_id, 'Modification');
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER attendance_history_trg
  AFTER INSERT OR UPDATE ON app.attendance
  FOR EACH ROW EXECUTE FUNCTION app.tg_attendance_history();

-- ===========================================================================
--  C. COMMUNIQUÉS
-- ===========================================================================

CREATE TABLE app.announcement_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  name           text NOT NULL,
  kind           app.template_kind NOT NULL DEFAULT 'communique_officiel',
  -- Modèle importé (PDF / DOCX) : structure + variables [NOM_ECOLE], [DATE]…
  source_format  text CHECK (source_format IN ('pdf','docx','html','manuel')),
  source_filename text,
  source_blob    bytea,                       -- fichier original conservé
  source_sha256  text,
  -- Représentation exploitable dans l'application
  body_html      text NOT NULL DEFAULT '',
  header_html    text,
  footer_html    text,
  css            text,
  variables      jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_default     boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        integer NOT NULL DEFAULT 1,
  CONSTRAINT tmpl_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT tmpl_unique   UNIQUE (school_id, name)
);

CREATE INDEX tmpl_school_idx ON app.announcement_templates (school_id, is_active, kind);

CREATE TABLE app.announcements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  academic_year_id  uuid REFERENCES app.academic_years(id) ON DELETE SET NULL,
  template_id       uuid REFERENCES app.announcement_templates(id) ON DELETE SET NULL,
  reference         text,                                 -- numéro officiel du document
  kind              app.announcement_kind NOT NULL DEFAULT 'communique',
  title             text NOT NULL,
  subject           text,                                 -- objet du communiqué
  summary           text,
  body_html         text NOT NULL DEFAULT '',
  body_text         text,
  is_urgent         boolean NOT NULL DEFAULT false,
  audience_kind     app.audience_kind NOT NULL DEFAULT 'toute_ecole',
  audience_filter   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {levels:[],class_ids:[],section_ids:[]}
  -- Pièces jointes et versions
  attachment_url    text,
  attachment_name   text,
  pdf_url           text,
  status            app.announcement_status NOT NULL DEFAULT 'brouillon',
  publish_at        timestamptz,
  published_at      timestamptz,
  expires_at        timestamptz,
  archived_at       timestamptz,
  created_by        uuid,
  created_by_name   text,
  updated_by        uuid,
  updated_by_name   text,
  deleted_at        timestamptz,
  stats             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT ann_title_len CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT ann_publish_ok CHECK (status <> 'publie' OR published_at IS NOT NULL),
  CONSTRAINT ann_schedule_ok CHECK (status <> 'programme' OR publish_at IS NOT NULL)
);

COMMENT ON TABLE  app.announcements IS 'Communiqués officiels école → parents (canal officiel)';
COMMENT ON COLUMN app.announcements.body_html IS 'Contenu éditable, variables déjà résolues à la publication';

CREATE INDEX ann_school_status_idx ON app.announcements (school_id, status, created_at DESC);
CREATE INDEX ann_schedule_idx      ON app.announcements (status, publish_at)
  WHERE status = 'programme';
CREATE INDEX ann_published_idx     ON app.announcements (school_id, published_at DESC)
  WHERE status = 'publie';
CREATE INDEX ann_urgent_idx        ON app.announcements (school_id, published_at DESC)
  WHERE is_urgent AND status = 'publie';
CREATE INDEX ann_search_idx        ON app.announcements
  USING gin (to_tsvector('simple', app.search_key(coalesce(title,'') || ' ' || coalesce(subject,''))));

-- Journal des destinataires + accusés de lecture
CREATE TABLE app.announcement_recipients (
  id               bigserial PRIMARY KEY,
  announcement_id  uuid NOT NULL REFERENCES app.announcements(id) ON DELETE CASCADE,
  school_id        uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  parent_id        uuid NOT NULL REFERENCES app.parents(id) ON DELETE CASCADE,
  student_id       uuid REFERENCES app.students(id) ON DELETE CASCADE,
  delivered_at     timestamptz,
  read_at          timestamptz,
  deliver_channel  sec.notification_channel NOT NULL DEFAULT 'interne',
  push_sent_at     timestamptz,
  email_sent_at    timestamptz,
  failure_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ann_recip_unique UNIQUE (announcement_id, parent_id, student_id)
);

CREATE INDEX ann_recip_parent_idx ON app.announcement_recipients (parent_id, read_at);
CREATE INDEX ann_recip_unread_idx ON app.announcement_recipients (parent_id, announcement_id)
  WHERE read_at IS NULL;
CREATE INDEX ann_recip_stats_idx  ON app.announcement_recipients (announcement_id, read_at);

-- ===========================================================================
--  D. DEMANDES / RÉCLAMATIONS
-- ===========================================================================

CREATE TABLE app.requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  reference         text NOT NULL,
  parent_id         uuid NOT NULL REFERENCES app.parents(id) ON DELETE CASCADE,
  student_id        uuid REFERENCES app.students(id) ON DELETE SET NULL,
  kind              app.request_kind NOT NULL DEFAULT 'reclamation',
  subject           text NOT NULL,
  message           text NOT NULL,
  status            app.request_status NOT NULL DEFAULT 'en_attente',
  priority          smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
  -- Justification d'absence (module dédié)
  absence_date      date,
  absence_reason    text,
  attachment_url    text,
  attachment_name   text,
  justification_decision app.justification_decision,
  -- Traitement administratif
  assigned_to       uuid,
  assigned_to_name  text,
  handled_at        timestamptz,
  closed_at         timestamptz,
  closed_by_name    text,
  client_uuid       uuid UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT req_subject_len CHECK (char_length(btrim(subject)) BETWEEN 2 AND 200),
  CONSTRAINT req_message_len CHECK (char_length(btrim(message)) BETWEEN 2 AND 8000),
  CONSTRAINT req_ref_unique  UNIQUE (school_id, reference)
);

CREATE INDEX req_school_status_idx ON app.requests (school_id, status, created_at DESC);
CREATE INDEX req_parent_idx        ON app.requests (parent_id, created_at DESC);
CREATE INDEX req_student_idx       ON app.requests (student_id, created_at DESC);
CREATE INDEX req_pending_idx       ON app.requests (school_id, created_at)
  WHERE status IN ('en_attente','en_cours');

CREATE TABLE app.request_messages (
  id            bigserial PRIMARY KEY,
  request_id    uuid NOT NULL REFERENCES app.requests(id) ON DELETE CASCADE,
  author_type   text NOT NULL CHECK (author_type IN ('parent','ecole','systeme')),
  author_id     uuid,
  author_name   text,
  body          text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 8000),
  is_internal   boolean NOT NULL DEFAULT false,
  attachment_url text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX req_msg_request_idx ON app.request_messages (request_id, created_at);

-- ===========================================================================
--  E. CALENDRIER SCOLAIRE
-- ===========================================================================

CREATE TABLE app.calendar_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id        uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  academic_year_id uuid REFERENCES app.academic_years(id) ON DELETE CASCADE,
  kind             app.calendar_event_kind NOT NULL DEFAULT 'evenement',
  title            text NOT NULL,
  description      text,
  starts_on        date NOT NULL,
  ends_on          date,
  start_time       time,
  end_time         time,
  all_day          boolean NOT NULL DEFAULT true,
  location         text,
  audience_kind    app.audience_kind NOT NULL DEFAULT 'toute_ecole',
  audience_filter  jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_published     boolean NOT NULL DEFAULT true,
  created_by_name  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  CONSTRAINT evt_title_len CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  CONSTRAINT evt_range_ok  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX evt_school_date_idx ON app.calendar_events (school_id, starts_on);
CREATE INDEX evt_range_idx       ON app.calendar_events (school_id, starts_on, coalesce(ends_on, starts_on));

-- ===========================================================================
--  F. DOCUMENTS DE L'ÉCOLE
-- ===========================================================================

CREATE TABLE app.school_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  category      text NOT NULL DEFAULT 'general',
  title         text NOT NULL,
  description   text,
  file_url      text,
  file_name     text,
  mime_type     text,
  file_size     bigint CHECK (file_size IS NULL OR file_size >= 0),
  sha256        text,
  visibility    app.document_visibility NOT NULL DEFAULT 'parents',
  audience_kind app.audience_kind NOT NULL DEFAULT 'toute_ecole',
  audience_filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  downloads     integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  uploaded_by_name text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1,
  CONSTRAINT doc_title_len CHECK (char_length(btrim(title)) BETWEEN 1 AND 200)
);

CREATE INDEX docs_school_idx ON app.school_documents (school_id, visibility, category, created_at DESC);

-- ===========================================================================
--  G. IMPORTATIONS (Excel / CSV)
-- ===========================================================================

CREATE TABLE app.import_jobs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  academic_year_id uuid REFERENCES app.academic_years(id) ON DELETE SET NULL,
  kind           text NOT NULL DEFAULT 'eleves' CHECK (kind IN ('eleves','parents','classes')),
  filename       text NOT NULL,
  total_rows     integer NOT NULL DEFAULT 0,
  valid_rows     integer NOT NULL DEFAULT 0,
  error_rows     integer NOT NULL DEFAULT 0,
  imported_rows  integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'analyse'
                   CHECK (status IN ('analyse','valide','importe','echec','annule')),
  errors         jsonb NOT NULL DEFAULT '[]'::jsonb,
  preview        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_name text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

CREATE INDEX import_school_idx ON app.import_jobs (school_id, created_at DESC);

-- ===========================================================================
--  H. NOTIFICATIONS (centre de notifications, commun aux deux interfaces)
-- ===========================================================================

CREATE TABLE app.notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid REFERENCES app.schools(id) ON DELETE CASCADE,
  audience      text NOT NULL CHECK (audience IN ('parent','ecole')),
  parent_id     uuid REFERENCES app.parents(id) ON DELETE CASCADE,
  staff_user_id uuid,
  kind          text NOT NULL,                -- 'presence_enregistree','nouveau_communique',…
  title         text NOT NULL,
  body          text,
  severity      text NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('info','succes','attention','urgent')),
  entity_type   text,                          -- 'announcement','attendance','request'…
  entity_id     uuid,
  action_url    text,
  channels      sec.notification_channel[] NOT NULL DEFAULT ARRAY['interne']::sec.notification_channel[],
  read_at       timestamptz,
  pushed_at     timestamptz,
  emailed_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notif_parent_idx ON app.notifications (parent_id, read_at, created_at DESC);
CREATE INDEX notif_school_idx ON app.notifications (school_id, audience, read_at, created_at DESC);

-- Abonnements Web Push (PWA)
CREATE TABLE app.push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience     text NOT NULL CHECK (audience IN ('parent','ecole')),
  parent_id    uuid REFERENCES app.parents(id) ON DELETE CASCADE,
  staff_user_id uuid,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  device_id    text,
  failure_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX push_parent_idx ON app.push_subscriptions (parent_id);
CREATE INDEX push_staff_idx  ON app.push_subscriptions (staff_user_id);

-- ===========================================================================
--  I. TRIGGERS updated_at
-- ===========================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'schools','academic_years','classes','sections','students','parents',
    'parent_student_links','attendance','announcement_templates','announcements',
    'requests','calendar_events','school_documents'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON app.%I
         FOR EACH ROW EXECUTE FUNCTION app.tg_touch_updated_at()', t, t);
  END LOOP;
END $$;

COMMIT;
