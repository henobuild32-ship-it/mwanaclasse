-- ============================================================================
--  MWANA CLASSE — 008 — Signature du journal : remplissage en deux temps
-- ============================================================================
--  Constat : l'API écrit une entrée puis attache la signature HMAC-SHA256 de
--  (prev_hash | entry_hash). Ces deux valeurs ne sont connues qu'APRÈS
--  l'insertion (c'est le déclencheur sec.tg_audit_chain qui les calcule), et
--  la clé de signature vit côté serveur : la signature ne peut donc pas être
--  produite avant l'insertion.
--
--  Or sec.tg_audit_immutable refusait TOUTE modification, y compris ce
--  remplissage : la première écriture d'audit échouait (SQLSTATE 42501).
--
--  Règle retenue — « ajout seul » conservé, exception minimale :
--    * l'insertion reste le seul moyen d'ajouter une entrée ;
--    * la modification n'est tolérée QUE pour passer signature de NULL à sa
--      valeur, et UNIQUEMENT si aucun autre champ ne change
--      (comparaison de la ligne entière à l'exception de signature) ;
--    * toute autre modification, ainsi que toute suppression, reste refusée ;
--    * le privilège est accordé COLONNE PAR COLONNE : l'application ne peut
--      modifier que sec.audit_log.signature, jamais le contenu chaîné.
--
--  Une signature ne peut pas être forgée sans la clé serveur, et toute
--  altération du contenu casse le chaînage vérifié par
--  sec.verify_audit_chain() — l'intégrité du journal reste démontrable.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION sec.tg_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- 1. Remplissage unique de la signature (aucune autre colonne modifiée).
  IF TG_OP = 'UPDATE'
     AND OLD.signature IS NULL
     AND NEW.signature IS NOT NULL
     AND (to_jsonb(OLD) - 'signature') = (to_jsonb(NEW) - 'signature')
  THEN
    RETURN NEW;
  END IF;

  -- 2. Tout le reste est interdit.
  RAISE EXCEPTION 'Le journal d''audit est en ajout seul : % interdite (entrée %)',
    CASE WHEN TG_OP = 'DELETE' THEN 'suppression' ELSE 'modification' END,
    OLD.id
    USING ERRCODE = '42501';
END $$;

COMMENT ON FUNCTION sec.tg_audit_immutable() IS
  'Bloque toute modification/suppression du journal ; autorise uniquement le remplissage initial de la signature HMAC';

-- Privilège de colonne : le rôle applicatif ne peut écrire que la signature.
REVOKE UPDATE, DELETE ON sec.audit_log FROM mwana_app;
GRANT UPDATE (signature) ON sec.audit_log TO mwana_app;

COMMIT;
