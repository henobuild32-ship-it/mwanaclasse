/**
 * ============================================================================
 *  MWANA CLASSE — Authentification (connexion, 2FA, inscription)
 * ============================================================================
 *  Séquence de connexion du personnel d'une école :
 *
 *    1. contrôle de débit (identifiant + adresse IP) ;
 *    2. recherche du compte, sans révéler s'il existe (message identique) ;
 *    3. vérification du mot de passe (Argon2id + pepper, temps constant) ;
 *    4. si la 2FA est active : émission d'un jeton temporaire, pas de session ;
 *       la session n'est ouverte qu'après validation du code TOTP ;
 *    5. journalisation systématique (succès comme échec) ;
 *    6. verrouillage progressif en cas d'échecs répétés.
 *
 *  Le jeton de session n'est JAMAIS délivré avant la validation du deuxième
 *  facteur : un mot de passe volé ne suffit donc pas à accéder aux données.
 * ============================================================================
 */

import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { verifyPassword, encryptSymmetric, decryptSymmetric, sha256Hex, randomToken, randomNumericCode } from './crypto.js';
import type { SecretsManager } from './secrets.js';
import type { AuditLogger } from './audit.js';
import { AUDIT_ACTIONS } from './audit.js';
import { PasswordService } from './passwords.js';
import { SessionService, type IssuedTokens, type Audience } from './sessions.js';
import { verifyTotp, otpAuthUri, otpAuthQrDataUrl, generateTotpSecret, generateRecoveryCodes, hashRecoveryCode, type TotpConfig, DEFAULT_TOTP } from './totp.js';
import type { BruteForceGuard } from './bruteforce.js';
import type { AppConfig } from '../config/index.js';

/* ==========================================================================
 *  Types
 * ========================================================================== */

export interface AuthRequestContext {
  ip?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
  fingerprint?: string | null;
}

export type LoginOutcome =
  | {
      status: 'succes';
      tokens: IssuedTokens;
      profile: StaffProfile | ParentProfile;
    }
  | { status: '2fa_requis'; challengeToken: string; method: 'totp'; expiresInSeconds: number }
  | { status: 'echec'; message: string }
  | { status: 'verrouille'; message: string; retryAfterSeconds: number }
  | { status: 'mot_de_passe_a_changer'; message: string };

export interface StaffProfile {
  kind: 'ecole';
  id: string;
  schoolId: string;
  schoolName: string;
  schoolCode: string;
  fullName: string;
  jobTitle: string | null;
  email: string;
  isOwner: boolean;
  permissions: string[];
  mustChangePassword: boolean;
  twoFactorEnabled: boolean;
  primaryColor: string;
}

export interface ParentProfile {
  kind: 'parent';
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  childrenCount: number;
  twoFactorEnabled: boolean;
}

/* ==========================================================================
 *  Service d'authentification
 * ========================================================================== */

export class AuthService {
  /** Exposé aux routes : gestion du cycle de vie des mots de passe. */
  readonly passwords: PasswordService;
  private readonly sessions: SessionService;

  constructor(
    private readonly cfg: AppConfig,
    private readonly secrets: SecretsManager,
    private readonly audit: AuditLogger,
    private readonly guard: BruteForceGuard,
    signAccessToken: (payload: Record<string, unknown>, ttlSeconds: number) => string,
  ) {
    this.passwords = new PasswordService(secrets);
    this.sessions = new SessionService(cfg, signAccessToken);
  }

  get sessionService(): SessionService {
    return this.sessions;
  }

  /* ====================================================================== */
  /*  1. CONNEXION ÉCOLE (personnel)                                        */
  /* ====================================================================== */

  async loginStaff(
    client: PoolClient,
    input: { email: string; password: string; schoolCode?: string | null; totpCode?: string | null },
    ctx: AuthRequestContext,
  ): Promise<LoginOutcome> {
    const identifier = input.email.trim().toLowerCase();

    // (1) Limitation de débit avant tout accès à la base
    const throttle = await this.guard.checkLogin(client, identifier, ctx.ip ?? null);
    if (!throttle.allowed) {
      await this.audit.write(client, this.auditCtx(null, null, ctx, identifier), {
        action: AUDIT_ACTIONS.RATE_LIMITED,
        severity: 'warning',
        result: 'refuse',
        payload: { identifiant: identifier, raison: throttle.reason },
      });
      return {
        status: 'verrouille',
        message: throttle.reason ?? 'Trop de tentatives. Réessayez plus tard.',
        retryAfterSeconds: throttle.retryAfterSeconds,
      };
    }

    // (2) Recherche du compte
    const { rows } = await client.query<{
      id: string;
      school_id: string;
      email: string;
      full_name: string;
      job_title: string | null;
      password_hash: string;
      password_algo: string;
      is_active: boolean;
      is_owner: boolean;
      must_change_password: boolean;
      totp_enabled: boolean;
      totp_secret_enc: Buffer | null;
      totp_last_used_step: string | null;
      locked_until: string | null;
      school_name: string;
      school_code: string;
      primary_color: string;
      school_link_mode: string;
    }>(
      `SELECT u.id, u.school_id, u.email, u.full_name, u.job_title,
              u.password_hash, u.password_algo, u.is_active, u.is_owner,
              u.must_change_password, u.totp_enabled, u.totp_secret_enc,
              u.totp_last_used_step, u.locked_until,
              s.official_name AS school_name, s.public_code AS school_code,
              s.primary_color, s.parent_link_mode AS school_link_mode
         FROM sec.staff_users u
         JOIN app.schools s ON s.id = u.school_id
        WHERE u.email = $1
          AND ($2::text IS NULL OR s.public_code = $2)
        LIMIT 1`,
      [identifier, input.schoolCode?.trim().toUpperCase() ?? null],
    );

    const user = rows[0];

    // (3) Compte inexistant : on renvoie un message générique, mais on
    //     enregistre la tentative pour alimenter la détection d'attaques.
    if (!user) {
      await this.guard.registerLoginAttempt(client, {
        audience: 'ecole',
        identifier,
        success: false,
        reason: 'utilisateur_inconnu',
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        fingerprint: ctx.fingerprint ?? null,
      });
      await this.audit.write(client, this.auditCtx(null, null, ctx, identifier), {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        severity: 'notice',
        result: 'echec',
        payload: { identifiant: identifier, motif: 'compte inexistant' },
      });
      return { status: 'echec', message: 'Identifiants incorrects.' };
    }

    // (4) Verrouillage en cours
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const wait = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
      await this.audit.write(client, this.auditCtx(user.school_id, user.id, ctx, identifier), {
        action: AUDIT_ACTIONS.LOGIN_LOCKED,
        severity: 'warning',
        result: 'refuse',
        entityType: 'staff',
        entityId: user.id,
        payload: { identifiant: identifier, verrouille_jusqu_a: user.locked_until },
      });
      return {
        status: 'verrouille',
        message: 'Compte temporairement verrouillé après plusieurs échecs.',
        retryAfterSeconds: wait,
      };
    }

    // (5) Compte désactivé
    if (!user.is_active) {
      await this.guard.registerLoginAttempt(client, {
        audience: 'ecole',
        identifier,
        staffUserId: user.id,
        schoolId: user.school_id,
        success: false,
        reason: 'compte_desactive',
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      });
      await this.audit.write(client, this.auditCtx(user.school_id, user.id, ctx, user.full_name), {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        severity: 'warning',
        result: 'refuse',
        entityType: 'staff',
        entityId: user.id,
        payload: { motif: 'compte désactivé' },
      });
      return { status: 'echec', message: 'Ce compte est désactivé. Contactez votre direction.' };
    }

    // (6) Vérification du mot de passe (temps constant, pepper + historique)
    const verification = await verifyPassword(input.password, user.password_hash, this.secrets.passwordPeppers(), user.password_algo as any);

    if (!verification.ok) {
      const attempt = await this.guard.registerLoginAttempt(client, {
        audience: 'ecole',
        identifier,
        staffUserId: user.id,
        schoolId: user.school_id,
        success: false,
        reason: 'mot_de_passe',
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        fingerprint: ctx.fingerprint ?? null,
      });

      await this.audit.write(client, this.auditCtx(user.school_id, user.id, ctx, user.full_name), {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        severity: attempt.locked ? 'warning' : 'notice',
        result: 'echec',
        entityType: 'staff',
        entityId: user.id,
        payload: {
          echecs_recents: attempt.failures,
          verrouillage: attempt.locked ? attempt.lockedUntil : null,
        },
      });

      if (attempt.locked) {
        return {
          status: 'verrouille',
          message: `Trop d’échecs : compte verrouillé ${Math.ceil(attempt.waitSeconds / 60)} minute(s).`,
          retryAfterSeconds: attempt.waitSeconds,
        };
      }

      const remaining = Math.max(0, this.cfg.LOGIN_MAX_ATTEMPTS - attempt.failures);
      return {
        status: 'echec',
        message:
          remaining > 0
            ? `Identifiants incorrects. ${remaining} tentative(s) avant verrouillage.`
            : 'Identifiants incorrects.',
      };
    }

    // (7) Mot de passe correct mais changement imposé
    if (user.must_change_password) {
      await this.guard.registerLoginAttempt(client, {
        audience: 'ecole',
        identifier,
        staffUserId: user.id,
        schoolId: user.school_id,
        success: true,
        reason: 'ok',
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      });
      return {
        status: 'mot_de_passe_a_changer',
        message:
          'Vous devez définir un nouveau mot de passe avant de continuer ' +
          '(celui fourni par l’administration est provisoire).',
      };
    }

    // (8) Deuxième facteur : exigé dès qu'il est activé sur le compte.
    //     Pour la direction et si la politique l'impose, il est obligatoire.
    if (!user.totp_enabled && (this.cfg.REQUIRE_2FA_STAFF || (this.cfg.REQUIRE_2FA_DIRECTOR && user.is_owner))) {
      await this.audit.write(client, this.auditCtx(user.school_id, user.id, ctx, user.full_name), {
        action: AUDIT_ACTIONS.MFA_ENABLED,
        severity: 'warning',
        result: 'refuse',
        entityType: 'staff',
        entityId: user.id,
        payload: { motif: 'double authentification obligatoire non configurée' },
      });
      return {
        status: 'echec',
        message:
          'La double authentification est obligatoire pour votre compte. ' +
          'Activez-la depuis les paramètres de sécurité (l’assistance peut vous accompagner).',
      };
    }

    if (user.totp_enabled) {
      if (!input.totpCode) {
        // Le mot de passe est bon : on délivre un jeton de défi à durée courte,
        // sans ouvrir de session. Aucune donnée n'est accessible avec ce jeton.
        const challengeToken = await this.createChallenge(client, 'staff', user.id, ctx);
        await this.audit.write(client, this.auditCtx(user.school_id, user.id, ctx, user.full_name), {
          action: AUDIT_ACTIONS.LOGIN_SUCCESS,
          severity: 'info',
          result: 'succes',
          entityType: 'staff',
          entityId: user.id,
          payload: { etape: 'mot de passe validé, attente du code à deux facteurs' },
        });
        return {
          status: '2fa_requis',
          challengeToken,
          method: 'totp',
          expiresInSeconds: 300,
        };
      }

      // Validation du code
      const secret = this.decryptTotpSecret(user.totp_secret_enc, user.id, 'staff');
      if (!secret) {
        return { status: 'echec', message: 'Configuration à deux facteurs illisible. Contactez l’assistance.' };
      }

      const check = verifyTotp(input.totpCode, secret, {
        ...DEFAULT_TOTP,
        lastUsedStep: user.totp_last_used_step ? Number(user.totp_last_used_step) : null,
      });

      if (!check.valid) {
        const attempt = await this.guard.registerLoginAttempt(client, {
          audience: 'ecole',
          identifier,
          staffUserId: user.id,
          schoolId: user.school_id,
          success: false,
          reason: '2fa_invalide',
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
        });
        await this.audit.write(client, this.auditCtx(user.school_id, user.id, ctx, user.full_name), {
          action: AUDIT_ACTIONS.MFA_CHALLENGE_FAILED,
          severity: 'warning',
          result: 'echec',
          entityType: 'staff',
          entityId: user.id,
          payload: { motif: 'code TOTP invalide ou déjà utilisé' },
        });
        return {
          status: 'echec',
          message: 'Code de vérification incorrect ou déjà utilisé.',
        };
      }

      // Anti-rejeu : on mémorise le pas consommé
      await client.query(`UPDATE sec.staff_users SET totp_last_used_step = $2 WHERE id = $1`, [
        user.id,
        check.step,
      ]);
    }

    // (9) Ré-hachage transparent si l'algorithme ou le pepper a évolué :
    //     l'utilisateur ne s'en aperçoit pas, mais la sécurité progresse.
    if (verification.needsRehash) {
      await this.passwords
        .upgradeHashIfNeeded(client, 'staff', user.id, input.password, user.password_hash)
        .catch(() => false);
    }

    // (10) Ouverture de la session
    const tokens = await this.sessions.create(client, {
      audience: 'ecole',
      staffUserId: user.id,
      schoolId: user.school_id,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      deviceId: ctx.deviceId ?? null,
      mfaSatisfied: user.totp_enabled,
      mfaMethod: user.totp_enabled ? 'totp' : 'none',
    });

    await client.query(
      `UPDATE sec.staff_users SET last_login_at = now(), last_login_ip = $2, failed_attempts = 0, locked_until = NULL
        WHERE id = $1`,
      [user.id, ctx.ip ?? null],
    );

    await this.guard.registerLoginAttempt(client, {
      audience: 'ecole',
      identifier,
      staffUserId: user.id,
      schoolId: user.school_id,
      success: true,
      reason: 'ok',
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    const permissions = (
      await client.query<{ permission_code: string }>(
        `SELECT permission_code FROM sec.effective_permissions($1)`,
        [user.id],
      )
    ).rows.map((r) => r.permission_code);

    await this.audit.write(client, this.auditCtx(user.school_id, user.id, ctx, user.full_name), {
      action: AUDIT_ACTIONS.LOGIN_SUCCESS,
      severity: 'info',
      result: 'succes',
      entityType: 'staff',
      entityId: user.id,
      payload: {
        double_facteur: user.totp_enabled,
        appareil: ctx.deviceId ?? 'inconnu',
      },
    });

    return {
      status: 'succes',
      tokens,
      profile: {
        kind: 'ecole',
        id: user.id,
        schoolId: user.school_id,
        schoolName: user.school_name,
        schoolCode: user.school_code,
        fullName: user.full_name,
        jobTitle: user.job_title,
        email: user.email,
        isOwner: user.is_owner,
        permissions,
        mustChangePassword: user.must_change_password,
        twoFactorEnabled: user.totp_enabled,
        primaryColor: user.primary_color,
      },
    };
  }

  /* ====================================================================== */
  /*  2. CONNEXION PARENT                                                   */
  /* ====================================================================== */

  async loginParent(
    client: PoolClient,
    input: { emailOrPhone: string; password: string; totpCode?: string | null },
    ctx: AuthRequestContext,
  ): Promise<LoginOutcome> {
    const identifier = input.emailOrPhone.trim().toLowerCase();

    const throttle = await this.guard.checkLogin(client, identifier, ctx.ip ?? null);
    if (!throttle.allowed) {
      return {
        status: 'verrouille',
        message: throttle.reason ?? 'Trop de tentatives. Réessayez plus tard.',
        retryAfterSeconds: throttle.retryAfterSeconds,
      };
    }

    const { rows } = await client.query<{
      id: string;
      full_name: string;
      email: string | null;
      phone: string | null;
      is_active: boolean;
      password_hash: string;
      password_algo: string;
      totp_enabled: boolean;
      totp_secret_enc: Buffer | null;
      totp_last_used_step: string | null;
      locked_until: string | null;
      children_count: string;
    }>(
      `SELECT p.id, p.full_name, p.email, p.phone, p.is_active,
              c.password_hash, c.password_algo, c.totp_enabled, c.totp_secret_enc,
              c.totp_last_used_step, c.locked_until,
              (SELECT count(*) FROM app.parent_student_links l
                WHERE l.parent_id = p.id AND l.status = 'actif')::text AS children_count
         FROM app.parents p
         JOIN sec.parent_credentials c ON c.parent_id = p.id
        WHERE lower(p.email::text) = $1 OR p.phone = $1
        LIMIT 1`,
      [identifier],
    );

    const parent = rows[0];

    if (!parent) {
      await this.guard.registerLoginAttempt(client, {
        audience: 'parent',
        identifier,
        success: false,
        reason: 'utilisateur_inconnu',
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      });
      await this.audit.write(client, this.auditCtx(null, null, ctx, identifier), {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        severity: 'notice',
        result: 'echec',
        payload: { identifiant: identifier, motif: 'compte inexistant', interface: 'parent' },
      });
      return { status: 'echec', message: 'Identifiants incorrects.' };
    }

    if (parent.locked_until && new Date(parent.locked_until).getTime() > Date.now()) {
      return {
        status: 'verrouille',
        message: 'Compte temporairement verrouillé. Réessayez plus tard.',
        retryAfterSeconds: Math.ceil((new Date(parent.locked_until).getTime() - Date.now()) / 1000),
      };
    }

    if (!parent.is_active) {
      return { status: 'echec', message: 'Ce compte est désactivé.' };
    }

    const verification = await verifyPassword(
      input.password,
      parent.password_hash,
      this.secrets.passwordPeppers(),
      parent.password_algo as any,
    );

    if (!verification.ok) {
      const attempt = await this.guard.registerLoginAttempt(client, {
        audience: 'parent',
        identifier,
        parentId: parent.id,
        success: false,
        reason: 'mot_de_passe',
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      });
      await this.audit.write(client, this.auditCtx(null, null, ctx, parent.full_name), {
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        severity: attempt.locked ? 'warning' : 'notice',
        result: 'echec',
        entityType: 'parent',
        entityId: parent.id,
        payload: { interface: 'parent', echecs_recents: attempt.failures },
      });
      if (attempt.locked) {
        return {
          status: 'verrouille',
          message: 'Trop d’échecs : compte temporairement verrouillé.',
          retryAfterSeconds: attempt.waitSeconds,
        };
      }
      return { status: 'echec', message: 'Identifiants incorrects.' };
    }

    // 2FA parent (facultative)
    if (parent.totp_enabled && !input.totpCode) {
      const challengeToken = await this.createChallenge(client, 'parent', parent.id, ctx);
      return { status: '2fa_requis', challengeToken, method: 'totp', expiresInSeconds: 300 };
    }

    if (parent.totp_enabled && input.totpCode) {
      const secret = this.decryptTotpSecret(parent.totp_secret_enc, parent.id, 'parent');
      const check = secret
        ? verifyTotp(input.totpCode, secret, {
            ...DEFAULT_TOTP,
            lastUsedStep: parent.totp_last_used_step ? Number(parent.totp_last_used_step) : null,
          })
        : { valid: false };
      if (!check.valid) {
        await this.guard.registerLoginAttempt(client, {
          audience: 'parent',
          identifier,
          parentId: parent.id,
          success: false,
          reason: '2fa_invalide',
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
        });
        return { status: 'echec', message: 'Code de vérification incorrect.' };
      }
      await client.query(`UPDATE sec.parent_credentials SET totp_last_used_step = $2 WHERE parent_id = $1`, [
        parent.id,
        (check as any).step,
      ]);
    }

    const tokens = await this.sessions.create(client, {
      audience: 'parent',
      parentId: parent.id,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      deviceId: ctx.deviceId ?? null,
      mfaSatisfied: parent.totp_enabled,
      mfaMethod: parent.totp_enabled ? 'totp' : 'none',
    });

    await client.query(
      `UPDATE sec.parent_credentials SET last_login_at = now(), last_login_ip = $2,
              failed_attempts = 0, locked_until = NULL
        WHERE parent_id = $1`,
      [parent.id, ctx.ip ?? null],
    );

    await client.query(`UPDATE app.parents SET last_seen_at = now() WHERE id = $1`, [parent.id]);

    await this.guard.registerLoginAttempt(client, {
      audience: 'parent',
      identifier,
      parentId: parent.id,
      success: true,
      reason: 'ok',
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    await this.audit.write(client, this.auditCtx(null, null, ctx, parent.full_name), {
      action: AUDIT_ACTIONS.LOGIN_SUCCESS,
      severity: 'info',
      result: 'succes',
      entityType: 'parent',
      entityId: parent.id,
      payload: { interface: 'parent', enfants_connectes: Number(parent.children_count) },
    });

    return {
      status: 'succes',
      tokens,
      profile: {
        kind: 'parent',
        id: parent.id,
        fullName: parent.full_name,
        email: parent.email,
        phone: parent.phone,
        childrenCount: Number(parent.children_count),
        twoFactorEnabled: parent.totp_enabled,
      },
    };
  }

  /* ====================================================================== */
  /*  3. DÉFI 2FA (entre le mot de passe et la session)                     */
  /* ====================================================================== */

  /**
   * Crée un jeton de défi : le mot de passe est validé mais la session n'est
   * pas encore ouverte. Le jeton est haché en base, valable 5 minutes et à
   * usage unique.
   */
  private async createChallenge(
    client: PoolClient,
    audience: 'staff' | 'parent',
    subjectId: string,
    ctx: AuthRequestContext,
  ): Promise<string> {
    const token = randomToken(32);
    await client.query(
      `INSERT INTO sec.one_time_tokens
         (purpose, audience, parent_id, staff_user_id, token_hash, max_attempts, ip, expires_at)
       VALUES ('2fa_sms', $1, $2, $3, $4, 6, $5, now() + interval '5 minutes')`,
      [
        audience === 'staff' ? 'ecole' : 'parent',
        audience === 'parent' ? subjectId : null,
        audience === 'staff' ? subjectId : null,
        sha256Hex(token),
        ctx.ip ?? null,
      ],
    );
    return token;
  }

  /** Valide un jeton de défi (usage unique). */
  async consumeChallenge(
    client: PoolClient,
    token: string,
  ): Promise<{ ok: true; audience: 'staff' | 'parent'; subjectId: string } | { ok: false }> {
    const hash = sha256Hex(token);
    const { rows } = await client.query<{
      id: string;
      parent_id: string | null;
      staff_user_id: string | null;
      attempts: number;
      max_attempts: number;
      expires_at: string;
      consumed_at: string | null;
    }>(
      `SELECT id, parent_id, staff_user_id, attempts, max_attempts, expires_at, consumed_at
         FROM sec.one_time_tokens
        WHERE token_hash = $1 AND purpose = '2fa_sms'
        FOR UPDATE`,
      [hash],
    );

    const row = rows[0];
    if (!row || row.consumed_at) return { ok: false };
    if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false };
    if (row.attempts >= row.max_attempts) return { ok: false };

    await client.query(
      `UPDATE sec.one_time_tokens SET consumed_at = now(), attempts = attempts + 1 WHERE id = $1`,
      [row.id],
    );

    if (row.staff_user_id) return { ok: true, audience: 'staff', subjectId: row.staff_user_id };
    if (row.parent_id) return { ok: true, audience: 'parent', subjectId: row.parent_id };
    return { ok: false };
  }

  /* ====================================================================== */
  /*  4. ACTIVATION / DÉSACTIVATION DU DEUXIÈME FACTEUR                     */
  /* ====================================================================== */

  /** Prépare l'enrôlement : renvoie le secret et le QR code (une seule fois). */
  async beginTotpEnrollment(
    client: PoolClient,
    subject: { kind: 'staff' | 'parent'; id: string; label: string; schoolName?: string },
  ): Promise<{ secretBase32: string; otpauthUri: string; qrDataUrl: string }> {
    const { secretBase32, secretRaw } = generateTotpSecret();

    // Le secret est chiffré immédiatement : il n'est jamais stocké en clair,
    // même pendant la phase d'enrôlement.
    const encrypted = this.encryptTotpSecret(secretRaw, subject.id, subject.kind);
    if (subject.kind === 'staff') {
      await client.query(
        `UPDATE sec.staff_users SET totp_secret_enc = $2, totp_enabled = false, totp_confirmed_at = NULL
          WHERE id = $1`,
        [subject.id, encrypted],
      );
    } else {
      await client.query(
        `UPDATE sec.parent_credentials SET totp_secret_enc = $2, totp_enabled = false, totp_confirmed_at = NULL
          WHERE parent_id = $1`,
        [subject.id, encrypted],
      );
    }

    const issuer = subject.schoolName
      ? `${this.cfg.TOTP_ISSUER} (${subject.schoolName})`
      : this.cfg.TOTP_ISSUER;

    const params = { secretBase32, accountName: subject.label, issuer };
    return {
      secretBase32,
      otpauthUri: otpAuthUri(params),
      qrDataUrl: await otpAuthQrDataUrl(params),
    };
  }

  /** Confirme l'enrôlement en vérifiant un premier code, puis délivre les codes de secours. */
  async confirmTotpEnrollment(
    client: PoolClient,
    subject: { kind: 'staff' | 'parent'; id: string },
    code: string,
  ): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; message: string }> {
    const { rows } = await client.query<{ totp_secret_enc: Buffer | null }>(
      subject.kind === 'staff'
        ? `SELECT totp_secret_enc FROM sec.staff_users WHERE id = $1`
        : `SELECT totp_secret_enc FROM sec.parent_credentials WHERE parent_id = $1`,
      [subject.id],
    );

    const encrypted = rows[0]?.totp_secret_enc;
    if (!encrypted) return { ok: false, message: 'Commencez par générer un nouveau secret.' };

    const secret = this.decryptTotpSecret(encrypted, subject.id, subject.kind);
    if (!secret) return { ok: false, message: 'Secret illisible. Recommencez l’opération.' };

    const check = verifyTotp(code, secret, { ...DEFAULT_TOTP, window: 2 });
    if (!check.valid) {
      return { ok: false, message: 'Code incorrect. Vérifiez l’heure de votre téléphone puis réessayez.' };
    }

    if (subject.kind === 'staff') {
      await client.query(
        `UPDATE sec.staff_users SET totp_enabled = true, totp_confirmed_at = now(), totp_last_used_step = $2
          WHERE id = $1`,
        [subject.id, check.step],
      );
      await this.audit.write(client, { actorKind: 'staff', actorId: subject.id }, {
        action: AUDIT_ACTIONS.MFA_ENABLED,
        severity: 'notice',
        result: 'succes',
        entityType: 'staff',
        entityId: subject.id,
      });
    } else {
      await client.query(
        `UPDATE sec.parent_credentials SET totp_enabled = true, totp_confirmed_at = now(), totp_last_used_step = $2
          WHERE parent_id = $1`,
        [subject.id, check.step],
      );
    }

    // Codes de secours : affichés une seule fois, stockés hachés
    const { plain, hashed } = generateRecoveryCodes(10);
    if (subject.kind === 'staff') {
      await client.query(`DELETE FROM sec.recovery_codes WHERE staff_user_id = $1`, [subject.id]);
      for (const h of hashed) {
        await client.query(
          `INSERT INTO sec.recovery_codes (staff_user_id, code_hash) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [subject.id, h],
        );
      }
    }

    return { ok: true, recoveryCodes: plain };
  }

  /** Désactive la 2FA (exige le mot de passe courant côté route). */
  async disableTotp(
    client: PoolClient,
    subject: { kind: 'staff' | 'parent'; id: string },
  ): Promise<void> {
    if (subject.kind === 'staff') {
      await client.query(
        `UPDATE sec.staff_users SET totp_enabled = false, totp_secret_enc = NULL, totp_confirmed_at = NULL
          WHERE id = $1`,
        [subject.id],
      );
      await client.query(`DELETE FROM sec.recovery_codes WHERE staff_user_id = $1`, [subject.id]);
      await this.audit.write(client, { actorKind: 'staff', actorId: subject.id }, {
        action: AUDIT_ACTIONS.MFA_DISABLED,
        severity: 'warning',
        result: 'succes',
        entityType: 'staff',
        entityId: subject.id,
      });
    } else {
      await client.query(
        `UPDATE sec.parent_credentials SET totp_enabled = false, totp_secret_enc = NULL, totp_confirmed_at = NULL
          WHERE parent_id = $1`,
        [subject.id],
      );
    }
  }

  /** Utilise un code de secours à la place du TOTP. */
  async useRecoveryCode(
    client: PoolClient,
    staffUserId: string,
    code: string,
  ): Promise<boolean> {
    const hash = hashRecoveryCode(code);
    const res = await client.query(
      `UPDATE sec.recovery_codes SET used_at = now()
        WHERE staff_user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
      [staffUserId, hash],
    );
    const used = (res.rowCount ?? 0) > 0;
    if (used) {
      await this.audit.write(client, { actorKind: 'staff', actorId: staffUserId }, {
        action: AUDIT_ACTIONS.RECOVERY_CODE_USED,
        severity: 'notice',
        result: 'succes',
        entityType: 'staff',
        entityId: staffUserId,
      });
    }
    return used;
  }

  /**
   * Vérifie un code fourni pour le deuxième facteur : soit un code TOTP,
   * soit un code de secours (format XXXX-XXXX). Utilisé par la route de
   * validation afin que les codes de secours restent utilisables en cas de
   * perte du téléphone.
   */
  async verifySecondFactor(
    client: PoolClient,
    staffUserId: string,
    code: string,
    encryptedSecret: Buffer | null,
    lastUsedStep: number | null,
  ): Promise<{ ok: boolean; method?: 'totp' | 'recovery'; step?: number }> {
    const secret = this.decryptTotpSecret(encryptedSecret, staffUserId, 'staff');

    if (secret) {
      const check = verifyTotp(code, secret, { ...DEFAULT_TOTP, lastUsedStep });
      if (check.valid) {
        await client.query(`UPDATE sec.staff_users SET totp_last_used_step = $2 WHERE id = $1`, [
          staffUserId,
          check.step,
        ]);
        return { ok: true, method: 'totp', step: check.step };
      }
    }

    if (/^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(code)) {
      const used = await this.useRecoveryCode(client, staffUserId, code);
      if (used) return { ok: true, method: 'recovery' };
    }

    return { ok: false };
  }

  /** Déchiffre le secret TOTP d'un compte (usage interne au service). */
  decryptTotpSecretFor(
    encrypted: Buffer | null,
    subjectId: string,
    kind: 'staff' | 'parent',
  ): Buffer | null {
    return this.decryptTotpSecret(encrypted, subjectId, kind);
  }

  /* ====================================================================== */
  /*  5. INSCRIPTION D'UNE ÉCOLE                                            */
  /* ====================================================================== */

  /**
   * Crée un établissement et son compte directeur.
   * Le code école est généré côté base (fonction app.random_code) et vérifié
   * unique ; en cas de collision, on réessaie automatiquement.
   */
  async registerSchool(
    client: PoolClient,
    input: {
      officialName: string;
      type: string;
      city?: string | null;
      commune?: string | null;
      addressLine?: string | null;
      phone?: string | null;
      email?: string | null;
      description?: string | null;
      openingHours?: string | null;
      primaryColor?: string | null;
      directorName: string;
      directorEmail: string;
      directorPhone?: string | null;
      directorJobTitle?: string | null;
      password: string;
      yearLabel: string;
      parentLinkMode?: 'automatique' | 'validation';
    },
    ctx: AuthRequestContext,
  ): Promise<{
    ok: true;
    schoolId: string;
    schoolCode: string;
    staffUserId: string;
    yearId: string;
    yearLabel: string;
  }> {
    // (1) Code école unique — plusieurs tentatives en cas de collision
    let schoolCode = '';
    for (let attempt = 0; attempt < 12; attempt++) {
      const { rows } = await client.query<{ code: string }>(
        `SELECT app.format_school_code(app.random_code(6)) AS code`,
      );
      const candidate = rows[0]!.code;
      const exists = await client.query(`SELECT 1 FROM app.schools WHERE public_code = $1`, [candidate]);
      if ((exists.rowCount ?? 0) === 0) {
        schoolCode = candidate;
        break;
      }
    }
    if (!schoolCode) {
      throw new Error(
        'Impossible de générer un code d’école unique. Réessayez dans quelques instants.',
      );
    }

    // (2) Identifiant de connexion : prenom.nom ou nom + suffixe
    const slug = await this.uniqueSlug(client, input.officialName);

    // (3) École
    const school = await client.query<{ id: string; official_name: string }>(
      `INSERT INTO app.schools
         (public_code, slug, official_name, type, city, commune, address_line,
          phones, email, description, opening_hours, primary_color,
          parent_link_mode, current_year_label, onboarded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
       RETURNING id, official_name`,
      [
        schoolCode,
        slug,
        input.officialName.trim(),
        input.type,
        input.city ?? null,
        input.commune ?? null,
        input.addressLine ?? null,
        input.phone ? [input.phone] : null,
        input.email ?? null,
        input.description ?? null,
        input.openingHours ?? null,
        input.primaryColor ?? '#0F5132',
        input.parentLinkMode ?? 'validation',
        input.yearLabel,
      ],
    );
    const schoolId = school.rows[0]!.id;

    // Adopte l'identite de la nouvelle ecole : les politiques RLS de portee
    // ecole (annee scolaire, etc.) exigent `app.school_id`.
    await client.query(`SELECT set_config('app.school_id', $1, true)`, [schoolId]);

    // (4) Année scolaire courante
    const year = await client.query<{ id: string }>(
      `INSERT INTO app.academic_years (school_id, label, starts_on, ends_on, is_current)
       VALUES ($1,$2, app.school_year_start($2), app.school_year_end($2), true)
       RETURNING id`,
      [schoolId, input.yearLabel],
    );
    const yearId = year.rows[0]!.id;

    // (5) Rôles système pour cette école (rôles par défaut)
    const roles = await client.query<{ id: string; code: string }>(
      `INSERT INTO sec.roles (school_id, code, name, description, is_system)
       VALUES
         ($1,'directeur','Directeur','Accès total à l''établissement', true),
         ($1,'administrateur','Administrateur','Gestion complète sauf sécurité', true),
         ($1,'secretaire','Secrétaire','Élèves, parents et communiqués', true),
         ($1,'responsable_presence','Responsable présence','Enregistrement des présences', true),
         ($1,'titulaire','Titulaire de classe','Présences de sa classe', true),
         ($1,'lecteur','Lecteur','Consultation seule', true)
       RETURNING id, code`,
      [schoolId],
    );
    const roleByCode = new Map(roles.rows.map((r) => [r.code, r.id]));

    // (6) Mot de passe du directeur : hachage + pepper
    const pepper = this.secrets.get('pepper.password');
    const { hashPassword, checkPasswordStrength } = await import('./crypto.js');
    const strength = checkPasswordStrength(input.password, {
      email: input.directorEmail,
      fullName: input.directorName,
      schoolName: input.officialName,
    });
    if (!strength.ok) {
      const err = new Error(
        `Mot de passe refusé : ${strength.violations.join(' ; ')}`,
      ) as Error & { statusCode?: number; code?: string; violations?: string[] };
      err.statusCode = 400;
      err.code = 'MOT_DE_PASSE_FAIBLE';
      err.violations = strength.violations;
      throw err;
    }

    const { hash, algo, pepperId } = await hashPassword(
      input.password,
      pepper.current.value,
      pepper.current.id,
      { email: input.directorEmail, fullName: input.directorName, schoolName: input.officialName },
    );

    // (7) Compte directeur : propriétaire de l'établissement
    const staff = await client.query<{ id: string }>(
      `INSERT INTO sec.staff_users
         (school_id, email, full_name, job_title, phone, password_hash, password_algo,
          password_pepper_id, is_owner, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,true)
       RETURNING id`,
      [
        schoolId,
        input.directorEmail.trim().toLowerCase(),
        input.directorName.trim(),
        input.directorJobTitle ?? 'Directeur',
        input.directorPhone ?? null,
        hash,
        algo,
        pepperId,
      ],
    );
    const staffUserId = staff.rows[0]!.id;

    const directorRoleId = roleByCode.get('directeur');
    if (directorRoleId) {
      await client.query(`INSERT INTO sec.staff_roles (staff_user_id, role_id) VALUES ($1,$2)`, [
        staffUserId,
        directorRoleId,
      ]);
    }

    // (8) Trace d'audit
    await this.audit.write(client, this.auditCtx(schoolId, staffUserId, ctx, input.directorName), {
      action: AUDIT_ACTIONS.SCHOOL_CREATED,
      severity: 'notice',
      result: 'succes',
      entityType: 'school',
      entityId: schoolId,
      entityLabel: input.officialName,
      payload: {
        code_ecole: schoolCode,
        type: input.type,
        ville: input.city,
        annee_scolaire: input.yearLabel,
        compte_directeur: input.directorEmail,
      },
    });

    return { ok: true, schoolId, schoolCode, staffUserId, yearId, yearLabel: input.yearLabel };
  }

  /* ====================================================================== */
  /*  6. INSCRIPTION D'UN PARENT                                            */
  /* ====================================================================== */

  async registerParent(
    client: PoolClient,
    input: {
      fullName: string;
      email?: string | null;
      phone?: string | null;
      password: string;
      relationship?: string;
      acceptTerms: boolean;
    },
    ctx: AuthRequestContext,
  ): Promise<{ ok: true; parentId: string; publicCode: string }> {
    if (!input.email && !input.phone) {
      const err = new Error('Une adresse e-mail ou un numéro de téléphone est obligatoire.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
    }
    if (!input.acceptTerms) {
      const err = new Error('Vous devez accepter les conditions d’utilisation.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
    }

    const { hashPassword, checkPasswordStrength } = await import('./crypto.js');
    const strength = checkPasswordStrength(input.password, {
      ...(input.email ? { email: input.email } : {}),
      fullName: input.fullName,
    });
    if (!strength.ok) {
      const err = new Error(`Mot de passe refusé : ${strength.violations.join(' ; ')}`) as Error & {
        statusCode?: number;
        violations?: string[];
      };
      err.statusCode = 400;
      err.violations = strength.violations;
      throw err;
    }

    // Code parent (facultatif mais utile au support)
    const codeRow = await client.query<{ code: string }>(
      `SELECT app.format_parent_code(app.random_code(6)) AS code`,
    );

    const parent = await client.query<{ id: string; public_code: string }>(
      `INSERT INTO app.parents (public_code, full_name, relationship, email, phone)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, public_code`,
      [
        codeRow.rows[0]!.code,
        input.fullName.trim(),
        input.relationship ?? 'parent',
        input.email?.trim().toLowerCase() ?? null,
        input.phone?.trim() ?? null,
      ],
    );
    const parentId = parent.rows[0]!.id;

    const pepper = this.secrets.get('pepper.password');
    const { hash, algo, pepperId } = await hashPassword(
      input.password,
      pepper.current.value,
      pepper.current.id,
      { ...(input.email ? { email: input.email } : {}), fullName: input.fullName },
    );

    await client.query(
      `INSERT INTO sec.parent_credentials
         (parent_id, password_hash, password_algo, password_pepper_id,
          terms_accepted_at, privacy_accepted_at)
       VALUES ($1,$2,$3,$4, now(), now())`,
      [parentId, hash, algo, pepperId],
    );

    await this.audit.write(client, this.auditCtx(null, null, ctx, input.fullName), {
      action: AUDIT_ACTIONS.SCHOOL_CREATED.replace('school', 'parent'),
      severity: 'info',
      result: 'succes',
      entityType: 'parent',
      entityId: parentId,
      payload: { interface: 'parent', creation: true },
    });

    return { ok: true, parentId, publicCode: parent.rows[0]!.public_code };
  }

  /* ====================================================================== */
  /*  Outils internes                                                       */
  /* ====================================================================== */

  private encryptTotpSecret(secret: Buffer, subjectId: string, kind: 'staff' | 'parent'): Buffer {
    const key = this.secrets.deriveKeyFor('key.totp', 'totp.secret');
    return encryptSymmetric(secret, key, `totp:${kind}:${subjectId}`);
  }

  private decryptTotpSecret(enc: Buffer | null, subjectId: string, kind: 'staff' | 'parent'): Buffer | null {
    if (!enc) return null;
    try {
      const key = this.secrets.deriveKeyFor('key.totp', 'totp.secret');
      const plain = decryptSymmetric(enc, key, `totp:${kind}:${subjectId}`);
      return Buffer.from(plain, 'binary');
    } catch {
      return null;
    }
  }

  private auditCtx(
    schoolId: string | null,
    actorId: string | null,
    ctx: AuthRequestContext,
    label: string | null,
  ) {
    return {
      actorKind: 'anonyme' as const,
      actorId,
      actorLabel: label,
      actorIp: ctx.ip ?? null,
      actorDevice: ctx.deviceId ?? null,
      schoolId,
    };
  }

  /** Slug unique pour l'URL publique de l'école. */
  private async uniqueSlug(client: PoolClient, name: string): Promise<string> {
    const base =
      name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'ecole';

    for (let i = 0; i < 40; i++) {
      const candidate = i === 0 ? base : `${base}-${i + 1}`;
      const exists = await client.query(`SELECT 1 FROM app.schools WHERE slug = $1`, [candidate]);
      if ((exists.rowCount ?? 0) === 0) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }
}
