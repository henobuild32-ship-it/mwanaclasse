/**
 * ============================================================================
 *  MWANA CLASSE — Protection contre les attaques par force brute
 * ============================================================================
 *  Trois niveaux complémentaires :
 *
 *   1. Verrouillage progressif d'un compte
 *        5 échecs → 1 minute      8 échecs → 5 minutes
 *       12 échecs → 30 minutes    20 échecs → 24 heures
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
      limit: cfg.RATE_LIMIT_LOGIN_PER_MINUTE * 4,
      windowSeconds: 60,
      blockSeconds: 600,
      description: 'Tentatives de connexion par adresse IP',
    },
    register: {
      bucket: 'register',
      limit: 5,
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
      limit: 3,
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
   */
  async checkLogin(
    client: PoolClient,
    identifier: string,
    ip: string | null,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number; reason?: string }> {
    if (ip) {
      const ipLock = await this.isLocked(client, 'ip', ip);
      if (ipLock.locked) {
        return {
          allowed: false,
          retryAfterSeconds: ipLock.retryAfterSeconds,
          reason: 'Adresse temporairement bloquée après plusieurs échecs.',
        };
      }
    }

    const byIdentifier = await this.consume(client, 'login', {
      kind: 'identifier',
      key: identifier.toLowerCase(),
    });
    if (!byIdentifier.allowed) {
      return {
        allowed: false,
        retryAfterSeconds: byIdentifier.retryAfterSeconds,
        reason: 'Trop de tentatives sur ce compte. Réessayez plus tard.',
      };
    }

    if (ip) {
      const byIp = await this.consume(client, 'login_ip', { kind: 'ip', key: ip });
      if (!byIp.allowed) {
        return {
          allowed: false,
          retryAfterSeconds: byIp.retryAfterSeconds,
          reason: 'Trop de tentatives depuis cette connexion. Réessayez plus tard.',
        };
      }
    }

    return { allowed: true, retryAfterSeconds: 0 };
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
