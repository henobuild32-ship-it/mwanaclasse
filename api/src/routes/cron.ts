/**
 * ============================================================================
 *  MWANA CLASSE — Tâches planifiées (cron)
 * ============================================================================
 *  - /api/cron/rappels-calendrier : rappelle aux parents les événements de
 *    demain (un seul rappel par événement).
 *
 *  Protégé par CRON_SECRET (en-tête Authorization: Bearer <secret>) que
 *  Vercel transmet automatiquement aux fonctions cron configurées dans
 *  vercel.json.
 * ============================================================================
 */

import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../app.js';
import { notifier } from '../services/notifier.js';

export async function registerCronRoutes(deps: AppDependencies): Promise<void> {
  const { app, db, push, config } = deps;

  app.post('/api/cron/rappels-calendrier', async (req, reply) => {
    if (!config.CRON_SECRET) {
      return reply.code(503).send({
        erreur: 'CRON_NON_CONFIGURE',
        message: 'CRON_SECRET n’est pas défini sur ce serveur.',
      });
    }

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token || token !== config.CRON_SECRET) {
      return reply.code(401).send({
        erreur: 'ACCES_REFUSE',
        message: 'Jeton cron invalide.',
      });
    }

    if (!push.disponible) {
      return reply.code(503).send({
        erreur: 'PUSH_INDISPONIBLE',
        message: 'Les notifications push ne sont pas configurées.',
      });
    }

    // Événements demain, publiés, sans rappel déjà envoyé.
    const result = await db.withIdentity({ actor: 'system' }, async (client) => {
      const { rows: events } = await client.query<{
        id: string;
        school_id: string;
        title: string;
        starts_on: string;
        start_time: string | null;
      }>(
        `SELECT e.id, e.school_id, e.title, e.starts_on::text AS starts_on,
                e.start_time::text AS start_time
           FROM app.calendar_events e
          WHERE e.is_published
            AND e.starts_on = CURRENT_DATE + 1
            AND NOT EXISTS (
              SELECT 1 FROM app.notifications n
               WHERE n.entity_type = 'calendar_event'
                 AND n.entity_id = e.id
                 AND n.kind = 'rappel_evenement'
            )
          ORDER BY e.starts_on, e.start_time NULLS LAST`,
      );

      let envoyees = 0;
      for (const evt of events) {
        // Un rappel par parent de l'école ayant une liaison active.
        const { rowCount } = await client.query(
          `INSERT INTO app.notifications
             (school_id, audience, parent_id, kind, title, body, severity,
              entity_type, entity_id, action_url, channels)
           SELECT DISTINCT l.school_id, 'parent', l.parent_id, 'rappel_evenement',
                  $2,
                  CASE
                    WHEN $3::text IS NOT NULL
                      THEN 'Demain à ' || substring($3 from 1 for 5) || ' — ' || $4
                    ELSE 'Demain — ' || $4
                  END,
                  'info',
                  'calendar_event',
                  $1,
                  '/parent/calendrier',
                  ARRAY['interne','push']::sec.notification_channel[]
             FROM app.parent_student_links l
            WHERE l.school_id = $5
              AND l.status = 'actif'
              AND NOT EXISTS (
                SELECT 1 FROM app.notifications n
                 WHERE n.kind = 'rappel_evenement'
                   AND n.entity_id = $1
                   AND n.parent_id = l.parent_id
              )`,
          [
            evt.id,
            `Rappel : ${evt.title}`,
            evt.start_time,
            evt.title,
            evt.school_id,
          ],
        );
        envoyees += rowCount ?? 0;
      }

      // Pousse chaque notification créée.
      if (envoyees > 0) {
        const { rows: notifs } = await client.query(
          `SELECT id, school_id, audience, parent_id, staff_user_id, kind, title, body,
                  severity, entity_type, entity_id, action_url
             FROM app.notifications
            WHERE kind = 'rappel_evenement'
              AND pushed_at IS NULL
              AND created_at > now() - interval '5 minutes'`,
        );
        for (const n of notifs) {
          push.envoyerEnArrierePlan(n as any);
        }
      }

      return { evenements: events.length, notifications: envoyees };
    });

    return reply.code(200).send({
      message: 'Rappels de calendrier traités.',
      ...result,
    });
  });
}
