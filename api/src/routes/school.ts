/**
 * ============================================================================
 *  MWANA CLASSE — Interface École (administration)
 * ============================================================================
 *  Chaque route :
 *    - exige une session école valide ;
 *    - vérifie une permission côté serveur (jamais uniquement dans Angular) ;
 *    - s'exécute dans une transaction portant l'identité de l'école, ce qui
 *      active l'isolation par établissement au niveau PostgreSQL ;
 *    - journalise l'action dans le journal d'audit.
 * ============================================================================
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDependencies } from '../app.js';
import {
  clientIp,
  dbIdentityFrom,
  requireAudience,
  requireAuth,
  requirePermission,
  requireSchool,
  sendError,
  noStore,
  runAudited,
  type QueryableClient,
} from '../http/middleware.js';
import { AUDIT_ACTIONS } from '../security/audit.js';

/* ==========================================================================
 *  Schémas
 * ========================================================================== */

const uuid = z.string().uuid('Identifiant invalide.');
const optionalUuid = z.string().uuid().optional().nullable();
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();

const ClassSchema = z.object({
  name: z.string().trim().min(1).max(80),
  level: optionalText(80),
  levelOrder: z.coerce.number().int().min(0).max(1000).optional().nullable(),
  maxCapacity: z.coerce.number().int().min(1).max(1000),
  room: optionalText(80),
  notes: optionalText(2000),
  promotionTargetId: optionalUuid,
  forceCapacity: z.boolean().optional(),
});

const SectionSchema = z.object({
  classId: uuid,
  name: z.string().trim().min(1).max(80),
  shortCode: optionalText(12),
  maxCapacity: z.coerce.number().int().min(1).max(1000).optional().nullable(),
  notes: optionalText(1000),
});

const StudentSchema = z.object({
  lastName: z.string().trim().min(1).max(80),
  middleName: optionalText(80),
  firstName: z.string().trim().min(1).max(80),
  gender: z.enum(['M', 'F']).optional().nullable(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date au format AAAA-MM-JJ.')
    .optional()
    .nullable(),
  placeOfBirth: optionalText(120),
  classId: uuid,
  sectionId: optionalUuid,
  internalNumber: optionalText(40),
  photoUrl: optionalText(500),
  medicalNotes: optionalText(4000),
  guardianPhone: optionalText(32),
  address: optionalText(300),
  extraInfo: z.record(z.string(), z.unknown()).optional(),
});

const AttendanceEntrySchema = z.object({
  studentId: uuid,
  status: z.enum(['present', 'absent', 'retard', 'depart_anticipe', 'non_enregistre']),
  arrivalTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable(),
  departureTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable(),
  reason: optionalText(500),
  adminNote: optionalText(1000),
});

const AttendanceBulkSchema = z.object({
  classId: uuid,
  sectionId: optionalUuid,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z
    .enum(['manuel_classe', 'tout_present', 'qr_code', 'tablette_entree', 'import_fichier', 'sync_offline'])
    .default('manuel_classe'),
  entries: z.array(AttendanceEntrySchema).min(1).max(2000),
  /** Identifiant du terminal : utilisé pour la traçabilité hors ligne */
  deviceId: optionalText(120),
});

const AnnouncementSchema = z.object({
  title: z.string().trim().min(1).max(200),
  subject: optionalText(200),
  summary: optionalText(600),
  bodyHtml: z.string().min(1).max(200_000),
  kind: z
    .enum([
      'communique', 'note_parents', 'rappel', 'annonce', 'invitation',
      'urgent', 'changement_horaire', 'reunion', 'calendrier', 'administratif',
    ])
    .default('communique'),
  isUrgent: z.boolean().default(false),
  templateId: optionalUuid,
  reference: optionalText(60),
  audienceKind: z.enum(['toute_ecole', 'niveau', 'classe', 'section', 'eleve', 'custom']).default('toute_ecole'),
  audienceFilter: z
    .object({
      levels: z.array(z.string()).optional(),
      classIds: z.array(uuid).optional(),
      sectionIds: z.array(uuid).optional(),
      studentIds: z.array(uuid).optional(),
    })
    .default({}),
  publishAt: z.string().datetime().optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable(),
  action: z.enum(['brouillon', 'publier', 'programmer']).default('brouillon'),
});

const LinkDecisionSchema = z.object({
  decision: z.enum(['approuver', 'refuser', 'revoquer']),
  note: optionalText(1000),
});

/* ==========================================================================
 *  Routes
 * ========================================================================== */

export async function registerSchoolRoutes(deps: AppDependencies): Promise<void> {
  const { app, db, audit, config } = deps;

  const authDeps = {
    db,
    sessions: deps.sessions,
    jwtVerify: (token: string) => app.jwt.verify(token) as Record<string, any>,
  };

  /** Pré-handlers communs à toute l'interface école. */
  const guard = [requireAuth(authDeps), requireAudience('ecole')];

  /* ====================================================================== */
  /*  TABLEAU DE BORD                                                       */
  /* ====================================================================== */

  app.get('/api/ecole/tableau-de-bord', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);

    const data = await runAudited(
      { db, audit },
      req,
        { action: 'ecole.tableau_de_bord.consulte', entityType: 'school', entityId: () => schoolId },
        async (_req: FastifyRequest, c: QueryableClient) => {
          const today = await c.query(
            `SELECT
               (SELECT count(*) FROM app.students WHERE school_id = $1 AND status = 'actif')::int AS eleves_total,
               (SELECT count(*) FROM app.classes  WHERE school_id = $1 AND is_active)::int      AS classes_total,
               (SELECT count(*) FROM app.sections s JOIN app.classes cl ON cl.id = s.class_id
                 WHERE s.school_id = $1 AND s.is_active)::int                                    AS sections_total,
               (SELECT count(*) FROM app.attendance
                 WHERE school_id = $1 AND attendance_date = CURRENT_DATE AND status = 'present')::int  AS presents,
               (SELECT count(*) FROM app.attendance
                 WHERE school_id = $1 AND attendance_date = CURRENT_DATE AND status = 'absent')::int   AS absents,
               (SELECT count(*) FROM app.attendance
                 WHERE school_id = $1 AND attendance_date = CURRENT_DATE AND status = 'retard')::int   AS retards,
               (SELECT count(*) FROM app.attendance
                 WHERE school_id = $1 AND attendance_date = CURRENT_DATE AND status = 'depart_anticipe')::int AS departs,
               (SELECT count(*) FROM app.attendance
                 WHERE school_id = $1 AND attendance_date = CURRENT_DATE AND status = 'non_enregistre')::int AS non_enregistres`,
            [schoolId],
          );

          const unrecorded = await c.query(
            `SELECT cl.id AS class_id, cl.name AS class_name,
                    count(s.id)::int AS eleves_sans_presence
               FROM app.classes cl
               JOIN app.students s ON s.class_id = cl.id AND s.status = 'actif'
               LEFT JOIN app.attendance a
                 ON a.student_id = s.id AND a.attendance_date = CURRENT_DATE
              WHERE cl.school_id = $1 AND cl.is_active
                AND (a.id IS NULL OR a.status = 'non_enregistre')
              GROUP BY cl.id, cl.name
              HAVING count(s.id) > 0
              ORDER BY count(s.id) DESC`,
            [schoolId],
          );

          const capacity = await c.query(
            `SELECT class_name, effectif, max_capacity, places_disponibles, etat_capacite, taux_occupation
               FROM app.v_class_occupancy
              WHERE school_id = $1 AND is_active
              ORDER BY taux_occupation DESC NULLS LAST
              LIMIT 10`,
            [schoolId],
          );

          const announcements = await c.query(
            `SELECT
               (SELECT count(*) FROM app.announcements WHERE school_id = $1 AND status = 'publie')::int    AS publies,
               (SELECT count(*) FROM app.announcements WHERE school_id = $1 AND status = 'brouillon')::int AS brouillons,
               (SELECT count(*) FROM app.announcements WHERE school_id = $1 AND status = 'programme')::int AS programmes`,
            [schoolId],
          );

          const requests = await c.query(
            `SELECT
               (SELECT count(*) FROM app.requests WHERE school_id = $1 AND status = 'en_attente')::int AS en_attente,
               (SELECT count(*) FROM app.requests WHERE school_id = $1 AND status = 'en_cours')::int   AS en_cours`,
            [schoolId],
          );

          const pendingLinks = await c.query(
            `SELECT count(*)::int AS en_attente
               FROM app.parent_student_links WHERE school_id = $1 AND status = 'en_attente'`,
            [schoolId],
          );

          const recentActivity = await c.query(
            `SELECT h.id, h.changed_at, h.new_status, h.old_status,
                    st.full_name AS eleve, cl.name AS classe,
                    h.changed_by_name AS par, h.change_source AS source
               FROM app.attendance_history h
               JOIN app.students st ON st.id = h.student_id
               LEFT JOIN app.classes cl ON cl.id = st.class_id
              WHERE h.school_id = $1
              ORDER BY h.changed_at DESC
              LIMIT 12`,
            [schoolId],
          );

          const recentStudents = await c.query(
            `SELECT s.id, s.full_name, s.public_code, s.created_at,
                    cl.name AS classe, sec.name AS section
               FROM app.students s
               JOIN app.classes cl ON cl.id = s.class_id
               LEFT JOIN app.sections sec ON sec.id = s.section_id
              WHERE s.school_id = $1
              ORDER BY s.created_at DESC
              LIMIT 8`,
            [schoolId],
          );

          const recentAnnouncements = await c.query(
            `SELECT a.id, a.title, a.kind, a.is_urgent, a.published_at, a.status, a.created_by_name,
                    (SELECT count(*) FROM app.announcement_recipients r
                      WHERE r.announcement_id = a.id AND r.read_at IS NULL)::int AS non_lus,
                    (SELECT count(*) FROM app.announcement_recipients r
                      WHERE r.announcement_id = a.id)::int AS destinataires
               FROM app.announcements a
              WHERE a.school_id = $1 AND a.status <> 'supprime'
              ORDER BY coalesce(a.published_at, a.created_at) DESC
              LIMIT 6`,
            [schoolId],
          );

          const monthly = await c.query(
            `SELECT to_char(attendance_date, 'YYYY-MM') AS mois,
                    count(*) FILTER (WHERE status = 'present')::int AS presents,
                    count(*) FILTER (WHERE status = 'absent')::int  AS absents,
                    count(*) FILTER (WHERE status = 'retard')::int  AS retards
               FROM app.attendance
              WHERE school_id = $1
                AND attendance_date >= CURRENT_DATE - INTERVAL '30 days'
                AND status <> 'non_enregistre'
              GROUP BY 1 ORDER BY 1`,
            [schoolId],
          );

          const stats = today.rows[0];

          return {
            eleves: {
              total: stats.eleves_total,
              presentsAujourdhui: stats.presents,
              absentsAujourdhui: stats.absents,
              retardsAujourdhui: stats.retards,
              departsAnticipesAujourdhui: stats.departs,
              presencesNonEnregistrees: stats.non_enregistres,
            },
            classes: {
              total: stats.classes_total,
              sections: stats.sections_total,
              occupation: capacity.rows,
              classesProchesCapacite: capacity.rows.filter(
                (c: any) => c.etat_capacite === 'presque_complete' || c.etat_capacite === 'complete',
              ).length,
            },
            presences: {
              presents: stats.presents,
              absents: stats.absents,
              retards: stats.retards,
              nonEnregistres: stats.non_enregistres,
              classesSansPresence: unrecorded.rows,
              tendance30Jours: monthly.rows,
            },
            communiques: {
              publies: announcements.rows[0].publies,
              brouillons: announcements.rows[0].brouillons,
              programmes: announcements.rows[0].programmes,
              derniers: recentAnnouncements.rows,
            },
            demandes: {
              enAttente: requests.rows[0].en_attente,
              enCours: requests.rows[0].en_cours,
            },
            parents: { liaisonsAValider: pendingLinks.rows[0].en_attente },
            activite: {
              dernieresPresences: recentActivity.rows,
              derniersEleves: recentStudents.rows,
            },
          };
        },
    );

    return noStore(reply).send(data);
  });

  /* ====================================================================== */
  /*  RECHERCHE GLOBALE                                                     */
  /* ====================================================================== */

  app.get('/api/ecole/recherche', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const q = String((req.query as any)?.q ?? '').trim();
    const limit = Math.min(20, Math.max(1, Number((req.query as any)?.limit ?? 8)));

    if (q.length < 2) {
      return noStore(reply).send({ eleves: [], classes: [], sections: [], communiques: [], parents: [], demandes: [] });
    }

    const result = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const key = q.toLowerCase();

      const students = await client.query(
        `SELECT s.id, s.full_name, s.public_code, s.status,
                cl.name AS classe, sec.name AS section
           FROM app.students s
           JOIN app.classes cl ON cl.id = s.class_id
           LEFT JOIN app.sections sec ON sec.id = s.section_id
          WHERE s.school_id = $1
            AND (s.search_name LIKE '%' || $2 || '%' OR s.public_code ILIKE '%' || $2 || '%')
          ORDER BY s.status = 'actif' DESC, s.full_name
          LIMIT $3`,
        [schoolId, key, limit],
      );

      const classes = await client.query(
        `SELECT cl.id, cl.name, cl.level, o.effectif, o.max_capacity, o.places_disponibles, o.etat_capacite
           FROM app.classes cl
           JOIN app.v_class_occupancy o ON o.class_id = cl.id
          WHERE cl.school_id = $1 AND app.search_key(cl.name) LIKE '%' || $2 || '%'
          ORDER BY cl.level_order NULLS LAST, cl.name
          LIMIT $3`,
        [schoolId, key, limit],
      );

      const sections = await client.query(
        `SELECT s.id, s.name, s.short_code, cl.name AS classe
           FROM app.sections s JOIN app.classes cl ON cl.id = s.class_id
          WHERE s.school_id = $1 AND app.search_key(s.name) LIKE '%' || $2 || '%'
          LIMIT $3`,
        [schoolId, key, limit],
      );

      const announcements = await client.query(
        `SELECT id, title, kind, is_urgent, status, published_at
           FROM app.announcements
          WHERE school_id = $1 AND status <> 'supprime'
            AND app.search_key(title) LIKE '%' || $2 || '%'
          ORDER BY coalesce(published_at, created_at) DESC
          LIMIT $3`,
        [schoolId, key, limit],
      );

      const parents = await client.query(
        `SELECT DISTINCT p.id, p.full_name, p.email, p.phone,
                (SELECT count(*) FROM app.parent_student_links l
                  WHERE l.parent_id = p.id AND l.status = 'actif')::int AS enfants
           FROM app.parents p
           JOIN app.parent_student_links l2 ON l2.parent_id = p.id AND l2.school_id = $1
          WHERE app.search_key(p.full_name) LIKE '%' || $2 || '%'
             OR coalesce(p.email::text,'') ILIKE '%' || $2 || '%'
          LIMIT $3`,
        [schoolId, key, limit],
      );

      const requests = await client.query(
        `SELECT r.id, r.reference, r.subject, r.kind, r.status, r.created_at
           FROM app.requests r
          WHERE r.school_id = $1 AND app.search_key(r.subject) LIKE '%' || $2 || '%'
          ORDER BY r.created_at DESC
          LIMIT $3`,
        [schoolId, key, limit],
      );

      return {
        eleves: students.rows,
        classes: classes.rows,
        sections: sections.rows,
        communiques: announcements.rows,
        parents: parents.rows,
        demandes: requests.rows,
      };
    });

    return noStore(reply).send(result);
  });

  /* ====================================================================== */
  /*  CLASSES                                                               */
  /* ====================================================================== */

  app.get('/api/ecole/classes', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const includeInactive = (req.query as any)?.inactives === 'true';

    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT o.class_id AS id, o.class_name AS name, o.level, o.max_capacity, o.effectif,
                o.places_disponibles, o.etat_capacite, o.taux_occupation, o.is_active,
                cl.room, cl.notes, cl.level_order, cl.promotion_target_id,
                ay.id AS academic_year_id, ay.label AS annee_scolaire, ay.is_current,
                (SELECT count(*) FROM app.sections s WHERE s.class_id = cl.id AND s.is_active)::int AS sections,
                (SELECT coalesce(json_agg(json_build_object(
                          'id', s.id, 'name', s.name, 'shortCode', s.short_code,
                          'maxCapacity', s.max_capacity,
                          'effectif', (SELECT count(*) FROM app.students st
                                        WHERE st.section_id = s.id AND st.status = 'actif')
                        ) ORDER BY s.name), '[]'::json)
                   FROM app.sections s WHERE s.class_id = cl.id AND s.is_active) AS sections_detail
           FROM app.classes cl
           JOIN app.v_class_occupancy o ON o.class_id = cl.id
           JOIN app.academic_years ay ON ay.id = cl.academic_year_id
          WHERE cl.school_id = $1 AND ($2::boolean OR cl.is_active)
          ORDER BY cl.level_order NULLS LAST, cl.name`,
        [schoolId, includeInactive],
      );
      return rows;
    });

    return noStore(reply).send({ classes: rows });
  });

  app.post(
    '/api/ecole/classes',
    { preHandler: [...guard, requirePermission('classes.gerer')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const parsed = ClassSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Formulaire de classe incomplet.', {
          details: parsed.error.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
        });
      }

      const created = await runAudited(
        { db, audit },
        req,
          {
            action: 'classe.creation',
            entityType: 'class',
            entityId: (_r, result: any) => result?.id ?? null,
            payload: (r) => ({ nom: parsed.data.name, capacite: parsed.data.maxCapacity }),
          },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const year = await c.query<{ id: string }>(
              `SELECT id FROM app.academic_years
                WHERE school_id = $1 AND is_current AND NOT is_archived LIMIT 1`,
              [schoolId],
            );
            if (!year.rows[0]) {
              const err = new Error(
                'Aucune année scolaire active. Configurez d’abord l’année scolaire dans les paramètres.',
              ) as Error & { statusCode?: number; code?: string };
              err.statusCode = 409;
              err.code = 'ANNEE_SCOLAIRE_ABSENTE';
              throw err;
            }

            const { rows } = await c.query(
              `INSERT INTO app.classes
                 (school_id, academic_year_id, name, level, level_order, max_capacity, room, notes, promotion_target_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               RETURNING id, name, max_capacity`,
              [
                schoolId,
                year.rows[0].id,
                parsed.data.name,
                parsed.data.level ?? null,
                parsed.data.levelOrder ?? null,
                parsed.data.maxCapacity,
                parsed.data.room ?? null,
                parsed.data.notes ?? null,
                parsed.data.promotionTargetId ?? null,
              ],
            );
            return rows[0];
          },
      );

      return noStore(reply).code(201).send({
        message: `Classe « ${created.name} » créée avec une capacité de ${created.max_capacity} élèves.`,
        classe: created,
      });
    },
  );

  app.patch(
    '/api/ecole/classes/:id',
    { preHandler: [...guard, requirePermission('classes.gerer')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const classId = String((req.params as any).id);

      const parsed = ClassSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Modification invalide.');
      }

      const result = await runAudited(
        { db, audit },
        req,
          {
            action: 'classe.modification',
            entityType: 'class',
            entityId: () => classId,
            severity: parsed.data.maxCapacity !== undefined ? 'notice' : 'info',
            payload: () => parsed.data as Record<string, unknown>,
          },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const current = await c.query<{
              id: string;
              name: string;
              max_capacity: number;
              effectif: number;
            }>(
              `SELECT cl.id, cl.name, cl.max_capacity,
                      (SELECT count(*) FROM app.students s
                        WHERE s.class_id = cl.id AND s.status = 'actif')::int AS effectif
                 FROM app.classes cl
                WHERE cl.id = $1 AND cl.school_id = $2
                FOR UPDATE`,
              [classId, schoolId],
            );

            const row = current.rows[0];
            if (!row) {
              const err = new Error('Classe introuvable.') as Error & { statusCode?: number; code?: string };
              err.statusCode = 404;
              err.code = 'CLASSE_INTROUVABLE';
              throw err;
            }

            // Cohérence de capacité : refuser une capacité inférieure à
            // l'effectif réel sans confirmation explicite, pour ne jamais
            // laisser une classe en incohérence.
            if (
              parsed.data.maxCapacity !== undefined &&
              parsed.data.maxCapacity < row.effectif &&
              !parsed.data.forceCapacity
            ) {
              const err = new Error(
                `Cette classe contient déjà ${row.effectif} élèves. ` +
                  `Une capacité de ${parsed.data.maxCapacity} est inférieure à l’effectif. ` +
                  'Confirmez explicitement pour continuer.',
              ) as Error & { statusCode?: number; code?: string; details?: unknown };
              err.statusCode = 409;
              err.code = 'CAPACITE_INCOHERENTE';
              (err as any).details = { effectif: row.effectif, capaciteDemandee: parsed.data.maxCapacity };
              throw err;
            }

            const { rows } = await c.query(
              `UPDATE app.classes SET
                 name = coalesce($3, name),
                 level = coalesce($4, level),
                 level_order = coalesce($5, level_order),
                 max_capacity = coalesce($6, max_capacity),
                 room = coalesce($7, room),
                 notes = coalesce($8, notes),
                 promotion_target_id = coalesce($9, promotion_target_id)
               WHERE id = $1 AND school_id = $2
               RETURNING id, name, max_capacity, is_active`,
              [
                classId,
                schoolId,
                parsed.data.name ?? null,
                parsed.data.level ?? null,
                parsed.data.levelOrder ?? null,
                parsed.data.maxCapacity ?? null,
                parsed.data.room ?? null,
                parsed.data.notes ?? null,
                parsed.data.promotionTargetId ?? null,
              ],
            );

            return { ...rows[0], effectif: row.effectif, capacitePrecedente: row.max_capacity };
          },
      );

      const places = Math.max(0, result.max_capacity - result.effectif);
      return noStore(reply).send({
        message:
          result.capacitePrecedente !== result.max_capacity
            ? `Capacité modifiée : ${result.capacitePrecedente} → ${result.max_capacity} élèves. ` +
              `${result.effectif} élèves inscrits, ${places} place(s) disponible(s).`
            : 'Classe mise à jour.',
        classe: result,
      });
    },
  );

  /* ====================================================================== */
  /*  SECTIONS                                                              */
  /* ====================================================================== */

  app.post(
    '/api/ecole/sections',
    { preHandler: [...guard, requirePermission('sections.gerer')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const parsed = SectionSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Formulaire de section incomplet.');
      }

      const created = await runAudited(
        { db, audit },
        req,
          { action: 'section.creation', entityType: 'section', entityId: (_r, res: any) => res?.id ?? null },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const klass = await c.query(`SELECT 1 FROM app.classes WHERE id = $1 AND school_id = $2`, [
              parsed.data.classId,
              schoolId,
            ]);
            if ((klass.rowCount ?? 0) === 0) {
              const err = new Error('Classe introuvable dans votre établissement.') as Error & {
                statusCode?: number;
                code?: string;
              };
              err.statusCode = 404;
              err.code = 'CLASSE_INTROUVABLE';
              throw err;
            }

            const { rows } = await c.query(
              `INSERT INTO app.sections (school_id, class_id, name, short_code, max_capacity, notes)
               VALUES ($1,$2,$3,$4,$5,$6)
               RETURNING id, name, short_code, max_capacity`,
              [
                schoolId,
                parsed.data.classId,
                parsed.data.name,
                parsed.data.shortCode ?? null,
                parsed.data.maxCapacity ?? null,
                parsed.data.notes ?? null,
              ],
            );
            return rows[0];
          },
      );

      return noStore(reply).code(201).send({ message: `Section « ${created.name} » créée.`, section: created });
    },
  );

  app.patch(
    '/api/ecole/sections/:id',
    { preHandler: [...guard, requirePermission('sections.gerer')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const sectionId = String((req.params as any).id);
      const parsed = SectionSchema.partial().omit({ classId: true }).safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Modification invalide.');
      }

      const updated = await runAudited(
        { db, audit },
        req,
          { action: 'section.modification', entityType: 'section', entityId: () => sectionId },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const { rows } = await c.query(
              `UPDATE app.sections SET
                 name = coalesce($3, name),
                 short_code = coalesce($4, short_code),
                 max_capacity = coalesce($5, max_capacity),
                 notes = coalesce($6, notes)
               WHERE id = $1 AND school_id = $2
               RETURNING id, name, short_code, max_capacity`,
              [
                sectionId,
                schoolId,
                parsed.data.name ?? null,
                parsed.data.shortCode ?? null,
                parsed.data.maxCapacity ?? null,
                parsed.data.notes ?? null,
              ],
            );
            if (!rows[0]) {
              const err = new Error('Section introuvable.') as Error & { statusCode?: number; code?: string };
              err.statusCode = 404;
              err.code = 'SECTION_INTROUVABLE';
              throw err;
            }
            return rows[0];
          },
      );

      return noStore(reply).send({ message: 'Section mise à jour.', section: updated });
    },
  );

  /* ====================================================================== */
  /*  ÉLÈVES                                                                */
  /* ====================================================================== */

  app.get('/api/ecole/eleves', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const q = (req.query as any) ?? {};
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    const offset = Math.max(0, Number(q.offset ?? 0));
    const status = typeof q.statut === 'string' ? q.statut : 'actif';

    const result = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT s.id, s.public_code, s.last_name, s.middle_name, s.first_name, s.full_name,
                s.gender, s.date_of_birth, s.status, s.photo_url, s.internal_number,
                s.created_at,
                cl.id AS class_id, cl.name AS classe, cl.academic_year_id,
                sec.id AS section_id, sec.name AS section,
                (SELECT count(*) FROM app.parent_student_links l
                  WHERE l.student_id = s.id AND l.status = 'actif')::int AS parents_connectes,
                (SELECT a.status FROM app.attendance a
                  WHERE a.student_id = s.id AND a.attendance_date = CURRENT_DATE) AS presence_aujourdhui
           FROM app.students s
           JOIN app.classes cl ON cl.id = s.class_id
           LEFT JOIN app.sections sec ON sec.id = s.section_id
          WHERE s.school_id = $1
            AND ($2::text IS NULL OR s.status = $2)
            AND ($3::uuid IS NULL OR s.class_id = $3)
            AND ($4::uuid IS NULL OR s.section_id = $4)
            AND ($5::text IS NULL OR s.search_name LIKE '%' || $5 || '%'
                 OR s.public_code ILIKE '%' || $5 || '%')
          ORDER BY cl.level_order NULLS LAST, cl.name, sec.name NULLS FIRST, s.full_name
          LIMIT $6 OFFSET $7`,
        [
          schoolId,
          status === 'tous' ? null : status,
          q.classeId ?? null,
          q.sectionId ?? null,
          q.recherche ? String(q.recherche).toLowerCase() : null,
          limit,
          offset,
        ],
      );

      const total = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM app.students s
          WHERE s.school_id = $1
            AND ($2::text IS NULL OR s.status = $2)
            AND ($3::uuid IS NULL OR s.class_id = $3)
            AND ($4::uuid IS NULL OR s.section_id = $4)
            AND ($5::text IS NULL OR s.search_name LIKE '%' || $5 || '%'
                 OR s.public_code ILIKE '%' || $5 || '%')`,
        [
          schoolId,
          status === 'tous' ? null : status,
          q.classeId ?? null,
          q.sectionId ?? null,
          q.recherche ? String(q.recherche).toLowerCase() : null,
        ],
      );

      return { eleves: rows, total: Number(total.rows[0]?.n ?? 0), limit, offset };
    });

    return noStore(reply).send(result);
  });

  app.get('/api/ecole/eleves/:id', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const studentId = String((req.params as any).id);

    const data = await runAudited(
      { db, audit },
      req,
        {
          action: AUDIT_ACTIONS.STUDENT_SENSITIVE_VIEWED,
          entityType: 'student',
          entityId: () => studentId,
          severity: 'notice',
        },
        async (_req: FastifyRequest, c: QueryableClient) => {
          const { rows } = await c.query(
            `SELECT s.id, s.public_code, s.last_name, s.middle_name, s.first_name, s.full_name,
                    s.gender, s.date_of_birth, s.place_of_birth, s.status, s.photo_url,
                    s.internal_number, s.extra_info, s.enrolled_on, s.created_at, s.version,
                    cl.id AS class_id, cl.name AS classe, cl.max_capacity,
                    sec.id AS section_id, sec.name AS section,
                    ay.id AS academic_year_id, ay.label AS annee_scolaire
               FROM app.students s
               JOIN app.classes cl ON cl.id = s.class_id
               LEFT JOIN app.sections sec ON sec.id = s.section_id
               JOIN app.academic_years ay ON ay.id = s.academic_year_id
              WHERE s.id = $1 AND s.school_id = $2`,
            [studentId, schoolId],
          );

          const student = rows[0];
          if (!student) {
            const err = new Error('Élève introuvable.') as Error & { statusCode?: number; code?: string };
            err.statusCode = 404;
            err.code = 'ELEVE_INTROUVABLE';
            throw err;
          }

          // Données chiffrées : déchiffrées uniquement à la demande explicite.
          const sensitive = await c.query<{
            medical_notes_enc: Buffer | null;
            guardian_phone_enc: Buffer | null;
            address_enc: Buffer | null;
          }>(
            `SELECT medical_notes_enc, guardian_phone_enc, address_enc
               FROM app.students WHERE id = $1`,
            [studentId],
          );

          const { decryptField } = await import('../security/secrets.js');
          const s = sensitive.rows[0];

          const links = await c.query(
            `SELECT l.id, l.status, l.relationship, l.is_primary, l.requested_at, l.decided_at,
                    p.id AS parent_id, p.full_name, p.email, p.phone
               FROM app.parent_student_links l
               JOIN app.parents p ON p.id = l.parent_id
              WHERE l.student_id = $1 AND l.school_id = $2
              ORDER BY l.status = 'actif' DESC, l.requested_at`,
            [studentId, schoolId],
          );

          const summary = await c.query(
            `SELECT to_char(attendance_date, 'YYYY-MM') AS mois,
                    count(*) FILTER (WHERE status = 'present')::int AS presents,
                    count(*) FILTER (WHERE status = 'absent')::int  AS absents,
                    count(*) FILTER (WHERE status = 'retard')::int  AS retards
               FROM app.attendance
              WHERE student_id = $1 AND school_id = $2
                AND attendance_date >= CURRENT_DATE - INTERVAL '90 days'
              GROUP BY 1 ORDER BY 1 DESC`,
            [studentId, schoolId],
          );

          const recent = await c.query(
            `SELECT attendance_date, status, arrival_time, departure_time, reason,
                    recorded_by_name, method
               FROM app.attendance
              WHERE student_id = $1 AND school_id = $2
              ORDER BY attendance_date DESC LIMIT 30`,
            [studentId, schoolId],
          );

          return {
            eleve: {
              ...student,
              notesMedicales: decryptField(s?.medical_notes_enc, deps.secrets, `student:${studentId}:medical`),
              telephoneTuteur: decryptField(s?.guardian_phone_enc, deps.secrets, `student:${studentId}:phone`),
              adresse: decryptField(s?.address_enc, deps.secrets, `student:${studentId}:address`),
            },
            parents: links.rows,
            historique: { resumeMensuel: summary.rows, dernieres: recent.rows },
          };
        },
    );

    return noStore(reply).send(data);
  });

  app.post(
    '/api/ecole/eleves',
    { preHandler: [...guard, requirePermission('eleves.creer')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const parsed = StudentSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Formulaire d’élève incomplet.', {
          details: parsed.error.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
        });
      }
      const input = parsed.data;

      const created = await runAudited(
        { db, audit },
        req,
          {
            action: AUDIT_ACTIONS.STUDENT_CREATED,
            entityType: 'student',
            entityId: (_r, res: any) => res?.id ?? null,
            payload: (r) => ({ nom: input.lastName, prenom: input.firstName, classe: input.classId }),
          },
          async (_req: FastifyRequest, c: QueryableClient) => {
            // La classe doit appartenir à l'école : aucune écriture croisée.
            const klass = await c.query<{
              id: string;
              name: string;
              academic_year_id: string;
              max_capacity: number;
              effectif: number;
            }>(
              `SELECT cl.id, cl.name, cl.academic_year_id, cl.max_capacity,
                      (SELECT count(*) FROM app.students s
                        WHERE s.class_id = cl.id AND s.status = 'actif')::int AS effectif
                 FROM app.classes cl
                WHERE cl.id = $1 AND cl.school_id = $2 AND cl.is_active`,
              [input.classId, schoolId],
            );
            const klassRow = klass.rows[0];
            if (!klassRow) {
              const err = new Error('Classe introuvable ou inactive.') as Error & {
                statusCode?: number;
                code?: string;
              };
              err.statusCode = 404;
              err.code = 'CLASSE_INTROUVABLE';
              throw err;
            }

            // Avertissement de capacité : l'administration reste maîtresse de
            // sa décision, mais elle est informée d'un dépassement.
            const depassement = klassRow.effectif >= klassRow.max_capacity;

            if (input.sectionId) {
              const sectionOk = await c.query(
                `SELECT 1 FROM app.sections WHERE id = $1 AND class_id = $2 AND school_id = $3 AND is_active`,
                [input.sectionId, input.classId, schoolId],
              );
              if ((sectionOk.rowCount ?? 0) === 0) {
                const err = new Error(
                  'La section indiquée n’appartient pas à cette classe.',
                ) as Error & { statusCode?: number; code?: string };
                err.statusCode = 400;
                err.code = 'SECTION_INVALIDE';
                throw err;
              }
            }

            // Code élève unique : généré par la base, vérifié en cas de collision
            let publicCode = '';
            for (let attempt = 0; attempt < 12; attempt++) {
              const candidate = (
                await c.query<{ code: string }>(`SELECT app.format_student_code(app.random_code(6)) AS code`)
              ).rows[0]!.code;
              const clash = await c.query(`SELECT 1 FROM app.students WHERE public_code = $1`, [candidate]);
              if ((clash.rowCount ?? 0) === 0) {
                publicCode = candidate;
                break;
              }
            }
            if (!publicCode) {
              throw new Error('Impossible de générer un code élève unique. Réessayez.');
            }

            // Champs sensibles chiffrés avant insertion
            const { encryptField } = await import('../security/secrets.js');
            const tempId = (
              await c.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)
            ).rows[0]!.id;

            const { rows } = await c.query(
              `INSERT INTO app.students
                 (id, school_id, public_code, academic_year_id, class_id, section_id,
                  last_name, middle_name, first_name, gender, date_of_birth, place_of_birth,
                  photo_url, internal_number, extra_info,
                  medical_notes_enc, guardian_phone_enc, address_enc)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
               RETURNING id, public_code, full_name, class_id, section_id, created_at`,
              [
                tempId,
                schoolId,
                publicCode,
                klassRow.academic_year_id,
                input.classId,
                input.sectionId ?? null,
                input.lastName,
                input.middleName ?? null,
                input.firstName,
                input.gender ?? null,
                input.dateOfBirth ?? null,
                input.placeOfBirth ?? null,
                input.photoUrl ?? null,
                input.internalNumber ?? null,
                JSON.stringify(input.extraInfo ?? {}),
                encryptField(input.medicalNotes ?? null, deps.secrets, `student:${tempId}:medical`),
                encryptField(input.guardianPhone ?? null, deps.secrets, `student:${tempId}:phone`),
                encryptField(input.address ?? null, deps.secrets, `student:${tempId}:address`),
              ],
            );

            return { ...rows[0], classe: klassRow.name, depassementCapacite: depassement };
          },
      );

      return noStore(reply).code(201).send({
        message:
          `Élève enregistré. Code unique : ${created.public_code}. ` +
          'Communiquez ce code au parent pour qu’il connecte son enfant.',
        eleve: created,
        avertissement: created.depassementCapacite
          ? 'Attention : cette classe a atteint ou dépassé sa capacité maximale.'
          : null,
      });
    },
  );

  app.patch(
    '/api/ecole/eleves/:id',
    { preHandler: [...guard, requirePermission('eleves.modifier')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const studentId = String((req.params as any).id);
      const parsed = StudentSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Modification invalide.');
      }
      const input = parsed.data;

      const updated = await runAudited(
        { db, audit },
        req,
          {
            action: AUDIT_ACTIONS.STUDENT_UPDATED,
            entityType: 'student',
            entityId: () => studentId,
            severity: input.classId ? 'notice' : 'info',
            payload: () => ({ champs: Object.keys(input) }),
          },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const before = await c.query<{ class_id: string; section_id: string | null }>(
              `SELECT class_id, section_id FROM app.students WHERE id = $1 AND school_id = $2 FOR UPDATE`,
              [studentId, schoolId],
            );
            if (!before.rows[0]) {
              const err = new Error('Élève introuvable.') as Error & { statusCode?: number; code?: string };
              err.statusCode = 404;
              err.code = 'ELEVE_INTROUVABLE';
              throw err;
            }

            const classChanged = input.classId && input.classId !== before.rows[0].class_id;

            const { encryptField } = await import('../security/secrets.js');
            const { rows } = await c.query(
              `UPDATE app.students SET
                 last_name = coalesce($3, last_name),
                 middle_name = coalesce($4, middle_name),
                 first_name = coalesce($5, first_name),
                 gender = coalesce($6, gender),
                 date_of_birth = coalesce($7, date_of_birth),
                 place_of_birth = coalesce($8, place_of_birth),
                 photo_url = coalesce($9, photo_url),
                 internal_number = coalesce($10, internal_number),
                 class_id = coalesce($11, class_id),
                 section_id = coalesce($12, section_id),
                 extra_info = coalesce($13::jsonb, extra_info),
                 medical_notes_enc = coalesce($14, medical_notes_enc),
                 guardian_phone_enc = coalesce($15, guardian_phone_enc),
                 address_enc = coalesce($16, address_enc)
               WHERE id = $1 AND school_id = $2
               RETURNING id, public_code, full_name, class_id, section_id`,
              [
                studentId,
                schoolId,
                input.lastName ?? null,
                input.middleName ?? null,
                input.firstName ?? null,
                input.gender ?? null,
                input.dateOfBirth ?? null,
                input.placeOfBirth ?? null,
                input.photoUrl ?? null,
                input.internalNumber ?? null,
                input.classId ?? null,
                input.sectionId ?? null,
                input.extraInfo ? JSON.stringify(input.extraInfo) : null,
                encryptField(input.medicalNotes ?? null, deps.secrets, `student:${studentId}:medical`),
                encryptField(input.guardianPhone ?? null, deps.secrets, `student:${studentId}:phone`),
                encryptField(input.address ?? null, deps.secrets, `student:${studentId}:address`),
              ],
            );

            if (classChanged) {
              await audit.write(c, {
                actorKind: 'staff',
                actorId: req.auth?.userId ?? null,
                actorLabel: req.auth?.displayName ?? null,
                actorIp: clientIp(req),
                schoolId,
              }, {
                action: AUDIT_ACTIONS.STUDENT_CLASS_CHANGED,
                severity: 'notice',
                result: 'succes',
                entityType: 'student',
                entityId: studentId,
                payload: {
                  ancienneClasse: before.rows[0].class_id,
                  nouvelleClasse: input.classId,
                },
              });
            }

            return rows[0];
          },
      );

      return noStore(reply).send({ message: 'Fiche élève mise à jour.', eleve: updated });
    },
  );

  app.post(
    '/api/ecole/eleves/:id/archiver',
    { preHandler: [...guard, requirePermission('eleves.archiver')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const studentId = String((req.params as any).id);
      const motif = z.object({ motif: optionalText(500) }).safeParse(req.body ?? {});

      const result = await runAudited(
        { db, audit },
        req,
          {
            action: AUDIT_ACTIONS.STUDENT_ARCHIVED,
            entityType: 'student',
            entityId: () => studentId,
            severity: 'warning',
            payload: () => ({ motif: motif.success ? motif.data.motif : null }),
          },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const { rows } = await c.query(
              `UPDATE app.students
                  SET status = 'archive', archived_at = now()
                WHERE id = $1 AND school_id = $2 AND status <> 'archive'
                RETURNING id, full_name, public_code`,
              [studentId, schoolId],
            );
            if (!rows[0]) {
              const err = new Error('Élève introuvable ou déjà archivé.') as Error & {
                statusCode?: number;
                code?: string;
              };
              err.statusCode = 404;
              err.code = 'ELEVE_INTROUVABLE';
              throw err;
            }
            return rows[0];
          },
      );

      return noStore(reply).send({
        message: `${result.full_name} a été archivé. Son historique de présence est conservé.`,
        eleve: result,
      });
    },
  );

  app.post(
    '/api/ecole/eleves/:id/reactiver',
    { preHandler: [...guard, requirePermission('eleves.modifier')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const studentId = String((req.params as any).id);

      const result = await runAudited(
        { db, audit },
        req,
          { action: 'eleve.reactivation', entityType: 'student', entityId: () => studentId },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const { rows } = await c.query(
              `UPDATE app.students SET status = 'actif', archived_at = NULL
                WHERE id = $1 AND school_id = $2
                RETURNING id, full_name, public_code`,
              [studentId, schoolId],
            );
            if (!rows[0]) {
              const err = new Error('Élève introuvable.') as Error & { statusCode?: number; code?: string };
              err.statusCode = 404;
              err.code = 'ELEVE_INTROUVABLE';
              throw err;
            }
            return rows[0];
          },
      );

      return noStore(reply).send({ message: `${result.full_name} a été réactivé.`, eleve: result });
    },
  );

  /* ---------------------------------------------------------------------- */
  /*  Fiche / carte élève (code + QR)                                       */
  /* ---------------------------------------------------------------------- */

  app.get('/api/ecole/eleves/:id/fiche', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const studentId = String((req.params as any).id);

    const fiche = await runAudited(
      { db, audit },
      req,
        { action: AUDIT_ACTIONS.STUDENT_CARD_PRINTED, entityType: 'student', entityId: () => studentId },
        async (_req: FastifyRequest, c: QueryableClient) => {
          const { rows } = await c.query(
            `SELECT s.full_name, s.public_code, s.gender, s.date_of_birth,
                    cl.name AS classe, sec.name AS section,
                    sch.official_name AS ecole,
                    sch.logo_url, sch.primary_color, sch.address_line, sch.city, sch.phone_contact
               FROM app.students s
               JOIN app.classes cl ON cl.id = s.class_id
               LEFT JOIN app.sections sec ON sec.id = s.section_id
               JOIN app.schools sch ON sch.id = s.school_id
              WHERE s.id = $1 AND s.school_id = $2`,
            [studentId, schoolId],
          );
          if (!rows[0]) {
            const err = new Error('Élève introuvable.') as Error & { statusCode?: number; code?: string };
            err.statusCode = 404;
            err.code = 'ELEVE_INTROUVABLE';
            throw err;
          }

          // QR code du code unique de l'élève : le parent scanne au lieu de taper.
          const QRCode = (await import('qrcode')).default;
          const payload = JSON.stringify({
            l: rows[0].public_code,
            n: rows[0].full_name,
          });
          const qrDataUrl = await QRCode.toDataURL(payload, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 320,
          });

          return { ...rows[0], qrCode: qrDataUrl };
        },
    );

    return noStore(reply).send({ fiche });
  });

  /* ====================================================================== */
  /*  PRÉSENCES                                                             */
  /* ====================================================================== */

  /** Feuille de présence d'une classe à une date donnée. */
  app.get('/api/ecole/presences', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const q = (req.query as any) ?? {};
    const date = typeof q.date === 'string' ? q.date : new Date().toISOString().slice(0, 10);
    const classId = q.classeId ?? null;
    const sectionId = q.sectionId ?? null;

    const data = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT s.id AS student_id, s.public_code, s.full_name, s.gender, s.photo_url,
                cl.id AS class_id, cl.name AS classe,
                sec.id AS section_id, sec.name AS section,
                coalesce(a.status, 'non_enregistre') AS status,
                a.arrival_time, a.departure_time, a.reason, a.admin_note,
                a.recorded_by_name, a.method, a.recorded_at, a.recorded_offline_at,
                a.version, a.id AS attendance_id
           FROM app.students s
           JOIN app.classes cl ON cl.id = s.class_id
           LEFT JOIN app.sections sec ON sec.id = s.section_id
           LEFT JOIN app.attendance a ON a.student_id = s.id AND a.attendance_date = $2::date
          WHERE s.school_id = $1 AND s.status = 'actif'
            AND ($3::uuid IS NULL OR s.class_id = $3)
            AND ($4::uuid IS NULL OR s.section_id = $4)
          ORDER BY cl.level_order NULLS LAST, cl.name, sec.name NULLS FIRST, s.full_name`,
        [schoolId, date, classId, sectionId],
      );

      const recap = {
        date,
        total: rows.length,
        presents: rows.filter((r: any) => r.status === 'present').length,
        absents: rows.filter((r: any) => r.status === 'absent').length,
        retards: rows.filter((r: any) => r.status === 'retard').length,
        departs: rows.filter((r: any) => r.status === 'depart_anticipe').length,
        nonEnregistres: rows.filter((r: any) => r.status === 'non_enregistre').length,
      };

      return { eleves: rows, recap };
    });

    // L'administration peut enregistrer hors ligne : la feuille est mise en
    // cache par le service worker côté Angular, pas par le navigateur.
    return reply
      .header('ETag', `"${data.recap.total}-${data.recap.date}"`)
      .send(data);
  });

  /** Enregistrement rapide d'un lot de présences (fonctionne hors ligne). */
  app.post(
    '/api/ecole/presences',
    { preHandler: [...guard, requirePermission('presences.enregistrer')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const parsed = AttendanceBulkSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Feuille de présence invalide.', {
          details: parsed.error.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
        });
      }
      const input = parsed.data;

      const result = await runAudited(
        { db, audit },
        req,
          {
            action: AUDIT_ACTIONS.ATTENDANCE_BULK,
            entityType: 'class',
            entityId: () => input.classId,
            payload: () => ({
              date: input.date,
              methode: input.method,
              nombre: input.entries.length,
            }),
          },
          async (_req: FastifyRequest, c: QueryableClient) => {
            // Toutes les écritures de présence de la feuille partagent une
            // transaction : soit la feuille entière est enregistrée, soit rien.
            const applied: { studentId: string; status: string; version: number }[] = [];
            const rejected: { studentId: string; raison: string }[] = [];

            for (const entry of input.entries) {
              // L'élève doit appartenir à l'école et à la classe annoncée.
              const check = await c.query<{ id: string; class_id: string; section_id: string | null }>(
                `SELECT id, class_id, section_id FROM app.students
                  WHERE id = $1 AND school_id = $2 AND status <> 'archive'`,
                [entry.studentId, schoolId],
              );
              const student = check.rows[0];
              if (!student) {
                rejected.push({ studentId: entry.studentId, raison: 'Élève introuvable dans cet établissement.' });
                continue;
              }
              if (student.class_id !== input.classId) {
                rejected.push({ studentId: entry.studentId, raison: 'Élève inscrit dans une autre classe.' });
                continue;
              }

              // Un retard sans heure d'arrivée violerait la contrainte métier :
              // on refuse explicitement plutôt que de laisser la base échouer.
              if (entry.status === 'retard' && !entry.arrivalTime) {
                rejected.push({
                  studentId: entry.studentId,
                  raison: 'Un retard doit comporter une heure d’arrivée.',
                });
                continue;
              }

              const { rows } = await c.query(
                `INSERT INTO app.attendance
                   (school_id, student_id, class_id, section_id, attendance_date, status,
                    arrival_time, departure_time, reason, admin_note,
                    recorded_by, recorded_by_name, method, device_id,
                    recorded_offline_at)
                 VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
                 ON CONFLICT (student_id, attendance_date) DO UPDATE SET
                   status = EXCLUDED.status,
                   arrival_time = EXCLUDED.arrival_time,
                   departure_time = EXCLUDED.departure_time,
                   reason = EXCLUDED.reason,
                   admin_note = EXCLUDED.admin_note,
                   recorded_by = EXCLUDED.recorded_by,
                   recorded_by_name = EXCLUDED.recorded_by_name,
                   method = EXCLUDED.method,
                   device_id = EXCLUDED.device_id,
                   synced_at = now()
                 RETURNING student_id, status, version`,
                [
                  schoolId,
                  entry.studentId,
                  input.classId,
                  student.section_id,
                  input.date,
                  entry.status,
                  entry.arrivalTime ?? null,
                  entry.departureTime ?? null,
                  entry.reason ?? null,
                  entry.adminNote ?? null,
                  req.auth?.userId ?? null,
                  req.auth?.displayName ?? null,
                  input.method,
                  input.deviceId ?? null,
                  new Date(),
                ],
              );
              applied.push({
                studentId: rows[0].student_id,
                status: rows[0].status,
                version: rows[0].version,
              });
            }

            return { applied, rejected, date: input.date, classId: input.classId };
          },
      );

      const presents = result.applied.filter((a) => a.status === 'present').length;
      return noStore(reply).send({
        message:
          `${result.applied.length} présence(s) enregistrée(s)` +
          (result.rejected.length > 0 ? `, ${result.rejected.length} refusée(s).` : '.'),
        enregistrees: result.applied.length,
        refusees: result.rejected,
        details: { presents, date: result.date },
      });
    },
  );

  /** Tableau de bord statistique des présences. */
  app.get('/api/ecole/presences/statistiques', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const q = (req.query as any) ?? {};
    const from = typeof q.du === 'string' ? q.du : new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const to = typeof q.au === 'string' ? q.au : new Date().toISOString().slice(0, 10);

    const stats = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const global = await client.query(
        `SELECT count(*) FILTER (WHERE status <> 'non_enregistre')::int AS enregistrees,
                count(*) FILTER (WHERE status = 'present')::int         AS presents,
                count(*) FILTER (WHERE status = 'absent')::int          AS absents,
                count(*) FILTER (WHERE status = 'retard')::int          AS retards,
                count(*) FILTER (WHERE status = 'depart_anticipe')::int AS departs,
                round(100.0 * count(*) FILTER (WHERE status IN ('present','retard'))
                      / nullif(count(*) FILTER (WHERE status <> 'non_enregistre'),0), 2) AS taux_presence
           FROM app.attendance
          WHERE school_id = $1 AND attendance_date BETWEEN $2::date AND $3::date AND status <> 'non_enregistre'`,
        [schoolId, from, to],
      );

      const byClass = await client.query(
        `SELECT cl.id AS class_id, cl.name AS classe,
                count(*) FILTER (WHERE a.status = 'present')::int AS presents,
                count(*) FILTER (WHERE a.status = 'absent')::int  AS absents,
                count(*) FILTER (WHERE a.status = 'retard')::int  AS retards,
                round(100.0 * count(*) FILTER (WHERE a.status IN ('present','retard'))
                      / nullif(count(*) FILTER (WHERE a.status <> 'non_enregistre'),0), 2) AS taux_presence
           FROM app.attendance a
           JOIN app.classes cl ON cl.id = a.class_id
          WHERE a.school_id = $1 AND a.attendance_date BETWEEN $2::date AND $3::date
          GROUP BY cl.id, cl.name
          ORDER BY taux_presence ASC NULLS LAST`,
        [schoolId, from, to],
      );

      const byDay = await client.query(
        `SELECT attendance_date,
                count(*) FILTER (WHERE status = 'present')::int AS presents,
                count(*) FILTER (WHERE status = 'absent')::int  AS absents,
                count(*) FILTER (WHERE status = 'retard')::int  AS retards,
                round(100.0 * count(*) FILTER (WHERE status IN ('present','retard'))
                      / nullif(count(*) FILTER (WHERE status <> 'non_enregistre'),0), 2) AS taux_presence
           FROM app.attendance
          WHERE school_id = $1 AND attendance_date BETWEEN $2::date AND $3::date
          GROUP BY attendance_date ORDER BY attendance_date`,
        [schoolId, from, to],
      );

      const frequent = await client.query(
        `SELECT s.id, s.full_name, s.public_code, cl.name AS classe,
                count(*) FILTER (WHERE a.status = 'absent')::int AS absences,
                count(*) FILTER (WHERE a.status = 'retard')::int AS retards
           FROM app.attendance a
           JOIN app.students s ON s.id = a.student_id
           JOIN app.classes cl ON cl.id = s.class_id
          WHERE a.school_id = $1 AND a.attendance_date BETWEEN $2::date AND $3::date
          GROUP BY s.id, s.full_name, s.public_code, cl.name
         HAVING count(*) FILTER (WHERE a.status = 'absent') >= 3
          ORDER BY absences DESC, retards DESC
          LIMIT 20`,
        [schoolId, from, to],
      );

      const worstDay = await client.query(
        `SELECT to_char(attendance_date, 'TMDay') AS jour,
                count(*) FILTER (WHERE status = 'absent')::int AS absents
           FROM app.attendance
          WHERE school_id = $1 AND attendance_date BETWEEN $2::date AND $3::date
          GROUP BY 1 ORDER BY absents DESC LIMIT 1`,
        [schoolId, from, to],
      );

      return {
        periode: { du: from, au: to },
        global: global.rows[0],
        parClasse: byClass.rows,
        parJour: byDay.rows,
        elevesFrequemmentAbsents: frequent.rows,
        jourLePlusAbsent: worstDay.rows[0] ?? null,
      };
    });

    return noStore(reply).send(stats);
  });

  /** Historique complet d'une présence (conflits, corrections). */
  app.get('/api/ecole/presences/:studentId/historique', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const studentId = String((req.params as any).studentId);

    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT h.id, h.attendance_date, h.old_status, h.new_status, h.old_arrival, h.new_arrival,
                h.changed_at, h.changed_by_name, h.change_source, h.note
           FROM app.attendance_history h
          WHERE h.student_id = $1 AND h.school_id = $2
          ORDER BY h.changed_at DESC LIMIT 200`,
        [studentId, schoolId],
      );
      return rows;
    });

    return noStore(reply).send({ historique: rows });
  });

  /* ====================================================================== */
  /*  COMMUNIQUÉS                                                           */
  /* ====================================================================== */

  app.get('/api/ecole/communiques', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const q = (req.query as any) ?? {};
    const status = typeof q.statut === 'string' ? q.statut : null;

    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT a.id, a.reference, a.title, a.subject, a.summary, a.kind, a.is_urgent,
                a.status, a.audience_kind, a.audience_filter, a.publish_at, a.published_at,
                a.created_by_name, a.updated_by_name, a.created_at, a.updated_at,
                a.attachment_name, a.pdf_url,
                (SELECT count(*) FROM app.announcement_recipients r WHERE r.announcement_id = a.id)::int AS destinataires,
                (SELECT count(*) FROM app.announcement_recipients r WHERE r.announcement_id = a.id AND r.read_at IS NOT NULL)::int AS lus,
                (SELECT count(*) FROM app.announcement_recipients r WHERE r.announcement_id = a.id AND r.read_at IS NULL)::int AS non_lus
           FROM app.announcements a
          WHERE a.school_id = $1 AND a.status <> 'supprime'
            AND ($2::text IS NULL OR (a.status)::text = $2)
          ORDER BY coalesce(a.published_at, a.publish_at, a.created_at) DESC
          LIMIT 200`,
        [schoolId, status],
      );
      return rows;
    });

    return noStore(reply).send({ communiques: rows });
  });

  app.get('/api/ecole/communiques/:id', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const id = String((req.params as any).id);

    const data = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT a.*, 
                (SELECT count(*) FROM app.announcement_recipients r WHERE r.announcement_id = a.id)::int AS destinataires,
                (SELECT count(*) FROM app.announcement_recipients r WHERE r.announcement_id = a.id AND r.read_at IS NOT NULL)::int AS lus
           FROM app.announcements a WHERE a.id = $1 AND a.school_id = $2`,
        [id, schoolId],
      );
      if (!rows[0]) {
        const err = new Error('Communiqué introuvable.') as Error & { statusCode?: number; code?: string };
        err.statusCode = 404;
        err.code = 'COMMUNIQUE_INTROUVABLE';
        throw err;
      }

      const recipients = await client.query(
        `SELECT r.id, r.read_at, r.delivered_at, r.deliver_channel,
                p.full_name AS parent, p.email, p.phone,
                s.full_name AS eleve, cl.name AS classe
           FROM app.announcement_recipients r
           JOIN app.parents p ON p.id = r.parent_id
           LEFT JOIN app.students s ON s.id = r.student_id
           LEFT JOIN app.classes cl ON cl.id = s.class_id
          WHERE r.announcement_id = $1
          ORDER BY r.read_at NULLS FIRST, p.full_name
          LIMIT 500`,
        [id],
      );

      return { communique: rows[0], destinataires: recipients.rows };
    });

    return noStore(reply).send(data);
  });

  app.post(
    '/api/ecole/communiques',
    { preHandler: [...guard, requirePermission('communiques.creer')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const parsed = AnnouncementSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Communiqué incomplet.', {
          details: parsed.error.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
        });
      }
      const input = parsed.data;

      const result = await runAudited(
        { db, audit },
        req,
          {
            action:
              input.action === 'publier' ? AUDIT_ACTIONS.ANNOUNCEMENT_PUBLISHED : AUDIT_ACTIONS.ANNOUNCEMENT_CREATED,
            entityType: 'announcement',
            entityId: (_r, res: any) => res?.id ?? null,
            severity: input.isUrgent ? 'warning' : 'info',
            payload: () => ({
              titre: input.title,
              objet: input.subject,
              urgence: input.isUrgent,
              cible: input.audienceKind,
              action: input.action,
            }),
          },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const year = await c.query<{ id: string }>(
              `SELECT id FROM app.academic_years WHERE school_id = $1 AND is_current LIMIT 1`,
              [schoolId],
            );

            const status =
              input.action === 'publier' ? 'publie' : input.action === 'programmer' ? 'programme' : 'brouillon';

            if (input.action === 'programmer' && !input.publishAt) {
              const err = new Error('Une date de publication est nécessaire pour programmer un communiqué.') as Error & {
                statusCode?: number;
                code?: string;
              };
              err.statusCode = 400;
              err.code = 'DATE_PUBLICATION_REQUISE';
              throw err;
            }

            // Numéro de référence du document : séquentiel par école et par année.
            const seq = await c.query<{ n: string }>(
              `SELECT (count(*) + 1)::text AS n FROM app.announcements
                WHERE school_id = $1 AND created_at >= date_trunc('year', now())`,
              [schoolId],
            );
            const reference =
              input.reference ??
              `COMM/${new Date().getFullYear()}/${String(seq.rows[0]?.n ?? '1').padStart(4, '0')}`;

            const { rows } = await c.query(
              `INSERT INTO app.announcements
                 (school_id, academic_year_id, template_id, reference, kind, title, subject, summary,
                  body_html, is_urgent, audience_kind, audience_filter, status, publish_at,
                  published_at, expires_at, created_by, created_by_name, updated_by_name)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$18)
               RETURNING id, reference, title, status, published_at, publish_at`,
              [
                schoolId,
                year.rows[0]?.id ?? null,
                input.templateId ?? null,
                reference,
                input.kind,
                input.title,
                input.subject ?? null,
                input.summary ?? null,
                input.bodyHtml,
                input.isUrgent,
                input.audienceKind,
                JSON.stringify(input.audienceFilter),
                status,
                input.publishAt ?? null,
                status === 'publie' ? new Date() : null,
                input.expiresAt ?? null,
                req.auth?.userId ?? null,
                req.auth?.displayName ?? null,
              ],
            );

            const announcement = rows[0]!;

            // Destinataires : résolus immédiatement à la publication pour que
            // l'accusé de lecture soit exploitable.
            let destinataires = 0;
            if (status === 'publie') {
              destinataires = await resolveAndInsertRecipients(c, schoolId, announcement.id, {
                audienceKind: input.audienceKind,
                audienceFilter: input.audienceFilter,
              });

              // Notifications internes pour les parents concernés
              await c.query(
                `INSERT INTO app.notifications
                   (school_id, audience, parent_id, kind, title, body, severity,
                    entity_type, entity_id, action_url)
                 SELECT DISTINCT $1, 'parent', r.parent_id,
                        $3, $4, $5,
                        CASE WHEN $6::boolean THEN 'urgent' ELSE 'info' END,
                        'announcement', $2, '/parent/communiques/' || $2::text
                   FROM app.announcement_recipients r
                  WHERE r.announcement_id = $2`,
                [
                  schoolId,
                  announcement.id,
                  input.isUrgent ? 'communique_urgent' : 'nouveau_communique',
                  input.title,
                  input.summary ?? input.subject ?? 'Nouveau communiqué de votre école',
                  input.isUrgent,
                ],
              );
            }

            return { ...announcement, destinataires };
          },
      );

      return noStore(reply).code(201).send({
        message:
          result.status === 'publie'
            ? `Communiqué publié et envoyé à ${result.destinataires} parent(s).`
            : result.status === 'programme'
              ? `Communiqué programmé pour le ${new Date(result.publish_at).toLocaleString('fr-FR')}.`
              : 'Communiqué enregistré comme brouillon.',
        communique: result,
      });
    },
  );

  app.patch(
    '/api/ecole/communiques/:id',
    { preHandler: [...guard, requirePermission('communiques.creer')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const id = String((req.params as any).id);
      const parsed = AnnouncementSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Modification invalide.');
      }
      const input = parsed.data;

      const updated = await runAudited(
        { db, audit },
        req,
          { action: AUDIT_ACTIONS.ANNOUNCEMENT_UPDATED, entityType: 'announcement', entityId: () => id },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const { rows } = await c.query(
              `UPDATE app.announcements SET
                 title = coalesce($3, title),
                 subject = coalesce($4, subject),
                 summary = coalesce($5, summary),
                 body_html = coalesce($6, body_html),
                 kind = coalesce($7, kind),
                 is_urgent = coalesce($8, is_urgent),
                 audience_kind = coalesce($9, audience_kind),
                 audience_filter = coalesce($10::jsonb, audience_filter),
                 publish_at = coalesce($11, publish_at),
                 updated_by = $12,
                 updated_by_name = $13
               WHERE id = $1 AND school_id = $2 AND status <> 'supprime'
               RETURNING id, reference, title, status, publish_at`,
              [
                id,
                schoolId,
                input.title ?? null,
                input.subject ?? null,
                input.summary ?? null,
                input.bodyHtml ?? null,
                input.kind ?? null,
                input.isUrgent ?? null,
                input.audienceKind ?? null,
                input.audienceFilter ? JSON.stringify(input.audienceFilter) : null,
                input.publishAt ?? null,
                req.auth?.userId ?? null,
                req.auth?.displayName ?? null,
              ],
            );
            if (!rows[0]) {
              const err = new Error('Communiqué introuvable.') as Error & { statusCode?: number; code?: string };
              err.statusCode = 404;
              err.code = 'COMMUNIQUE_INTROUVABLE';
              throw err;
            }
            return rows[0];
          },
      );

      return noStore(reply).send({ message: 'Communiqué mis à jour.', communique: updated });
    },
  );

  app.post(
    '/api/ecole/communiques/:id/publier',
    { preHandler: [...guard, requirePermission('communiques.publier')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const id = String((req.params as any).id);

      const result = await runAudited(
        { db, audit },
        req,
          {
            action: AUDIT_ACTIONS.ANNOUNCEMENT_PUBLISHED,
            entityType: 'announcement',
            entityId: () => id,
            severity: 'notice',
          },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const { rows } = await c.query<{
              id: string;
              title: string;
              summary: string | null;
              subject: string | null;
              is_urgent: boolean;
              audience_kind: string;
              audience_filter: any;
              status: string;
            }>(
              `UPDATE app.announcements
                  SET status = 'publie', published_at = now()
                WHERE id = $1 AND school_id = $2 AND status IN ('brouillon','programme')
                RETURNING id, title, summary, subject, is_urgent, audience_kind, audience_filter, status`,
              [id, schoolId],
            );
            const ann = rows[0];
            if (!ann) {
              const err = new Error(
                'Communiqué introuvable ou déjà publié.',
              ) as Error & { statusCode?: number; code?: string };
              err.statusCode = 404;
              err.code = 'COMMUNIQUE_INTROUVABLE';
              throw err;
            }

            const count = await resolveAndInsertRecipients(c, schoolId, ann.id, {
              audienceKind: ann.audience_kind as any,
              audienceFilter: ann.audience_filter ?? {},
            });

            await c.query(
              `INSERT INTO app.notifications
                 (school_id, audience, parent_id, kind, title, body, severity,
                  entity_type, entity_id, action_url)
               SELECT DISTINCT $1, 'parent', r.parent_id,
                      $3, $4, $5,
                      CASE WHEN $6::boolean THEN 'urgent' ELSE 'info' END,
                      'announcement', $2, '/parent/communiques/' || $2::text
                 FROM app.announcement_recipients r
                WHERE r.announcement_id = $2`,
              [
                schoolId,
                ann.id,
                ann.is_urgent ? 'communique_urgent' : 'nouveau_communique',
                ann.title,
                ann.summary ?? ann.subject ?? 'Nouveau communiqué de votre école',
                ann.is_urgent,
              ],
            );

            return { ...ann, destinataires: count };
          },
      );

      return noStore(reply).send({
        message: `Communiqué publié et envoyé à ${result.destinataires} parent(s).`,
        communique: result,
      });
    },
  );

  /* ---------------------------------------------------------------------- */
  /*  Modèles de communiqués (import PDF / DOCX puis édition)               */
  /* ---------------------------------------------------------------------- */

  app.get('/api/ecole/modeles', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, kind, source_format, source_filename, body_html, header_html,
                footer_html, variables, is_default, is_active, created_at, updated_at,
                (source_blob IS NOT NULL) AS a_fichier_source
           FROM app.announcement_templates
          WHERE school_id = $1 AND is_active
          ORDER BY is_default DESC, name`,
        [schoolId],
      );
      return rows;
    });
    return noStore(reply).send({ modeles: rows });
  });

  /**
   * Import d'un modèle PDF ou DOCX : le fichier est conservé, son contenu est
   * extrait puis converti en HTML éditable, et les variables détectées
   * ([NOM_ECOLE], [DATE], [OBJET], [MESSAGE], [SIGNATURE]…) sont listées.
   */
  app.post(
    '/api/ecole/modeles/importer',
    { preHandler: [...guard, requirePermission('communiques.creer')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);

      const file = await (req as any).file();
      if (!file) {
        return sendError(reply, 400, 'FICHIER_REQUIS', 'Aucun fichier reçu.');
      }

      const buffer: Buffer = await file.toBuffer();
      const filename: string = file.filename ?? 'modele';
      const mimetype: string = file.mimetype ?? '';

      const { createHash } = await import('node:crypto');
      const sha256 = createHash('sha256').update(buffer).digest('hex');

      const fields = (file.fields ?? {}) as Record<string, any>;
      const name = String(fields.nom?.value ?? filename.replace(/\.[^.]+$/, '')).slice(0, 120);
      const kind = String(fields.type?.value ?? 'communique_officiel');

      // Extraction du texte selon le format
      let extractedHtml = '';
      let sourceFormat: 'pdf' | 'docx' | 'manuel' = 'manuel';

      if (mimetype === 'application/pdf') {
        sourceFormat = 'pdf';
        try {
          const pdfParse = (await import('pdf-parse')).default as any;
          const parsed = await pdfParse(buffer);
          extractedHtml = textToEditableHtml(parsed.text ?? '');
        } catch {
          // Un PDF scanné (image) ne contient pas de texte : on le signale
          // clairement plutôt que d'importer un modèle vide.
          extractedHtml =
            '<p><em>Ce PDF ne contient pas de texte extractible (document probablement scanné). ' +
            'Saisissez le contenu du modèle manuellement ci-dessous.</em></p>';
        }
      } else if (
        mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        filename.toLowerCase().endsWith('.docx')
      ) {
        sourceFormat = 'docx';
        extractedHtml = await docxToHtml(buffer);
      } else {
        return sendError(
          reply,
          415,
          'FORMAT_NON_SUPPORTE',
          'Formats acceptés : PDF et DOCX (Word).',
        );
      }

      // Variables reconnues dans le document importé
      const KNOWN_VARIABLES = [
        'NOM_ECOLE', 'CODE_ECOLE', 'LOGO', 'DATE', 'HEURE', 'LIEU', 'CLASSE', 'SECTION',
        'OBJET', 'MESSAGE', 'SIGNATURE', 'NOM_DIRECTEUR', 'FONCTION', 'ANNEE_SCOLAIRE',
        'TELEPHONE', 'ADRESSE', 'ELEVE', 'NOM_ELEVE',
      ];
      const variables = KNOWN_VARIABLES.filter((v) =>
        new RegExp(`\\[${v}\\]`, 'i').test(extractedHtml),
      ).map((v) => ({ cle: v, libelle: VARIABLE_LABELS[v] ?? v }));

      const created = await runAudited(
        { db, audit },
        req,
          {
            action: AUDIT_ACTIONS.TEMPLATE_IMPORTED,
            entityType: 'template',
            entityId: (_r, res: any) => res?.id ?? null,
            payload: () => ({ fichier: filename, format: sourceFormat, variables: variables.length }),
          },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const { rows } = await c.query(
              `INSERT INTO app.announcement_templates
                 (school_id, name, kind, source_format, source_filename, source_blob, source_sha256,
                  body_html, variables)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
               RETURNING id, name, kind, source_format, variables, created_at`,
              [
                schoolId,
                name,
                kind,
                sourceFormat,
                filename,
                buffer,
                sha256,
                extractedHtml,
                JSON.stringify(variables),
              ],
            );
            return rows[0];
          },
      );

      return noStore(reply).code(201).send({
        message:
          `Modèle « ${name} » importé (${sourceFormat.toUpperCase()}). ` +
          'Vous pouvez maintenant le modifier directement depuis MwanaClasse.',
        modele: created,
        apercu: extractedHtml.slice(0, 4000),
        variablesDetectees: variables,
        formatsAcceptes: ['PDF', 'DOCX'],
      });
    },
  );

  /* ====================================================================== */
  /*  PARENTS ET LIAISONS                                                   */
  /* ====================================================================== */

  app.get('/api/ecole/parents', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const q = (req.query as any) ?? {};

    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT p.id, p.full_name, p.email, p.phone, p.relationship, p.is_active,
                p.last_seen_at, p.created_at,
                (SELECT count(*) FROM app.parent_student_links l
                  WHERE l.parent_id = p.id AND l.school_id = $1 AND l.status = 'actif')::int AS enfants_actifs,
                (SELECT count(*) FROM app.parent_student_links l
                  WHERE l.parent_id = p.id AND l.school_id = $1 AND l.status = 'en_attente')::int AS en_attente,
                (SELECT coalesce(json_agg(json_build_object(
                          'studentId', l.student_id, 'nom', s.full_name,
                          'classe', cl.name, 'section', sec.name, 'statut', l.status)
                        ORDER BY s.full_name), '[]'::json)
                   FROM app.parent_student_links l
                   JOIN app.students s ON s.id = l.student_id
                   JOIN app.classes cl ON cl.id = s.class_id
                   LEFT JOIN app.sections sec ON sec.id = s.section_id
                  WHERE l.parent_id = p.id AND l.school_id = $1) AS enfants
           FROM app.parents p
          WHERE EXISTS (SELECT 1 FROM app.parent_student_links l
                         WHERE l.parent_id = p.id AND l.school_id = $1)
            AND ($2::text IS NULL OR app.search_key(p.full_name) LIKE '%' || $2 || '%'
                 OR coalesce(p.email::text,'') ILIKE '%' || $2 || '%'
                 OR coalesce(p.phone,'') LIKE '%' || $2 || '%')
          ORDER BY p.full_name
          LIMIT 300`,
        [schoolId, q.recherche ? String(q.recherche).toLowerCase() : null],
      );
      return rows;
    });

    return noStore(reply).send({ parents: rows });
  });

  /** Liaisons en attente de validation administrative. */
  app.get('/api/ecole/liaisons', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const status = String((req.query as any)?.statut ?? 'en_attente');

    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT l.id, l.status, l.relationship, l.requested_at, l.requested_ip,
                l.requested_device, l.requested_method, l.decided_at, l.decision_note,
                p.id AS parent_id, p.full_name AS parent, p.email, p.phone,
                s.id AS student_id, s.full_name AS eleve, s.public_code,
                cl.name AS classe, sec.name AS section
           FROM app.parent_student_links l
           JOIN app.parents p ON p.id = l.parent_id
           JOIN app.students s ON s.id = l.student_id
           JOIN app.classes cl ON cl.id = s.class_id
           LEFT JOIN app.sections sec ON sec.id = s.section_id
          WHERE l.school_id = $1 AND ($2::text IS NULL OR l.status = $2::text::app.link_status)
          ORDER BY l.requested_at DESC
          LIMIT 300`,
        [schoolId, status === 'tous' ? null : status],
      );
      return rows;
    });

    return noStore(reply).send({ liaisons: rows });
  });

  app.post(
    '/api/ecole/liaisons/:id/decision',
    { preHandler: [...guard, requirePermission('liens.valider')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const linkId = String((req.params as any).id);
      const parsed = LinkDecisionSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Décision invalide.');
      }

      const result = await runAudited(
        { db, audit },
        req,
          {
            action:
              parsed.data.decision === 'approuver'
                ? AUDIT_ACTIONS.LINK_APPROVED
                : parsed.data.decision === 'revoquer'
                  ? AUDIT_ACTIONS.LINK_REVOKED
                  : 'lien.refuse',
            entityType: 'parent_student_link',
            entityId: () => linkId,
            severity: parsed.data.decision === 'approuver' ? 'notice' : 'warning',
            payload: () => ({ decision: parsed.data.decision, note: parsed.data.note }),
          },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const target =
              parsed.data.decision === 'approuver'
                ? 'actif'
                : parsed.data.decision === 'refuser'
                  ? 'refuse'
                  : 'revoque';

            const { rows } = await c.query<{
              id: string;
              parent_id: string;
              student_id: string;
              status: string;
            }>(
              `UPDATE app.parent_student_links SET
                 status = $3::app.link_status,
                 decided_at = now(),
                 decided_by = $4,
                 decision_note = $5,
                 revoked_at = CASE WHEN $3 = 'revoque' THEN now() ELSE revoked_at END,
                 revoked_reason = CASE WHEN $3 = 'revoque' THEN $5 ELSE revoked_reason END
               WHERE id = $1 AND school_id = $2
               RETURNING id, parent_id, student_id, status`,
              [linkId, schoolId, target, req.auth?.userId ?? null, parsed.data.note ?? null],
            );

            const link = rows[0];
            if (!link) {
              const err = new Error('Liaison introuvable.') as Error & { statusCode?: number; code?: string };
              err.statusCode = 404;
              err.code = 'LIAISON_INTROUVABLE';
              throw err;
            }

            if (target === 'actif') {
              // Le parent est prévenu que l'accès est ouvert.
              await c.query(
                `INSERT INTO app.notifications
                   (school_id, audience, parent_id, kind, title, body, severity,
                    entity_type, entity_id, action_url)
                 VALUES ($1,'parent',$2,'liaison_validee','Accès à votre enfant confirmé',
                         'L’école a validé votre accès. Vous pouvez consulter les présences et les communiqués.',
                         'succes','student',$3,'/parent/enfants/' || $3::text)`,
                [schoolId, link.parent_id, link.student_id],
              );
            }

            return link;
          },
      );

      const labels: Record<string, string> = {
        approuver: 'Liaison validée : le parent peut désormais suivre son enfant.',
        refuser: 'Demande refusée.',
        revoquer: 'Liaison révoquée : le parent n’a plus accès aux informations de cet enfant.',
      };

      return noStore(reply).send({ message: labels[parsed.data.decision], liaison: result });
    },
  );

  /* ====================================================================== */
  /*  DEMANDES / RÉCLAMATIONS                                               */
  /* ====================================================================== */

  app.get('/api/ecole/demandes', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const q = (req.query as any) ?? {};

    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT r.id, r.reference, r.kind, r.subject, r.message, r.status, r.priority,
                r.absence_date, r.absence_reason, r.justification_decision,
                r.assigned_to_name, r.handled_at, r.closed_at, r.created_at, r.updated_at,
                p.id AS parent_id, p.full_name AS parent, p.email, p.phone,
                s.id AS student_id, s.full_name AS eleve, cl.name AS classe,
                (SELECT count(*) FROM app.request_messages m
                  WHERE m.request_id = r.id AND m.author_type = 'parent')::int AS messages_parent,
                (SELECT count(*) FROM app.request_messages m
                  WHERE m.request_id = r.id AND m.author_type = 'ecole')::int AS messages_ecole
           FROM app.requests r
           JOIN app.parents p ON p.id = r.parent_id
           LEFT JOIN app.students s ON s.id = r.student_id
           LEFT JOIN app.classes cl ON cl.id = s.class_id
          WHERE r.school_id = $1
            AND ($2::text IS NULL OR r.status = $2::text::app.request_status)
          ORDER BY
            CASE r.status WHEN 'en_attente' THEN 1 WHEN 'en_cours' THEN 2 ELSE 3 END,
            r.priority ASC, r.created_at DESC
          LIMIT 300`,
        [schoolId, q.statut && q.statut !== 'tous' ? String(q.statut) : null],
      );
      return rows;
    });

    return noStore(reply).send({ demandes: rows });
  });

  app.post(
    '/api/ecole/demandes/:id/repondre',
    { preHandler: [...guard, requirePermission('demandes.traiter')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const id = String((req.params as any).id);

      const parsed = z
        .object({
          message: z.string().trim().min(1).max(8000),
          nouveauStatut: z.enum(['en_cours', 'repondu', 'cloture', 'en_attente']).optional(),
          decisionJustification: z.enum(['acceptee', 'refusee', 'a_verifier']).optional(),
        })
        .safeParse(req.body);

      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Réponse invalide.');
      }

      const result = await runAudited(
        { db, audit },
        req,
          {
            action: parsed.data.nouveauStatut === 'cloture' ? AUDIT_ACTIONS.REQUEST_CLOSED : AUDIT_ACTIONS.REQUEST_HANDLED,
            entityType: 'request',
            entityId: () => id,
            severity: 'notice',
            payload: () => ({ statut: parsed.data.nouveauStatut ?? 'repondu' }),
          },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const existing = await c.query<{ id: string; parent_id: string; student_id: string | null; subject: string }>(
              `SELECT id, parent_id, student_id, subject FROM app.requests
                WHERE id = $1 AND school_id = $2 FOR UPDATE`,
              [id, schoolId],
            );
            const request = existing.rows[0];
            if (!request) {
              const err = new Error('Demande introuvable.') as Error & { statusCode?: number; code?: string };
              err.statusCode = 404;
              err.code = 'DEMANDE_INTROUVABLE';
              throw err;
            }

            const newStatus = parsed.data.nouveauStatut ?? 'repondu';

            await c.query(
              `INSERT INTO app.request_messages (request_id, author_type, author_id, author_name, body)
               VALUES ($1,'ecole',$2,$3,$4)`,
              [id, req.auth?.userId ?? null, req.auth?.displayName ?? null, parsed.data.message],
            );

            await c.query(
              `UPDATE app.requests SET
                 status = $3::app.request_status,
                 handled_at = coalesce(handled_at, now()),
                 closed_at = CASE WHEN $3 = 'cloture' THEN now() ELSE closed_at END,
                 closed_by_name = CASE WHEN $3 = 'cloture' THEN $4 ELSE closed_by_name END,
                 assigned_to = coalesce(assigned_to, $5),
                 assigned_to_name = coalesce(assigned_to_name, $4),
                 justification_decision = coalesce($6::app.justification_decision, justification_decision)
               WHERE id = $1 AND school_id = $2`,
              [
                id,
                schoolId,
                newStatus,
                req.auth?.displayName ?? null,
                req.auth?.userId ?? null,
                parsed.data.decisionJustification ?? null,
              ],
            );

            // Le parent est notifié de la réponse.
            await c.query(
              `INSERT INTO app.notifications
                 (school_id, audience, parent_id, kind, title, body, severity,
                  entity_type, entity_id, action_url)
               VALUES ($1,'parent',$2,'reponse_administration',$3,$4,'info','request',$5,
                       '/parent/demandes/' || $5::text)`,
              [
                schoolId,
                request.parent_id,
                `Réponse à votre demande : ${request.subject}`,
                parsed.data.message.slice(0, 500),
                id,
              ],
            );

            return { id, status: newStatus };
          },
      );

      return noStore(reply).send({
        message:
          result.status === 'cloture'
            ? 'Demande clôturée. Le parent a été informé.'
            : 'Réponse envoyée au parent.',
        demande: result,
      });
    },
  );

  /* ====================================================================== */
  /*  CALENDRIER                                                            */
  /* ====================================================================== */

  app.get('/api/ecole/calendrier', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT id, kind, title, description, starts_on, ends_on, start_time, end_time,
                all_day, location, audience_kind, audience_filter, is_published, created_by_name
           FROM app.calendar_events
          WHERE school_id = $1
          ORDER BY starts_on DESC
          LIMIT 300`,
        [schoolId],
      );
      return rows;
    });
    return noStore(reply).send({ evenements: rows });
  });

  app.post(
    '/api/ecole/calendrier',
    { preHandler: [...guard, requirePermission('calendrier.gerer')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const parsed = z
        .object({
          title: z.string().trim().min(1).max(160),
          description: optionalText(4000),
          kind: z.enum([
            'rentree', 'cours', 'conge', 'vacances', 'examen', 'reunion',
            'evenement', 'journee_speciale', 'ferie', 'autre',
          ]),
          startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
          startTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
          endTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
          allDay: z.boolean().default(true),
          location: optionalText(160),
          audienceKind: z.enum(['toute_ecole', 'niveau', 'classe', 'section']).default('toute_ecole'),
          audienceFilter: z.object({ classIds: z.array(uuid).optional() }).default({}),
        })
        .safeParse(req.body);

      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Événement incomplet.');
      }
      const input = parsed.data;

      const created = await runAudited(
        { db, audit },
        req,
          { action: 'calendrier.creation', entityType: 'calendar_event', entityId: (_r, res: any) => res?.id ?? null },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const year = await c.query<{ id: string }>(
              `SELECT id FROM app.academic_years WHERE school_id = $1 AND is_current LIMIT 1`,
              [schoolId],
            );
            const { rows } = await c.query(
              `INSERT INTO app.calendar_events
                 (school_id, academic_year_id, kind, title, description, starts_on, ends_on,
                  start_time, end_time, all_day, location, audience_kind, audience_filter, created_by_name)
               VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$12,$13::jsonb,$14)
               RETURNING id, title, kind, starts_on, ends_on`,
              [
                schoolId,
                year.rows[0]?.id ?? null,
                input.kind,
                input.title,
                input.description ?? null,
                input.startsOn,
                input.endsOn ?? null,
                input.startTime ?? null,
                input.endTime ?? null,
                input.allDay,
                input.location ?? null,
                input.audienceKind,
                JSON.stringify(input.audienceFilter),
                req.auth?.displayName ?? null,
              ],
            );
            return rows[0];
          },
      );

      return noStore(reply).code(201).send({ message: 'Événement ajouté au calendrier.', evenement: created });
    },
  );

  /* ====================================================================== */
  /*  DOCUMENTS DE L'ÉCOLE                                                  */
  /* ====================================================================== */

  app.get('/api/ecole/documents', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT id, category, title, description, file_url, file_name, mime_type, file_size,
                visibility, audience_kind, downloads, is_active, uploaded_by_name, created_at
           FROM app.school_documents
          WHERE school_id = $1 AND is_active
          ORDER BY category, created_at DESC`,
        [schoolId],
      );
      return rows;
    });
    return noStore(reply).send({ documents: rows });
  });

  /* ====================================================================== */
  /*  RAPPORTS                                                              */
  /* ====================================================================== */

  app.get('/api/ecole/rapports/effectifs', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const data = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const parClasse = await client.query(
        `SELECT o.class_name AS classe, o.level, o.effectif, o.max_capacity,
                o.places_disponibles, o.etat_capacite,
                count(*) FILTER (WHERE s.gender = 'M')::int AS garcons,
                count(*) FILTER (WHERE s.gender = 'F')::int AS filles
           FROM app.v_class_occupancy o
           LEFT JOIN app.students s ON s.class_id = o.class_id AND s.status = 'actif'
          WHERE o.school_id = $1
          GROUP BY o.class_name, o.level, o.effectif, o.max_capacity, o.places_disponibles, o.etat_capacite
          ORDER BY o.class_name`,
        [schoolId],
      );

      const global = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE gender = 'M')::int AS garcons,
                count(*) FILTER (WHERE gender = 'F')::int AS filles,
                count(*) FILTER (WHERE status <> 'actif')::int AS inactifs
           FROM app.students WHERE school_id = $1`,
        [schoolId],
      );

      return { global: global.rows[0], parClasse: parClasse.rows };
    });
    return noStore(reply).send(data);
  });

  app.get('/api/ecole/rapports/parents-connectes', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT s.full_name AS eleve, s.public_code, cl.name AS classe, sec.name AS section,
                count(l.id) FILTER (WHERE l.status = 'actif')::int AS parents_connectes,
                count(l.id) FILTER (WHERE l.status = 'en_attente')::int AS en_attente,
                string_agg(p.full_name || coalesce(' (' || p.phone || ')',''), ' · '
                           ORDER BY p.full_name) FILTER (WHERE l.status = 'actif') AS responsables
           FROM app.students s
           JOIN app.classes cl ON cl.id = s.class_id
           LEFT JOIN app.sections sec ON sec.id = s.section_id
           LEFT JOIN app.parent_student_links l ON l.student_id = s.id
           LEFT JOIN app.parents p ON p.id = l.parent_id
          WHERE s.school_id = $1 AND s.status = 'actif'
          GROUP BY s.id, s.full_name, s.public_code, cl.name, sec.name
          ORDER BY parents_connectes ASC, cl.name, s.full_name`,
        [schoolId],
      );
      return rows;
    });
    return noStore(reply).send({ eleves: rows });
  });

  /* ====================================================================== */
  /*  PARAMÈTRES DE L'ÉTABLISSEMENT                                         */
  /* ====================================================================== */

  app.get('/api/ecole/parametres', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const data = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const school = await client.query(
        `SELECT id, slug, official_name, short_name, type, types, is_mixed, logo_url,
                primary_color, secondary_color, address_line, commune, city, province, country,
                phones, email, website, description, opening_hours, extra_info,
                current_year_label, parent_link_mode, settings, signature_name, signature_title,
                onboarded_at
           FROM app.schools WHERE id = $1`,
        [schoolId],
      );

      const years = await client.query(
        `SELECT id, label, starts_on, ends_on, is_current, is_archived
           FROM app.academic_years WHERE school_id = $1 ORDER BY starts_on DESC`,
        [schoolId],
      );

      const staff = await client.query(
        `SELECT u.id, u.email, u.full_name, u.job_title, u.phone, u.is_active, u.is_owner,
                u.totp_enabled, u.last_login_at,
                coalesce(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.id IS NOT NULL), '{}') AS roles
           FROM sec.staff_users u
           LEFT JOIN sec.staff_roles sr ON sr.staff_user_id = u.id
           LEFT JOIN sec.roles r ON r.id = sr.role_id
          WHERE u.school_id = $1
          GROUP BY u.id
          ORDER BY u.is_owner DESC, u.full_name`,
        [schoolId],
      );

      const stats = await client.query(
        `SELECT
           (SELECT count(*) FROM app.students WHERE school_id = $1)::int   AS eleves,
           (SELECT count(*) FROM app.classes  WHERE school_id = $1)::int   AS classes,
           (SELECT count(*) FROM app.attendance WHERE school_id = $1)::int AS presences,
           (SELECT count(*) FROM app.announcements WHERE school_id = $1)::int AS communiques`,
        [schoolId],
      );

      return {
        ecole: school.rows[0],
        anneesScolaires: years.rows,
        personnel: staff.rows,
        statistiques: stats.rows[0],
      };
    });

    return noStore(reply).send(data);
  });

  app.patch(
    '/api/ecole/parametres',
    { preHandler: [...guard, requirePermission('parametres.modifier')] },
    async (req, reply) => {
      const schoolId = requireSchool(req);
      const parsed = z
        .object({
          officialName: z.string().trim().min(3).max(180).optional(),
          shortName: optionalText(80),
          type: z
            .enum(['maternelle', 'primaire', 'secondaire', 'humanites', 'technique', 'professionnel', 'mixte', 'autre'])
            .optional(),
          // Sélection multiple des cycles proposés.
          types: z
            .array(
              z.enum([
                'maternelle', 'primaire', 'secondaire', 'humanites',
                'technique', 'professionnel', 'mixte', 'autre',
              ]),
            )
            .min(1)
            .max(8)
            .optional(),
          // Précision « mixte / non mixte » (notamment pour le collège).
          isMixed: z.boolean().optional(),
          logoUrl: optionalText(500),
          primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
          secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
          addressLine: optionalText(240),
          commune: optionalText(120),
          city: optionalText(120),
          province: optionalText(120),
          phones: z.array(z.string().trim().max(32)).optional(),
          email: z.string().email().optional().nullable(),
          website: optionalText(200),
          description: optionalText(4000),
          openingHours: optionalText(600),
          parentLinkMode: z.enum(['automatique', 'validation']).optional(),
          signatureName: optionalText(160),
          signatureTitle: optionalText(80),
          settings: z.record(z.string(), z.unknown()).optional(),
        })
        .safeParse(req.body);

      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Paramètres invalides.', {
          details: parsed.error.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
        });
      }
      const input = parsed.data;

      const updated = await runAudited(
        { db, audit },
        req,
          {
            action: AUDIT_ACTIONS.SCHOOL_UPDATED,
            entityType: 'school',
            entityId: () => schoolId,
            payload: () => ({ champs: Object.keys(input) }),
          },
          async (_req: FastifyRequest, c: QueryableClient) => {
            const { rows } = await c.query(
              `UPDATE app.schools SET
                 official_name = coalesce($2, official_name),
                 short_name = coalesce($3, short_name),
                 type = coalesce($4::app.school_type, type),
                 logo_url = coalesce($5, logo_url),
                 primary_color = coalesce($6, primary_color),
                 secondary_color = coalesce($7, secondary_color),
                 address_line = coalesce($8, address_line),
                 commune = coalesce($9, commune),
                 city = coalesce($10, city),
                 province = coalesce($11, province),
                 phones = coalesce($12, phones),
                 email = coalesce($13, email),
                 website = coalesce($14, website),
                 description = coalesce($15, description),
                 opening_hours = coalesce($16, opening_hours),
                 parent_link_mode = coalesce($17, parent_link_mode),
                 signature_name = coalesce($18, signature_name),
                 signature_title = coalesce($19, signature_title),
                 settings = coalesce($20::jsonb, settings),
                 types = coalesce($21::app.school_type[], types),
                 is_mixed = coalesce($22, is_mixed)
               WHERE id = $1
               RETURNING id, official_name, primary_color, parent_link_mode, settings`,
              [
                schoolId,
                input.officialName ?? null,
                input.shortName ?? null,
                input.type ?? input.types?.[0] ?? null,
                input.logoUrl ?? null,
                input.primaryColor ?? null,
                input.secondaryColor ?? null,
                input.addressLine ?? null,
                input.commune ?? null,
                input.city ?? null,
                input.province ?? null,
                input.phones ?? null,
                input.email ?? null,
                input.website ?? null,
                input.description ?? null,
                input.openingHours ?? null,
                input.parentLinkMode ?? null,
                input.signatureName ?? null,
                input.signatureTitle ?? null,
                input.settings ? JSON.stringify(input.settings) : null,
                input.types ?? null,
                input.isMixed ?? null,
              ],
            );
            return rows[0];
          },
      );

      return noStore(reply).send({ message: 'Paramètres de l’établissement enregistrés.', ecole: updated });
    },
  );

  /* ====================================================================== */
  /*  NOTIFICATIONS ÉCOLE                                                   */
  /* ====================================================================== */

  app.get('/api/ecole/notifications', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT id, kind, title, body, severity, entity_type, entity_id, action_url, read_at, created_at
           FROM app.notifications
          WHERE school_id = $1 AND audience = 'ecole'
          ORDER BY created_at DESC LIMIT 100`,
        [schoolId],
      );
      return rows;
    });
    return noStore(reply).send({
      notifications: rows,
      nonLues: rows.filter((r: any) => !r.read_at).length,
    });
  });

  app.post('/api/ecole/notifications/lues', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);
    const count = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const res = await client.query(
        `UPDATE app.notifications SET read_at = now()
          WHERE school_id = $1 AND audience = 'ecole' AND read_at IS NULL`,
        [schoolId],
      );
      return res.rowCount ?? 0;
    });
    return noStore(reply).send({ message: `${count} notification(s) marquée(s) comme lue(s).` });
  });

  /* ====================================================================== */
  /*  ALERTES ADMINISTRATION                                                */
  /* ====================================================================== */

  app.get('/api/ecole/alertes', { preHandler: guard }, async (req, reply) => {
    const schoolId = requireSchool(req);

    const alerts = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const result: any[] = [];

      // Élèves sans présence enregistrée aujourd'hui, par classe
      const unrecorded = await client.query(
        `SELECT cl.name AS classe, count(s.id)::int AS eleves
           FROM app.classes cl
           JOIN app.students s ON s.class_id = cl.id AND s.status = 'actif'
           LEFT JOIN app.attendance a ON a.student_id = s.id AND a.attendance_date = CURRENT_DATE
          WHERE cl.school_id = $1 AND cl.is_active AND (a.id IS NULL OR a.status = 'non_enregistre')
          GROUP BY cl.name HAVING count(s.id) >= 5
          ORDER BY count(s.id) DESC`,
        [schoolId],
      );
      for (const row of unrecorded.rows) {
        result.push({
          type: 'presence_non_enregistree',
          gravite: 'attention',
          titre: `Présence non enregistrée pour ${row.eleves} élèves de ${row.classe}`,
          detail: 'Pensez à enregistrer la feuille de présence de cette classe.',
          action: '/ecole/presences',
        });
      }

      // Classes complètes ou presque
      const capacity = await client.query(
        `SELECT class_name, effectif, max_capacity, places_disponibles, etat_capacite
           FROM app.v_class_occupancy
          WHERE school_id = $1 AND is_active AND etat_capacite IN ('complete','presque_complete')`,
        [schoolId],
      );
      for (const row of capacity.rows) {
        result.push({
          type: row.etat_capacite === 'complete' ? 'classe_complete' : 'capacite_presque_atteinte',
          gravite: row.etat_capacite === 'complete' ? 'grave' : 'attention',
          titre:
            row.etat_capacite === 'complete'
              ? `Classe complète : ${row.class_name}`
              : `Capacité presque atteinte : ${row.class_name}`,
          detail: `${row.effectif} / ${row.max_capacity} élèves — ${row.places_disponibles} place(s) disponible(s).`,
          action: '/ecole/classes',
        });
      }

      // Liaisons parent en attente
      const pending = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.parent_student_links
          WHERE school_id = $1 AND status = 'en_attente'`,
        [schoolId],
      );
      if ((pending.rows[0]?.n ?? 0) > 0) {
        result.push({
          type: 'parents_a_valider',
          gravite: 'attention',
          titre: `${pending.rows[0]!.n} connexion(s) parent en attente de validation`,
          detail: 'Validez ou refusez ces demandes pour que les parents voient leurs enfants.',
          action: '/ecole/parents',
        });
      }

      // Demandes non traitées
      const requests = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.requests WHERE school_id = $1 AND status = 'en_attente'`,
        [schoolId],
      );
      if ((requests.rows[0]?.n ?? 0) > 0) {
        result.push({
          type: 'demandes_en_attente',
          gravite: 'info',
          titre: `${requests.rows[0]!.n} demande(s) parent non traitée(s)`,
          action: '/ecole/demandes',
        });
      }

      // Communiqués programmés arrivés à échéance mais non publiés
      const scheduled = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.announcements
          WHERE school_id = $1 AND status = 'programme' AND publish_at <= now()`,
        [schoolId],
      );
      if ((scheduled.rows[0]?.n ?? 0) > 0) {
        result.push({
          type: 'communique_non_publie',
          gravite: 'attention',
          titre: `${scheduled.rows[0]!.n} communiqué(s) programmé(s) en retard de publication`,
          action: '/ecole/communiques',
        });
      }

      // Synchronisations en attente
      const sync = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM sync.operations
          WHERE school_id = $1 AND status IN ('pending','conflict','failed')`,
        [schoolId],
      );
      if ((sync.rows[0]?.n ?? 0) > 0) {
        result.push({
          type: 'synchronisation_en_attente',
          gravite: 'attention',
          titre: `${sync.rows[0]!.n} opération(s) hors ligne non synchronisée(s)`,
          detail: 'Des présences enregistrées hors ligne attendent d’être envoyées au serveur.',
          action: '/ecole/parametres',
        });
      }

      return result;
    });

    return noStore(reply).send({ alertes: alerts, total: alerts.length });
  });
}

/* ==========================================================================
 *  Résolution des destinataires d'un communiqué
 * ========================================================================== */

/**
 * Traduit un ciblage (toute l'école, un niveau, des classes, des sections, un
 * élève) en une liste de parents destinataires, puis l'enregistre.
 * L'insertion est idempotente grâce à la contrainte d'unicité.
 */
async function resolveAndInsertRecipients(
  client: QueryableClient,
  schoolId: string,
  announcementId: string,
  audience: {
    audienceKind: 'toute_ecole' | 'niveau' | 'classe' | 'section' | 'eleve' | 'custom';
    audienceFilter: {
      levels?: string[];
      classIds?: string[];
      sectionIds?: string[];
      studentIds?: string[];
    };
  },
): Promise<number> {
  const { audienceKind, audienceFilter } = audience;

  const levels = audienceFilter.levels ?? [];
  const classIds = audienceFilter.classIds ?? [];
  const sectionIds = audienceFilter.sectionIds ?? [];
  const studentIds = audienceFilter.studentIds ?? [];

  const { rowCount } = await client.query(
    `INSERT INTO app.announcement_recipients
       (announcement_id, school_id, parent_id, student_id)
     SELECT DISTINCT $1, $2, l.parent_id, l.student_id
       FROM app.parent_student_links l
       JOIN app.students s ON s.id = l.student_id
       JOIN app.classes  cl ON cl.id = s.class_id
      WHERE l.school_id = $2
        AND l.status = 'actif'
        AND s.status = 'actif'
        AND (
          $3 = 'toute_ecole'
          OR ($3 = 'niveau'   AND cl.level = ANY($4::text[]))
          OR ($3 = 'classe'   AND s.class_id = ANY($5::uuid[]))
          OR ($3 = 'section'  AND s.section_id = ANY($6::uuid[]))
          OR ($3 = 'eleve'    AND s.id = ANY($7::uuid[]))
          OR ($3 = 'custom'   AND (
                s.class_id = ANY($5::uuid[])
             OR s.section_id = ANY($6::uuid[])
             OR s.id = ANY($7::uuid[])
             OR cl.level = ANY($4::text[])))
        )
     ON CONFLICT (announcement_id, parent_id, student_id) DO NOTHING`,
    [
      announcementId,
      schoolId,
      audienceKind,
      levels.length ? levels : null,
      classIds.length ? classIds : null,
      sectionIds.length ? sectionIds : null,
      studentIds.length ? studentIds : null,
    ],
  );

  return rowCount ?? 0;
}

/* ==========================================================================
 *  Conversion de texte extrait en HTML éditable
 * ========================================================================== */

const VARIABLE_LABELS: Record<string, string> = {
  NOM_ECOLE: 'Nom officiel de l’établissement',
  CODE_ECOLE: 'Code unique de l’école',
  LOGO: 'Logo de l’établissement',
  DATE: 'Date du jour',
  HEURE: 'Heure',
  LIEU: 'Lieu',
  CLASSE: 'Classe concernée',
  SECTION: 'Section concernée',
  OBJET: 'Objet du communiqué',
  MESSAGE: 'Corps du message',
  SIGNATURE: 'Signature et fonction',
  NOM_DIRECTEUR: 'Nom du responsable',
  FONCTION: 'Fonction du responsable',
  ANNEE_SCOLAIRE: 'Année scolaire en cours',
  TELEPHONE: 'Téléphone de l’école',
  ADRESSE: 'Adresse de l’école',
  ELEVE: 'Nom de l’élève',
  NOM_ELEVE: 'Nom de l’élève',
};

/** Convertit du texte brut en paragraphes HTML sûrs (échappement inclus). */
function textToEditableHtml(text: string): string {
  const escapeHtml = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n').map((l) => escapeHtml(l.trim()));
      // Une ligne courte et seule ressemble à un titre
      if (lines.length === 1 && lines[0]!.length <= 80 && lines[0] === lines[0]!.toUpperCase()) {
        return `<h2>${lines[0]}</h2>`;
      }
      return `<p>${lines.join('<br>')}</p>`;
    })
    .join('\n');
}

/**
 * Convertit un DOCX en HTML éditable.
 * On extrait le XML du document et on conserve la structure utile : titres,
 * paragraphes, gras, italique, tableaux simples. Les images et styles
 * complexes ne sont pas repris ; le fichier d'origine reste conservé pour
 * l'impression du document officiel.
 */
async function docxToHtml(buffer: Buffer): Promise<string> {
  const { default: JSZip } = await import('jszip').catch(() => ({ default: null as any }));

  // Repli sans dépendance : extraction du texte brut depuis le XML.
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  if (JSZip) {
    try {
      const zip = await JSZip.loadAsync(buffer);
      const doc = zip.file('word/document.xml');
      if (!doc) return '<p><em>Document Word illisible.</em></p>';
      const xml = await doc.async('string');
      return convertWordXml(xml);
    } catch {
      /* on passe au repli */
    }
  }

  // Repli : recherche des paragraphes dans le binaire (utile pour le texte simple)
  const raw = buffer.toString('binary');
  const paragraphs = [...raw.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1] ?? '');
  return paragraphs.length
    ? `<p>${escapeHtml(paragraphs.join(' '))}</p>`
    : '<p><em>Impossible d’extraire le contenu de ce document. Saisissez le texte du modèle manuellement.</em></p>';
}

/** Conversion structurelle du XML WordprocessingML en HTML. */
function convertWordXml(xml: string): string {
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const out: string[] = [];

  // Chaque paragraphe Word devient un paragraphe HTML ; le style permet de
  // reconnaître les titres.
  for (const paraMatch of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const para = paraMatch[0];
    const style = /<w:pStyle w:val="([^"]+)"/.exec(para)?.[1] ?? '';
    const isHeading = /heading|titre|title/i.test(style);

    let text = '';
    for (const runMatch of para.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)) {
      const run = runMatch[0];
      const parts = [...run.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1] ?? '');
      if (parts.length === 0) continue;
      let chunk = escapeHtml(parts.join(''));
      if (/<w:b\b/.test(run)) chunk = `<strong>${chunk}</strong>`;
      if (/<w:i\b/.test(run)) chunk = `<em>${chunk}</em>`;
      if (/<w:u\b/.test(run)) chunk = `<u>${chunk}</u>`;
      text += chunk;
    }

    // Sauts de ligne explicites
    text = text.replace(/<w:br\b[^>]*\/?>/g, '<br>');

    if (text.trim()) {
      out.push(isHeading ? `<h2>${text}</h2>` : `<p>${text}</p>`);
    }
  }

  // Tableaux simples
  for (const tableMatch of xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)) {
    const rows: string[] = [];
    for (const rowMatch of tableMatch[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)) {
        const cellText = [...cellMatch[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
          .map((m) => m[1] ?? '')
          .join(' ');
        cells.push(`<td>${escapeHtml(cellText)}</td>`);
      }
      if (cells.length) rows.push(`<tr>${cells.join('')}</tr>`);
    }
    if (rows.length) out.push(`<table><tbody>${rows.join('')}</tbody></table>`);
  }

  return out.length
    ? out.join('\n')
    : '<p><em>Document Word vide ou structure non reconnue. Saisissez le contenu du modèle.</em></p>';
}
