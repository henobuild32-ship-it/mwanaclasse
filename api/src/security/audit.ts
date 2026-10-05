/**
 * ============================================================================
 *  MWANA CLASSE — Journal d'audit inviolable
 * ============================================================================
 *  Objectifs :
 *    1. Tracer toutes les tentatives de connexion et tous les accès aux
 *       données sensibles (exigence explicite du cahier des charges).
 *    2. Rendre toute falsification détectable :
 *         - chaque entrée est chiffrée (AES-256-GCM) : confidentialité ;
 *         - chaque entrée porte une empreinte SHA-256 chaînée à la précédente
 *           (prev_hash / entry_hash) : toute suppression ou modification en
 *           milieu de chaîne casse la vérification ;
 *         - chaque entrée est signée HMAC-SHA256 avec une clé qui n'est PAS
 *           dans la base : un attaquant disposant du dump SQL complet ne peut
 *           pas produire de fausses entrées valides.
 *    3. Alimenter une surveillance temps réel (détection d'anomalies).
 * ============================================================================
 */

import {
  hmacHex,
  sha256Hex,
  encryptSymmetric,
  decryptSymmetric,
  safeEqual,
} from './crypto.js';
import type { SecretsManager } from './secrets.js';

/* ==========================================================================
 *  Types
 * ========================================================================== */

/**
 * Client minimal exigé par le journal : toute connexion PostgreSQL capable
 * d'exécuter une requête convient (PoolClient, client de transaction, shim).
 * Défini structurellement pour que les gestionnaires de route qui reçoivent un
 * client de transaction puissent journaliser sans conversion de type.
 */
export interface AuditClient {
  query<R extends Record<string, any> = any>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export type ActorKind = 'parent' | 'staff' | 'systeme' | 'api' | 'integration' | 'anonyme';
export type Severity = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critique';
export type AuditResult = 'succes' | 'echec' | 'refuse' | 'erreur';

export interface AuditContext {
  actorKind: ActorKind;
  actorId?: string | null;
  actorLabel?: string | null;
  actorIp?: string | null;
  actorDevice?: string | null;
  schoolId?: string | null;
}

export interface AuditEntry {
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  entityLabel?: string | null;
  severity?: Severity;
  result?: AuditResult;
  /** Détail : sera chiffré avant stockage */
  payload?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

/* ==========================================================================
 *  Catalogue des actions sensibles suivies
 * ========================================================================== */

export const AUDIT_ACTIONS = {
  // Authentification
  LOGIN_SUCCESS: 'auth.login.succes',
  LOGIN_FAILED: 'auth.login.echec',
  LOGIN_LOCKED: 'auth.login.verrouille',
  LOGOUT: 'auth.deconnexion',
  TOKEN_REFRESH: 'auth.jeton.renouvele',
  TOKEN_REVOKED: 'auth.jeton.revoque',
  PASSWORD_CHANGED: 'auth.mot_de_passe.modifie',
  PASSWORD_RESET_REQUESTED: 'auth.mot_de_passe.reinitialisation_demandee',
  PASSWORD_RESET_DONE: 'auth.mot_de_passe.reinitialise',
  MFA_ENABLED: 'auth.2fa.active',
  MFA_DISABLED: 'auth.2fa.desactive',
  MFA_CHALLENGE_FAILED: 'auth.2fa.echec',
  RECOVERY_CODE_USED: 'auth.2fa.code_secours_utilise',

  // Écoles et comptes
  SCHOOL_CREATED: 'school.creation',
  SCHOOL_UPDATED: 'school.modification',
  SCHOOL_CODE_VIEWED: 'school.code_consulte',
  STAFF_CREATED: 'staff.creation',
  STAFF_UPDATED: 'staff.modification',
  STAFF_DISABLED: 'staff.desactivation',
  STAFF_ROLE_CHANGED: 'staff.role_modifie',

  // Élèves
  STUDENT_CREATED: 'student.creation',
  STUDENT_UPDATED: 'student.modification',
  STUDENT_ARCHIVED: 'student.archivage',
  STUDENT_CLASS_CHANGED: 'student.classe_modifiee',
  STUDENT_SENSITIVE_VIEWED: 'student.donnee_sensible_consultee',
  STUDENT_CODE_LOOKUP: 'student.code_recherche',
  STUDENT_CARD_PRINTED: 'student.fiche_imprimee',

  // Présences
  ATTENDANCE_CREATED: 'attendance.creation',
  ATTENDANCE_UPDATED: 'attendance.modification',
  ATTENDANCE_BULK: 'attendance.lot_enregistre',
  ATTENDANCE_SYNCED: 'attendance.synchronisation',

  // Liaisons parent-enfant
  LINK_REQUESTED: 'lien.demande',
  LINK_APPROVED: 'lien.valide',
  LINK_REVOKED: 'lien.revoque',
  LINK_AUTO_APPROVED: 'lien.valide_automatiquement',

  // Communiqués
  ANNOUNCEMENT_CREATED: 'announcement.creation',
  ANNOUNCEMENT_UPDATED: 'announcement.modification',
  ANNOUNCEMENT_PUBLISHED: 'announcement.publication',
  ANNOUNCEMENT_DELETED: 'announcement.suppression',
  ANNOUNCEMENT_READ: 'announcement.lecture',
  TEMPLATE_IMPORTED: 'announcement.modele_importe',

  // Demandes
  REQUEST_CREATED: 'request.creation',
  REQUEST_HANDLED: 'request.traitement',
  REQUEST_CLOSED: 'request.cloture',

  // Sécurité
  RATE_LIMITED: 'securite.limite_debit',
  ACCESS_DENIED: 'securite.acces_refuse',
  SUSPICIOUS_ACTIVITY: 'securite.activite_suspecte',
  DATA_EXPORTED: 'donnees.export',
  GDPR_ERASURE: 'donnees.effacement',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/* ==========================================================================
 *  Écrivain du journal
 * ========================================================================== */

export class AuditLogger {
  constructor(
    private readonly secrets: SecretsManager,
    private readonly opts: { enabled?: boolean; chainVerifyEveryWrites?: number } = {},
  ) {}

  private get key(): Buffer {
    return this.secrets.deriveKeyFor('key.audit', 'audit.payload');
  }

  private get signingKey(): Buffer {
    return this.secrets.deriveKeyFor('key.audit', 'audit.signature');
  }

  /**
   * Écrit une entrée d'audit dans la transaction de l'appelant.
   * L'écriture partage la transaction métier : si l'action est annulée, sa
   * trace l'est aussi (cohérence), et si elle réussit, la trace est garantie.
   *
   * Ne journalise JAMAIS de mot de passe, jeton ou numéro de carte : la
   * fonction `redact` nettoie récursivement la charge utile.
   */
  async write(
    client: AuditClient,
    ctx: AuditContext,
    entry: AuditEntry,
  ): Promise<{ id: string; hash: string; signature: string }> {
    if (this.opts.enabled === false) return { id: '0', hash: '', signature: '' };

    const canonicalPayload = JSON.stringify(redact(entry.payload ?? {}));
    const payloadHash = sha256Hex(canonicalPayload);

    // 1) Chiffrement du détail : il reste confidentiel même si la base fuit.
    const aad = `${ctx.schoolId ?? 'global'}|${entry.action}`;
    const payloadEnc = encryptSymmetric(canonicalPayload, this.key, aad);

    // 2) Insertion : le trigger PostgreSQL calcule prev_hash et entry_hash.
    const { rows } = await client.query<{ id: string; entry_hash: string; prev_hash: string | null }>(
      `INSERT INTO sec.audit_log
         (school_id, actor_kind, actor_id, actor_label, actor_ip, actor_device,
          action, entity_type, entity_id, entity_label, severity, result,
          payload_enc, payload_hash, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id, entry_hash, prev_hash`,
      [
        ctx.schoolId ?? null,
        ctx.actorKind,
        ctx.actorId ?? null,
        ctx.actorLabel ?? null,
        ctx.actorIp ?? null,
        ctx.actorDevice ?? null,
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.entityLabel ?? null,
        entry.severity ?? 'info',
        entry.result ?? 'succes',
        payloadEnc,
        payloadHash,
        JSON.stringify(redact(entry.metadata ?? {})),
      ],
    );

    const row = rows[0]!;

    // 3) Signature HMAC : la clé vit hors base, donc un dump SQL ne suffit pas
    //    à forger des entrées cohérentes.
    const signature = hmacHex(`${row.prev_hash ?? 'GENESE'}|${row.entry_hash}`, this.signingKey);
    await client.query(`UPDATE sec.audit_log SET signature = $1 WHERE id = $2`, [signature, row.id]);

    return { id: row.id, hash: row.entry_hash, signature };
  }

  /**
   * Écrit une entrée hors transaction (best-effort), sans jamais faire échouer
   * l'opération appelante : sert aux événements de sécurité (échec de
   * connexion) qui doivent être tracés même si la requête échoue ensuite.
   */
  async writeSafe(
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>,
    ctx: AuditContext,
    entry: AuditEntry,
  ): Promise<void> {
    try {
      const shim = { query } as unknown as AuditClient;
      await this.write(shim, ctx, entry);
    } catch (err) {
      // Un journal d'audit indisponible ne doit pas masquer l'erreur métier,
      // mais il doit être visible dans les journaux du serveur.
      // eslint-disable-next-line no-console
      console.error('[audit] écriture impossible', entry.action, (err as Error).message);
    }
  }

  /**
   * Vérifie l'intégrité de la chaîne d'audit.
   * Détecte : entrée modifiée, entrée supprimée, entrée insérée sans chaînage.
   */
  async verify(
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>,
    opts: { fromId?: number; limit?: number; schoolId?: string } = {},
  ): Promise<{
    checked: number;
    intact: boolean;
    brokenEntries: { id: string; reason: string }[];
    signatureFailures: string[];
  }> {
    const rows = (
      await query(
        `SELECT id, occurred_at, school_id, actor_kind, actor_id, actor_ip, action,
                entity_type, entity_id, severity, result, payload_hash,
                prev_hash, entry_hash, signature
           FROM sec.audit_log
          WHERE id > $1 ${opts.schoolId ? 'AND school_id = $3' : ''}
          ORDER BY id
          LIMIT $2`,
        opts.schoolId
          ? [opts.fromId ?? 0, opts.limit ?? 100_000, opts.schoolId]
          : [opts.fromId ?? 0, opts.limit ?? 100_000],
      )
    ).rows;

    const brokenEntries: { id: string; reason: string }[] = [];
    const signatureFailures: string[] = [];
    let prev: string | null = null;

    for (const r of rows) {
      const canonical = [
        prev ?? 'GENESE',
        toIsoString(r.occurred_at),
        r.school_id ?? '',
        r.actor_kind,
        r.actor_id ?? '',
        r.actor_ip ?? '',
        r.action,
        r.entity_type ?? '',
        r.entity_id ?? '',
        r.severity,
        r.result,
        r.payload_hash ?? '',
      ].join('|');

      const expected = sha256Hex(canonical);
      if (!safeEqual(expected, String(r.entry_hash))) {
        brokenEntries.push({ id: String(r.id), reason: 'empreinte incohérente (entrée modifiée)' });
      }
      if ((r.prev_hash ?? null) !== prev) {
        brokenEntries.push({ id: String(r.id), reason: 'chaînage rompu (entrée supprimée ou insérée)' });
      }

      if (r.signature) {
        const expectedSig = hmacHex(`${r.prev_hash ?? 'GENESE'}|${r.entry_hash}`, this.signingKey);
        if (!safeEqual(expectedSig, String(r.signature))) {
          signatureFailures.push(String(r.id));
        }
      } else {
        signatureFailures.push(String(r.id));
      }

      prev = String(r.entry_hash);
    }

    return {
      checked: rows.length,
      intact: brokenEntries.length === 0 && signatureFailures.length === 0,
      brokenEntries,
      signatureFailures,
    };
  }

  /** Relit le détail chiffré d'une entrée (réservé aux administrateurs). */
  async readPayload(
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const { rows } = await query(
      `SELECT payload_enc, school_id, action FROM sec.audit_log WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row?.payload_enc) return null;
    try {
      const aad = `${row.school_id ?? 'global'}|${row.action}`;
      const json = decryptSymmetric(Buffer.from(row.payload_enc), this.key, aad);
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/* ==========================================================================
 *  Nettoyage : aucune donnée secrète ne doit atteindre le journal
 * ========================================================================== */

const REDACT_KEYS = new Set([
  'password', 'motdepasse', 'mot_de_passe', 'passwd', 'pwd',
  'password_hash', 'passwordhash', 'pepper',
  'token', 'access_token', 'refresh_token', 'id_token', 'jwt',
  'secret', 'totp_secret', 'totpsecret', 'client_secret',
  'authorization', 'cookie', 'set-cookie', 'apikey', 'api_key',
  'cvv', 'cvc', 'card_number', 'numerocarte',
  'recovery_code', 'recovery_codes', 'code_secours',
  'private_key', 'privatekey',
]);

const REDACT_PATTERNS: [RegExp, string | ((match: string) => string)][] = [
  [/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, '[NUMÉRO_MASQUÉ]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[JETON_MASQUÉ]'],
  [/MC-(ELV|ECOLE|PAR)-[A-Z0-9]+/g, (m: string) => `${m.slice(0, 7)}••••`],
];

/**
 * Masque récursivement les valeurs sensibles.
 * Protection en profondeur : même si un développeur journalise par erreur un
 * objet de formulaire complet, le mot de passe n'atteint jamais le journal.
 */
export function redact(value: unknown, depth = 0): any {
  if (depth > 8) return '[PROFONDEUR_MAX]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    let out: string = value;
    for (const [re, rep] of REDACT_PATTERNS) {
      out = typeof rep === 'string' ? out.replace(re, rep) : out.replace(re, rep);
    }
    return out;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 200).map((v) => redact(v, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();

  if (Buffer.isBuffer(value)) return `[BINAIRE ${value.length} octets]`;

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const normalized = k.toLowerCase().replace(/[^a-z0-9_]/g, '');
      out[k] = REDACT_KEYS.has(normalized) ? '[MASQUÉ]' : redact(v, depth + 1);
    }
    return out;
  }

  return '[VALEUR_NON_SERIALISABLE]';
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return String(value);
}
