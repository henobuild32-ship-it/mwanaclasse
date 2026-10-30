-- ============================================================================
--  MWANA CLASSE — 019 — Module Ministère de l'EPST (Kinshasa)
-- ============================================================================

BEGIN;

-- 1. Table du compte unique Ministère
CREATE TABLE IF NOT EXISTS app.ministere_account (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier          citext NOT NULL UNIQUE,
  password_hash       text NOT NULL,
  password_algo       text NOT NULL DEFAULT 'argon2id',
  password_pepper_id  text NOT NULL DEFAULT 'v1',
  password_changed_at timestamptz,
  is_default_password boolean NOT NULL DEFAULT true,
  singleton_guard     boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton_guard = true),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app.ministere_account IS 'Compte unique réservé au Ministère de l''EPST';

-- 2. Mise à jour des sessions pour supporter le Ministère
ALTER TABLE sec.sessions DROP CONSTRAINT IF EXISTS sessions_audience_check;
ALTER TABLE sec.sessions ADD CONSTRAINT sessions_audience_check CHECK (audience IN ('parent', 'ecole', 'ministere'));

ALTER TABLE sec.sessions ADD COLUMN IF NOT EXISTS ministere_id uuid REFERENCES app.ministere_account(id) ON DELETE CASCADE;

ALTER TABLE sec.sessions DROP CONSTRAINT IF EXISTS session_owner;
ALTER TABLE sec.sessions ADD CONSTRAINT session_owner CHECK (
  (audience = 'parent' AND parent_id IS NOT NULL AND staff_user_id IS NULL AND ministere_id IS NULL)
  OR (audience = 'ecole' AND staff_user_id IS NOT NULL AND parent_id IS NULL AND ministere_id IS NULL)
  OR (audience = 'ministere' AND ministere_id IS NOT NULL AND staff_user_id IS NULL AND parent_id IS NULL)
);

CREATE INDEX IF NOT EXISTS sessions_ministere_idx ON sec.sessions (ministere_id) WHERE revoked_at IS NULL;

-- 3. Table des communiqués émis par le Ministère
CREATE TABLE IF NOT EXISTS app.ministere_communiques (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             text NOT NULL,
  message           text NOT NULL,
  attachment_url    text,
  attachment_name   text,
  attachment_type   text,
  is_urgent         boolean NOT NULL DEFAULT false,
  target_type       text NOT NULL CHECK (target_type IN ('toutes_ecoles', 'ecole_specifique')),
  target_school_id  uuid REFERENCES app.schools(id) ON DELETE SET NULL,
  target_count      integer NOT NULL DEFAULT 0,
  sender_label      text NOT NULL DEFAULT 'Ministère de l''EPST',
  sent_by           text NOT NULL DEFAULT 'ministere-epst@classe.com',
  sent_at           timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app.ministere_communiques IS 'Communiqués officiels émis par le Ministère de l''EPST aux écoles de Kinshasa';

CREATE INDEX IF NOT EXISTS min_comm_sent_idx ON app.ministere_communiques (sent_at DESC);
CREATE INDEX IF NOT EXISTS min_comm_target_idx ON app.ministere_communiques (target_type, target_school_id);

-- 4. Table des accusés de lecture des écoles pour les communiqués Ministère
CREATE TABLE IF NOT EXISTS app.ministere_communique_lectures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  communique_id   uuid NOT NULL REFERENCES app.ministere_communiques(id) ON DELETE CASCADE,
  school_id       uuid NOT NULL REFERENCES app.schools(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (communique_id, school_id)
);

COMMENT ON TABLE app.ministere_communique_lectures IS 'Accusés de lecture par école pour chaque communiqué du Ministère';

CREATE INDEX IF NOT EXISTS min_lectures_school_idx ON app.ministere_communique_lectures (school_id, read_at DESC);

COMMIT;
