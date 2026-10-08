/**
 * ============================================================================
 *  MWANA CLASSE — Accès à la base PostgreSQL
 * ============================================================================
 *  Points clés :
 *    - pool de connexions borné (évite l'épuisement côté serveur PostgreSQL) ;
 *    - chaque requête métier s'exécute dans une TRANSACTION qui positionne
 *      d'abord l'identité applicative (école, parent, acteur) ;
 *    - set_config(..., true) est LOCAL à la transaction : la valeur ne peut
 *      pas fuir vers la requête suivante d'une autre utilisatrice ou d'un
 *      autre utilisateur qui réutilise la même connexion du pool ;
 *    - délais d'expiration stricts : une requête ne peut pas bloquer le serveur ;
 *    - le schéma n'est jamais modifié par l'API (pas de DDL).
 * ============================================================================
 */

import { Pool, type PoolClient, type PoolConfig, type QueryResult } from 'pg';
import type { AppConfig } from '../config/index.js';

/* ==========================================================================
 *  Identité applicative transmise aux politiques RLS
 * ========================================================================== */

export interface DbIdentity {
  /** École active (isolation des données) */
  schoolId?: string | null;
  /** Parent connecté (accès à ses propres enfants) */
  parentId?: string | null;
  /** Type d'acteur : pilote les politiques RLS */
  actor: 'staff' | 'parent' | 'system';
  /** Identifiant du personnel (journalisation) */
  staffId?: string | null;
  /** Adresse IP pour la traçabilité */
  ip?: string | null;
  /** Identifiant de terminal (synchronisation) */
  deviceId?: string | null;
}

/* ==========================================================================
 *  Classe principale
 * ========================================================================== */

export class Database {
  readonly pool: Pool;
  private readonly cfg: AppConfig;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;

    const poolConfig: PoolConfig = {
      connectionString: cfg.DATABASE_URL,
      min: cfg.DB_POOL_MIN,
      max: cfg.DB_POOL_MAX,
      // Un client inactif depuis 30 s est rendu au serveur PostgreSQL
      idleTimeoutMillis: 30_000,
      // Attente maximale d'une connexion libre : au-delà, erreur explicite
      connectionTimeoutMillis: 10_000,
      // Empêche une requête bloquée de retenir une connexion indéfiniment
      statement_timeout: cfg.DB_STATEMENT_TIMEOUT_MS,
      query_timeout: cfg.DB_STATEMENT_TIMEOUT_MS + 2_000,
      application_name: 'mwana-classe-api',
      ...(cfg.DB_SSL
        ? {
            ssl: {
              rejectUnauthorized: cfg.DB_SSL_REJECT_UNAUTHORIZED,
            },
          }
        : {}),
    };

    this.pool = new Pool(poolConfig);

    // Un pool PostgreSQL est un composant critique : toute erreur inattendue
    // est journalisée, jamais ignorée silencieusement.
    this.pool.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[db] erreur sur une connexion inactive du pool', err.message);
    });
  }

  /* ---------------------------------------------------------------------- */

  /** Requête sans contexte RLS (santé, migrations, inscriptions publiques). */
  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, params as any[]);
  }

  /**
   * Exécute une fonction dans une transaction, avec l'identité applicative
   * positionnée en portée LOCALE. C'est le point d'entrée à utiliser pour
   * TOUTE opération métier.
   */
  async withIdentity<T>(
    identity: DbIdentity,
    fn: (client: PoolClient) => Promise<T>,
    opts: { readOnly?: boolean; isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {},
  ): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      if (opts.isolation) {
        await client.query(`SET TRANSACTION ISOLATION LEVEL ${opts.isolation.toUpperCase()}`);
      }
      if (opts.readOnly) {
        await client.query('SET TRANSACTION READ ONLY');
      }

      // set_config(..., true) => LOCAL à la transaction uniquement.
      await client.query(
        `SELECT set_config('app.school_id', $1, true),
                set_config('app.parent_id', $2, true),
                set_config('app.actor',     $3, true),
                set_config('app.staff_id',  $4, true),
                set_config('app.client_ip', $5, true),
                set_config('app.device_id', $6, true)`,
        [
          identity.schoolId ?? '',
          identity.parentId ?? '',
          identity.actor,
          identity.staffId ?? '',
          identity.ip ?? '',
          identity.deviceId ?? '',
        ],
      );

      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* la connexion est peut-être déjà cassée : on la libère plus bas */
      }
      throw err;
    } finally {
      // On libère la connexion ; le pool la réinitialise (ROLLBACK implicite
      // si une transaction est restée ouverte).
      client.release();
    }
  }

  /** Transaction sans identité (opérations d'inscription, tâches système). */
  async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    opts: { readOnly?: boolean } = {},
  ): Promise<T> {
    return this.withIdentity({ actor: 'system' }, fn, opts);
  }

  /**
   * Vérifie la disponibilité de la base et que les politiques d'isolation
   * sont bien actives. Utilisé par /sante et au démarrage.
   */
  async health(): Promise<{
    ok: boolean;
    version: string;
    rlsEnabledTables: number;
    rlsForcedTables: number;
    latencyMs: number;
    error?: string;
  }> {
    const started = Date.now();
    try {
      const version = await this.query<{ v: string }>('SELECT version() AS v');
      const rls = await this.query<{ enabled: string; forced: string }>(
        `SELECT
           count(*) FILTER (WHERE relrowsecurity)::text      AS enabled,
           count(*) FILTER (WHERE relforcerowsecurity)::text AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'app' AND c.relkind = 'r'`,
      );

      return {
        ok: true,
        version: String(version.rows[0]?.v ?? '').split(' ').slice(0, 2).join(' '),
        rlsEnabledTables: Number(rls.rows[0]?.enabled ?? 0),
        rlsForcedTables: Number(rls.rows[0]?.forced ?? 0),
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        version: '',
        rlsEnabledTables: 0,
        rlsForcedTables: 0,
        latencyMs: Date.now() - started,
        error: (err as Error).message,
      };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/* ==========================================================================
 *  Helpers de requête typés
 * ========================================================================== */

/** Renvoie la première ligne ou null. */
export async function one<T extends Record<string, unknown>>(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const res = await client.query<T>(sql, params as any[]);
  return res.rows[0] ?? null;
}

/** Renvoie la première ligne ou lève une erreur explicite. */
export async function oneOrFail<T extends Record<string, unknown>>(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
  notFoundMessage = 'Ressource introuvable',
): Promise<T> {
  const row = await one<T>(client, sql, params);
  if (!row) {
    const err = new Error(notFoundMessage) as Error & { statusCode?: number; code?: string };
    err.statusCode = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  return row;
}

/** Renvoie toutes les lignes. */
export async function many<T extends Record<string, unknown>>(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await client.query<T>(sql, params as any[]);
  return res.rows;
}

/** Exécute une écriture et renvoie le nombre de lignes affectées. */
export async function execute(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const res = await client.query(sql, params as any[]);
  return res.rowCount ?? 0;
}

/* ==========================================================================
 *  Gestion des erreurs PostgreSQL
 * ========================================================================== */

export interface PgErrorLike {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  column?: string;
}

/**
 * Traduit une erreur PostgreSQL en message utilisateur compréhensible.
 * On ne renvoie jamais le message brut de PostgreSQL : il peut révéler la
 * structure interne de la base (fuite d'information).
 */
export function translatePgError(err: unknown): { status: number; code: string; message: string } {
  const e = err as PgErrorLike;

  switch (e.code) {
    case '23505': // unique_violation
      if (e.constraint?.includes('students_code')) {
        return { status: 409, code: 'CODE_EXISTANT', message: 'Ce code est déjà utilisé.' };
      }
      if (e.constraint?.includes('email')) {
        return { status: 409, code: 'EMAIL_EXISTANT', message: 'Cette adresse e-mail est déjà enregistrée.' };
      }
      if (e.constraint?.includes('att_unique_day') || e.constraint?.includes('student_id')) {
        return {
          status: 409,
          code: 'PRESENCE_EXISTANTE',
          message: 'Une présence est déjà enregistrée pour cet élève à cette date.',
        };
      }
      return { status: 409, code: 'DOUBLON', message: 'Cet enregistrement existe déjà.' };

    case '23503': // foreign_key_violation
      return {
        status: 409,
        code: 'REFERENCE_INVALIDE',
        message: 'La référence indiquée est introuvable ou déjà supprimée.',
      };

    case '23502': // not_null_violation
      return { status: 400, code: 'CHAMP_OBLIGATOIRE', message: 'Un champ obligatoire est manquant.' };

    case '23514': // check_violation
      if (e.constraint?.includes('att_late_needs_time')) {
        return {
          status: 400,
          code: 'HEURE_REQUISE',
          message: 'Un retard doit obligatoirement comporter une heure d’arrivée.',
        };
      }
      if (e.constraint?.includes('att_times_ok')) {
        return {
          status: 400,
          code: 'HEURES_INCOHERENTES',
          message: 'L’heure de départ ne peut pas précéder l’heure d’arrivée.',
        };
      }
      return { status: 400, code: 'VALEUR_INVALIDE', message: 'Une valeur ne respecte pas les règles attendues.' };

    case '42501': // insufficient_privilege — souvent une tentative d'accès hors école
      return { status: 403, code: 'ACCES_REFUSE', message: 'Accès refusé.' };

    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return {
        status: 409,
        code: 'CONFLIT_CONCURRENT',
        message: 'La donnée a été modifiée simultanément. Réessayez.',
      };

    case '57014': // query_canceled (statement_timeout)
      return { status: 504, code: 'DELAI_DEPASSE', message: 'L’opération a pris trop de temps.' };

    case '08000': // connection_exception
    case '08001': // sqlclient_unable_to_establish_sqlconnection
    case '08003': // connection_does_not_exist
    case '08004': // sqlserver_rejected_establishment_of_sqlconnection
    case '08006': // connection_failure
    case '08P01': // protocol_violation
    case '53300': // too_many_connections
    case '53400': // configuration_limit_exceeded
    case '57P01': // admin_shutdown
    case '57P02': // crash_shutdown
    case '57P03': // cannot_connect_now
      return { status: 503, code: 'BASE_SATUREE', message: 'Le service est momentanément surchargé.' };

    default:
      return {
        status: 500,
        code: 'ERREUR_BASE',
        message: 'Une erreur interne est survenue lors du traitement.',
      };
  }
}

/**
 * Une erreur qui n'a PAS de SQLSTATE (échec de connexion réseau, épuisement du
 * pool, expiration de délai) ne doit jamais se terminer en 500 : le client
 * reçoit un « service momentanément indisponible » avec une consigne de
 * nouvelle tentative, et le serveur continue de répondre aux autres requêtes.
 */
export function isInfrastructureError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const code = String(e.code ?? '');
  if (
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EPIPE',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ERR_SOCKET_CONNECTION_TIMEOUT',
    ].includes(code)
  ) {
    return true;
  }
  return /timeout exceeded when trying to connect|Connection terminated|Client has encountered a connection error|remaining connection slots|too many clients already|Connection ended unexpectedly/i.test(
    e.message ?? '',
  );
}

