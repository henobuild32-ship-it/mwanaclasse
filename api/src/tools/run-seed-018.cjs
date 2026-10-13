/**
 * Exécute uniquement le seed 018 (purge + démo) avec le pepper en variable de session.
 * Usage : node api/src/tools/run-seed-018.cjs   (depuis la racine ou api/)
 */
require('dotenv/config');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const pepper = process.env.MWANA_PEPPER_PASSWORD;
if (!pepper) {
  console.error('MWANA_PEPPER_PASSWORD manquant dans api/.env');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquante dans api/.env');
  process.exit(1);
}

// Localise le fichier SQL 018
function findSql() {
  const candidates = [
    path.resolve(__dirname, '../../db/sql/018_seed_purge_demo.sql'),
    path.resolve(__dirname, '../../../db/sql/018_seed_purge_demo.sql'),
  ];
  for (const c of candidates) {
    try { readFileSync(c); return c; } catch { /* continue */ }
  }
  throw new Error('018_seed_purge_demo.sql introuvable');
}

const sqlPath = findSql();
const sql = readFileSync(sqlPath, 'utf8');
console.log('Script :', sqlPath, `(${Math.round(sql.length / 1024)} Kio)`);

const pool = new Pool({
  connectionString: url,
  max: 1,
  application_name: 'mwana-seed-018',
  statement_timeout: 0,
  query_timeout: 0,
});

(async () => {
  const client = await pool.connect();
  try {
    await client.query('SELECT set_config($1, $2, false)', ['app.seed_pepper', pepper]);
    const t0 = Date.now();
    await client.query(sql);
    console.log(`[ok] Seed 018 appliqué en ${Date.now() - t0} ms`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[x] Échec :', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
