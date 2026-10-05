/**
 * ============================================================================
 *  MWANA CLASSE — Outils de ligne de commande (partagé)
 * ============================================================================
 *  Utilitaires communs à migrate / seed / verify-db / generate-secrets /
 *  security-selftest : localisation des scripts SQL, hachage d'intégrité et
 *  connexion PostgreSQL dédiée aux opérations d'administration.
 * ============================================================================
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

/* ==========================================================================
 *  Localisation des ressources
 * ========================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Remonte l'arborescence jusqu'au dossier qui contient `db/sql`. */
export function findRepoRoot(startDir: string = HERE): string {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(path.join(dir, 'db', 'sql'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Dossier db/sql introuvable : exécutez cette commande depuis le dépôt MwanaClasse.',
  );
}

/** Dossier contenant les scripts de migration. */
export function sqlDir(root: string = findRepoRoot()): string {
  return path.join(root, 'db', 'sql');
}

export interface SqlFile {
  /** Identifiant de version, ex. « 002 » */
  version: string;
  name: string;
  fullPath: string;
  sql: string;
  checksum: string;
  /** Un script de jeu de démonstration n'est jamais appliqué par migrate. */
  isSeed: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Liste les scripts SQL triés par version. */
export function listSqlFiles(dir: string = sqlDir()): SqlFile[] {
  const names = readdirSync(dir)
    .filter((n) => /^\d{3}_.*\.sql$/i.test(n))
    .sort((a, b) => a.localeCompare(b));

  return names.map((name) => {
    const fullPath = path.join(dir, name);
    const sql = readFileSync(fullPath, 'utf8');
    return {
      version: name.slice(0, 3),
      name,
      fullPath,
      sql,
      checksum: sha256(sql),
      isSeed: /seed/i.test(name),
    };
  });
}

/** Scripts de structure (migrations) : tout sauf les jeux de démonstration. */
export function migrationFiles(dir: string = sqlDir()): SqlFile[] {
  return listSqlFiles(dir).filter((f) => !f.isSeed);
}

/** Scripts de démonstration, à n'appliquer que sur une base vide/local. */
export function seedFiles(dir: string = sqlDir()): SqlFile[] {
  return listSqlFiles(dir).filter((f) => f.isSeed);
}

/* ==========================================================================
 *  Connexion PostgreSQL
 * ========================================================================== */

/**
 * Pool dédié aux outils d'administration : pas de timeout de requête (un
 * script de migration peut être long), ni d'identité applicative (le DDL et
 * le seed s'exécutent en superutilisateur, hors politiques RLS).
 */
export function createAdminPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL manquante : copiez api/.env.example vers api/.env et renseignez la connexion.',
    );
  }
  return new Pool({
    connectionString: url,
    max: 1,
    application_name: 'mwana-classe-outils',
    connectionTimeoutMillis: 15_000,
    // Un script de migration volumineux ne doit jamais être interrompu.
    statement_timeout: 0,
    query_timeout: 0,
  });
}

/* ==========================================================================
 *  Affichage
 * ========================================================================== */

export const out = {
  info: (msg: string) => console.log(`  ${msg}`),
  step: (msg: string) => console.log(`\n» ${msg}`),
  ok: (msg: string) => console.log(`  [ok] ${msg}`),
  warn: (msg: string) => console.warn(`  [!]  ${msg}`),
  fail: (msg: string) => console.error(`  [x]  ${msg}`),
};

/** Termine l'outil avec un code de sortie explicite. */
export function finish(code: number, message: string): never {
  console.log('');
  console.log(message);
  process.exit(code);
}
