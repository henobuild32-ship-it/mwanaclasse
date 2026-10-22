/**
 * Met à jour les comptes de démonstration :
 *   École  : ecole@mwanaclasse.com  / 12345678
 *   Parent : parent@mwanaclasse.com / 12345678
 *
 * Usage : node api/src/tools/update-demo-accounts.cjs
 */
require('dotenv/config');
const path = require('node:path');
const { readFileSync } = require('node:fs');
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

function findSql() {
  const candidates = [
    path.resolve(__dirname, '../../db/sql/update-demo-accounts.sql'),
    path.resolve(__dirname, '../../../db/sql/update-demo-accounts.sql'),
  ];
  for (const c of candidates) {
    try { readFileSync(c); return c; } catch { /* continue */ }
  }
  throw new Error('update-demo-accounts.sql introuvable');
}

const sqlPath = findSql();
const sql = readFileSync(sqlPath, 'utf8');
console.log('Script :', sqlPath);

const pool = new Pool({ connectionString: url, max: 1, application_name: 'mwana-update-demo', statement_timeout: 0 });

(async () => {
  const client = await pool.connect();
  try {
    await client.query('SELECT set_config($1, $2, false)', ['app.seed_pepper', pepper]);
    const t0 = Date.now();
    await client.query(sql);
    console.log(`[ok] Comptes mis à jour en ${Date.now() - t0} ms`);

    // Vérification
    const staff = await client.query(`SELECT email FROM sec.staff_users ORDER BY created_at LIMIT 1`);
    const parent = await client.query(`SELECT email FROM app.parents ORDER BY created_at LIMIT 1`);
    console.log('École  :', staff.rows[0]?.email);
    console.log('Parent :', parent.rows[0]?.email);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[x] Échec :', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
