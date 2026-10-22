-- ============================================================================
--  MWANA CLASSE — MISE À JOUR DES COMPTES DE DÉMONSTRATION
-- ============================================================================
--  Change les emails et mots de passe des deux comptes démo :
--    • École  : ecole@mwanaclasse.com  / 12345678
--    • Parent : parent@mwanaclasse.com / 12345678
--
--  Exécution (depuis api/) :
--    node src/tools/update-demo-accounts.cjs
--  ou manuellement via psql avec le pepper en variable de session :
--    SELECT set_config('app.seed_pepper', '<MWANA_PEPPER_PASSWORD>', false);
--    \i db/sql/update-demo-accounts.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Compte école — nouvel email + nouveau mot de passe
-- ---------------------------------------------------------------------------
UPDATE sec.staff_users
   SET email = 'ecole@mwanaclasse.com',
       password_hash = app.demo_password_hash('12345678', current_setting('app.seed_pepper', true)),
       password_algo = 'bcrypt',
       password_pepper_id = 'v1',
       updated_at = now()
 WHERE email IN ('mwanaclasse12@gmail.com', 'ecole@mwanaclasse.com');

-- ---------------------------------------------------------------------------
-- 2. Compte parent — nouvel email
-- ---------------------------------------------------------------------------
UPDATE app.parents
   SET email = 'parent@mwanaclasse.com',
       updated_at = now()
 WHERE email IN ('mwanaclasse@gmail.com', 'parent@mwanaclasse.com');

-- ---------------------------------------------------------------------------
-- 3. Identifiants parent — nouveau mot de passe
-- ---------------------------------------------------------------------------
UPDATE sec.parent_credentials c
   SET password_hash = app.demo_password_hash('12345678', current_setting('app.seed_pepper', true)),
       password_algo = 'bcrypt',
       password_pepper_id = 'v1'
  FROM app.parents p
 WHERE c.parent_id = p.id
   AND p.email = 'parent@mwanaclasse.com';

COMMIT;
