/**
 * ============================================================================
 *  MWANA CLASSE — Protection contre les attaques par force brute
 * ============================================================================
 *  Trois niveaux complémentaires :
 *
 *   1. Verrouillage progressif d'un compte
 *        10 échecs → 1 minute      20 échecs → 5 minutes
 *        40 échecs → 30 minutes    80 échecs → 1 heure
 *      (paliers définis dans la fonction SQL sec.register_login_attempt)
 *
 *   2. Limitation de débit par sujet : adresse IP, identifiant, école,
 *      appareil. Fenêtres glissantes stockées en base (partagées entre toutes
 *      les instances de l'API : un contournement par changement d'instance
 *      est impossible).
 *
 *   3. Détection d'anomalies : bourrage d'identifiants, énumération de codes,
 *      accès hors horaires — remontés en alertes de sécurité.
 * ============================================================================
 */

import type { PoolClient } from 'pg';
import type { AppConfig } from '../config/index.js';
import type { Database } from '../db/pool.js';

/* ==========================================================================
 *  Quotas par type d'opération
 * ========================================================================== */

export interface QuotaRule {
  bucket: string;
  limit: number;
  windowSeconds: number;
  blockSeconds: number;
  description: string;
}

export function quotaRules(cfg: AppConfig): Record<string, QuotaRule> {
  return {
    login: {
      bucket: 'login',
      limit: cfg.RATE_LIMIT_LOGIN_PER_MINUTE,
      windowSeconds: 60,
      blockSeconds: 300,
      description: 'Tentatives de connexion par identifiant',
    },
    login_ip: {
      bucket: 'login_ip',
      limit: cfg.RATE_LIMIT_LOGIN_IP_PER_MINUTE,
      windowSeconds: 60,
      blockSeconds: 600,
      description: 'Tentatives de connexion par adresse IP (réseau partagé)',
    },
    register: {
      bucket: 'register',
      limit: cfg.RATE_LIMIT_REGISTER_PER_HOUR,
      windowSeconds: 3600,
      blockSeconds: 3600,
      description: 'Créations de compte',
    },
    code_lookup: {
      bucket: 'code_lookup',
      limit: cfg.CODE_LOOKUP_PER_HOUR,
      windowSeconds: 3600,
      blockSeconds: 1800,
      description: 'Recherches de code élève / école (anti-énumération)',
    },
    totp: {
      bucket: 'totp',
      limit: cfg.TOTP_MAX_ATTEMPTS,
      windowSeconds: 300,
      blockSeconds: 900,
      description: 'Validations de code à deux facteurs',
    },
    password_reset: {
      bucket: 'password_reset',
      limit: cfg.RATE_LIMIT_PASSWORD_RESET_PER_HOUR,
      windowSeconds: 3600,
      blockSeconds: 3600,
      description: 'Demandes de réinitialisation de mot de passe',
    },
    attendance_write: {
      bucket: 'attendance_write',
      limit: 6000,
      windowSeconds: 3600,
      blockSeconds: 300,
      description: 'Enregistrements de présence (large : usage hors ligne légitime)',
    },
    sync: {
      bucket: 'sync',
      limit: 240,
      windowSeconds: 3600,
      blockSeconds: 300,
      description: 'Synchronisations offline',
    },
    export: {
      bucket: 'export',
      limit: 20,
      windowSeconds: 3600,
      blockSeconds: 1800,
      description: 'Exports de données',
    },
    announcement: {
      bucket: 'announcement',
      limit: 120,
      windowSeconds: 3600,
      blockSeconds: 600,
      description: 'Créations de communiqué',
    },
  };
}

/* ==========================================================================
 *  Résultat d'un contrôle de quota
 * ========================================================================== */

export interface QuotaDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  rule: string;
}

export class BruteForceGuard {
  constructor(
    private readonly db: Database,
    private readonly cfg: AppConfig,
  ) {}

  private get rules(): Record<string, QuotaRule> {
    return quotaRules(this.cfg);
  }

  /**
   * Consomme une unité de quota pour un sujet donné.
   * Le compteur vit en base : il est partagé par toutes les instances de l'API
   * et survit à un redémarrage (contrairement à un compteur en mémoire).
   */
  async consume(
    client: PoolClient,
    ruleKey: keyof ReturnType<typeof quotaRules> | string,
    subject: { kind: 'ip' | 'identifier' | 'parent' | 'staff' | 'school' | 'device'; key: string },
  ): Promise<QuotaDecision> {
    const rule = this.rules[ruleKey as string] ?? this.rules['login']!;

    try {
      const { rows } = await client.query<{
        allowed: boolean;
        remaining: number;
        retry_after: number;
      }>(`SELECT * FROM sec.consume_quota($1, $2, $3, $4, $5, $6)`, [
        rule.bucket,
        subject.kind,
        subject.key,
        rule.limit,
        rule.windowSeconds,
        rule.blockSeconds,
      ]);

      const row = rows[0];
      return {
        allowed: row?.allowed ?? true,
        remaining: Math.max(0, row?.remaining ?? 0),
        retryAfterSeconds: Math.max(0, row?.retry_after ?? 0),
        rule: rule.bucket,
      };
    } catch (err) {
      // Disponibilité d'abord : un compteur illisible (base momentanément
      // indisponible) ne doit JAMAIS faire échouer une connexion ou une
      // inscription légitime. On autorise (fail-open) et on trace l'anomalie.
      // eslint-disable-next-line no-console
      console.warn(
        `[bruteforce] quota « ${rule.bucket} » indisponible, requête autorisée : ${(err as Error).message}`,
      );
      return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0, rule: rule.bucket };
    }
  }

  /**
   * Vérifie si un sujet est actuellement sous verrouillage explicite
   * (compte bloqué, IP bloquée) sans consommer de quota.
   */
  async isLocked(client: PoolClient, scope: 'compte' | 'ip' | 'appareil' | 'ecole', key: string) {
    const { rows } = await client.query<{ locked: boolean; until: string | null }>(
      `SELECT * FROM sec.is_locked_out($1, $2)`,
      [scope, key],
    );
    const row = rows[0];
    return {
      locked: row?.locked ?? false,
      until: row?.until ? new Date(row.until) : null,
      retryAfterSeconds: row?.until
        ? Math.max(1, Math.ceil((new Date(row.until).getTime() - Date.now()) / 1000))
        : 0,
    };
  }

  /**
   * Enregistre une tentative de connexion et applique le verrouillage
   * progressif. Retourne l'état après enregistrement.
   */
  async registerLoginAttempt(
    client: PoolClient,
    input: {
      audience: 'parent' | 'ecole';
      identifier: string;
      parentId?: string | null;
      staffUserId?: string | null;
      schoolId?: string | null;
      success: boolean;
      reason:
        | 'mot_de_passe'
        | 'utilisateur_inconnu'
        | 'compte_desactive'
        | 'compte_verrouille'
        | '2fa_invalide'
        | '2fa_requis'
        | 'token_invalide'
        | 'ok';
      ip?: string | null;
      userAgent?: string | null;
      fingerprint?: string | null;
    },
  ): Promise<{ locked: boolean; lockedUntil: Date | null; failures: number; waitSeconds: number }> {
    const { rows } = await client.query<{
      locked: boolean;
      locked_until: string | null;
      failures: number;
      wait_seconds: number;
    }>(`SELECT * FROM sec.register_login_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      input.audience,
      input.identifier,
      input.parentId ?? null,
      input.staffUserId ?? null,
      input.schoolId ?? null,
      input.success,
      input.reason,
      input.ip ?? null,
      input.userAgent ?? null,
      input.fingerprint ?? null,
    ]);

    const row = rows[0];
    return {
      locked: row?.locked ?? false,
      lockedUntil: row?.locked_until ? new Date(row.locked_until) : null,
      failures: row?.failures ?? 0,
      waitSeconds: row?.wait_seconds ?? 0,
    };
  }

  /**
   * Applique tous les contrôles de débit à une tentative de connexion, en
   * fonction de l'identifiant ET de l'adresse IP (deux sujets distincts :
   * un attaquant qui change d'identifiant reste limité par son IP).
   *
   * Les trois contrôles (verrou IP, quota identifiant, quota IP) sont
   * exécutés en UNE seule requête SQL : chaque aller-retour coûte des
   * centaines de millisecondes, ce qui comptait pour ~1 seconde par
   * connexion tentée avant cette optimisation.
   */
  async checkLogin(
    client: PoolClient,
    identifier: string,
    ip: string | null,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number; reason?: string }> {
    const bySubject = identifier.toLowerCase();

    try {
      if (!ip) {
        const byIdentifier = await this.consume(client, 'login', {
          kind: 'identifier',
          key: bySubject,
        });
        if (!byIdentifier.allowed) {
          return {
            allowed: false,
            retryAfterSeconds: byIdentifier.retryAfterSeconds,
            reason: 'Trop de tentatives sur ce compte. Réessayez plus tard.',
          };
        }
        return { allowed: true, retryAfterSeconds: 0 };
      }

      const login = this.rules['login']!;
      const loginIp = this.rules['login_ip']!;

      const { rows } = await client.query<{
        ip_locked: boolean;
        ip_until: string | null;
        id_allowed: boolean;
        id_retry: number;
        ip_allowed: boolean;
        ip_retry: number;
      }>(
        `WITH verrou AS (
           SELECT * FROM sec.is_locked_out('ip', $1)
         ),
         conso_ident AS (
           SELECT * FROM sec.consume_quota($2, 'identifier', $3, $4, $5, $6)
         ),
         conso_ip AS (
           SELECT * FROM sec.consume_quota($7, 'ip', $8, $9, $10, $11)
         )
         SELECT COALESCE((SELECT locked  FROM verrou), false)     AS ip_locked,
                (SELECT until FROM verrou)                        AS ip_until,
                COALESCE((SELECT allowed FROM conso_ident), true) AS id_allowed,
                COALESCE((SELECT retry_after FROM conso_ident), 0) AS id_retry,
                COALESCE((SELECT allowed FROM conso_ip), true)     AS ip_allowed,
                COALESCE((SELECT retry_after FROM conso_ip), 0)    AS ip_retry`,
        [
          ip,
          login.bucket,
          bySubject,
          login.limit,
          login.windowSeconds,
          login.blockSeconds,
          loginIp.bucket,
          ip,
          loginIp.limit,
          loginIp.windowSeconds,
          loginIp.blockSeconds,
        ],
      );

      const row = rows[0];
      if (!row) return { allowed: true, retryAfterSeconds: 0 };

      if (row.ip_locked && row.ip_until) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((new Date(row.ip_until).getTime() - Date.now()) / 1000),
        );
        return {
          allowed: false,
          retryAfterSeconds,
          reason: 'Adresse temporairement bloquée après plusieurs échecs.',
        };
      }
      if (!row.id_allowed) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(0, row.id_retry),
          reason: 'Trop de tentatives sur ce compte. Réessayez plus tard.',
        };
      }
      if (!row.ip_allowed) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(0, row.ip_retry),
          reason: 'Trop de tentatives depuis cette connexion. Réessayez plus tard.',
        };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    } catch (err) {
      // Fail-open : une panne du compteur ne doit pas refuser en masse des
      // milliers de connexions légitimes (voir consume()).
      // eslint-disable-next-line no-console
      console.warn(`[bruteforce] contrôle de débit indisponible, tentative autorisée : ${(err as Error).message}`);
      return { allowed: true, retryAfterSeconds: 0 };
    }
  }

  /** Libère explicitement un verrouillage (action d'administration). */
  async release(client: PoolClient, scope: string, key: string, releasedBy: string): Promise<number> {
    const res = await client.query(
      `UPDATE sec.lockouts
          SET released_at = now(), released_by_name = $3
        WHERE scope = $1 AND subject_key = $2 AND released_at IS NULL`,
      [scope, key, releasedBy],
    );
    return res.rowCount ?? 0;
  }

  /** Liste les verrouillages actifs d'une école / d'un périmètre. */
  async activeLockouts(client: PoolClient, limit = 100) {
    const { rows } = await client.query(
      `SELECT id, scope, subject_key, reason, failed_count, locked_at, locked_until
         FROM sec.lockouts
        WHERE released_at IS NULL AND locked_until > now()
        ORDER BY locked_until DESC
        LIMIT $1`,
      [limit],
    );
    return rows;
  }

  /** Déclenche l'analyse de détection d'anomalies (règles SQL). */
  async detectAnomalies(client: PoolClient, windowMinutes = 15): Promise<number> {
    const { rows } = await client.query<{ detect_anomalies: number }>(
      `SELECT sec.detect_anomalies($1) AS detect_anomalies`,
      [windowMinutes],
    );
    return rows[0]?.detect_anomalies ?? 0;
  }

  /** Alertes de sécurité ouvertes. */
  async openAlerts(client: PoolClient, limit = 50) {
    const { rows } = await client.query(
      `SELECT id, school_id, rule_code, severity, title, detail, subject_kind,
              subject_key, occurrences, status, first_seen_at, last_seen_at
         FROM sec.security_alerts
        WHERE status IN ('ouverte','en_cours')
        ORDER BY
          CASE severity WHEN 'critique' THEN 1 WHEN 'grave' THEN 2
                        WHEN 'attention' THEN 3 ELSE 4 END,
          last_seen_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows;
  }
}

/* ==========================================================================
 *  En-têtes de réponse normalisés pour la limitation de débit
 * ========================================================================== */

export function rateLimitHeaders(decision: QuotaDecision): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(decision.remaining + 1),
    'X-RateLimit-Remaining': String(decision.remaining),
  };
  if (!decision.allowed && decision.retryAfterSeconds > 0) {
    headers['Retry-After'] = String(decision.retryAfterSeconds);
  }
  return headers;
}
