/**
 * ============================================================================
 *  MWANA CLASSE — Service Ministère de l'EPST
 * ============================================================================
 *  Gère le compte unique du Ministère de l'EPST, les écoles de Kinshasa,
 *  l'envoi des communiqués officiels, l'historique et les accusés de lecture.
 * ============================================================================
 */

import type { PoolClient } from 'pg';
import { activeHasher, verifyPassword } from '../security/crypto.js';
import type { SecretsManager } from '../security/secrets.js';
import type { Database } from '../db/pool.js';

export interface MinistereAccount {
  id: string;
  identifier: string;
  password_hash: string;
  password_algo: string;
  is_default_password: boolean;
  password_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EcoleKinshasa {
  id: string;
  public_code: string;
  official_name: string;
  short_name: string | null;
  type: string;
  types: string[];
  commune: string | null;
  city: string | null;
  address_line: string | null;
  phone_contact: string | null;
  email: string | null;
  is_active: boolean;
  created_at: string;
  eleves_count: number;
  classes_count: number;
}

export interface MinistereCommuniqueInput {
  title: string;
  message: string;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentType?: string | null;
  isUrgent: boolean;
  targetType: 'toutes_ecoles' | 'ecole_specifique';
  targetSchoolId?: string | null;
  sentBy: string;
}

export class MinistereService {
  constructor(private readonly secrets: SecretsManager) {}

  /**
   * Crée automatiquement le compte unique Ministère au démarrage s'il n'existe pas encore.
   * Identifiant : min-epst@mwanaclasse.com
   * Mot de passe de départ : 12345678
   */
  async ensureMinistereAccountExists(db: Database): Promise<void> {
    await db.withIdentity({ actor: 'system' }, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM app.ministere_account LIMIT 1`,
      );
      if (rows.length === 0) {
        const hasher = activeHasher();
        const pepper = this.secrets.get('pepper.password').current.value;
        const hash = await hasher.hash('12345678', pepper);
        await client.query(
          `INSERT INTO app.ministere_account (identifier, password_hash, password_algo, is_default_password)
           VALUES ($1, $2, $3, true)
           ON CONFLICT DO NOTHING`,
          ['min-epst@mwanaclasse.com', hash, hasher.algo],
        );
      }
    });
  }

  /**
   * Trouve le compte Ministère par son identifiant (insensible à la casse).
   */
  async findAccountByIdentifier(
    client: PoolClient,
    identifier: string,
  ): Promise<MinistereAccount | null> {
    const { rows } = await client.query<MinistereAccount>(
      `SELECT id, identifier, password_hash, password_algo, is_default_password,
              password_changed_at, created_at, updated_at
         FROM app.ministere_account
        WHERE identifier = $1
        LIMIT 1`,
      [identifier.trim().toLowerCase()],
    );
    return rows[0] ?? null;
  }

  /**
   * Récupère le compte Ministère unique.
   */
  async getAccount(client: PoolClient): Promise<Omit<MinistereAccount, 'password_hash'> | null> {
    const { rows } = await client.query<Omit<MinistereAccount, 'password_hash'>>(
      `SELECT id, identifier, password_algo, is_default_password,
              password_changed_at, created_at, updated_at
         FROM app.ministere_account
        LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  /**
   * Met à jour le mot de passe du compte Ministère.
   */
  async updatePassword(
    client: PoolClient,
    accountId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const { rows } = await client.query<{ password_hash: string }>(
      `SELECT password_hash FROM app.ministere_account WHERE id = $1 FOR UPDATE`,
      [accountId],
    );
    const account = rows[0];
    if (!account) {
      return { ok: false, message: 'Compte Ministère introuvable.' };
    }

    const check = await verifyPassword(
      currentPassword,
      account.password_hash,
      this.secrets.passwordPeppers(),
    );
    if (!check.ok) {
      return { ok: false, message: 'L’ancien mot de passe est incorrect.' };
    }

    if (newPassword.length < 8) {
      return { ok: false, message: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' };
    }

    const hasher = activeHasher();
    const pepper = this.secrets.get('pepper.password').current.value;
    const hash = await hasher.hash(newPassword, pepper);
    await client.query(
      `UPDATE app.ministere_account
          SET password_hash = $2,
              password_algo = $3,
              is_default_password = false,
              password_changed_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [accountId, hash, hasher.algo],
    );

    return { ok: true };
  }

  /**
   * Modifie l'identifiant du Ministère.
   */
  async updateIdentifier(
    client: PoolClient,
    accountId: string,
    newIdentifier: string,
  ): Promise<{ ok: true; identifier: string } | { ok: false; message: string }> {
    const clean = newIdentifier.trim().toLowerCase();
    if (!clean || clean.length < 5 || !clean.includes('@')) {
      return { ok: false, message: 'Adresse e-mail invalide pour le nouvel identifiant.' };
    }

    await client.query(
      `UPDATE app.ministere_account
          SET identifier = $2,
              updated_at = now()
        WHERE id = $1`,
      [accountId, clean],
    );

    return { ok: true, identifier: clean };
  }

  /**
   * Liste toutes les écoles inscrites à Kinshasa avec recherche et filtre par commune.
   */
  async getEcolesKinshasa(
    client: PoolClient,
    filters?: { commune?: string; recherche?: string; statut?: string },
  ): Promise<{ ecoles: EcoleKinshasa[]; total: number; communes: string[] }> {
    const conditions: string[] = [
      `(s.city ILIKE '%Kinshasa%' OR s.province ILIKE '%Kinshasa%' OR s.commune IS NOT NULL)`,
    ];
    const params: unknown[] = [];

    if (filters?.commune && filters.commune.trim() !== '' && filters.commune !== 'toutes') {
      params.push(filters.commune.trim());
      conditions.push(`s.commune = $${params.length}`);
    }

    if (filters?.statut === 'actif') {
      conditions.push(`s.is_active = true`);
    } else if (filters?.statut === 'inactif') {
      conditions.push(`s.is_active = false`);
    }

    if (filters?.recherche && filters.recherche.trim() !== '') {
      params.push(`%${filters.recherche.trim()}%`);
      const pIdx = params.length;
      conditions.push(
        `(s.official_name ILIKE $${pIdx} OR s.commune ILIKE $${pIdx} OR s.public_code ILIKE $${pIdx} OR s.phone_contact ILIKE $${pIdx} OR s.email ILIKE $${pIdx})`,
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await client.query<EcoleKinshasa>(
      `SELECT s.id, s.public_code, s.official_name, s.short_name, s.type, s.types,
              s.commune, s.city, s.address_line, s.phone_contact, s.email, s.is_active,
              s.created_at,
              COALESCE((SELECT count(*)::int FROM app.students st WHERE st.school_id = s.id AND st.status = 'actif'), 0) AS eleves_count,
              COALESCE((SELECT count(*)::int FROM app.classes cl WHERE cl.school_id = s.id AND cl.is_active), 0) AS classes_count
         FROM app.schools s
         ${whereClause}
        ORDER BY s.official_name ASC`,
      params,
    );

    // Liste des communes distinctes pour le filtre
    const { rows: communeRows } = await client.query<{ commune: string }>(
      `SELECT DISTINCT s.commune
         FROM app.schools s
        WHERE s.commune IS NOT NULL AND btrim(s.commune) <> ''
        ORDER BY s.commune ASC`,
    );

    return {
      ecoles: rows,
      total: rows.length,
      communes: communeRows.map((r) => r.commune),
    };
  }

  /**
   * Récupère la fiche détaillée d'une école.
   */
  async getEcoleDetails(client: PoolClient, schoolId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await client.query(
      `SELECT s.id, s.public_code, s.official_name, s.short_name, s.type, s.types,
              s.commune, s.city, s.province, s.address_line, s.phone_contact, s.email,
              s.website, s.description, s.opening_hours, s.current_year_label,
              s.is_active, s.created_at,
              COALESCE((SELECT count(*)::int FROM app.students st WHERE st.school_id = s.id AND st.status = 'actif'), 0) AS eleves_count,
              COALESCE((SELECT count(*)::int FROM app.classes cl WHERE cl.school_id = s.id AND cl.is_active), 0) AS classes_count,
              COALESCE((SELECT count(*)::int FROM app.announcements a WHERE a.school_id = s.id AND a.status = 'publie'), 0) AS communiques_ecole_count
         FROM app.schools s
        WHERE s.id = $1
        LIMIT 1`,
      [schoolId],
    );
    return rows[0] ?? null;
  }

  /**
   * Envoie un communiqué officiel du Ministère.
   */
  async sendCommunique(
    client: PoolClient,
    input: MinistereCommuniqueInput,
  ): Promise<{ id: string; targetCount: number; message: string }> {
    let targetCount = 1;
    if (input.targetType === 'toutes_ecoles') {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::int AS count
           FROM app.schools
          WHERE is_active AND (city ILIKE '%Kinshasa%' OR province ILIKE '%Kinshasa%' OR commune IS NOT NULL)`,
      );
      targetCount = Number(rows[0]?.count ?? 0);
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO app.ministere_communiques
         (title, message, attachment_url, attachment_name, attachment_type,
          is_urgent, target_type, target_school_id, target_count, sender_label, sent_by, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Ministère de l''EPST', $10, now())
       RETURNING id`,
      [
        input.title.trim(),
        input.message.trim(),
        input.attachmentUrl ?? null,
        input.attachmentName ?? null,
        input.attachmentType ?? null,
        input.isUrgent,
        input.targetType,
        input.targetType === 'ecole_specifique' ? input.targetSchoolId ?? null : null,
        targetCount,
        input.sentBy,
      ],
    );

    return {
      id: rows[0]!.id,
      targetCount,
      message: 'Communiqué envoyé avec succès.',
    };
  }

  /**
   * Historique de tous les communiqués envoyés par le Ministère.
   */
  async getHistorique(client: PoolClient): Promise<unknown[]> {
    const { rows } = await client.query(
      `SELECT c.id, c.title, c.message, c.attachment_url, c.attachment_name, c.attachment_type,
              c.is_urgent, c.target_type, c.target_school_id, c.target_count,
              c.sender_label, c.sent_by, c.sent_at,
              s.official_name AS target_school_name,
              COALESCE((SELECT count(*)::int FROM app.ministere_communique_lectures l WHERE l.communique_id = c.id), 0) AS lectures_count
         FROM app.ministere_communiques c
         LEFT JOIN app.schools s ON s.id = c.target_school_id
        ORDER BY c.sent_at DESC`,
    );
    return rows;
  }

  /**
   * Récupère les communiqués destinés à une école spécifique.
   * L'école reçoit les communiqués envoyés à toutes les écoles ET ceux envoyés à elle seule.
   * Elle ne voit JAMAIS ceux envoyés aux autres écoles.
   */
  async getCommuniquesPourEcole(
    client: PoolClient,
    schoolId: string,
  ): Promise<{ communiques: unknown[]; nonLusCount: number }> {
    const { rows } = await client.query(
      `SELECT c.id, c.title, c.message, c.attachment_url, c.attachment_name, c.attachment_type,
              c.is_urgent, c.sender_label, c.sent_at,
              (l.read_at IS NOT NULL) AS lu,
              l.read_at
         FROM app.ministere_communiques c
         LEFT JOIN app.ministere_communique_lectures l
                ON l.communique_id = c.id AND l.school_id = $1
        WHERE c.target_type = 'toutes_ecoles' OR c.target_school_id = $1
        ORDER BY c.sent_at DESC`,
      [schoolId],
    );

    const nonLusCount = rows.filter((r: any) => !r.lu).length;

    return {
      communiques: rows,
      nonLusCount,
    };
  }

  /**
   * Marque un communiqué Ministère comme lu par une école.
   */
  async markAsRead(client: PoolClient, schoolId: string, communiqueId: string): Promise<void> {
    await client.query(
      `INSERT INTO app.ministere_communique_lectures (communique_id, school_id, read_at)
       VALUES ($1, $2, now())
       ON CONFLICT (communique_id, school_id) DO NOTHING`,
      [communiqueId, schoolId],
    );
  }
}
