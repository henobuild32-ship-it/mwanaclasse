/**
 * ============================================================================
 *  MWANA CLASSE — Cycle de vie des mots de passe
 * ============================================================================
 *  Règles appliquées :
 *    - jamais de mot de passe stocké en clair, ni journalisé, ni renvoyé ;
 *    - hachage Argon2id + pepper serveur (voir crypto.ts) ;
 *    - historique des 5 derniers mots de passe : un mot de passe déjà utilisé
 *      ne peut pas être repris ;
 *    - réinitialisation par jeton à usage unique, valable 30 minutes, usage
 *      unique, stocké haché ;
 *    - changement obligatoire à la première connexion d'un compte créé par
 *      l'administration ;
 *    - révocation de TOUTES les sessions après changement de mot de passe
 *      (un attaquant déjà connecté est immédiatement déconnecté).
 * ============================================================================
 */

import type { PoolClient } from 'pg';
import {
  hashPassword,
  verifyPassword,
  checkPasswordStrength,
  rehashIfNeeded,
  randomToken,
  sha256Hex,
  type PasswordCheck,
} from './crypto.js';
import type { SecretsManager } from './secrets.js';

export interface PasswordPolicyInfo {
  minLength: number;
  requiresMixedCase: boolean;
  requiresDigit: boolean;
  requiresSymbol: boolean;
  historySize: number;
  maxAgeDays: number | null;
}

export const PASSWORD_POLICY_INFO: PasswordPolicyInfo = {
  minLength: 12,
  requiresMixedCase: false, // une phrase de passe longue est préférable
  requiresDigit: false,
  requiresSymbol: false,
  historySize: 5,
  maxAgeDays: null, // pas d'expiration forcée (recommandation ANSSI/NIST)
};

export class PasswordService {
  constructor(private readonly secrets: SecretsManager) {}

  /** Évalue la robustesse (exposé à l'interface pour un retour immédiat). */
  evaluate(
    password: string,
    context: { email?: string; fullName?: string; schoolName?: string } = {},
  ): PasswordCheck {
    return checkPasswordStrength(password, context);
  }

  /**
   * Définit un nouveau mot de passe pour un compte du personnel.
   * Vérifie : politique, historique, puis enregistre le hachage et révoque
   * toutes les sessions actives.
   */
  async setStaffPassword(
    client: PoolClient,
    input: {
      staffUserId: string;
      newPassword: string;
      currentPassword?: string | null;
      requireCurrent?: boolean;
      actorLabel: string;
      context?: { email?: string; fullName?: string; schoolName?: string };
    },
  ): Promise<{ ok: true; algo: string; revokedSessions: number } | { ok: false; reason: string; violations?: string[] }> {
    const { rows } = await client.query<{
      id: string;
      password_hash: string;
      password_algo: string;
      password_history: string[] | null;
      email: string;
      full_name: string;
    }>(
      `SELECT id, password_hash, password_algo, password_history, email, full_name
         FROM sec.staff_users WHERE id = $1 FOR UPDATE`,
      [input.staffUserId],
    );

    const user = rows[0];
    if (!user) return { ok: false, reason: 'Compte introuvable.' };

    // 1) Vérification du mot de passe actuel si exigée
    if (input.requireCurrent) {
      if (!input.currentPassword) {
        return { ok: false, reason: 'Le mot de passe actuel est obligatoire.' };
      }
      const check = await verifyPassword(input.currentPassword, user.password_hash, this.secrets.passwordPeppers());
      if (!check.ok) {
        return { ok: false, reason: 'Le mot de passe actuel est incorrect.' };
      }
    }

    // 2) Politique de robustesse
    const context = {
      email: input.context?.email ?? user.email,
      fullName: input.context?.fullName ?? user.full_name,
      ...(input.context?.schoolName ? { schoolName: input.context.schoolName } : {}),
    };
    const strength = this.evaluate(input.newPassword, context);
    if (!strength.ok) {
      return { ok: false, reason: 'Mot de passe trop faible.', violations: strength.violations };
    }

    // 3) Historique : refus des mots de passe déjà utilisés
    const history = user.password_history ?? [];
    for (const oldHash of history) {
      const reused = await verifyPassword(input.newPassword, oldHash, this.secrets.passwordPeppers());
      if (reused.ok) {
        return {
          ok: false,
          reason: `Ce mot de passe a déjà été utilisé. Choisissez-en un nouveau (les ${PASSWORD_POLICY_INFO.historySize} derniers sont mémorisés).`,
        };
      }
    }

    // 4) Hachage avec le pepper courant
    const pepper = this.secrets.get('pepper.password');
    const { hash, algo, pepperId } = await hashPassword(
      input.newPassword,
      pepper.current.value,
      pepper.current.id,
      context,
    );

    // 5) Enregistrement + historique borné
    const newHistory = [user.password_hash, ...history].slice(0, PASSWORD_POLICY_INFO.historySize);

    await client.query(
      `UPDATE sec.staff_users
          SET password_hash = $2,
              password_algo = $3,
              password_pepper_id = $4,
              password_history = $5,
              password_changed_at = now(),
              must_change_password = false,
              failed_attempts = 0,
              locked_until = NULL
        WHERE id = $1`,
      [input.staffUserId, hash, algo, pepperId, newHistory],
    );

    // 6) Révocation immédiate de toutes les sessions : un mot de passe volé
    //    puis changé ne laisse aucune porte ouverte.
    const revoked = await client.query(
      `UPDATE sec.sessions
          SET revoked_at = now(), revoked_reason = 'changement de mot de passe'
        WHERE staff_user_id = $1 AND revoked_at IS NULL`,
      [input.staffUserId],
    );

    return { ok: true, algo, revokedSessions: revoked.rowCount ?? 0 };
  }

  /** Change le mot de passe d'un compte parent. */
  async setParentPassword(
    client: PoolClient,
    input: { parentId: string; newPassword: string; requireCurrent?: boolean; currentPassword?: string | null },
  ): Promise<{ ok: true } | { ok: false; reason: string; violations?: string[] }> {
    const { rows } = await client.query<{ password_hash: string }>(
      `SELECT password_hash FROM sec.parent_credentials WHERE parent_id = $1 FOR UPDATE`,
      [input.parentId],
    );
    const cred = rows[0];
    if (!cred) return { ok: false, reason: 'Aucun identifiant pour ce compte parent.' };

    if (input.requireCurrent) {
      if (!input.currentPassword) return { ok: false, reason: 'Le mot de passe actuel est obligatoire.' };
      const check = await verifyPassword(input.currentPassword, cred.password_hash, this.secrets.passwordPeppers());
      if (!check.ok) return { ok: false, reason: 'Le mot de passe actuel est incorrect.' };
    }

    const strength = this.evaluate(input.newPassword);
    if (!strength.ok) {
      return { ok: false, reason: 'Mot de passe trop faible.', violations: strength.violations };
    }

    const pepper = this.secrets.get('pepper.password');
    const { hash, algo, pepperId } = await hashPassword(input.newPassword, pepper.current.value, pepper.current.id);

    await client.query(
      `UPDATE sec.parent_credentials
          SET password_hash = $2, password_algo = $3, password_pepper_id = $4,
              password_changed_at = now(), failed_attempts = 0, locked_until = NULL
        WHERE parent_id = $1`,
      [input.parentId, hash, algo, pepperId],
    );

    await client.query(
      `UPDATE sec.sessions SET revoked_at = now(), revoked_reason = 'changement de mot de passe'
        WHERE parent_id = $1 AND revoked_at IS NULL`,
      [input.parentId],
    );

    return { ok: true };
  }

  /**
   * Ré-hachage transparent : si l'algorithme ou le pepper a évolué depuis la
   * création du compte, on met à jour le hachage à la connexion réussie.
   * L'utilisateur ne s'en aperçoit pas.
   */
  async upgradeHashIfNeeded(
    client: PoolClient,
    table: 'staff' | 'parent',
    id: string,
    plainPassword: string,
    currentHash: string,
  ): Promise<boolean> {
    const pepper = this.secrets.get('pepper.password');
    const upgraded = await rehashIfNeeded(plainPassword, currentHash, pepper.current.value, pepper.current.id);
    if (!upgraded) return false;

    if (table === 'staff') {
      await client.query(
        `UPDATE sec.staff_users SET password_hash = $2, password_algo = $3, password_pepper_id = $4 WHERE id = $1`,
        [id, upgraded.hash, upgraded.algo, upgraded.pepperId],
      );
    } else {
      await client.query(
        `UPDATE sec.parent_credentials SET password_hash = $2, password_algo = $3, password_pepper_id = $4 WHERE parent_id = $1`,
        [id, upgraded.hash, upgraded.algo, upgraded.pepperId],
      );
    }
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /*  Réinitialisation par jeton à usage unique                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Crée un jeton de réinitialisation.
   * Le jeton en clair n'est renvoyé qu'une fois (pour l'e-mail) ; la base ne
   * conserve que son empreinte SHA-256 : même un accès en lecture à la table
   * ne permet pas d'usurper la réinitialisation.
   */
  async createResetToken(
    client: PoolClient,
    input: { audience: 'parent' | 'ecole'; parentId?: string; staffUserId?: string; ip?: string | null },
  ): Promise<{ token: string; expiresAt: Date }> {
    // Invalide les jetons précédents du même compte (un seul actif à la fois)
    await client.query(
      `UPDATE sec.one_time_tokens SET consumed_at = now()
        WHERE purpose = 'reset_password' AND consumed_at IS NULL
          AND (($1::uuid IS NOT NULL AND parent_id = $1) OR ($2::uuid IS NOT NULL AND staff_user_id = $2))`,
      [input.parentId ?? null, input.staffUserId ?? null],
    );

    const token = randomToken(32);
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + 30 * 60_000); // 30 minutes

    await client.query(
      `INSERT INTO sec.one_time_tokens
         (purpose, audience, parent_id, staff_user_id, token_hash, max_attempts, ip, expires_at)
       VALUES ('reset_password', $1, $2, $3, $4, 3, $5, $6)`,
      [input.audience, input.parentId ?? null, input.staffUserId ?? null, tokenHash, input.ip ?? null, expiresAt],
    );

    return { token, expiresAt };
  }

  /** Consomme un jeton de réinitialisation et définit le nouveau mot de passe. */
  async consumeResetToken(
    client: PoolClient,
    input: { token: string; newPassword: string },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const tokenHash = sha256Hex(input.token);

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
        WHERE token_hash = $1 AND purpose = 'reset_password'
        FOR UPDATE`,
      [tokenHash],
    );

    const row = rows[0];
    if (!row) return { ok: false, reason: 'Lien de réinitialisation invalide.' };
    if (row.consumed_at) return { ok: false, reason: 'Ce lien a déjà été utilisé.' };
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { ok: false, reason: 'Ce lien a expiré. Demandez-en un nouveau.' };
    }
    if (row.attempts >= row.max_attempts) {
      return { ok: false, reason: 'Trop de tentatives sur ce lien. Demandez-en un nouveau.' };
    }

    // Marque le jeton comme consommé AVANT de changer le mot de passe :
    // si le changement échoue, le jeton n'est pas réutilisable.
    await client.query(
      `UPDATE sec.one_time_tokens SET consumed_at = now(), attempts = attempts + 1 WHERE id = $1`,
      [row.id],
    );

    if (row.staff_user_id) {
      const res = await this.setStaffPassword(client, {
        staffUserId: row.staff_user_id,
        newPassword: input.newPassword,
        requireCurrent: false,
        actorLabel: 'réinitialisation',
      });
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    }

    if (row.parent_id) {
      const res = await this.setParentPassword(client, {
        parentId: row.parent_id,
        newPassword: input.newPassword,
        requireCurrent: false,
      });
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    }

    return { ok: false, reason: 'Lien de réinitialisation invalide.' };
  }

  /** Indique si un compte doit changer son mot de passe à la prochaine connexion. */
  async mustChangePassword(client: PoolClient, staffUserId: string): Promise<boolean> {
    const { rows } = await client.query<{ must: boolean }>(
      `SELECT must_change_password AS must FROM sec.staff_users WHERE id = $1`,
      [staffUserId],
    );
    return rows[0]?.must ?? false;
  }
}
