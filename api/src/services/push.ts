/**
 * ============================================================================
 *  MWANA CLASSE — Service d'envoi Web Push
 * ============================================================================
 *  - Envoi via web-push (VAPID) vers TOUS les appareils abonnés d'un
 *    destinataire (parent ou personnel d'école) ;
 *  - Essais automatiques en cas d'échec temporaire (failure_count) ;
 *  - Suppression automatique des abonnements expirés (404 / 410) ;
 *  - Envoi en arrière-plan (non bloquant pour l'API) ;
 *  - Respect des préférences par type de notification (interrupteurs).
 * ============================================================================
 */

import type { PoolClient } from 'pg';
import type { AppConfig } from '../config/index.js';
import type { Database } from '../db/pool.js';

// web-push est chargé dynamiquement pour ne pas casser le tracing des
// dépendances de Vercel (NFT) — son package contient des require non statiques.
type WebPushModule = typeof import('web-push');
let webpushModule: WebPushModule | null = null;
async function chargerWebPush(): Promise<WebPushModule | null> {
  if (webpushModule) return webpushModule;
  try {
    webpushModule = await import('web-push');
    return webpushModule;
  } catch {
    return null;
  }
}

/* ==========================================================================
 *  Types
 * ========================================================================== */

export interface NotificationPush {
  id: string;
  school_id: string | null;
  audience: 'parent' | 'ecole';
  parent_id: string | null;
  staff_user_id: string | null;
  kind: string;
  title: string;
  body: string | null;
  severity: string;
  entity_type: string | null;
  entity_id: string | null;
  action_url: string | null;
}

/** Charge utile envoyée au service worker (affichage + deep link). */
export interface PayloadPush {
  title: string;
  body: string;
  icon: string;
  badge: string;
  tag: string;
  data: {
    url: string;
    kind: string;
    notificationId: string;
    severity: string;
  };
}

interface AbonnementRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  prefs: Record<string, unknown> | null;
}

/* ==========================================================================
 *  Correspondance type de notification → interrupteur de préférence
 * ========================================================================== */

const PREFERENCE_PAR_KIND: Record<string, string> = {
  nouvelle_demande: 'demandes',
  message_parent: 'demandes',
  reponse_administration: 'demandes',
  clarification_demandee: 'demandes',
  reponse_clarification: 'demandes',
  parent_a_valider: 'demandes',
  liaison_validee: 'demandes',
  enfant_ajoute: 'demandes',
  nouveau_communique: 'communiques',
  communique_urgent: 'communiques',
  presence_enregistree: 'presences',
  presence_absente: 'presences',
  presence_retard: 'presences',
  presence_depart: 'presences',
  document_publie: 'documents',
  evenement_calendrier: 'calendrier',
  changement_calendrier: 'calendrier',
  rappel_evenement: 'calendrier',
};

/** Traduit un statut de présence en kind de notification. */
export function kindPresence(statut: string): { kind: string; titre: string } {
  switch (statut) {
    case 'absent':
      return { kind: 'presence_absente', titre: 'Absence signalée' };
    case 'retard':
      return { kind: 'presence_retard', titre: 'Retard signalé' };
    case 'depart_anticipe':
      return { kind: 'presence_depart', titre: 'Départ anticipé signalé' };
    default:
      return { kind: 'presence_enregistree', titre: 'Présence enregistrée' };
  }
}

/* ==========================================================================
 *  Service
 * ========================================================================== */

export class PushService {
  private actif = false;
  private vapidConfigure = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
  ) {
    this.actif = Boolean(
      config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.PUSH_ENABLED,
    );
  }

  /** Configure les détails VAPID (une seule fois) via le module chargé dynamiquement. */
  private async preparerWebPush(): Promise<WebPushModule | null> {
    const wp = await chargerWebPush();
    if (!wp) return null;
    if (!this.vapidConfigure) {
      wp.setVapidDetails(
        this.config.VAPID_SUBJECT,
        this.config.VAPID_PUBLIC_KEY!,
        this.config.VAPID_PRIVATE_KEY!,
      );
      this.vapidConfigure = true;
    }
    return wp;
  }

  get disponible(): boolean {
    return this.actif;
  }

  get clePublique(): string | null {
    return this.config.VAPID_PUBLIC_KEY ?? null;
  }

  /**
   * Envoie une notification en push à tous les appareils du destinataire.
   * Ne JAMAIS bloquer la requête appelante : les erreurs sont journalisées.
   */
  async envoyer(notification: NotificationPush): Promise<void> {
    if (!this.actif) return;
    try {
      const wp = await this.preparerWebPush();
      if (!wp) return;
      const clePreference = PREFERENCE_PAR_KIND[notification.kind] ?? null;
      const abonnements = await this.chargerAbonnements(notification, clePreference);
      if (abonnements.length === 0) return;

      const corps = JSON.stringify(this.construirePayload(notification));

      // Envoi en parallèle, borné (limite le nombre de requêtes simultanées).
      const resultats = await Promise.allSettled(
        abonnements.map((abo) => this.envoyerAbo(wp, abo, corps)),
      );

      for (const [i, r] of resultats.entries()) {
        if (r.status === 'rejected') {
          await this.enregistrerEchec(abonnements[i]!.id, String(r.reason));
        }
      }
    } catch (err) {
      // Le push ne doit jamais faire échouer l'opération métier.
      console.error('[push] échec d’envoi:', err);
    }
  }

  /** Envoie en arrière-plan (fire-and-forget) — utilisé par les routes. */
  envoyerEnArrierePlan(notification: NotificationPush): void {
    if (!this.actif) return;
    setImmediate(() => {
      void this.envoyer(notification);
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  Abonnements                                                           */
  /* ---------------------------------------------------------------------- */

  private async chargerAbonnements(
    n: NotificationPush,
    clePreference: string | null,
  ): Promise<AbonnementRow[]> {
    const pool = this.db.pool;

    if (n.audience === 'parent' && n.parent_id) {
      const { rows } = await pool.query<AbonnementRow>(
        `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, p.notification_prefs AS prefs
           FROM app.push_subscriptions ps
           JOIN app.parents p ON p.id = ps.parent_id
          WHERE ps.parent_id = $1
            AND ps.disabled_at IS NULL
            AND ps.failure_count < 8
            AND p.is_active
            AND coalesce((p.notification_prefs->>'push')::boolean, true)
          ORDER BY ps.last_used_at DESC NULLS LAST
          LIMIT 20`,
        [n.parent_id],
      );
      return this.filtrerPreference(rows, clePreference);
    }

    if (n.audience === 'ecole' && n.school_id) {
      // Tout le personnel actif de l'école abonné sur ses appareils.
      const { rows } = await pool.query<AbonnementRow>(
        `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, s.notification_prefs AS prefs
           FROM app.push_subscriptions ps
           JOIN sec.staff_users s ON s.id = ps.staff_user_id
          WHERE s.school_id = $1
            AND s.is_active
            AND ps.staff_user_id IS NOT NULL
            AND ps.disabled_at IS NULL
            AND ps.failure_count < 8
            AND coalesce((s.notification_prefs->>'push')::boolean, true)
          ORDER BY ps.last_used_at DESC NULLS LAST
          LIMIT 40`,
        [n.school_id],
      );
      return this.filtrerPreference(rows, clePreference);
    }

    return [];
  }

  private filtrerPreference(rows: AbonnementRow[], cle: string | null): AbonnementRow[] {
    if (!cle) return rows;
    return rows.filter((r) => r.prefs?.[cle] !== false);
  }

  /* ---------------------------------------------------------------------- */
  /*  Envoi                                                                 */
  /* ---------------------------------------------------------------------- */

  private construirePayload(n: NotificationPush): PayloadPush {
    const url = n.action_url ?? (n.audience === 'parent' ? '/parent/notifications' : '/ecole/notifications');
    return {
      title: n.title.slice(0, 120),
      body: (n.body ?? 'MwanaClasse').slice(0, 300),
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: `${n.kind}:${n.entity_id ?? n.id}`,
      data: {
        url,
        kind: n.kind,
        notificationId: n.id,
        severity: n.severity ?? 'info',
      },
    };
  }

  private async envoyerAbo(wp: WebPushModule, abo: AbonnementRow, corps: string): Promise<void> {
    try {
      await wp.sendNotification(
        { endpoint: abo.endpoint, keys: { p256dh: abo.p256dh, auth: abo.auth } },
        corps,
        { TTL: 24 * 3600, urgency: 'normal' },
      );
      // Succès : remise à zéro du compteur d'échecs.
      await this.db.pool.query(
        `UPDATE app.push_subscriptions
            SET failure_count = 0, last_used_at = now(), last_error = NULL
          WHERE id = $1`,
        [abo.id],
      );
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode ?? 0;
      if (status === 404 || status === 410) {
        // Abonnement expiré ou révoqué : suppression définitive.
        await this.db.pool.query(`DELETE FROM app.push_subscriptions WHERE id = $1`, [abo.id]);
        return;
      }
      // Erreur temporaire (429, 5xx, réseau) : compteur d'échecs incrémenté
      // par l'appelant, réessai automatique au prochain envoi.
      throw err;
    }
  }

  private async enregistrerEchec(id: string, message: string): Promise<void> {
    try {
      await this.db.pool.query(
        `UPDATE app.push_subscriptions
            SET failure_count = failure_count + 1, last_error = $2
          WHERE id = $1`,
        [id, message.slice(0, 300)],
      );
    } catch {
      /* best effort */
    }
  }
}

/* ==========================================================================
 *  Enregistrement / désactivation d'un abonnement (appelé par les routes)
 * ========================================================================== */

export async function upsertAbonnement(
  client: PoolClient,
  input: {
    audience: 'parent' | 'ecole';
    parentId: string | null;
    staffUserId: string | null;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
    deviceId: string | null;
  },
): Promise<{ id: string; renouvele: boolean }> {
  const { rows } = await client.query<{ id: string; renouvele: boolean }>(
    `INSERT INTO app.push_subscriptions
       (audience, parent_id, staff_user_id, endpoint, p256dh, auth, user_agent, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (endpoint) DO UPDATE SET
       audience = EXCLUDED.audience,
       parent_id = EXCLUDED.parent_id,
       staff_user_id = EXCLUDED.staff_user_id,
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent,
       device_id = EXCLUDED.device_id,
       disabled_at = NULL,
       failure_count = 0,
       last_error = NULL,
       last_used_at = now()
     RETURNING id, (xmax <> 0) AS renouvele`,
    [
      input.audience,
      input.parentId,
      input.staffUserId,
      input.endpoint,
      input.p256dh,
      input.auth,
      input.userAgent,
      input.deviceId,
    ],
  );
  return rows[0]!;
}

/** Désactive l'abonnement d'un appareil (déconnexion). */
export async function desactiverAbonnement(
  client: PoolClient,
  input: {
    audience: 'parent' | 'ecole';
    parentId: string | null;
    staffUserId: string | null;
    endpoint?: string | null;
    deviceId?: string | null;
  },
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE app.push_subscriptions
        SET disabled_at = now()
      WHERE disabled_at IS NULL
        AND audience = $1
        AND (parent_id IS NOT DISTINCT FROM $2)
        AND (staff_user_id IS NOT DISTINCT FROM $3)
        AND ($4::text IS NULL OR endpoint = $4)
        AND ($5::text IS NULL OR device_id = $5)`,
    [
      input.audience,
      input.parentId,
      input.staffUserId,
      input.endpoint ?? null,
      input.deviceId ?? null,
    ],
  );
  return rowCount ?? 0;
}
