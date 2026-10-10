/**
 * ============================================================================
 *  MWANA CLASSE — Synchronisation Offline First
 * ============================================================================
 *  Principe :
 *    Le terminal (tablette de l'école, téléphone de l'administration) enregistre
 *    les actions localement dans IndexedDB, puis les envoie par lots dès que la
 *    connexion revient.
 *
 *    - IDEMPOTENCE : chaque opération porte un identifiant unique généré par le
 *      terminal. Rejouer un lot après une coupure réseau ne crée donc jamais de
 *      doublon (contrainte UNIQUE (client_id, op_uuid)).
 *    - HORODATAGE RÉEL : `clientTime` conserve l'heure locale du moment de
 *      l'action ; une présence enregistrée à 07:42 hors ligne reste à 07:42.
 *    - CONFLITS : la version connue du terminal (`baseVersion`) est comparée à
 *      la version serveur. En cas de divergence, la règle est explicite (le
 *      serveur fait foi) MAIS le conflit est journalisé avec les deux valeurs :
 *      aucun écrasement silencieux.
 *    - DELTA : le terminal ne redemande que ce qui a changé depuis son curseur.
 * ============================================================================
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { AppDependencies } from '../app.js';
import {
  clientIp,
  dbIdentityFrom,
  requireAudience,
  requireAuth,
  requirePermission,
  sendError,
  noStore,
  type QueryableClient,
} from '../http/middleware.js';
import { AUDIT_ACTIONS } from '../security/audit.js';
import { libelleFermeture, lireEtatJour } from '../domain/calendrier-scolaire.js';

/* ==========================================================================
 *  Schémas
 * ========================================================================== */

const OperationSchema = z.object({
  /** Identifiant unique de l'opération, généré par le terminal */
  opUuid: z.string().uuid(),
  entityType: z.enum([
    'attendance',
    'attendance.bulk',
    'request',
    'request.message',
    'announcement.draft',
    'student.draft',
    'notification.read',
  ]),
  opType: z.enum(['create', 'update', 'delete', 'upsert', 'action']),
  entityId: z.string().uuid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()).default({}),
  baseVersion: z.coerce.number().int().min(0).optional().nullable(),
  clientTime: z.string().datetime().optional().nullable(),
  deviceId: z.string().max(120).optional().nullable(),
});

const PushSchema = z.object({
  clientId: z.string().uuid(),
  batchId: z.string().uuid(),
  audience: z.enum(['ecole', 'parent']),
  deviceLabel: z.string().max(120).optional().nullable(),
  platform: z.string().max(40).optional().nullable(),
  appVersion: z.string().max(40).optional().nullable(),
  clientCreatedAt: z.string().datetime().optional().nullable(),
  operations: z.array(OperationSchema).min(1).max(500),
});

const PullSchema = z.object({
  clientId: z.string().uuid(),
  audience: z.enum(['ecole', 'parent']),
  /** Curseur : date du dernier changement reçu (ISO) */
  since: z.string().datetime().optional().nullable(),
  entities: z
    .array(z.enum(['attendance', 'student', 'class', 'section', 'announcement', 'request', 'notification', 'calendar', 'school']))
    .optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

/* ==========================================================================
 *  Routes
 * ========================================================================== */

export async function registerSyncRoutes(deps: AppDependencies): Promise<void> {
  const { app, db, audit, guard } = deps;

  const authDeps = {
    db,
    sessions: deps.sessions,
    jwtVerify: (token: string) => app.jwt.verify(token) as Record<string, any>,
  };

  /* ====================================================================== */
  /*  ENREGISTREMENT / MISE À JOUR DU TERMINAL                              */
  /* ====================================================================== */

  /**
   * Déclare le terminal. Appelé au premier démarrage de la PWA.
   * Le terminal est identifié par un UUID qu'il génère lui-même et conserve,
   * ce qui permet de tracer l'origine de chaque présence hors ligne.
   */
  app.post('/api/sync/client', { preHandler: [requireAuth(authDeps)] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = z
      .object({
        clientId: z.string().uuid(),
        audience: z.enum(['ecole', 'parent']),
        label: z.string().trim().min(1).max(120),
        platform: z.string().max(40).optional().nullable(),
        appVersion: z.string().max(40).optional().nullable(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Identification du terminal invalide.');
    }

    if (parsed.data.audience !== auth.identity.audience) {
      return sendError(reply, 403, 'MAUVAISE_INTERFACE', 'Ce terminal ne correspond pas à votre interface.');
    }

    const result = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      // Un parent n'a pas d'école de session : on la retrouve par son lien
      // avec un enfant. Un parent sans enfant rattaché déclare quand même son
      // terminal (sync.clients.school_id nullable depuis 014).
      let schoolId = auth.schoolId ?? null;
      if (!schoolId && auth.identity.audience === 'parent') {
        const liens = await client.query<{ school_id: string }>(
          `SELECT school_id FROM app.parent_student_links
            WHERE parent_id = $1 AND status = 'actif'
            ORDER BY created_at DESC LIMIT 1`,
          [auth.identity.parentId ?? auth.userId],
        );
        schoolId = liens.rows[0]?.school_id ?? null;
      }

      const { rows } = await client.query(
        `INSERT INTO sync.clients
           (id, school_id, audience, staff_user_id, parent_id, label, platform, app_version, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           school_id = coalesce(sync.clients.school_id, EXCLUDED.school_id),
           label = EXCLUDED.label,
           platform = EXCLUDED.platform,
           app_version = EXCLUDED.app_version,
           user_agent = EXCLUDED.user_agent,
           last_seen_at = now()
         RETURNING id, label, last_sync_at, last_pull_cursor, pending_count, is_blocked`,
        [
          parsed.data.clientId,
          schoolId,
          parsed.data.audience,
          auth.identity.staffUserId ?? null,
          auth.identity.parentId ?? null,
          parsed.data.label,
          parsed.data.platform ?? null,
          parsed.data.appVersion ?? null,
          req.headers['user-agent'] ?? null,
        ],
      );
      return rows[0];
    });

    return noStore(reply).send({
      message: 'Terminal enregistré. La synchronisation hors ligne est active.',
      client: result,
      frequenceConseilleeSecondes: 60,
    });
  });

  /* ====================================================================== */
  /*  ENVOI D'UN LOT D'OPÉRATIONS (push)                                    */
  /* ====================================================================== */

  app.post(
    '/api/sync/push',
    { preHandler: [requireAuth(authDeps)] },
    async (req, reply) => {
      const auth = req.auth!;
      const parsed = PushSchema.safeParse(req.body);

      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Lot de synchronisation invalide.', {
          details: parsed.error.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
        });
      }

      const input = parsed.data;
      const ip = clientIp(req);

      if (input.audience !== auth.identity.audience) {
        return sendError(reply, 403, 'MAUVAISE_INTERFACE', 'Interface incohérente avec votre session.');
      }

      if (auth.identity.audience === 'ecole' && !auth.isOwner) {
        // Un lot d'école contient des présences : la permission est exigée.
        const needsAttendance = input.operations.some((o) => o.entityType.startsWith('attendance'));
        if (needsAttendance && !auth.permissions.includes('presences.enregistrer')) {
          return sendError(
            reply,
            403,
            'ACCES_REFUSE',
            'Vous n’avez pas la permission d’enregistrer des présences.',
          );
        }
      }

      const result = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        // Limitation de débit : un terminal légitime synchronise quelques fois
        // par heure, jamais des centaines de fois par minute.
        const quota = await guard.consume(client, 'sync', {
          kind: auth.identity.audience === 'parent' ? 'parent' : 'staff',
          key: auth.userId,
        });
        if (!quota.allowed) {
          const err = new Error('Trop de synchronisations. Patientez un instant.') as Error & {
            statusCode?: number;
            code?: string;
          };
          err.statusCode = 429;
          err.code = 'TROP_DE_SYNCHRONISATIONS';
          throw err;
        }

        // Le terminal doit être connu : on l'enregistre à la volée si besoin
        // (premier envoi avant l'appel d'enregistrement, par exemple).
        await client.query(
          `INSERT INTO sync.clients (id, school_id, audience, staff_user_id, parent_id, label, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (id) DO UPDATE SET last_seen_at = now(),
             pending_count = greatest(0, sync.clients.pending_count - $7)`,
          [
            input.clientId,
            auth.schoolId,
            input.audience,
            auth.identity.staffUserId ?? null,
            auth.identity.parentId ?? null,
            input.deviceLabel ?? 'Terminal inconnu',
            input.operations.length,
          ],
        );

        const blocked = await client.query<{ is_blocked: boolean }>(
          `SELECT is_blocked FROM sync.clients WHERE id = $1`,
          [input.clientId],
        );
        if (blocked.rows[0]?.is_blocked) {
          const err = new Error(
            'Ce terminal a été bloqué par l’administration. Contactez votre direction.',
          ) as Error & { statusCode?: number; code?: string };
          err.statusCode = 403;
          err.code = 'TERMINAL_BLOQUE';
          throw err;
        }

        // Enregistrement du lot
        await client.query(
          `INSERT INTO sync.batches
             (id, school_id, client_id, audience, operation_count, client_created_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (id) DO NOTHING`,
          [
            input.batchId,
            auth.schoolId,
            input.clientId,
            input.audience,
            input.operations.length,
            input.clientCreatedAt ?? null,
          ],
        );

        const applied: { opUuid: string; entityType: string; entityId?: string; deviceId?: string | null }[] = [];
        const duplicates: string[] = [];
        const conflicts: {
          opUuid: string;
          entityType: string;
          entityId: string | null;
          resolution: string;
          message: string;
          serveur?: unknown;
        }[] = [];
        const rejected: { opUuid: string; raison: string }[] = [];

        for (const op of input.operations) {
          // --- Idempotence -------------------------------------------------
          const existing = await client.query<{ status: string }>(
            `SELECT status FROM sync.operations WHERE client_id = $1 AND op_uuid = $2`,
            [input.clientId, op.opUuid],
          );
          if (existing.rows[0]) {
            // L'opération a déjà été traitée : on ne la rejoue pas.
            duplicates.push(op.opUuid);
            if (existing.rows[0].status === 'applied') {
              applied.push({ opUuid: op.opUuid, entityType: op.entityType });
            }
            continue;
          }

          // Journal de l'opération brute, pour la traçabilité
          await client.query(
            `INSERT INTO sync.operations
               (op_uuid, batch_id, client_id, school_id, audience, actor_staff_id, actor_parent_id,
                entity_type, entity_id, op_type, payload, base_version, client_time, device_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
             ON CONFLICT (client_id, op_uuid) DO NOTHING`,
            [
              op.opUuid,
              input.batchId,
              input.clientId,
              auth.schoolId,
              input.audience,
              auth.identity.staffUserId ?? null,
              auth.identity.parentId ?? null,
              op.entityType,
              op.entityId ?? null,
              op.opType,
              JSON.stringify(op.payload),
              op.baseVersion ?? null,
              op.clientTime ?? null,
              op.deviceId ?? null,
            ],
          );

          try {
            const outcome = await applyOperation(client, deps, {
              op,
              auth,
              schoolId: auth.schoolId,
              clientId: input.clientId,
              ip,
              batchId: input.batchId,
            });

            if (outcome.status === 'applied') {
              await client.query(
                `UPDATE sync.operations SET status = 'applied', applied_at = now(),
                        server_version = $3, message = $4, entity_id = coalesce($5, entity_id)
                  WHERE client_id = $1 AND op_uuid = $2`,
                [input.clientId, op.opUuid, outcome.version ?? null, outcome.message ?? null, outcome.entityId ?? null],
              );
              applied.push({
                opUuid: op.opUuid,
                entityType: op.entityType,
                deviceId: op.deviceId ?? input.deviceLabel ?? null,
                ...(outcome.entityId ? { entityId: outcome.entityId } : {}),
              });
            } else if (outcome.status === 'conflict') {
              await client.query(
                `UPDATE sync.operations SET status = 'conflict', message = $3,
                        conflict_detail = $4::jsonb, server_version = $5
                  WHERE client_id = $1 AND op_uuid = $2`,
                [
                  input.clientId,
                  op.opUuid,
                  outcome.message ?? 'Conflit détecté',
                  JSON.stringify({
                    resolution: outcome.resolution,
                    champs: outcome.fieldDiffs ?? [],
                    valeurServeur: outcome.serverValue ?? null,
                    valeurRetenue: outcome.resolvedValue ?? outcome.serverValue ?? null,
                  }),
                  outcome.version ?? null,
                ],
              );

              await client.query(
                `INSERT INTO sync.conflicts
                   (school_id, entity_type, entity_id, client_id, op_uuid, resolution,
                    field_diffs, server_value, client_value, resolved_value)
                 VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb)`,
                [
                  auth.schoolId,
                  op.entityType,
                  outcome.entityId ?? op.entityId ?? null,
                  input.clientId,
                  op.opUuid,
                  outcome.resolution ?? 'serveur_gagne',
                  JSON.stringify(outcome.fieldDiffs ?? []),
                  JSON.stringify(outcome.serverValue ?? {}),
                  JSON.stringify(op.payload ?? {}),
                  JSON.stringify(outcome.resolvedValue ?? outcome.serverValue ?? {}),
                ],
              );

              conflicts.push({
                opUuid: op.opUuid,
                entityType: op.entityType,
                entityId: outcome.entityId ?? op.entityId ?? null,
                resolution: outcome.resolution ?? 'serveur_gagne',
                message: outcome.message ?? 'La version du serveur a été conservée.',
                serveur: outcome.serverValue,
              });
            } else {
              await client.query(
                `UPDATE sync.operations SET status = 'rejected', message = $3
                  WHERE client_id = $1 AND op_uuid = $2`,
                [input.clientId, op.opUuid, outcome.message ?? 'Opération refusée'],
              );
              rejected.push({ opUuid: op.opUuid, raison: outcome.message ?? 'Opération refusée' });
            }
          } catch (err) {
            const message = translateSyncError(err);
            await client.query(
              `UPDATE sync.operations SET status = 'failed', message = $3
                WHERE client_id = $1 AND op_uuid = $2`,
              [input.clientId, op.opUuid, message],
            );
            rejected.push({ opUuid: op.opUuid, raison: message });
          }
        }

        const status =
          rejected.length === 0 && conflicts.length === 0
            ? 'applique'
            : applied.length > 0
              ? 'partiel'
              : 'rejete';

        await client.query(
          `UPDATE sync.batches SET
             applied_count = $2, conflict_count = $3, rejected_count = $4,
             status = $5, processed_at = now(),
             duration_ms = extract(epoch FROM (now() - received_at)) * 1000,
             summary = $6::jsonb
           WHERE id = $1`,
          [
            input.batchId,
            applied.length,
            conflicts.length,
            rejected.length,
            status,
            JSON.stringify({
              doublons: duplicates.length,
              operations: input.operations.length,
            }),
          ],
        );

        await client.query(
          `UPDATE sync.clients SET last_sync_at = now(),
                  pending_count = greatest(0, pending_count - $2)
            WHERE id = $1`,
          [input.clientId, applied.length],
        );

        // Change log : alimente le pull des autres terminaux
        for (const a of applied) {
          await client.query(
            `INSERT INTO sync.change_log
               (school_id, entity_type, entity_id, operation, changed_by_name, device_id)
             SELECT $1::uuid, $2, coalesce($3::uuid, gen_random_uuid()), 'update', $4, $5
              WHERE $3::uuid IS NOT NULL`,
            [auth.schoolId, a.entityType, a.entityId ?? null, auth.displayName, a.deviceId ?? null],
          );
        }

        await audit.write(client, {
          actorKind: auth.identity.audience === 'parent' ? 'parent' : 'staff',
          actorId: auth.userId,
          actorLabel: auth.displayName,
          actorIp: ip,
          actorDevice: input.deviceLabel ?? input.clientId,
          schoolId: auth.schoolId,
        }, {
          action: AUDIT_ACTIONS.ATTENDANCE_SYNCED,
          severity: conflicts.length > 0 || rejected.length > 0 ? 'warning' : 'info',
          result: status === 'rejete' ? 'echec' : 'succes',
          entityType: 'sync_batch',
          entityId: input.batchId,
          payload: {
            operations: input.operations.length,
            appliquees: applied.length,
            doublons: duplicates.length,
            conflits: conflicts.length,
            refusees: rejected.length,
          },
        });

        return {
          batchId: input.batchId,
          status,
          appliquees: applied.length,
          doublons: duplicates.length,
          conflits: conflicts,
          refusees: rejected,
          details: applied,
        };
      });

      const messages: string[] = [];
      if (result.appliquees > 0) messages.push(`${result.appliquees} opération(s) synchronisée(s)`);
      if (result.doublons > 0) messages.push(`${result.doublons} déjà enregistrée(s)`);
      if (result.conflits.length > 0) messages.push(`${result.conflits.length} conflit(s) à vérifier`);
      if (result.refusees.length > 0) messages.push(`${result.refusees.length} refusée(s)`);

      return noStore(reply).send({
        message: messages.length ? messages.join(', ') + '.' : 'Aucune opération à synchroniser.',
        lot: result,
      });
    },
  );

  /* ====================================================================== */
  /*  RÉCUPÉRATION DU DELTA (pull)                                          */
  /* ====================================================================== */

  app.post('/api/sync/pull', { preHandler: [requireAuth(authDeps)] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = PullSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Demande de synchronisation invalide.');
    }

    const input = parsed.data;
    const since = input.since ? new Date(input.since) : new Date('1970-01-01T00:00:00Z');

    const result = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      // Le terminal est identifié et son curseur mis à jour : cela rend la
      // synchronisation reprenable après une coupure au milieu d'un transfert.
      const cursor = await client.query<{ last_pull_cursor: string }>(
        `UPDATE sync.clients
            SET last_seen_at = now(), last_pull_cursor = greatest(last_pull_cursor, $2::timestamptz)
          WHERE id = $1
          RETURNING last_pull_cursor`,
        [input.clientId, since],
      );

      const serverTime = new Date();

      if (auth.identity.audience === 'ecole') {
        // ---------------------------------------------------------------
        //  Delta pour l'administration
        // ---------------------------------------------------------------
        const students = await client.query(
          `SELECT s.id, s.public_code, s.full_name, s.last_name, s.middle_name, s.first_name,
                  s.gender, s.date_of_birth, s.status, s.class_id, s.section_id,
                  s.internal_number, s.photo_url, s.version, s.updated_at,
                  cl.name AS classe, sec.name AS section
             FROM app.students s
             JOIN app.classes cl ON cl.id = s.class_id
             LEFT JOIN app.sections sec ON sec.id = s.section_id
            WHERE s.school_id = $1 AND s.updated_at > $2
            ORDER BY s.updated_at
            LIMIT $3`,
          [auth.schoolId, since, input.limit],
        );

        const classes = await client.query(
          `SELECT cl.id, cl.name, cl.level, cl.max_capacity, cl.is_active, cl.version, cl.updated_at,
                  (SELECT count(*) FROM app.students st
                    WHERE st.class_id = cl.id AND st.status = 'actif')::int AS effectif
             FROM app.classes cl
            WHERE cl.school_id = $1 AND cl.updated_at > $2
            ORDER BY cl.updated_at LIMIT $3`,
          [auth.schoolId, since, input.limit],
        );

        const sections = await client.query(
          `SELECT id, class_id, name, short_code, max_capacity, is_active, version, updated_at
             FROM app.sections
            WHERE school_id = $1 AND updated_at > $2
            ORDER BY updated_at LIMIT $3`,
          [auth.schoolId, since, input.limit],
        );

        const attendance = await client.query(
          `SELECT id, student_id, class_id, section_id, attendance_date, status,
                  arrival_time, departure_time, reason, admin_note,
                  recorded_by_name, method, version, synced_at, updated_at
             FROM app.attendance
            WHERE school_id = $1 AND updated_at > $2
            ORDER BY updated_at LIMIT $3`,
          [auth.schoolId, since, input.limit],
        );

        const announcements = await client.query(
          `SELECT id, reference, title, subject, summary, body_html, kind, is_urgent,
                  status, audience_kind, audience_filter, publish_at, published_at, updated_at
             FROM app.announcements
            WHERE school_id = $1 AND updated_at > $2 AND status <> 'supprime'
            ORDER BY updated_at LIMIT $3`,
          [auth.schoolId, since, input.limit],
        );

        const requests = await client.query(
          `SELECT id, reference, kind, subject, message, status, priority, student_id,
                  absence_date, created_at, updated_at
             FROM app.requests
            WHERE school_id = $1 AND updated_at > $2
            ORDER BY updated_at LIMIT $3`,
          [auth.schoolId, since, input.limit],
        );

        const notifications = await client.query(
          `SELECT id, kind, title, body, severity, entity_type, entity_id, action_url, read_at, created_at
             FROM app.notifications
            WHERE school_id = $1 AND audience = 'ecole' AND created_at > $2
            ORDER BY created_at DESC LIMIT $3`,
          [auth.schoolId, since, input.limit],
        );

        const calendar = await client.query(
          `SELECT id, kind, title, starts_on, ends_on, start_time, location, school_closed, updated_at
             FROM app.calendar_events
            WHERE school_id = $1 AND updated_at > $2
            ORDER BY updated_at LIMIT $3`,
          [auth.schoolId, since, input.limit],
        );

        return {
          curseur: cursor.rows[0]?.last_pull_cursor ?? since.toISOString(),
          heureServeur: serverTime.toISOString(),
          ecole: {
            eleves: students.rows,
            classes: classes.rows,
            sections: sections.rows,
            presences: attendance.rows,
            communiques: announcements.rows,
            demandes: requests.rows,
            notifications: notifications.rows,
            calendrier: calendar.rows,
          },
          termine:
            students.rows.length < input.limit &&
            attendance.rows.length < input.limit &&
            classes.rows.length < input.limit,
        };
      }

      // -----------------------------------------------------------------
      //  Delta pour un parent
      // -----------------------------------------------------------------
      const parentId = auth.userId;

      // Fiches des enfants rattachés : nécessaires à l'affichage hors ligne
      // (liste, contacts, code élève) — le régime de l'école vient via ecoles.
      const students = await client.query(
        `SELECT s.id, s.full_name, s.public_code, s.gender, s.date_of_birth,
                s.photo_url, s.phone_contact, s.email_ecole, s.annee_scolaire,
                s.status, l.relationship, l.status AS lien_statut, l.school_id,
                sch.official_name AS ecole, sch.primary_color,
                cl.name AS classe, sec.name AS section, s.updated_at
           FROM app.parent_student_links l
           JOIN app.students s ON s.id = l.student_id
           LEFT JOIN app.schools sch ON sch.id = l.school_id
           LEFT JOIN app.classes cl ON cl.id = s.class_id
           LEFT JOIN app.sections sec ON sec.id = s.section_id
          WHERE l.parent_id = $1 AND l.status = 'actif' AND s.updated_at > $2
          ORDER BY s.updated_at LIMIT $3`,
        [parentId, since, input.limit],
      );

      const attendance = await client.query(
        `SELECT a.id, a.student_id, a.attendance_date, a.status, a.arrival_time, a.departure_time,
                a.reason, a.updated_at
           FROM app.attendance a
           JOIN app.parent_student_links l ON l.student_id = a.student_id
          WHERE l.parent_id = $1 AND l.status = 'actif' AND a.updated_at > $2
          ORDER BY a.updated_at LIMIT $3`,
        [parentId, since, input.limit],
      );

      const announcements = await client.query(
        `SELECT a.id, a.title, a.subject, a.summary, a.body_html, a.kind, a.is_urgent,
                a.published_at, r.read_at, r.student_id
           FROM app.announcement_recipients r
           JOIN app.announcements a ON a.id = r.announcement_id
          WHERE r.parent_id = $1 AND a.status = 'publie'
            AND greatest(a.updated_at, coalesce(r.read_at, a.updated_at)) > $2
          ORDER BY a.published_at DESC LIMIT $3`,
        [parentId, since, input.limit],
      );

      const notifications = await client.query(
        `SELECT id, kind, title, body, severity, entity_type, entity_id, action_url, read_at, created_at
           FROM app.notifications
          WHERE parent_id = $1 AND audience = 'parent' AND created_at > $2
          ORDER BY created_at DESC LIMIT $3`,
        [parentId, since, input.limit],
      );

      const requests = await client.query(
        `SELECT id, reference, kind, subject, status, updated_at
           FROM app.requests
          WHERE parent_id = $1 AND updated_at > $2
          ORDER BY updated_at LIMIT $3`,
        [parentId, since, input.limit],
      );

      const calendar = await client.query(
        `SELECT e.id, e.kind, e.title, e.starts_on, e.ends_on, e.start_time, e.location,
                e.school_closed, e.school_id, e.updated_at
           FROM app.calendar_events e
          WHERE e.is_published AND e.school_id IN (
                  SELECT DISTINCT school_id FROM app.parent_student_links
                   WHERE parent_id = $1 AND status = 'actif')
            AND e.updated_at > $2
          ORDER BY e.starts_on LIMIT $3`,
        [parentId, since, input.limit],
      );

      // Régime d'activité des écoles rattachées : le parent doit savoir quels
      // jours sont scolaires (lundi → vendredi ou lundi → samedi) — le régime
      // suit la même synchronisation incrémentale que le reste.
      const ecoles = await client.query(
        `SELECT s.id, s.official_name, s.activity_days, s.updated_at
           FROM app.schools s
          WHERE s.id IN (SELECT DISTINCT school_id FROM app.parent_student_links
                          WHERE parent_id = $1 AND status = 'actif')
            AND s.updated_at > $2
          ORDER BY s.updated_at LIMIT $3`,
        [parentId, since, input.limit],
      );

      return {
        curseur: cursor.rows[0]?.last_pull_cursor ?? since.toISOString(),
        heureServeur: serverTime.toISOString(),
        parent: {
          eleves: students.rows,
          presences: attendance.rows,
          communiques: announcements.rows,
          notifications: notifications.rows,
          demandes: requests.rows,
          calendrier: calendar.rows,
          ecoles: ecoles.rows,
        },
        termine:
          students.rows.length < input.limit &&
          attendance.rows.length < input.limit &&
          ecoles.rows.length < input.limit,
      };
    });

    return noStore(reply).send(result);
  });

  /* ====================================================================== */
  /*  ÉTAT DE LA SYNCHRONISATION                                            */
  /* ====================================================================== */

  app.get('/api/sync/etat', { preHandler: [requireAuth(authDeps)] }, async (req, reply) => {
    const auth = req.auth!;
    const clientId = String((req.query as any)?.clientId ?? '');

    const state = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const clients = await client.query(
        `SELECT id, label, platform, app_version, last_seen_at, last_sync_at,
                last_pull_cursor, pending_count, is_blocked
           FROM sync.clients
          WHERE ($1::uuid IS NULL OR id = $1)
            AND (($2::uuid IS NOT NULL AND school_id = $2)
                 OR ($3::uuid IS NOT NULL AND parent_id = $3))
          ORDER BY last_seen_at DESC LIMIT 20`,
        [clientId || null, auth.schoolId, auth.identity.parentId ?? null],
      );

      const pending = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM sync.operations
          WHERE status IN ('pending','conflict','failed')
            AND (($1::uuid IS NOT NULL AND school_id = $1)
                 OR ($2::uuid IS NOT NULL AND actor_parent_id = $2))`,
        [auth.schoolId, auth.identity.parentId ?? null],
      );

      const openConflicts = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM sync.conflicts
          WHERE resolved_at IS NULL AND school_id = $1`,
        [auth.schoolId],
      );

      return {
        terminaux: clients.rows,
        operationsEnAttente: pending.rows[0]?.n ?? 0,
        conflitsNonResolus: openConflicts.rows[0]?.n ?? 0,
      };
    });

    return noStore(reply).send({
      ...state,
      conseil:
        state.operationsEnAttente > 0
          ? 'Des opérations enregistrées hors ligne attendent d’être envoyées. Laissez l’application ouverte avec une connexion active.'
          : 'Tout est synchronisé.',
    });
  });

  /* ====================================================================== */
  /*  CONFLITS (administration)                                             */
  /* ====================================================================== */

  app.get(
    '/api/ecole/sync/conflits',
    { preHandler: [requireAuth(authDeps), requireAudience('ecole'), requirePermission('presences.consulter')] },
    async (req, reply) => {
      const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const { rows } = await client.query(
          `SELECT c.id, c.entity_type, c.entity_id, c.resolution, c.field_diffs,
                  c.server_value, c.client_value, c.resolved_value, c.detected_at, c.resolved_at,
                  cl.label AS terminal
             FROM sync.conflicts c
             LEFT JOIN sync.clients cl ON cl.id = c.client_id
            WHERE c.school_id = $1
            ORDER BY c.detected_at DESC LIMIT 200`,
          [req.auth!.schoolId],
        );
        return rows;
      });

      return noStore(reply).send({
        conflits: rows,
        regle:
          'En cas de modification simultanée sur deux appareils, la version enregistrée sur le serveur ' +
          'est conservée ; les deux valeurs restent consultables ici. Aucune donnée n’est écrasée en silence.',
      });
    },
  );

  /** Résolution manuelle d'un conflit par l'administration. */
  app.post(
    '/api/ecole/sync/conflits/:id/resoudre',
    { preHandler: [requireAuth(authDeps), requireAudience('ecole'), requirePermission('presences.modifier')] },
    async (req, reply) => {
      const schoolId = req.auth!.schoolId!;
      const id = Number((req.params as any).id);

      const parsed = z
        .object({ choix: z.enum(['serveur', 'terminal']), note: z.string().max(1000).optional().nullable() })
        .safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Choix de résolution invalide.');
      }

      const result = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const conflict = await client.query<{
          id: string;
          entity_type: string;
          entity_id: string | null;
          server_value: any;
          client_value: any;
        }>(
          `SELECT id, entity_type, entity_id, server_value, client_value
             FROM sync.conflicts
            WHERE id = $1 AND school_id = $2 AND resolved_at IS NULL
            FOR UPDATE`,
          [id, schoolId],
        );

        const row = conflict.rows[0];
        if (!row) {
          const err = new Error('Conflit introuvable ou déjà résolu.') as Error & {
            statusCode?: number;
            code?: string;
          };
          err.statusCode = 404;
          err.code = 'CONFLIT_INTROUVABLE';
          throw err;
        }

        // Application de la version retenue sur la présence concernée
        if (row.entity_type.startsWith('attendance') && row.entity_id) {
          const source = parsed.data.choix === 'terminal' ? row.client_value : row.server_value;
          if (source && typeof source === 'object') {
            await client.query(
              `UPDATE app.attendance SET
                 status = coalesce($3::app.attendance_status, status),
                 arrival_time = coalesce($4::time, arrival_time),
                 reason = coalesce($5, reason),
                 admin_note = coalesce($6, admin_note),
                 recorded_offline_at = coalesce(recorded_offline_at, now())
               WHERE id = $1 AND school_id = $2`,
              [
                row.entity_id,
                schoolId,
                (source as any).status ?? null,
                (source as any).arrivalTime ?? null,
                (source as any).reason ?? null,
                parsed.data.note ?? 'Conflit résolu manuellement',
              ],
            );
          }
        }

        await client.query(
          `UPDATE sync.conflicts SET
             resolution = $3, resolved_at = now(), resolved_by_name = $4, resolved_value = $5::jsonb
           WHERE id = $1 AND school_id = $2`,
          [
            id,
            schoolId,
            parsed.data.choix === 'terminal' ? 'terminal_gagne' : 'serveur_gagne',
            req.auth!.displayName,
            JSON.stringify(parsed.data.choix === 'terminal' ? row.client_value : row.server_value),
          ],
        );

        await audit.write(client, {
          actorKind: 'staff',
          actorId: req.auth!.userId,
          actorLabel: req.auth!.displayName,
          actorIp: clientIp(req),
          schoolId,
        }, {
          action: 'sync.conflit_resolu',
          severity: 'notice',
          result: 'succes',
          entityType: row.entity_type,
          entityId: row.entity_id,
          payload: { choix: parsed.data.choix, note: parsed.data.note },
        });

        return { ok: true };
      });

      return noStore(reply).send({
        message:
          parsed.data.choix === 'terminal'
            ? 'La version de l’appareil a été retenue.'
            : 'La version du serveur a été conservée.',
        ...result,
      });
    },
  );

  /* ====================================================================== */
  /*  PURGE DES DONNÉES ANCIENNES (tâche planifiée)                         */
  /* ====================================================================== */

  app.post(
    '/api/ecole/sync/purge',
    { preHandler: [requireAuth(authDeps), requireAudience('ecole')] },
    async (req, reply) => {
      if (!req.auth!.isOwner) {
        return sendError(reply, 403, 'ACCES_REFUSE', 'Seule la direction peut lancer une purge.');
      }
      const keepDays = Math.min(3650, Math.max(7, Number((req.body as any)?.jours ?? 90)));

      const results = await db.withTransaction(async (client) => {
        const { rows } = await client.query(`SELECT * FROM sync.purge_old($1)`, [keepDays]);
        return rows;
      });

      return noStore(reply).send({
        message: `Purge effectuée : les données de synchronisation de plus de ${keepDays} jours ont été supprimées.`,
        suppressions: results,
      });
    },
  );
}

/* ==========================================================================
 *  Application d'une opération hors ligne
 * ========================================================================== */

type ApplyOutcome =
  | { status: 'applied'; entityId?: string; version?: number; message?: string }
  | {
      status: 'conflict';
      entityId?: string;
      version?: number;
      message: string;
      resolution: 'serveur_gagne' | 'terminal_gagne' | 'fusion' | 'reporte';
      fieldDiffs?: unknown;
      serverValue?: unknown;
      resolvedValue?: unknown;
    }
  | { status: 'rejected'; message: string };

async function applyOperation(
  client: PoolClient,
  deps: AppDependencies,
  ctx: {
    op: z.infer<typeof OperationSchema>;
    auth: NonNullable<import('fastify').FastifyRequest['auth']>;
    schoolId: string | null;
    clientId: string;
    ip: string | null;
    batchId: string;
  },
): Promise<ApplyOutcome> {
  const { op, auth, schoolId } = ctx;
  const payload = op.payload as Record<string, any>;

  switch (op.entityType) {
    /* ==================================================================== */
    /*  Présences hors ligne — le cas le plus important                     */
    /* ==================================================================== */
    case 'attendance':
    case 'attendance.bulk': {
      const entries: any[] = Array.isArray(payload.entries)
        ? payload.entries
        : [
            {
              studentId: payload.studentId ?? op.entityId,
              status: payload.status,
              arrivalTime: payload.arrivalTime,
              departureTime: payload.departureTime,
              reason: payload.reason,
              adminNote: payload.adminNote,
              attendanceDate: payload.attendanceDate ?? payload.date,
            },
          ];

      if (entries.length === 0) {
        return { status: 'rejected', message: 'Aucune présence dans l’opération.' };
      }
      if (!schoolId) {
        return { status: 'rejected', message: 'Aucune école associée à cet appareil.' };
      }

      const appliedIds: string[] = [];
      let lastVersion = 0;

      // Jours non scolaires ou fermés déjà vérifiés dans ce lot (le régime et
      // le calendrier ne changent pas pendant la reprise d'un lot).
      const etatsJours = new Map<string, Awaited<ReturnType<typeof lireEtatJour>>>();
      const forcer = payload.forcer === true;

      for (const entry of entries) {
        const studentId = String(entry.studentId ?? '').trim();
        const date = String(entry.attendanceDate ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
        const status = String(entry.status ?? '').trim();

        if (!studentId || !status) {
          return { status: 'rejected', message: 'Élève ou statut de présence manquant.' };
        }
        if (!['present', 'absent', 'retard', 'depart_anticipe', 'non_enregistre'].includes(status)) {
          return { status: 'rejected', message: `Statut de présence inconnu : ${status}` };
        }
        if (status === 'retard' && !entry.arrivalTime) {
          return {
            status: 'rejected',
            message: 'Un retard doit comporter une heure d’arrivée.',
          };
        }

        // Jour non scolaire ou école fermée : aucune absence ne peut être
        // comptée, même en reprise hors ligne — sauf ouverture exceptionnelle.
        if (!forcer) {
          let etat = etatsJours.get(date);
          if (!etat) {
            etat = await lireEtatJour(client, schoolId, date);
            etatsJours.set(date, etat);
          }
          if (etat.ferme) {
            return { status: 'rejected', message: `${libelleFermeture(etat)} — appel désactivé.` };
          }
        }

        // L'élève doit appartenir à l'école de l'appareil : c'est la garantie
        // qu'un terminal compromis ne peut pas écrire chez une autre école.
        const student = await client.query<{
          id: string;
          class_id: string;
          section_id: string | null;
          school_id: string;
        }>(
          `SELECT id, class_id, section_id, school_id FROM app.students
            WHERE id = $1 AND school_id = $2`,
          [studentId, schoolId],
        );

        const found = student.rows[0];
        if (!found) {
          return { status: 'rejected', message: `Élève ${studentId} introuvable dans cet établissement.` };
        }

        // Détection de conflit : le terminal connaît-il la bonne version ?
        const current = await client.query<{
          id: string;
          version: number;
          status: string;
          arrival_time: string | null;
          recorded_at: string;
          method: string;
        }>(
          `SELECT id, version, status, arrival_time, recorded_at, method
             FROM app.attendance
            WHERE student_id = $1 AND attendance_date = $2::date`,
          [studentId, date],
        );

        const existing = current.rows[0];

        if (
          existing &&
          op.baseVersion != null &&
          existing.version !== op.baseVersion &&
          // Un enregistrement hors ligne est plus récent que la version connue :
          // c'est un vrai conflit, on ne l'écrase pas en silence.
          existing.method !== 'sync_offline'
        ) {
          return {
            status: 'conflict',
            entityId: existing.id,
            version: existing.version,
            message:
              `Présence du ${date} déjà modifiée sur le serveur (version ${existing.version}). ` +
              'La version du serveur est conservée ; le conflit est enregistré pour vérification.',
            resolution: 'serveur_gagne',
            serverValue: {
              status: existing.status,
              arrivalTime: existing.arrival_time,
              version: existing.version,
              recordedAt: existing.recorded_at,
            },
            fieldDiffs: [
              {
                champ: 'status',
                serveur: existing.status,
                terminal: status,
              },
              {
                champ: 'arrivalTime',
                serveur: existing.arrival_time,
                terminal: entry.arrivalTime ?? null,
              },
            ],
            resolvedValue: { status: existing.status, arrivalTime: existing.arrival_time },
          };
        }

        const { rows } = await client.query<{ id: string; version: number }>(
          `INSERT INTO app.attendance
             (school_id, student_id, class_id, section_id, attendance_date, status,
              arrival_time, departure_time, reason, admin_note,
              recorded_by, recorded_by_name, method, device_id,
              client_uuid, recorded_offline_at, synced_at)
           VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,$12,'sync_offline',$13,
                   $14,$15, now())
           ON CONFLICT (student_id, attendance_date) DO UPDATE SET
             status = EXCLUDED.status,
             arrival_time = EXCLUDED.arrival_time,
             departure_time = EXCLUDED.departure_time,
             reason = EXCLUDED.reason,
             admin_note = EXCLUDED.admin_note,
             method = 'sync_offline',
             device_id = EXCLUDED.device_id,
             recorded_offline_at = EXCLUDED.recorded_offline_at,
             synced_at = now()
           RETURNING id, version`,
          [
            schoolId,
            studentId,
            found.class_id,
            found.section_id,
            date,
            status,
            entry.arrivalTime ?? null,
            entry.departureTime ?? null,
            entry.reason ?? null,
            entry.adminNote ?? 'Enregistré hors ligne puis synchronisé',
            auth.userId,
            auth.displayName,
            ctx.clientId,
            // client_uuid unique par opération : garantit qu'un rejeu ne
            // duplique pas l'enregistrement, même au niveau de la table.
            op.opUuid,
            op.clientTime ? new Date(op.clientTime) : null,
          ],
        );

        appliedIds.push(rows[0]!.id);
        lastVersion = rows[0]!.version;
      }

      return {
        status: 'applied',
        entityId: appliedIds[0],
        version: lastVersion,
        message: `${appliedIds.length} présence(s) enregistrée(s)`,
      };
    }

    /* ==================================================================== */
    /*  Demandes créées hors ligne par un parent                            */
    /* ==================================================================== */
    case 'request': {
      if (auth.identity.audience !== 'parent') {
        return { status: 'rejected', message: 'Seul un parent peut créer une demande.' };
      }

      const studentId = payload.studentId ? String(payload.studentId) : null;
      const subject = String(payload.subject ?? '').slice(0, 200);
      const message = String(payload.message ?? '').slice(0, 8000);
      const kind = String(payload.kind ?? 'reclamation');

      if (!subject || !message) {
        return { status: 'rejected', message: 'Objet ou message de la demande manquant.' };
      }

      // Le parent doit être rattaché à l'élève concerné
      let parentSchoolId: string | null = null;
      if (studentId) {
        const link = await client.query<{ school_id: string }>(
          `SELECT school_id FROM app.parent_student_links
            WHERE parent_id = $1 AND student_id = $2 AND status = 'actif'`,
          [auth.userId, studentId],
        );
        if (!link.rows[0]) {
          return { status: 'rejected', message: 'Accès refusé à cet élève.' };
        }
        parentSchoolId = link.rows[0].school_id;
      } else {
        const link = await client.query<{ school_id: string }>(
          `SELECT school_id FROM app.parent_student_links
            WHERE parent_id = $1 AND status = 'actif' LIMIT 1`,
          [auth.userId],
        );
        parentSchoolId = link.rows[0]?.school_id ?? null;
      }

      if (!parentSchoolId) {
        return { status: 'rejected', message: 'Aucun enfant connecté à ce compte.' };
      }

      const seq = await client.query<{ ref: string }>(
        `SELECT app.nouvelle_reference_demande($1) AS ref`,
        [parentSchoolId],
      );
      const reference = seq.rows[0]?.ref ?? `DEM/${new Date().getFullYear()}/0001`;

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO app.requests
           (school_id, reference, parent_id, student_id, kind, subject, message,
            absence_date, absence_reason, client_uuid, created_at)
         VALUES ($1,$2,$3,$4,$5::app.request_kind,$6,$7,$8::date,$9,$10,$11)
         ON CONFLICT (client_uuid) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [
          parentSchoolId,
          reference,
          auth.userId,
          studentId,
          kind,
          subject,
          message,
          payload.absenceDate ?? null,
          payload.absenceReason ?? null,
          op.opUuid,
          // La date réelle de création côté terminal est conservée
          op.clientTime ? new Date(op.clientTime) : new Date(),
        ],
      );

      await client.query(
        `INSERT INTO app.request_messages (request_id, author_type, author_id, author_name, body, created_at)
         VALUES ($1,'parent',$2,$3,$4,$5)`,
        [
          rows[0]!.id,
          auth.userId,
          auth.displayName,
          message,
          op.clientTime ? new Date(op.clientTime) : new Date(),
        ],
      );

      return { status: 'applied', entityId: rows[0]!.id, message: 'Demande transmise' };
    }

    case 'request.message': {
      if (auth.identity.audience !== 'parent') {
        return { status: 'rejected', message: 'Interface inadaptée.' };
      }
      const requestId = String(payload.requestId ?? op.entityId ?? '');
      if (!requestId) return { status: 'rejected', message: 'Demande cible manquante.' };

      const owned = await client.query(
        `SELECT 1 FROM app.requests WHERE id = $1 AND parent_id = $2`,
        [requestId, auth.userId],
      );
      if (!owned.rows[0]) {
        return { status: 'rejected', message: 'Demande introuvable.' };
      }

      await client.query(
        `INSERT INTO app.request_messages (request_id, author_type, author_id, author_name, body, created_at)
         VALUES ($1,'parent',$2,$3,$4,$5)`,
        [
          requestId,
          auth.userId,
          auth.displayName,
          String(payload.message ?? '').slice(0, 8000),
          op.clientTime ? new Date(op.clientTime) : new Date(),
        ],
      );
      return { status: 'applied', entityId: requestId };
    }

    /* ==================================================================== */
    /*  Brouillon de communiqué (administration)                            */
    /* ==================================================================== */
    case 'announcement.draft': {
      if (auth.identity.audience !== 'ecole') {
        return { status: 'rejected', message: 'Interface inadaptée.' };
      }
      if (!auth.isOwner && !auth.permissions.includes('communiques.creer')) {
        return { status: 'rejected', message: 'Permission manquante pour créer un communiqué.' };
      }

      const title = String(payload.title ?? '').trim().slice(0, 200);
      if (!title) return { status: 'rejected', message: 'Titre du communiqué manquant.' };

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO app.announcements
           (school_id, title, subject, summary, body_html, kind, status, created_by, created_by_name)
         VALUES ($1,$2,$3,$4,$5,coalesce($6,'communique')::app.announcement_kind,'brouillon',$7,$8)
         RETURNING id`,
        [
          schoolId,
          title,
          payload.subject ?? null,
          payload.summary ?? null,
          String(payload.bodyHtml ?? ''),
          payload.kind ?? null,
          auth.userId,
          auth.displayName,
        ],
      );
      return { status: 'applied', entityId: rows[0]!.id, message: 'Brouillon enregistré' };
    }

    /* ==================================================================== */
    /*  Accusé de lecture d'une notification                                */
    /* ==================================================================== */
    case 'notification.read': {
      const ids: string[] = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
      if (ids.length === 0) return { status: 'rejected', message: 'Aucune notification indiquée.' };

      await client.query(
        `UPDATE app.notifications SET read_at = now()
          WHERE id = ANY($1::uuid[])
            AND (parent_id = $2 OR ($3::uuid IS NOT NULL AND school_id = $3 AND audience = 'ecole'))
            AND read_at IS NULL`,
        [ids, auth.identity.parentId ?? null, schoolId],
      );
      return { status: 'applied', message: 'Notifications marquées comme lues' };
    }

    default:
      return { status: 'rejected', message: `Type d’opération non pris en charge : ${op.entityType}` };
  }
}

/** Traduit une erreur inattendue en message exploitable par le terminal. */
function translateSyncError(err: unknown): string {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e.code === '23505') {
    if (e.constraint?.includes('att_unique_day')) {
      return 'Une présence existe déjà pour cet élève à cette date.';
    }
    return 'Cet enregistrement existe déjà.';
  }
  if (e.code === '23503') return 'Référence invalide : l’élément a peut-être été supprimé.';
  if (e.code === '23514') return 'Valeur refusée par une règle métier (vérifiez les heures et le statut).';
  if (e.code === '42501') return 'Accès refusé pour cette opération.';
  return 'Opération refusée par le serveur.';
}
