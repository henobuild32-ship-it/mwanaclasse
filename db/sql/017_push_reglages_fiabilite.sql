-- ============================================================================
--  MWANA CLASSE — 017 — Notifications push : réglages et fiabilité
-- ============================================================================
--  A. sec.staff_users.notification_prefs : miroir des préférences parent
--     (interrupteurs par type de notification + push général).
--  B. app.push_subscriptions : colonnes d'état pour la fiabilité d'envoi
--     (abonnement désactivé à la déconnexion, dernière erreur rencontrée).
--  C. Index de file d'attente pour les notifications non encore poussées.
-- ============================================================================

BEGIN;

-- A. Préférences de notification du personnel (structure identique aux parents)
ALTER TABLE sec.staff_users
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{
    "push": true,
    "demandes": true,
    "communiques": true,
    "presences": true,
    "calendrier": true,
    "documents": true
  }'::jsonb;

-- Les préférences parent existantes reçoivent les mêmes clés par défaut.
UPDATE app.parents
   SET notification_prefs = notification_prefs
       || '{"demandes": true, "communiques": true, "presences": true,
            "calendrier": true, "documents": true}'::jsonb
 WHERE NOT (notification_prefs ? 'demandes');

-- B. État des abonnements push
ALTER TABLE app.push_subscriptions
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

COMMENT ON COLUMN app.push_subscriptions.disabled_at IS
  'Abonnement désactivé (déconnexion de l''appareil) — conservé pour éviter les doublons d''endpoint';
COMMENT ON COLUMN app.push_subscriptions.last_error IS
  'Dernière erreur d''envoi push (410 expiré, 429 limite, réseau…)';

CREATE INDEX IF NOT EXISTS push_actifs_idx
  ON app.push_subscriptions (parent_id) WHERE disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS push_staff_actifs_idx
  ON app.push_subscriptions (staff_user_id) WHERE disabled_at IS NULL;

-- C. Notifications en attente de push (file non bloquante)
CREATE INDEX IF NOT EXISTS notif_push_en_attente_idx
  ON app.notifications (created_at)
  WHERE pushed_at IS NULL AND 'push' = ANY(channels);

COMMIT;
