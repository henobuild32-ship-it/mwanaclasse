-- ============================================================================
--  MWANA CLASSE — 015 — Jours d'activité, fériés et calendrier adapté
-- ============================================================================
--  A1. Régime d'activité : chaque école choisit « Lundi → Vendredi » ou
--      « Lundi → Samedi ». Les jours hors régime (dimanche, et samedi pour
--      le régime Lundi → Vendredi) sont non scolaires : aucun appel
--      possible, aucune absence comptée.
--  A2. Jours fériés et événements : chaque entrée du calendrier porte un
--      indicateur « école fermée ». Les fériés, congés et vacances déjà
--      saisis ferment l'école par défaut.
-- ============================================================================

BEGIN;

ALTER TABLE app.schools
  ADD COLUMN IF NOT EXISTS activity_days text NOT NULL DEFAULT 'lundi_vendredi';

DO $$ BEGIN
  ALTER TABLE app.schools
    ADD CONSTRAINT schools_activity_days_ok
    CHECK (activity_days IN ('lundi_vendredi', 'lundi_samedi'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN app.schools.activity_days IS
  'Régime d''activité hebdomadaire : lundi_vendredi ou lundi_samedi — les autres jours sont non scolaires (aucun appel, aucune absence)';

ALTER TABLE app.calendar_events
  ADD COLUMN IF NOT EXISTS school_closed boolean NOT NULL DEFAULT false;

-- Les fériés, congés et vacances existants ferment l'école.
UPDATE app.calendar_events
   SET school_closed = true
  WHERE kind IN ('ferie', 'conge', 'vacances');

COMMENT ON COLUMN app.calendar_events.school_closed IS
  'Vrai = école fermée ce jour / cette période : appel désactivé et statistiques exclues';

COMMIT;
