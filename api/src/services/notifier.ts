/**
 * ============================================================================
 *  MWANA CLASSE — Service de notification (interne + push)
 * ============================================================================
 *  Toutes les notifications du produit passent par ce service : une seule
 *  table d'insertion, un seul canal push, un seul format de charge utile.
 *  L'envoi push est toujours en arrière-plan (jamais bloquant).
 * ============================================================================
 */

import type { PushService, NotificationPush } from './push.js';

export interface NotificationInput {
  schoolId: string | null;
  audience: 'parent' | 'ecole';
  parentId?: string | null;
  staffUserId?: string | null;
  kind: string;
  title: string;
  body?: string | null;
  severity?: 'info' | 'succes' | 'attention' | 'urgent';
  entityType?: string | null;
  entityId?: string | null;
  actionUrl?: string | null;
}

/** Client de requête minimal — compatible PoolClient et QueryableClient. */
interface Queryable {
  query<R extends Record<string, any> = any>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * Insère une notification dans la base (dans la transaction du client fourni)
 * puis la pousse en arrière-plan sur les appareils abonnés.
 */
export async function notifier(
  client: Queryable,
  push: PushService,
  input: NotificationInput,
): Promise<NotificationPush> {
  const { rows } = await client.query<NotificationPush>(
    `INSERT INTO app.notifications
       (school_id, audience, parent_id, staff_user_id, kind, title, body, severity,
        entity_type, entity_id, action_url, channels)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             ARRAY['interne','push']::sec.notification_channel[])
     RETURNING id, school_id, audience, parent_id, staff_user_id, kind, title, body,
               severity, entity_type, entity_id, action_url`,
    [
      input.schoolId,
      input.audience,
      input.parentId ?? null,
      input.staffUserId ?? null,
      input.kind,
      input.title.slice(0, 200),
      input.body?.slice(0, 2000) ?? null,
      input.severity ?? 'info',
      input.entityType ?? null,
      input.entityId ?? null,
      input.actionUrl ?? null,
    ],
  );
  const notification = rows[0]!;
  push.envoyerEnArrierePlan(notification);
  return notification;
}
