/**
 * ============================================================================
 *  MWANA CLASSE — Migration de la base de données
 * ============================================================================
 *  Usage :
 *    npm run db:migrate            applique tous les scripts en attente
 *    npm run db:migrate -- --status   affiche l'état sans rien appliquer
 *    npm run db:migrate -- --dry-run  affiche ce qui serait appliqué
 *
 *  Règles :
 *    - chaque script s'exécute dans SON propre COMMIT (les fichiers SQL sont
 *      déjà enveloppés) : un échec annule intégralement le script fautif ;
 *    - chaque application est journalisée dans sec.schema_migrations avec
 *      l'empreinte SHA-256 du fichier, ce qui rend une modification a
 *      postériori détectable ;
 *    - les scripts de démonstration (006_seed_demo.sql) sont ignorés ici :
 *      ils relèvent de « npm run db:seed ».
 * ============================================================================
 */

import 'dotenv/config';
import path from 'node:path';
import {
  createAdminPool,
  findRepoRoot,
  finish,
  listSqlFiles,
  migrationFiles,
  out,
  sqlDir,
} from './_shared.js';

const CREATE_TRACKING = `
CREATE SCHEMA IF NOT EXISTS sec;
CREATE TABLE IF NOT EXISTS sec.schema_migrations (
  version     text PRIMARY KEY,
  filename    text NOT NULL,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL DEFAULT 0
);
COMMENT ON TABLE sec.schema_migrations IS
  'Suivi des migrations de structure appliquées (empreinte SHA-256 du fichier)';
`;

interface AppliedRow {
  version: string;
  filename: string;
  checksum: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const statusOnly = args.includes('--status');
  const dryRun = args.includes('--dry-run');

  const root = findRepoRoot();
  const dir = sqlDir(root);
  const files = migrationFiles(dir);

  out.step(`Migrations — ${path.relative(process.cwd(), dir) || dir}`);
  out.info(`${files.length} script(s) de structure, ${listSqlFiles(dir).length - files.length} script(s) de démonstration ignoré(s)`);

  const pool = createAdminPool();

  // ---------------------------------------------------------------------
  //  Table de suivi
  // ---------------------------------------------------------------------
  await pool.query(CREATE_TRACKING);

  const { rows: appliedRows } = await pool.query<AppliedRow>(
    'SELECT version, filename, checksum FROM sec.schema_migrations ORDER BY version',
  );
  const applied = new Map(appliedRows.map((r) => [r.version, r]));

  // ---------------------------------------------------------------------
  //  État
  // ---------------------------------------------------------------------
  const pending = files.filter((f) => !applied.has(f.version));
  const drift: string[] = [];

  for (const file of files) {
    const known = applied.get(file.version);
    if (known && known.checksum !== file.checksum) {
      drift.push(file.name);
    }
  }

  if (statusOnly || dryRun) {
    for (const file of files) {
      const known = applied.get(file.version);
      const state = known ? (known.checksum === file.checksum ? 'appliqué' : 'MODIFIÉ') : 'en attente';
      out.info(`${file.version}  ${state.padEnd(10)}  ${file.name}`);
    }
    if (drift.length > 0) {
      out.warn(`${drift.length} fichier(s) modifié(s) après application : ${drift.join(', ')}`);
      out.warn('Recréez la base ou alignez les fichiers avant toute nouvelle exécution.');
    }
    await pool.end();
    finish(0, dryRun && pending.length > 0 ? `\n${pending.length} migration(s) seraient appliquée(s).` : '\nAucune action.');
  }

  if (drift.length > 0) {
    await pool.end();
    finish(
      1,
      `Migration refusée : ${drift.length} fichier(s) déjà appliqué(s) ont changé —\n  ${drift.join('\n  ')}\n` +
        'Modifier une migration en production casse la reproductibilité : créez un nouveau numéro.',
    );
  }

  if (pending.length === 0) {
    await pool.end();
    finish(0, 'Base à jour : aucune migration en attente.');
  }

  // ---------------------------------------------------------------------
  //  Application
  // ---------------------------------------------------------------------
  let done = 0;
  for (const file of pending) {
    const client = await pool.connect();
    const started = Date.now();
    let failure: string | null = null;
    try {
      await client.query(file.sql);
      const duration = Date.now() - started;
      await client.query(
        `INSERT INTO sec.schema_migrations (version, filename, checksum, duration_ms)
         VALUES ($1, $2, $3, $4)`,
        [file.version, file.name, file.checksum, duration],
      );
      done += 1;
      out.ok(`${file.name} (${duration} ms)`);
    } catch (err) {
      // Le script est annulé en intégralité (ROLLBACK) : la base reste dans
      // l'état du dernier fichier appliqué avec succès.
      await client.query('ROLLBACK').catch(() => undefined);
      failure = (err as Error).message;
    } finally {
      // Le client est TOUJOURS rendu au pool avant toute tentative de fermeture :
      // pool.end() attend sinon indéfiniment la libération de la connexion.
      client.release();
    }

    if (failure !== null) {
      await pool.end();
      finish(
        1,
        `Échec de ${file.name} — le script a été annulé, la base n'est pas partiellement modifiée.\n` +
          `Cause : ${failure}`,
      );
    }
  }

  await pool.end();
  finish(0, `${done} migration(s) appliquée(s). Base alignée sur la version ${files[files.length - 1]?.version}.`);
}

main().catch((err: unknown) => {
  console.error(`\n[x] ${(err as Error).message}\n`);
  process.exit(1);
});
