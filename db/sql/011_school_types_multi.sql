-- =====================================================================
-- Migration 011 — Type d'établissement en sélection multiple
--                + précision « mixte / non mixte » pour le collège
--
-- Constat : `app.schools.type` est un énumératif mono-valeur. Un
-- établissement qui propose plusieurs cycles (maternelle + primaire,
-- secondaire + humanités…) devait en réduire l'un à « mixte » ou
-- « autre », ce qui rendait la donnée inutilisable pour la suite du
-- produit.
--
-- Correction :
--   * `types`  — tableau des cycles réellement proposés (sélection
--                multiple) ; `type` est conservé comme type principal
--                (premier élément de `types`) pour ne rien casser ;
--   * `is_mixed` — précision explicite « établissement mixte ? »,
--                demandée notamment pour le collège (secondaire).
--
-- La colonne `type` reste NOT NULL : elle sert de libellé principal
-- partout où la base l'expose (cartes, exports, seeds).
-- =====================================================================

BEGIN;

ALTER TABLE app.schools
  ADD COLUMN IF NOT EXISTS types    app.school_type[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_mixed boolean;

COMMENT ON COLUMN app.schools.types IS
  'Types d''enseignement proposés par l''établissement (sélection multiple)';
COMMENT ON COLUMN app.schools.is_mixed IS
  'Établissement mixte garçons/filles — précision demandée pour le collège';

-- Les écoles existantes héritent de leur type principal.
UPDATE app.schools SET types = ARRAY[type] WHERE cardinality(types) = 0;

-- Une école déclarée « mixte » l'était au sens « garçons et filles ».
UPDATE app.schools SET is_mixed = true WHERE type = 'mixte' AND is_mixed IS NULL;

-- Recherche « ce cycle est proposé » (utile pour les listes/filtres).
CREATE INDEX IF NOT EXISTS school_types_idx ON app.schools USING gin (types);

COMMIT;
