/**
 * ============================================================================
 *  MWANA CLASSE — Routes Notifications Push (Web Push / VAPID)
 * ============================================================================
 *  - GET  /api/push/config            → clé publique VAPID (sans authentification)
 *  - POST /api/push/abonner           → enregistre l'abonnement de l'appareil
 *  - POST /api/push/desabonner        → désactive l'abonnement de l'appareil
 *  - GET  /api/push/reglages          → préférences par type de notification
 *  - PUT  /api/push/reglages          → met à jour les préférences
 *  - POST /api/push/test              → envoie une notification de test
 * ============================================================================
 */

import { z } from 'zod';
import type { AppDependencies } from '../app.js';
import {
  dbIdentityFrom,
  noStore,
  requireAuth,
  requireSchool,
  sendError,
} from '../http/middleware.js';
import {
  desactiverAbonnement,
  upsertAbonnement,
} from '../services/push.js';

const cleAbonnement = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(200),
  }),
});

const prefsSchema = z.object({
  push: z.boolean().optional(),
  demandes: z.boolean().optional(),
  communiques: z.boolean().optional(),
  presences: z.boolean().optional(),
  calendrier: z.boolean().optional(),
  documents: z.boolean().optional(),
});

export async function registerPushRoutes(deps: AppDependencies): Promise<void> {
  const { app, db, push } = deps;

  const authDeps = {
    db,
    sessions: deps.sessions,
    jwtVerify: (token: string) => app.jwt.verify(token) as Record<string, any>,
  };

  const guardHooks = [requireAuth(authDeps)];

  /* ====================================================================== */
  /*  CONFIGURATION PUBLIQUE                                                */
  /* ====================================================================== */

  app.get('/api/push/config', async (_req, reply) => {
    return noStore(reply).send({
      disponible: push.disponible,
      clePublique: push.clePublique,
    });
  });

  /* ====================================================================== */
  /*  ABONNEMENT / DÉSABONNEMENT                                            */
  /* ====================================================================== */

  app.post('/api/push/abonner', { preHandler: guardHooks }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = z
      .object({
        abonnement: cleAbonnement,
        deviceId: z.string().trim().max(128).optional().nullable(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Abonnement push invalide.');
    }
    if (!push.disponible) {
      return sendError(
        reply,
        503,
        'PUSH_INDISPONIBLE',
        'Les notifications push ne sont pas encore configurées sur ce serveur.',
      );
    }

    const audience = auth.identity.audience as 'parent' | 'ecole';
    const result = await db.withIdentity(dbIdentityFrom(req), (client) =>
      upsertAbonnement(client, {
        audience,
        parentId: auth.identity.parentId ?? null,
        staffUserId: auth.identity.staffUserId ?? null,
        endpoint: parsed.data.abonnement.endpoint,
        p256dh: parsed.data.abonnement.keys.p256dh,
        auth: parsed.data.abonnement.keys.auth,
        userAgent: (req.headers['user-agent'] as string) ?? null,
        deviceId: parsed.data.deviceId ?? (auth.identity.deviceId ?? null),
      }),
    );

    return noStore(reply).send({
      message: result.renouvele
        ? 'Abonnement mis à jour sur cet appareil.'
        : 'Notifications activées sur cet appareil.',
      abonnementId: result.id,
    });
  });

  app.post('/api/push/desabonner', { preHandler: guardHooks }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = z
      .object({
        endpoint: z.string().url().max(2048).optional(),
        deviceId: z.string().trim().max(128).optional().nullable(),
      })
      .safeParse(req.body ?? {});

    const audience = auth.identity.audience as 'parent' | 'ecole';
    const count = await db.withIdentity(dbIdentityFrom(req), (client) =>
      desactiverAbonnement(client, {
        audience,
        parentId: auth.identity.parentId ?? null,
        staffUserId: auth.identity.staffUserId ?? null,
        endpoint: parsed.success ? parsed.data.endpoint ?? null : null,
        deviceId: parsed.success ? parsed.data.deviceId ?? null : (auth.identity.deviceId ?? null),
      }),
    );

    return noStore(reply).send({
      message: count > 0 ? 'Notifications désactivées sur cet appareil.' : 'Aucun abonnement actif.',
      desabonnements: count,
    });
  });

  /* ====================================================================== */
  /*  RÉGLAGES (préférences par type)                                       */
  /* ====================================================================== */

  app.get('/api/push/reglages', { preHandler: guardHooks }, async (req, reply) => {
    const auth = req.auth!;
    const prefs = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      if (auth.identity.audience === 'parent') {
        const { rows } = await client.query<{ notification_prefs: any; abonnements: number }>(
          `SELECT p.notification_prefs,
                  (SELECT count(*) FROM app.push_subscriptions ps
                    WHERE ps.parent_id = p.id AND ps.disabled_at IS NULL)::int AS abonnements
             FROM app.parents p WHERE p.id = $1`,
          [auth.userId],
        );
        return rows[0] ?? null;
      }
      const { rows } = await client.query<{ notification_prefs: any; abonnements: number }>(
        `SELECT s.notification_prefs,
                (SELECT count(*) FROM app.push_subscriptions ps
                  WHERE ps.staff_user_id = s.id AND ps.disabled_at IS NULL)::int AS abonnements
           FROM sec.staff_users s WHERE s.id = $1`,
        [auth.userId],
      );
      return rows[0] ?? null;
    });

    if (!prefs) {
      return sendError(reply, 404, 'PROFIL_INTROUVABLE', 'Profil introuvable.');
    }

    return noStore(reply).send({
      reglages: prefs.notification_prefs ?? {},
      appareilsAbonnes: prefs.abonnements ?? 0,
      pushDisponible: push.disponible,
    });
  });

  app.put('/api/push/reglages', { preHandler: guardHooks }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = prefsSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Réglages de notification invalides.');
    }

    const audience = auth.identity.audience;
    const updated = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const table = audience === 'parent' ? 'app.parents' : 'sec.staff_users';
      const { rows } = await client.query(
        `UPDATE ${table}
            SET notification_prefs = notification_prefs || $2::jsonb
          WHERE id = $1
          RETURNING notification_prefs`,
        [auth.userId, JSON.stringify(parsed.data)],
      );
      return rows[0]?.notification_prefs ?? null;
    });

    if (!updated) {
      return sendError(reply, 404, 'PROFIL_INTROUVABLE', 'Profil introuvable.');
    }

    return noStore(reply).send({
      message: 'Réglages de notification enregistrés.',
      reglages: updated,
    });
  });

  /* ====================================================================== */
  /*  NOTIFICATION DE TEST                                                  */
  /* ====================================================================== */

  app.post('/api/push/test', { preHandler: guardHooks }, async (req, reply) => {
    const auth = req.auth!;
    if (!push.disponible) {
      return sendError(
        reply,
        503,
        'PUSH_INDISPONIBLE',
        'Les notifications push ne sont pas configurées sur ce serveur.',
      );
    }

    const audience = auth.identity.audience as 'parent' | 'ecole';
    const ecoleId = audience === 'ecole' ? requireSchool(req) : null;

    // Insère une notification de test, puis la pousse en arrière-plan.
    const notification = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `INSERT INTO app.notifications
           (school_id, audience, parent_id, staff_user_id, kind, title, body, severity,
            entity_type, action_url, channels)
         VALUES ($1,$2,$3,$4,'test_push','Test de notification',
                 'Ceci est une notification de test. Si vous la lisez, tout fonctionne\u00a0!',
                 'info',NULL,$5, ARRAY['interne','push']::sec.notification_channel[])
         RETURNING id, school_id, audience, parent_id, staff_user_id, kind, title, body,
                   severity, entity_type, entity_id, action_url`,
        [
          ecoleId,
          audience,
          auth.identity.parentId ?? null,
          auth.identity.staffUserId ?? null,
          audience === 'parent' ? '/parent/notifications' : '/ecole/notifications',
        ],
      );
      return rows[0]!;
    });

    push.envoyerEnArrierePlan(notification);

    return noStore(reply).send({
      message:
        'Notification de test envoyée sur vos appareils abonnés. ' +
        'Si vous ne la recevez pas dans les secondes qui suivent, vérifiez les réglages de votre navigateur.',
    });
  });
}
