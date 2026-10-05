/**
 * ============================================================================
 *  MWANA CLASSE — Sessions et jetons
 * ============================================================================
 *  Modèle retenu (jeton d'accès court + jeton de rafraîchissement tournant) :
 *
 *    - le jeton d'accès est un JWT signé, valable 15 minutes : sa fuite a une
 *      portée limitée et il n'est jamais stocké côté serveur ;
 *    - le jeton de rafraîchissement est OPAQUE et vit 30 jours ; seule son
 *      empreinte SHA-256 est stockée : un vol de base ne permet pas de
 *      reconstituer un jeton utilisable ;
 *    - ROTATION À CHAQUE USAGE : le jeton utilisé est révoqué et remplacé ;
 *    - DÉTECTION DE REJEU : si un jeton déjà consommé est représenté, toute la
 *      famille de jetons (token_family) est révoquée immédiatement — c'est le
 *      signe d'un vol ;
 *    - durée de vie absolue (90 jours) : une session ne peut pas être
 *      prolongée indéfiniment ;
 *    - le cookie est HttpOnly + SameSite + Secure en production, donc
 *      inaccessible au JavaScript de la page (protection XSS).
 * ============================================================================
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { randomToken, sha256Hex } from './crypto.js';
import type { AppConfig } from '../config/index.js';

export type Audience = 'parent' | 'ecole';

export interface SessionIdentity {
  sessionId: string;
  audience: Audience;
  parentId?: string | null;
  staffUserId?: string | null;
  schoolId?: string | null;
  mfaSatisfied: boolean;
  deviceId?: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  accessExpiresIn: number;
  refreshExpiresAt: Date;
}

/** Parse « 15m », « 2h », « 30d », « 900 » en secondes. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd])?$/i.exec(value.trim());
  if (!match) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    throw new Error(`Durée illisible : ${value}`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const factor = { s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;
  return amount * factor;
}

export class SessionService {
  constructor(
    private readonly cfg: AppConfig,
    private readonly signAccessToken: (payload: Record<string, unknown>, ttlSeconds: number) => string,
  ) {}

  get accessTtlSeconds(): number {
    return parseDuration(this.cfg.ACCESS_TOKEN_TTL);
  }

  /**
   * Ouvre une session et délivre la paire de jetons.
   * Le jeton de rafraîchissement n'est renvoyé qu'ici : il n'existe nulle part
   * ailleurs en clair.
   */
  async create(
    client: PoolClient,
    input: {
      audience: Audience;
      parentId?: string | null;
      staffUserId?: string | null;
      schoolId?: string | null;
      ip?: string | null;
      userAgent?: string | null;
      deviceId?: string | null;
      deviceLabel?: string | null;
      mfaSatisfied?: boolean;
      mfaMethod?: 'totp' | 'sms' | 'recovery' | 'none';
      tokenFamily?: string;
    },
  ): Promise<IssuedTokens> {
    const refreshToken = randomToken(48);
    const refreshHash = sha256Hex(refreshToken);
    const family = input.tokenFamily ?? randomUUID();

    const refreshExpiresAt = new Date(Date.now() + this.cfg.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    const absoluteExpiresAt = new Date(Date.now() + this.cfg.SESSION_ABSOLUTE_DAYS * 86_400_000);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sec.sessions
         (audience, parent_id, staff_user_id, school_id, refresh_token_hash, token_family,
          ip, user_agent, device_id, device_label, mfa_satisfied, mfa_method,
          expires_at, absolute_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        input.audience,
        input.parentId ?? null,
        input.staffUserId ?? null,
        input.schoolId ?? null,
        refreshHash,
        family,
        input.ip ?? null,
        input.userAgent ?? null,
        input.deviceId ?? null,
        input.deviceLabel ?? null,
        input.mfaSatisfied ?? false,
        input.mfaMethod ?? 'none',
        refreshExpiresAt,
        absoluteExpiresAt,
      ],
    );

    const sessionId = rows[0]!.id;
    const accessToken = this.buildAccessToken({
      sessionId,
      audience: input.audience,
      parentId: input.parentId ?? null,
      staffUserId: input.staffUserId ?? null,
      schoolId: input.schoolId ?? null,
      deviceId: input.deviceId ?? null,
      mfa: input.mfaSatisfied ?? false,
    });

    return {
      accessToken,
      refreshToken,
      sessionId,
      accessExpiresIn: this.accessTtlSeconds,
      refreshExpiresAt,
    };
  }

  /**
   * Fait tourner un jeton de rafraîchissement.
   * Détecte le rejeu : un jeton déjà consommé révoque toute la famille.
   */
  async rotate(
    client: PoolClient,
    input: { refreshToken: string; ip?: string | null; userAgent?: string | null },
  ): Promise<
    | { ok: true; tokens: IssuedTokens; identity: SessionIdentity }
    | { ok: false; reason: string; replayed?: boolean }
  > {
    const hash = sha256Hex(input.refreshToken);

    const { rows } = await client.query<{
      id: string;
      audience: Audience;
      parent_id: string | null;
      staff_user_id: string | null;
      school_id: string | null;
      token_family: string;
      device_id: string | null;
      mfa_satisfied: boolean;
      expires_at: string;
      absolute_expires_at: string;
      revoked_at: string | null;
      revoked_reason: string | null;
    }>(
      `SELECT id, audience, parent_id, staff_user_id, school_id, token_family,
              device_id, mfa_satisfied, expires_at, absolute_expires_at,
              revoked_at, revoked_reason
         FROM sec.sessions
        WHERE refresh_token_hash = $1
        FOR UPDATE`,
      [hash],
    );

    const session = rows[0];
    if (!session) return { ok: false, reason: 'Session inconnue. Reconnectez-vous.' };

    // --- Détection de rejeu ------------------------------------------------
    if (session.revoked_at) {
      // Un jeton révoqué qui resurgit = vol probable. On coupe tout.
      await client.query(
        `UPDATE sec.sessions
            SET revoked_at = now(),
                revoked_reason = 'rejeu détecté : famille de jetons révoquée par précaution'
          WHERE token_family = $1 AND revoked_at IS NULL`,
        [session.token_family],
      );
      return {
        ok: false,
        reason: 'Session invalidée pour raison de sécurité. Reconnectez-vous.',
        replayed: true,
      };
    }

    const now = Date.now();
    if (new Date(session.expires_at).getTime() < now) {
      return { ok: false, reason: 'Session expirée. Reconnectez-vous.' };
    }
    if (new Date(session.absolute_expires_at).getTime() < now) {
      await client.query(
        `UPDATE sec.sessions SET revoked_at = now(), revoked_reason = 'durée maximale atteinte' WHERE id = $1`,
        [session.id],
      );
      return { ok: false, reason: 'Durée maximale de session atteinte. Reconnectez-vous.' };
    }

    // --- Rotation ----------------------------------------------------------
    await client.query(
      `UPDATE sec.sessions
          SET revoked_at = now(), revoked_reason = 'rotation de jeton', last_used_at = now()
        WHERE id = $1`,
      [session.id],
    );

    const tokens = await this.create(client, {
      audience: session.audience,
      parentId: session.parent_id,
      staffUserId: session.staff_user_id,
      schoolId: session.school_id,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      deviceId: session.device_id,
      mfaSatisfied: session.mfa_satisfied,
      mfaMethod: session.mfa_satisfied ? 'totp' : 'none',
      tokenFamily: session.token_family, // même famille : le rejeu reste détectable
    });

    return {
      ok: true,
      tokens,
      identity: {
        sessionId: tokens.sessionId,
        audience: session.audience,
        parentId: session.parent_id,
        staffUserId: session.staff_user_id,
        schoolId: session.school_id,
        mfaSatisfied: session.mfa_satisfied,
        deviceId: session.device_id,
      },
    };
  }

  /** Révoque une session précise (déconnexion d'un appareil). */
  async revoke(client: PoolClient, sessionId: string, reason: string): Promise<boolean> {
    const res = await client.query(
      `UPDATE sec.sessions SET revoked_at = now(), revoked_reason = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, reason],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Révoque toutes les sessions d'un compte (déconnexion de partout). */
  async revokeAll(
    client: PoolClient,
    subject: { parentId?: string | null; staffUserId?: string | null },
    reason: string,
    exceptSessionId?: string,
  ): Promise<number> {
    const res = await client.query(
      `UPDATE sec.sessions
          SET revoked_at = now(), revoked_reason = $3
        WHERE revoked_at IS NULL
          AND ($1::uuid IS NULL OR parent_id = $1)
          AND ($2::uuid IS NULL OR staff_user_id = $2)
          AND ($4::uuid IS NULL OR id <> $4)`,
      [subject.parentId ?? null, subject.staffUserId ?? null, reason, exceptSessionId ?? null],
    );
    return res.rowCount ?? 0;
  }

  /** Sessions actives d'un compte (écran « appareils connectés »). */
  async listActive(
    client: PoolClient,
    subject: { parentId?: string | null; staffUserId?: string | null },
  ) {
    const { rows } = await client.query(
      `SELECT id, ip, user_agent, device_label, created_at, last_used_at,
              expires_at, mfa_satisfied, mfa_method
         FROM sec.sessions
        WHERE revoked_at IS NULL
          AND expires_at > now()
          AND ($1::uuid IS NULL OR parent_id = $1)
          AND ($2::uuid IS NULL OR staff_user_id = $2)
        ORDER BY last_used_at DESC`,
      [subject.parentId ?? null, subject.staffUserId ?? null],
    );
    return rows;
  }

  /** Marque une session comme ayant satisfait la 2FA (après validation du code). */
  async markMfaSatisfied(
    client: PoolClient,
    sessionId: string,
    method: 'totp' | 'sms' | 'recovery',
  ): Promise<void> {
    await client.query(
      `UPDATE sec.sessions SET mfa_satisfied = true, mfa_method = $2 WHERE id = $1`,
      [sessionId, method],
    );
  }

  /** Charge une session valide par son identifiant (vérification du jeton d'accès). */
  async loadValid(client: PoolClient, sessionId: string): Promise<SessionIdentity | null> {
    const { rows } = await client.query<{
      id: string;
      audience: Audience;
      parent_id: string | null;
      staff_user_id: string | null;
      school_id: string | null;
      mfa_satisfied: boolean;
      device_id: string | null;
      revoked_at: string | null;
      expires_at: string;
      absolute_expires_at: string;
    }>(
      `SELECT id, audience, parent_id, staff_user_id, school_id, mfa_satisfied,
              device_id, revoked_at, expires_at, absolute_expires_at
         FROM sec.sessions WHERE id = $1`,
      [sessionId],
    );

    const s = rows[0];
    if (!s) return null;
    if (s.revoked_at) return null;
    if (new Date(s.expires_at).getTime() < Date.now()) return null;
    if (new Date(s.absolute_expires_at).getTime() < Date.now()) return null;

    await client.query(`UPDATE sec.sessions SET last_used_at = now() WHERE id = $1`, [sessionId]);

    return {
      sessionId: s.id,
      audience: s.audience,
      parentId: s.parent_id,
      staffUserId: s.staff_user_id,
      schoolId: s.school_id,
      mfaSatisfied: s.mfa_satisfied,
      deviceId: s.device_id,
    };
  }

  /* ---------------------------------------------------------------------- */

  private buildAccessToken(payload: {
    sessionId: string;
    audience: Audience;
    parentId: string | null;
    staffUserId: string | null;
    schoolId: string | null;
    deviceId: string | null;
    mfa: boolean;
  }): string {
    return this.signAccessToken(
      {
        sid: payload.sessionId,
        aud: payload.audience,
        pid: payload.parentId,
        uid: payload.staffUserId,
        sch: payload.schoolId,
        did: payload.deviceId,
        mfa: payload.mfa,
      },
      this.accessTtlSeconds,
    );
  }
}

/* ==========================================================================
 *  Options de cookie
 * ========================================================================== */

export function refreshCookieOptions(cfg: AppConfig, maxAgeSeconds: number) {
  return {
    httpOnly: true, // inaccessible au JavaScript : protection contre le vol par XSS
    secure: cfg.isProduction || cfg.COOKIE_SECURE, // HTTPS uniquement
    sameSite: cfg.COOKIE_SAMESITE, // 'lax' par défaut : protège du CSRF
    path: '/api/auth',
    maxAge: maxAgeSeconds,
    ...(cfg.COOKIE_DOMAIN ? { domain: cfg.COOKIE_DOMAIN } : {}),
  } as const;
}

export const REFRESH_COOKIE = 'mwana_rt';
