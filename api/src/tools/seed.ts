/**
 * ============================================================================
 *  MWANA CLASSE — Jeu de données de démonstration
 * ============================================================================
 *  Usage :
 *    npm run db:seed              applique les scripts *seed* (démo)
 *    npm run db:seed -- --check   affiche ce qui serait appliqué
 *
 *  Sécurité :
 *    - les scripts de démonstration créent des comptes dont le mot de passe
 *      est PUBLIC : ils sont INTERDITS en production ;
 *    - la commande refuse donc de s'exécuter si NODE_ENV=production, sauf
 *      avec l'option explicite --force-production ;
 *    - le script est idempotent (ON CONFLICT DO NOTHING) : on peut le
 *      relancer pour compléter une base locale.
 * ============================================================================
 */

import 'dotenv/config';
import path from 'node:path';
import {
  createAdminPool,
  findRepoRoot,
  finish,
  migrationFiles,
  out,
  seedFiles,
  sqlDir,
} from './_shared.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const forceProduction = args.includes('--force-production');

  const root = findRepoRoot();
  const dir = sqlDir(root);
  const files = seedFiles(dir);

  out.step(`Jeu de démonstration — ${path.relative(process.cwd(), dir) || dir}`);

  if (files.length === 0) {
    finish(0, 'Aucun script de démonstration trouvé.');
  }

  if (process.env.NODE_ENV === 'production' && !forceProduction) {
    finish(
      1,
      'Refus : les données de démonstration ne doivent JAMAIS être chargées en production.\n' +
        'Elles créent des comptes dont le mot de passe est public.',
    );
  }

  for (const file of files) {
    out.info(`${file.name} (${Math.round(file.sql.length / 1024)} Kio)`);
  }

  if (checkOnly) {
    finish(0, `\n${files.length} script(s) seraient appliqué(s).`);
  }

  const pool = createAdminPool();

  // Le poivre (MWANA_PEPPER_PASSWORD) doit être le même que celui de l'API :
  // la base hache elle-même les mots de passe de démonstration. Sans lui, les
  // comptes créés seraient impossibles à utiliser.
  const pepper = process.env.MWANA_PEPPER_PASSWORD;
  if (!pepper) {
    await pool.end();
    finish(
      1,
      'MWANA_PEPPER_PASSWORD est absent de api/.env : impossible de hacher les mots de passe.\n' +
        'Générez les secrets avec « npm run secrets:generate » puis ajoutez les valeurs dans api/.env.',
    );
  }

  // Le suivi des migrations peut être absent si seed est lancé seul.
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS sec;
    CREATE TABLE IF NOT EXISTS sec.schema_migrations (
      version     text PRIMARY KEY,
      filename    text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0
    );
  `);

  const { rows: appliedRows } = await pool.query<{ version: string }>(
    'SELECT version FROM sec.schema_migrations',
  );
  const applied = new Set(appliedRows.map((r) => r.version));
  const pendingStructure = migrationFiles(dir).filter((f) => !applied.has(f.version));

  if (pendingStructure.length > 0) {
    out.warn(
      `${pendingStructure.length} migration(s) de structure non appliquée(s) : lancez « npm run db:migrate » avant le seed.`,
    );
    for (const f of pendingStructure) out.info(`  ${f.name}`);
  }

  for (const file of files) {
    const client = await pool.connect();
    const started = Date.now();
    let failure: string | null = null;
    try {
      // Poivre visible par les fonctions SQL du script de démonstration.
      await client.query('SELECT set_config($1, $2, false)', ['app.seed_pepper', pepper]);
      await client.query(file.sql);
      const duration = Date.now() - started;
      await client.query(
        `INSERT INTO sec.schema_migrations (version, filename, checksum, duration_ms)
         VALUES ($1, $2, $3, $4) ON CONFLICT (version) DO NOTHING`,
        [file.version, file.name, file.checksum, duration],
      );
      out.ok(`${file.name} (${duration} ms)`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      failure = (err as Error).message;
    } finally {
      client.release();
    }

    if (failure !== null) {
      await pool.end();
      finish(1, `Échec de ${file.name} — script annulé.\nCause : ${failure}`);
    }
  }

  // RLS ... FORCE : les volumes ne sont visibles que pour l'école courante.
  const client = await pool.connect();
  let schoolCount = 0;
  let studentCount = 0;
  try {
    const schools = await client.query<{ id: string }>('SELECT id FROM app.schools ORDER BY id');
    schoolCount = schools.rows.length;
    for (const s of schools.rows) {
      await client.query('SELECT set_config($1, $2, false)', ['app.school_id', s.id]);
      const students = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM app.students',
      );
      studentCount += Number(students.rows[0]?.n ?? 0);
    }
  } finally {
    client.release();
  }

  await pool.end();

  console.log('');
  out.info(`Écoles : ${schoolCount} — Élèves : ${studentCount}`);
  out.info('Identifiants de démonstration : voir l’en-tête de db/sql/006_seed_demo.sql.');
  finish(0, 'Jeu de démonstration chargé.');
}

main().catch((err: unknown) => {
  console.error(`\n[x] ${(err as Error).message}\n`);
  process.exit(1);
});
