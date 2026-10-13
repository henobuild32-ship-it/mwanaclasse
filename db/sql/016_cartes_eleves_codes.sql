-- ============================================================================
--  MWANA CLASSE — 016 — Cartes élèves : code unique pour chaque élève
-- ============================================================================
--  La carte PVC (QR code) est construite à partir du `public_code` de
--  l'élève : le QR encode ce code seul, sans nom ni photo.
--
--  Ce script idempotent complète les codes manquants des élèves déjà
--  inscrits, pour que chaque élève actif puisse recevoir sa carte dès
--  l'ouverture du module « Carte des élèves ». Les élèves créés ensuite
--  reçoivent leur code à l'inscription (POST /api/ecole/eleves) : aucune
--  action n'est nécessaire pour eux.
--
--  Relancer ce script est sans effet dès que tous les élèves ont un code.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  eleve    record;
  candidat text;
  essai    int;
  genere   int := 0;
  reste    int := 0;
BEGIN
  FOR eleve IN
    SELECT id, full_name
      FROM app.students
     WHERE public_code IS NULL OR public_code = ''
       AND status <> 'archive'
     ORDER BY created_at
     FOR UPDATE
  LOOP
    candidat := '';
    FOR essai IN 1..12 LOOP
      candidat := app.format_student_code(app.random_code(6));
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM app.students s WHERE s.public_code = candidat
      );
    END LOOP;

    IF candidat <> '' AND candidat IS NOT NULL THEN
      UPDATE app.students s
         SET public_code = candidat
       WHERE s.id = eleve.id;
      genere := genere + 1;
    ELSE
      reste := reste + 1;
      RAISE WARNING 'Code élève impossible à générer pour % (%)', eleve.full_name, eleve.id;
    END IF;
  END LOOP;

  RAISE NOTICE 'Cartes élèves : % code(s) généré(s), % élève(s) sans code.', genere, reste;
END $$;

COMMENT ON COLUMN app.students.public_code IS
  'Code unique de l''élève (MC-ELV-XXXXXX) : imprimé en clair et encodé dans le QR de sa carte PVC — aucune donnée personnelle dans le QR.';

COMMIT;
