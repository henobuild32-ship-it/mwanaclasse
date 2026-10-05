/**
 * ============================================================================
 *  MWANA CLASSE — Chaîne de sécurité des requêtes HTTP
 * ============================================================================
 *  Chaque requête traverse les étapes suivantes, dans cet ordre :
 *
 *    1. identifiant de corrélation (tracabilité bout en bout) ;
 *    2. en-têtes de sécurité (CSP, HSTS, nosniff, referrer-policy…) ;
 *    3. vérification du jeton d'accès JWT puis de la session en base
 *       (une session révoquée cesse immédiatement de fonctionner) ;
 *    4. contrôle du deuxième facteur si la route l'exige ;
 *    5. contrôle de permission au niveau BACKEND (jamais seulement Angular) ;
 *    6. limitation de débit ;
 *    7. journalisation d'audit de l'action.
 * ============================================================================
 */

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Database, DbIdentity } from '../db/pool.js';
import type { AppConfig } from '../config/index.js';
import type { AuditLogger, AuditEntry, Severity } from '../security/audit.js';
import type { BruteForceGuard } from '../security/bruteforce.js';
import type { SessionService, SessionIdentity } from '../security/sessions.js';

/* ==========================================================================
 *  Authentification
 * ========================================================================== */

export interface AuthContext {
  identity: SessionIdentity;
  schoolId: string | null;
  userId: string;
  displayName: string;
  permissions: string[];
  isOwner: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    /** Identifiant de corrélation, réutilisé dans les journaux et les erreurs */
    correlationId: string;
    /** Adresse IP réelle (derrière un proxy de confiance) */
    clientIp: string | null;
  }
}

/** Adresse IP de la requête, en tenant compte du proxy uniquement s'il est de confiance. */
export function clientIp(req: FastifyRequest): string | null {
  // `req.ip` respecte trustProxy configuré sur l'instance : c'est la source
  // fiable. X-Forwarded-For brut n'est jamais lu directement (usurpable).
  return req.ip ?? null;
}

/**
 * Type du client PostgreSQL utilisé par les gestionnaires enveloppés.
 * On n'importe pas le type ici pour éviter un cycle de dépendances : la forme
 * utile (query) suffit et reste compatible avec PoolClient.
 */
export interface QueryableClient {
  query<R extends Record<string, any> = any>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * Dépendance d'authentification : vérifie le JWT, puis recharge la session en
 * base. Le rechargement est indispensable : un jeton signé reste valide
 * jusqu'à expiration, alors qu'une session révoquée doit être refusée
 * immédiatement (déconnexion, changement de mot de passe, vol détecté).
 */
export function requireAuth(deps: {
  db: Database;
  sessions: SessionService;
  jwtVerify: (token: string) => Record<string, any>;
}): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const fromHeader = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (!fromHeader) {
      return reply.code(401).send({
        erreur: 'AUTHENTIFICATION_REQUISE',
        message: 'Vous devez vous connecter pour accéder à cette ressource.',
      });
    }

    let payload: Record<string, any>;
    try {
      payload = deps.jwtVerify(fromHeader);
    } catch (err) {
      const expired = (err as Error).name === 'TokenExpiredError' ||
        (err as Error).message.toLowerCase().includes('expired');
      return reply.code(401).send({
        erreur: expired ? 'JETON_EXPIRE' : 'JETON_INVALIDE',
        message: expired
          ? 'Votre session a expiré. Reconnexion nécessaire.'
          : 'Jeton d’authentification invalide.',
      });
    }

    const sessionId = String(payload.sid ?? '');
    if (!sessionId) {
      return reply.code(401).send({
        erreur: 'JETON_INVALIDE',
        message: 'Jeton d’authentification incomplet.',
      });
    }

    const identity = await deps.db.withIdentity({ actor: 'system' }, (client) =>
      deps.sessions.loadValid(client, sessionId),
    );

    if (!identity) {
      return reply.code(401).send({
        erreur: 'SESSION_INVALIDE',
        message: 'Votre session n’est plus valide. Reconnectez-vous.',
      });
    }

    // Le JWT ne doit pas désigner une autre identité que la session : si les
    // deux divergent, le jeton a été forgé ou mal associé. On refuse.
    if (payload.aud !== identity.audience) {
      return reply.code(401).send({
        erreur: 'JETON_INCOHERENT',
        message: 'Jeton d’authentification incohérent.',
      });
    }

    // Chargement du profil et des permissions
    if (identity.audience === 'ecole' && identity.staffUserId) {
      const profile = await deps.db.withIdentity({ actor: 'system' }, async (client) => {
        const { rows } = await client.query<{
          full_name: string;
          is_owner: boolean;
          is_active: boolean;
        }>(`SELECT full_name, is_owner, is_active FROM sec.staff_users WHERE id = $1`, [
          identity.staffUserId,
        ]);
        const perms = await client.query<{ permission_code: string }>(
          `SELECT permission_code FROM sec.effective_permissions($1)`,
          [identity.staffUserId],
        );
        return { staff: rows[0] ?? null, permissions: perms.rows.map((r) => r.permission_code) };
      });

      if (!profile.staff?.is_active) {
        return reply.code(403).send({
          erreur: 'COMPTE_DESACTIVE',
          message: 'Ce compte a été désactivé.',
        });
      }

      req.auth = {
        identity,
        schoolId: identity.schoolId ?? null,
        userId: identity.staffUserId,
        displayName: profile.staff.full_name,
        permissions: profile.permissions,
        isOwner: profile.staff.is_owner,
      };
      return;
    }

    if (identity.audience === 'parent' && identity.parentId) {
      const profile = await deps.db.withIdentity({ actor: 'system' }, async (client) => {
        const { rows } = await client.query<{ full_name: string; is_active: boolean }>(
          `SELECT full_name, is_active FROM app.parents WHERE id = $1`,
          [identity.parentId],
        );
        return rows[0] ?? null;
      });

      if (!profile?.is_active) {
        return reply.code(403).send({ erreur: 'COMPTE_DESACTIVE', message: 'Ce compte a été désactivé.' });
      }

      req.auth = {
        identity,
        schoolId: null,
        userId: identity.parentId,
        displayName: profile.full_name,
        permissions: [],
        isOwner: false,
      };
      return;
    }

    return reply.code(401).send({
      erreur: 'SESSION_INVALIDE',
      message: 'Votre session n’est plus valide. Reconnectez-vous.',
    });
  };
}

/** Exige un public précis (école ou parent). */
export function requireAudience(audience: 'ecole' | 'parent'): preHandlerHookHandler {
  return async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ erreur: 'AUTHENTIFICATION_REQUISE', message: 'Connexion requise.' });
    }
    if (req.auth.identity.audience !== audience) {
      return reply.code(403).send({
        erreur: 'MAUVAISE_INTERFACE',
        message:
          audience === 'ecole'
            ? 'Cette action est réservée à l’administration de l’école.'
            : 'Cette action est réservée aux comptes parents.',
      });
    }
  };
}

/** Exige que la double authentification ait été satisfaite. */
export function requireMfa(): preHandlerHookHandler {
  return async (req, reply) => {
    if (!req.auth?.identity.mfaSatisfied) {
      return reply.code(403).send({
        erreur: 'DEUXIEME_FACTEUR_REQUIS',
        message: 'Cette opération exige la validation du code à deux facteurs.',
      });
    }
  };
}

/* ==========================================================================
 *  Autorisation par permission (appliquée côté serveur)
 * ========================================================================== */

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  readonly code = 'ACCES_REFUSE';
  constructor(message = 'Vous n’avez pas la permission d’effectuer cette action.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Vérifie une permission. Le propriétaire de l'établissement dispose de toutes
 * les permissions ; les autres comptes sont limités par leurs rôles.
 */
export function assertPermission(req: FastifyRequest, permission: string): void {
  const auth = req.auth;
  if (!auth) throw new ForbiddenError('Connexion requise.');
  if (auth.isOwner) return;
  if (!auth.permissions.includes(permission)) {
    throw new ForbiddenError(
      `Permission manquante : ${permission}. Contactez la direction de votre établissement.`,
    );
  }
}

/** Fabrique un pré-handler qui exige une permission. */
export function requirePermission(permission: string): preHandlerHookHandler {
  return async (req, reply) => {
    try {
      assertPermission(req, permission);
    } catch (err) {
      return reply.code(403).send({
        erreur: 'ACCES_REFUSE',
        message: (err as Error).message,
      });
    }
  };
}

/* ==========================================================================
 *  Contexte d'identité pour la base (RLS)
 * ========================================================================== */

export function dbIdentityFrom(req: FastifyRequest): DbIdentity {
  const auth = req.auth;
  if (!auth) {
    return { actor: 'system', ip: clientIp(req) };
  }
  return {
    actor: auth.identity.audience === 'parent' ? 'parent' : 'staff',
    schoolId: auth.schoolId,
    parentId: auth.identity.parentId ?? null,
    staffId: auth.identity.staffUserId ?? null,
    ip: clientIp(req),
    deviceId: auth.identity.deviceId ?? null,
  };
}

/** Exige qu'une école soit résolue dans le contexte (routes de l'administration). */
export function requireSchool(req: FastifyRequest): string {
  const schoolId = req.auth?.schoolId;
  if (!schoolId) {
    const err = new Error('Aucun établissement associé à cette session.') as Error & {
      statusCode?: number;
      code?: string;
    };
    err.statusCode = 400;
    err.code = 'ECOLE_NON_RESOLUE';
    throw err;
  }
  return schoolId;
}

/* ==========================================================================
 *  Limitation de débit par route
 * ========================================================================== */

export function rateLimit(deps: { db: Database; guard: BruteForceGuard; audit: AuditLogger }, ruleKey: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ip = clientIp(req) ?? 'inconnue';
    const subject = req.auth?.userId
      ? { kind: (req.auth.identity.audience === 'parent' ? 'parent' : 'staff') as 'parent' | 'staff', key: req.auth.userId }
      : { kind: 'ip' as const, key: ip };

    const decision = await deps.db.withIdentity({ actor: 'system' }, (client) =>
      deps.guard.consume(client, ruleKey, subject),
    );

    reply.header('X-RateLimit-Remaining', String(decision.remaining));

    if (!decision.allowed) {
      reply.header('Retry-After', String(decision.retryAfterSeconds));

      await deps.db
        .withIdentity({ actor: 'system' }, (client) =>
          deps.audit.write(client, {
            actorKind: req.auth ? (req.auth.identity.audience === 'parent' ? 'parent' : 'staff') : 'anonyme',
            actorId: req.auth?.userId ?? null,
            actorLabel: req.auth?.displayName ?? null,
            actorIp: ip,
            schoolId: req.auth?.schoolId ?? null,
          }, {
            action: 'securite.limite_debit',
            severity: 'warning',
            result: 'refuse',
            payload: { regle: decision.rule, chemin: req.url, methode: req.method },
          }),
        )
        .catch(() => undefined);

      return reply.code(429).send({
        erreur: 'TROP_DE_REQUETES',
        message: 'Trop de requêtes. Merci de patienter avant de réessayer.',
        reessayerDansSecondes: decision.retryAfterSeconds,
      });
    }
  };
}

/* ==========================================================================
 *  Journalisation d'audit des actions
 * ========================================================================== */

export interface AuditTrailOptions {
  action: string;
  severity?: Severity;
  entityType?: string;
  /** Extrait l'identifiant de l'entité depuis la réponse ou les paramètres */
  entityId?: (req: FastifyRequest, result: any) => string | null;
  /** Charge utile à journaliser (sera nettoyée et chiffrée) */
  payload?: (req: FastifyRequest, result: any) => Record<string, unknown>;
  resultOverride?: (result: any) => 'succes' | 'echec' | 'refuse' | 'erreur';
}

/**
 * Enveloppe un gestionnaire de route pour journaliser automatiquement
 * l'action dans le journal d'audit, dans la MÊME transaction que l'opération.
 *
 * Si l'opération échoue, l'entrée est écrite avec le résultat « echec » :
 * les tentatives infructueuses d'accès aux données sensibles sont donc
 * traçables, ce qui est indispensable à la détection d'intrusion.
 */
export function withAudit<T>(
  deps: { audit: AuditLogger },
  options: AuditTrailOptions,
  handler: (req: FastifyRequest, client: any) => Promise<T>,
): (req: FastifyRequest, client: QueryableClient) => Promise<T> {
  return async (req: FastifyRequest, client: QueryableClient): Promise<T> => {
    const auth = req.auth;
    const ctx = {
      actorKind: (auth
        ? auth.identity.audience === 'parent'
          ? 'parent'
          : 'staff'
        : 'anonyme') as 'parent' | 'staff' | 'anonyme',
      actorId: auth?.userId ?? null,
      actorLabel: auth?.displayName ?? null,
      actorIp: clientIp(req),
      actorDevice: auth?.identity.deviceId ?? null,
      schoolId: auth?.schoolId ?? null,
    };

    try {
      const result = await handler(req, client);
      const entry: AuditEntry = {
        action: options.action,
        severity: options.severity ?? 'info',
        result: options.resultOverride?.(result) ?? 'succes',
        entityType: options.entityType ?? null,
        entityId: options.entityId?.(req, result) ?? null,
        payload: options.payload?.(req, result) ?? null,
      };
      await deps.audit.write(client, ctx, entry);
      return result;
    } catch (err) {
      await deps.audit
        .write(client, ctx, {
          action: options.action,
          severity: 'warning',
          result: (err as { statusCode?: number }).statusCode === 403 ? 'refuse' : 'echec',
          entityType: options.entityType ?? null,
          entityId: options.entityId?.(req, null) ?? null,
          payload: {
            erreur: (err as Error).message,
            parametres: req.params,
            requete: req.query,
          },
        })
        .catch(() => undefined);
      throw err;
    }
  };
}

/* ==========================================================================
 *  Combinaison pratique : transaction portant l'identité + journalisation
 * ========================================================================== */

/**
 * Exécute une opération dans une transaction portant l'identité de l'appelant
 * (donc soumise à l'isolation par établissement) et journalise automatiquement
 * le résultat dans le journal d'audit.
 *
 * C'est le point d'entrée recommandé pour toute écriture métier sensible :
 * en cas d'erreur, la transaction est annulée (donc aucune donnée écrite) et
 * une entrée d'audit « echec » est produite dans une transaction séparée.
 */
export async function runAudited<T>(
  deps: { db: Database; audit: AuditLogger },
  req: FastifyRequest,
  options: AuditTrailOptions,
  handler: (req: FastifyRequest, client: any) => Promise<T>,
): Promise<T> {
  const identity = dbIdentityFrom(req);

  const auth = req.auth;
  const ctx = {
    actorKind: (auth
      ? auth.identity.audience === 'parent'
        ? 'parent'
        : 'staff'
      : 'anonyme') as 'parent' | 'staff' | 'anonyme',
    actorId: auth?.userId ?? null,
    actorLabel: auth?.displayName ?? null,
    actorIp: clientIp(req),
    actorDevice: auth?.identity.deviceId ?? null,
    schoolId: auth?.schoolId ?? null,
  };

  try {
    return await deps.db.withIdentity(identity, async (client) => {
      const result = await handler(req, client);
      await deps.audit.write(client, ctx, {
        action: options.action,
        severity: options.severity ?? 'info',
        result: options.resultOverride?.(result) ?? 'succes',
        entityType: options.entityType ?? null,
        entityId: options.entityId?.(req, result) ?? null,
        payload: options.payload?.(req, result) ?? null,
      });
      return result;
    });
  } catch (err) {
    // Trace de l'échec, dans sa propre transaction : elle doit survivre à
    // l'annulation de l'opération métier.
    try {
      await deps.db.withIdentity({ actor: 'system' }, (client) =>
        deps.audit.write(client, ctx, {
          action: options.action,
          severity: 'warning',
          result: (err as { statusCode?: number }).statusCode === 403 ? 'refuse' : 'echec',
          entityType: options.entityType ?? null,
          entityId: options.entityId?.(req, null) ?? null,
          payload: {
            erreur: (err as Error).message,
            parametres: req.params,
            requete: req.query,
          },
        }),
      );
    } catch {
      /* un journal indisponible ne doit pas masquer l'erreur métier d'origine */
    }
    throw err;
  }
}

/* ==========================================================================
 *  Utilitaires de réponse
 * ========================================================================== */

export function noStore(reply: FastifyReply): FastifyReply {
  // Les réponses contenant des données personnelles ne doivent jamais être
  // mises en cache par un navigateur, un proxy ou un CDN.
  return reply
    .header('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    .header('Pragma', 'no-cache')
    .header('Expires', '0');
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return noStore(reply).code(status).send({ erreur: code, message, ...extra });
}
