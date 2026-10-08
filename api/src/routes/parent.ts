/**
 * ============================================================================
 *  MWANA CLASSE — Interface Parent
 * ============================================================================
 *  Le parent ne configure RIEN : il saisit le code unique de son enfant, et
 *  le système récupère automatiquement le nom complet, la classe, la section
 *  et l'établissement.
 *
 *  Chaque route vérifie que le parent est bien rattaché à l'enfant concerné
 *  (liaison « actif ») avant de renvoyer la moindre donnée.
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
  sendError,
  noStore,
} from '../http/middleware.js';
import { AUDIT_ACTIONS } from '../security/audit.js';
import { normalizeStudentCode } from '../security/codes.js';

const uuid = z.string().uuid('Identifiant invalide.');
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();

export async function registerParentRoutes(deps: AppDependencies): Promise<void> {
  const { app, db, audit, secrets, guard } = deps;

  const authDeps = {
    db,
    sessions: deps.sessions,
    jwtVerify: (token: string) => app.jwt.verify(token) as Record<string, any>,
  };

  const guardHooks = [requireAuth(authDeps), requireAudience('parent')];

  /** Vérifie que le parent a bien un accès actif à cet enfant. */
  async function assertAccess(
    client: import('pg').PoolClient,
    parentId: string,
    studentId: string,
  ): Promise<{ student_id: string; school_id: string; full_name: string }> {
    const { rows } = await client.query<{
      student_id: string;
      school_id: string;
      full_name: string;
    }>(
      `SELECT l.student_id, l.school_id, s.full_name
         FROM app.parent_student_links l
         JOIN app.students s ON s.id = l.student_id
        WHERE l.parent_id = $1 AND l.student_id = $2 AND l.status = 'actif'`,
      [parentId, studentId],
    );

    const row = rows[0];
    if (!row) {
      const err = new Error(
        'Vous n’avez pas accès aux informations de cet élève. ' +
          'Vérifiez le code saisi ou contactez l’école.',
      ) as Error & { statusCode?: number; code?: string };
      err.statusCode = 403;
      err.code = 'ACCES_ENFANT_REFUSE';
      throw err;
    }
    return row;
  }

  /**
   * École sélectionnée dans l'interface parent (`?ecoleId=`).
   * `null` = toutes les écoles rattachées au compte.
   */
  function ecoleIdCourante(req: FastifyRequest): string | null {
    const raw = (req.query as any)?.ecoleId;
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const parsed = uuid.safeParse(raw.trim());
    return parsed.success ? parsed.data : null;
  }

  /* ====================================================================== */
  /*  TABLEAU DE BORD PARENT                                                */
  /* ====================================================================== */

  app.get('/api/parent/tableau-de-bord', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const ecoleId = ecoleIdCourante(req);

    const data = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      // Mes enfants avec leur présence du jour
      const children = await client.query(
        `SELECT s.id, s.full_name, s.public_code, s.gender, s.date_of_birth, s.photo_url,
                cl.name AS classe, cl.id AS class_id,
                sec.name AS section, sec.id AS section_id,
                sch.id AS school_id, sch.official_name AS ecole,
                sch.primary_color, sch.logo_url,
                l.id AS lien_id, l.status AS lien_statut, l.is_primary,
                coalesce(a.status::text, 'non_enregistre') AS presence,
                a.arrival_time, a.recorded_at, a.recorded_offline_at
           FROM app.parent_student_links l
           JOIN app.students s ON s.id = l.student_id
           JOIN app.classes cl ON cl.id = s.class_id
           LEFT JOIN app.sections sec ON sec.id = s.section_id
           JOIN app.schools sch ON sch.id = s.school_id
           LEFT JOIN app.attendance a ON a.student_id = s.id AND a.attendance_date = CURRENT_DATE
          WHERE l.parent_id = $1
            AND ($2::uuid IS NULL OR sch.id = $2)
          ORDER BY l.status = 'actif' DESC, sch.official_name, s.full_name`,
        [parentId, ecoleId],
      );

      // Derniers communiqués non lus
      const announcements = await client.query(
        `SELECT a.id, a.title, a.subject, a.summary, a.kind, a.is_urgent, a.published_at,
                r.read_at, sch.official_name AS ecole, s.full_name AS eleve
           FROM app.announcement_recipients r
           JOIN app.announcements a ON a.id = r.announcement_id
           JOIN app.schools sch ON sch.id = a.school_id
           LEFT JOIN app.students s ON s.id = r.student_id
          WHERE r.parent_id = $1 AND a.status = 'publie'
            AND (a.expires_at IS NULL OR a.expires_at > now())
            AND ($2::uuid IS NULL OR a.school_id = $2)
          ORDER BY r.read_at NULLS FIRST, a.published_at DESC
          LIMIT 10`,
        [parentId, ecoleId],
      );

      const unread = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM app.announcement_recipients r
           JOIN app.announcements a ON a.id = r.announcement_id
          WHERE r.parent_id = $1 AND r.read_at IS NULL AND a.status = 'publie'
            AND ($2::uuid IS NULL OR a.school_id = $2)`,
        [parentId, ecoleId],
      );

      // Prochains événements du calendrier des écoles concernées
      const calendar = await client.query(
        `SELECT e.id, e.kind, e.title, e.starts_on, e.ends_on, e.start_time, e.location,
                sch.official_name AS ecole
           FROM app.calendar_events e
           JOIN app.schools sch ON sch.id = e.school_id
          WHERE e.is_published
            AND e.school_id IN (
              SELECT DISTINCT l.school_id FROM app.parent_student_links l
               WHERE l.parent_id = $1 AND l.status = 'actif')
            AND ($2::uuid IS NULL OR e.school_id = $2)
            AND coalesce(e.ends_on, e.starts_on) >= CURRENT_DATE
          ORDER BY e.starts_on
          LIMIT 8`,
        [parentId, ecoleId],
      );

      // Demandes en cours
      const requests = await client.query(
        `SELECT r.id, r.reference, r.subject, r.kind, r.status, r.created_at,
                (SELECT count(*) FROM app.request_messages m
                  WHERE m.request_id = r.id AND m.author_type = 'ecole')::int AS reponses
           FROM app.requests r
          WHERE r.parent_id = $1 AND r.status NOT IN ('cloture','annule')
            AND ($2::uuid IS NULL OR r.school_id = $2)
          ORDER BY r.created_at DESC LIMIT 5`,
        [parentId, ecoleId],
      );

      const notifications = await client.query(
        `SELECT id, kind, title, body, severity, entity_type, entity_id, action_url, read_at, created_at
           FROM app.notifications
          WHERE parent_id = $1 AND audience = 'parent'
            AND ($2::uuid IS NULL OR school_id = $2)
          ORDER BY created_at DESC LIMIT 20`,
        [parentId, ecoleId],
      );

      // Résumé de présence du mois en cours, par enfant
      const summaries = await client.query(
        `SELECT a.student_id,
                count(*) FILTER (WHERE a.status = 'present')::int AS presents,
                count(*) FILTER (WHERE a.status = 'absent')::int  AS absents,
                count(*) FILTER (WHERE a.status = 'retard')::int  AS retards
           FROM app.attendance a
           JOIN app.parent_student_links l ON l.student_id = a.student_id
          WHERE l.parent_id = $1 AND l.status = 'actif'
            AND ($2::uuid IS NULL OR l.school_id = $2)
            AND a.attendance_date >= date_trunc('month', CURRENT_DATE)
          GROUP BY a.student_id`,
        [parentId, ecoleId],
      );

      const summaryByStudent = new Map(
        summaries.rows.map((r: any) => [r.student_id, r]),
      );

      const childrenEnriched = children.rows.map((c: any) => {
        const s: any = summaryByStudent.get(c.id);
        return {
          ...c,
          resumeMois: s
            ? { presents: s.presents, absents: s.absents, retards: s.retards }
            : { presents: 0, absents: 0, retards: 0 },
          statutAujourdhui:
            c.lien_statut !== 'actif'
              ? { code: 'acces_en_attente', libelle: 'Accès en attente de validation par l’école', icone: '⏳' }
              : c.presence === 'present'
                ? { code: 'present', libelle: 'Présent à l’école', icone: '🟢' }
                : c.presence === 'absent'
                  ? { code: 'absent', libelle: 'Absent', icone: '🔴' }
                  : c.presence === 'retard'
                    ? { code: 'retard', libelle: `Retard${c.arrival_time ? ` — arrivé à ${String(c.arrival_time).slice(0, 5)}` : ''}`, icone: '🟠' }
                    : c.presence === 'depart_anticipe'
                      ? { code: 'depart_anticipe', libelle: 'Départ anticipé', icone: '🟡' }
                      : { code: 'non_enregistre', libelle: 'Présence non encore enregistrée', icone: '⚪' },
        };
      });

      return {
        enfants: childrenEnriched,
        communiques: {
          derniers: announcements.rows,
          nonLus: unread.rows[0]?.n ?? 0,
        },
        calendrier: calendar.rows,
        demandes: requests.rows,
        notifications: {
          dernieres: notifications.rows,
          nonLues: notifications.rows.filter((n: any) => !n.read_at).length,
        },
        precision: {
          avertissement:
            'MwanaClasse indique si l’école a enregistré une présence. ' +
            'L’application ne connaît pas la position physique réelle de votre enfant.',
        },
      };
    });

    return noStore(reply).send(data);
  });

  /* ====================================================================== */
  /*  AJOUTER UN ENFANT (par code unique)                                   */
  /* ====================================================================== */

  app.post('/api/parent/enfants', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const parsed = z
      .object({
        codeEnfant: z.string().trim().min(6).max(32),
        relation: z
          .enum(['pere', 'mere', 'tuteur', 'oncle', 'tante', 'grand_parent', 'frere', 'soeur', 'parent', 'autre'])
          .default('parent'),
        deviceId: optionalText(120),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Le code de l’enfant est obligatoire.');
    }

    const studentCode = normalizeStudentCode(parsed.data.codeEnfant);
    const ip = clientIp(req);

    const result = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const quota = await guard.consume(client, 'code_lookup', { kind: 'parent', key: parentId });
      if (!quota.allowed) {
        const err = new Error('Trop de tentatives. Patientez avant de réessayer.') as Error & {
          statusCode?: number;
          code?: string;
        };
        err.statusCode = 429;
        err.code = 'TROP_DE_RECHERCHES';
        throw err;
      }

      // Le code élève est suffisant pour retrouver l'enfant, quel que soit
      // l'établissement : un même parent peut rattacher plusieurs écoles.
      const { rows } = await client.query<{
        student_id: string;
        full_name: string;
        first_name: string;
        gender: string | null;
        date_of_birth: string | null;
        public_code: string;
        class_id: string;
        classe: string;
        section: string | null;
        section_id: string | null;
        school_id: string;
        ecole: string;
        parent_link_mode: string;
        logo_url: string | null;
        primary_color: string;
        photo_url: string | null;
        existing_link_id: string | null;
        existing_status: string | null;
      }>(
        `SELECT s.id AS student_id, s.full_name, s.first_name, s.gender, s.date_of_birth,
                s.public_code, s.class_id, cl.name AS classe,
                sec.name AS section, sec.id AS section_id,
                sch.id AS school_id, sch.official_name AS ecole,
                sch.parent_link_mode, sch.logo_url, sch.primary_color, s.photo_url,
                l.id AS existing_link_id, l.status::text AS existing_status
           FROM app.students s
           JOIN app.classes cl ON cl.id = s.class_id
           LEFT JOIN app.sections sec ON sec.id = s.section_id
           JOIN app.schools sch ON sch.id = s.school_id
           LEFT JOIN app.parent_student_links l
                  ON l.student_id = s.id AND l.parent_id = $1
          WHERE s.public_code = $2 AND sch.is_active`,
        [parentId, studentCode],
      );

      const student = rows[0];

      await audit.write(client, {
        actorKind: 'parent',
        actorId: parentId,
        actorLabel: req.auth!.displayName,
        actorIp: ip,
        actorDevice: parsed.data.deviceId ?? null,
        schoolId: student?.school_id ?? null,
      }, {
        action: AUDIT_ACTIONS.STUDENT_CODE_LOOKUP,
        severity: student ? 'info' : 'notice',
        result: student ? 'succes' : 'echec',
        entityType: 'student',
        entityId: student?.student_id ?? null,
        payload: {
          code_enfant: studentCode,
          trouve: Boolean(student),
          etape: 'enfant',
        },
      });

      if (!student) {
        const err = new Error(
          'Aucun élève ne correspond à ce code. Vérifiez le code unique de votre enfant ' +
            'tel qu’il figure sur la fiche remise par l’établissement.',
        ) as Error & { statusCode?: number; code?: string };
        err.statusCode = 404;
        err.code = 'ELEVE_INTROUVABLE';
        throw err;
      }

      // Déjà connecté : on renvoie l'état existant sans créer de doublon.
      if (student.existing_link_id) {
        return {
          student,
          link: { id: student.existing_link_id, status: student.existing_status },
          created: false,
        };
      }

      // Mode automatique : accès immédiat. Mode validation : accord de l'école.
      const autoApprove = student.parent_link_mode === 'automatique';
      const status = autoApprove ? 'actif' : 'en_attente';

      // Premier parent rattaché => responsable principal
      // (on ne recrée jamais de lien principal tant qu'un lien principal
      //  non terminé existe : index unique links_one_primary)
      const isPrimary = (
        await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM app.parent_student_links
            WHERE student_id = $1 AND is_primary AND status IN ('actif','en_attente')`,
          [student.student_id],
        )
      ).rows[0]!.n === '0';

      const { rows: linkRows } = await client.query<{ id: string; status: string }>(
        `INSERT INTO app.parent_student_links
           (school_id, parent_id, student_id, relationship, status, is_primary,
            requested_ip, requested_device, requested_method,
            decided_at, decision_note)
         VALUES ($1,$2,$3,$4,$5::app.link_status,$6,$7,$8,'code_enfant',
                 CASE WHEN $5 = 'actif' THEN now() ELSE NULL END,
                 CASE WHEN $5 = 'actif' THEN 'Validation automatique (configuration de l''école)' ELSE NULL END)
         ON CONFLICT (parent_id, student_id) DO UPDATE SET
           status = EXCLUDED.status,
           relationship = EXCLUDED.relationship
         RETURNING id, status`,
        [
          student.school_id,
          parentId,
          student.student_id,
          parsed.data.relation,
          status,
          isPrimary && autoApprove,
          ip,
          parsed.data.deviceId ?? null,
        ],
      );

      await audit.write(client, {
        actorKind: 'parent',
        actorId: parentId,
        actorLabel: req.auth!.displayName,
        actorIp: ip,
        schoolId: student.school_id,
      }, {
        action: autoApprove ? AUDIT_ACTIONS.LINK_AUTO_APPROVED : AUDIT_ACTIONS.LINK_REQUESTED,
        severity: autoApprove ? 'info' : 'notice',
        result: 'succes',
        entityType: 'student',
        entityId: student.student_id,
        entityLabel: student.full_name,
        payload: {
          mode: student.parent_link_mode,
          relation: parsed.data.relation,
          responsable_principal: isPrimary && autoApprove,
        },
      });

      // L'école est prévenue qu'un parent demande l'accès.
      if (!autoApprove) {
        await client.query(
          `INSERT INTO app.notifications
             (school_id, audience, kind, title, body, severity, entity_type, entity_id, action_url)
           VALUES ($1,'ecole','parent_a_valider',$2,$3,'attention','student',$4,'/ecole/parents')`,
          [
            student.school_id,
            'Nouvelle demande de connexion parent',
            `${req.auth!.displayName} souhaite accéder au suivi de ${student.full_name} (${student.classe}).`,
            student.student_id,
          ],
        );
      }

      return { student, link: linkRows[0]!, created: true, autoApprove };
    });

    const s = result.student;

    return noStore(reply).code(result.created ? 201 : 200).send({
      message: result.created
        ? result.autoApprove
          ? `${s.full_name} a été connecté à votre compte.`
          : `Demande envoyée à ${s.ecole}. Vous serez prévenu dès la validation.`
        : `${s.full_name} est déjà connecté à votre compte.`,
      eleve: {
        id: s.student_id,
        nomComplet: s.full_name,
        prenom: s.first_name,
        code: s.public_code,
        classe: s.classe,
        section: s.section,
        ecole: s.ecole,
        sexe: s.gender,
        dateNaissance: s.date_of_birth,
        photo: s.photo_url,
        couleurEcole: s.primary_color,
        logo: s.logo_url,
      },
      liaison: {
        id: result.link.id,
        statut: result.link.status,
        validationRequise: result.link.status === 'en_attente',
      },
    });
  });

  /* ====================================================================== */
  /*  MES ENFANTS                                                           */
  /* ====================================================================== */

  app.get('/api/parent/enfants', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;

    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT s.id, s.full_name, s.public_code, s.gender, s.date_of_birth, s.photo_url,
                cl.name AS classe, cl.id AS class_id,
                sec.name AS section, sec.id AS section_id,
                sch.id AS school_id,
                sch.official_name AS ecole, sch.primary_color, sch.logo_url,
                l.status AS lien_statut, l.relationship, l.is_primary, l.requested_at,
                coalesce(a.status::text,'non_enregistre') AS presence_aujourdhui,
                a.arrival_time
           FROM app.parent_student_links l
           JOIN app.students s ON s.id = l.student_id
           JOIN app.classes cl ON cl.id = s.class_id
           LEFT JOIN app.sections sec ON sec.id = s.section_id
           JOIN app.schools sch ON sch.id = s.school_id
           LEFT JOIN app.attendance a ON a.student_id = s.id AND a.attendance_date = CURRENT_DATE
          WHERE l.parent_id = $1
          ORDER BY l.status = 'actif' DESC, s.full_name`,
        [parentId],
      );
      return rows;
    });

    return noStore(reply).send({ enfants: rows });
  });

  /* ====================================================================== */
  /*  FICHE D'UN ENFANT                                                     */
  /* ====================================================================== */

  app.get('/api/parent/enfants/:id', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const studentId = String((req.params as any).id);

    const data = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      await assertAccess(client, parentId, studentId);

      const info = await client.query(
        `SELECT s.id, s.full_name, s.public_code, s.gender, s.date_of_birth, s.photo_url,
                cl.name AS classe, sec.name AS section,
                sch.official_name AS ecole, sch.primary_color,
                sch.logo_url, sch.phone_contact, sch.email AS email_ecole,
                ay.label AS annee_scolaire,
                l.relationship, l.is_primary, l.status AS lien_statut,
                coalesce(a.status::text,'non_enregistre') AS presence_aujourdhui,
                a.arrival_time, a.departure_time, a.recorded_at, a.recorded_offline_at,
                a.method, a.reason
           FROM app.students s
           JOIN app.classes cl ON cl.id = s.class_id
           LEFT JOIN app.sections sec ON sec.id = s.section_id
           JOIN app.schools sch ON sch.id = s.school_id
           JOIN app.academic_years ay ON ay.id = s.academic_year_id
           JOIN app.parent_student_links l ON l.student_id = s.id AND l.parent_id = $1
           LEFT JOIN app.attendance a ON a.student_id = s.id AND a.attendance_date = CURRENT_DATE
          WHERE s.id = $2`,
        [parentId, studentId],
      );

      const summary = await client.query(
        `SELECT count(*) FILTER (WHERE status = 'present')::int AS presents,
                count(*) FILTER (WHERE status = 'absent')::int  AS absents,
                count(*) FILTER (WHERE status = 'retard')::int  AS retards,
                count(*) FILTER (WHERE status = 'depart_anticipe')::int AS departs
           FROM app.attendance
          WHERE student_id = $1 AND status <> 'non_enregistre'
            AND attendance_date >= CURRENT_DATE - INTERVAL '30 days'`,
        [studentId],
      );

      const unread = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM app.announcement_recipients r
           JOIN app.announcements a ON a.id = r.announcement_id
          WHERE r.parent_id = $1 AND r.read_at IS NULL AND a.status = 'publie'
            AND (r.student_id = $2 OR r.student_id IS NULL)`,
        [parentId, studentId],
      );

      return {
        eleve: info.rows[0],
        resume30Jours: summary.rows[0],
        communiquesNonLus: unread.rows[0]?.n ?? 0,
        clarification:
          'Ce statut reflète l’enregistrement fait par l’école. ' +
          'Il ne s’agit pas d’une géolocalisation.',
      };
    });

    return noStore(reply).send(data);
  });

  /* ====================================================================== */
  /*  PRÉSENCE DU JOUR ET HISTORIQUE                                        */
  /* ====================================================================== */

  app.get('/api/parent/enfants/:id/presence', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const studentId = String((req.params as any).id);

    const data = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      await assertAccess(client, parentId, studentId);

      const today = await client.query(
        `SELECT attendance_date, status, arrival_time, departure_time, reason,
                recorded_at, recorded_offline_at, method, recorded_by_name
           FROM app.attendance
          WHERE student_id = $1 AND attendance_date = CURRENT_DATE`,
        [studentId],
      );

      return {
        aujourdhui: today.rows[0] ?? {
          status: 'non_enregistre',
          attendance_date: new Date().toISOString().slice(0, 10),
        },
      };
    });

    return noStore(reply).send(data);
  });

  app.get('/api/parent/enfants/:id/historique', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const studentId = String((req.params as any).id);
    const mois = String((req.query as any)?.mois ?? '').trim(); // 'AAAA-MM'

    const data = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      await assertAccess(client, parentId, studentId);

      const resume = await client.query(
        `SELECT to_char(attendance_date, 'YYYY-MM') AS mois,
                count(*) FILTER (WHERE status = 'present')::int         AS presents,
                count(*) FILTER (WHERE status = 'absent')::int          AS absents,
                count(*) FILTER (WHERE status = 'retard')::int          AS retards,
                count(*) FILTER (WHERE status = 'depart_anticipe')::int AS departs
           FROM app.attendance
          WHERE student_id = $1 AND status <> 'non_enregistre'
          GROUP BY 1 ORDER BY 1 DESC LIMIT 24`,
        [studentId],
      );

      const details = await client.query(
        `SELECT attendance_date, status, arrival_time, departure_time, reason
           FROM app.attendance
          WHERE student_id = $1
            AND ($2::text IS NULL OR to_char(attendance_date, 'YYYY-MM') = $2)
          ORDER BY attendance_date DESC
          LIMIT 500`,
        [studentId, mois || null],
      );

      return { resumeMensuel: resume.rows, jours: details.rows };
    });

    return noStore(reply).send(data);
  });

  /* ====================================================================== */
  /*  COMMUNIQUÉS                                                           */
  /* ====================================================================== */

  app.get('/api/parent/communiques', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const onlyUnread = (req.query as any)?.nonLus === 'true';
    const ecoleId = ecoleIdCourante(req);

    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT a.id, a.reference, a.title, a.subject, a.summary, a.body_html, a.kind,
                a.is_urgent, a.published_at, a.attachment_name, a.pdf_url,
                a.school_id, sch.official_name AS ecole, sch.primary_color,
                r.read_at, r.delivered_at, r.student_id,
                s.full_name AS eleve, cl.name AS classe, sec.name AS section
           FROM app.announcement_recipients r
           JOIN app.announcements a ON a.id = r.announcement_id
           JOIN app.schools sch ON sch.id = a.school_id
           LEFT JOIN app.students s ON s.id = r.student_id
           LEFT JOIN app.classes cl ON cl.id = s.class_id
           LEFT JOIN app.sections sec ON sec.id = s.section_id
          WHERE r.parent_id = $1
            AND a.status = 'publie'
            AND (a.expires_at IS NULL OR a.expires_at > now())
            AND ($2::boolean = false OR r.read_at IS NULL)
            AND ($3::uuid IS NULL OR a.school_id = $3)
          ORDER BY r.read_at NULLS FIRST, a.is_urgent DESC, a.published_at DESC
          LIMIT 200`,
        [parentId, onlyUnread, ecoleId],
      );
      return rows;
    });

    return noStore(reply).send({
      communiques: rows,
      nonLus: rows.filter((r: any) => !r.read_at).length,
    });
  });

  app.get('/api/parent/communiques/:id', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const id = String((req.params as any).id);

    const data = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT a.id, a.reference, a.title, a.subject, a.summary, a.body_html, a.kind,
                a.is_urgent, a.published_at, a.attachment_name, a.attachment_url, a.pdf_url,
                sch.official_name AS ecole, sch.logo_url, sch.primary_color,
                sch.address_line, sch.city, sch.phone_contact, sch.signature_name, sch.signature_title,
                r.read_at, r.id AS recipient_id
           FROM app.announcement_recipients r
           JOIN app.announcements a ON a.id = r.announcement_id
           JOIN app.schools sch ON sch.id = a.school_id
          WHERE r.parent_id = $1 AND a.id = $2 AND a.status = 'publie'`,
        [parentId, id],
      );

      const announcement = rows[0];
      if (!announcement) {
        const err = new Error('Communiqué introuvable.') as Error & { statusCode?: number; code?: string };
        err.statusCode = 404;
        err.code = 'COMMUNIQUE_INTROUVABLE';
        throw err;
      }

      // Accusé de lecture : enregistré à la première ouverture.
      if (!announcement.read_at) {
        await client.query(
          `UPDATE app.announcement_recipients SET read_at = now(), delivered_at = coalesce(delivered_at, now())
            WHERE id = $1`,
          [announcement.recipient_id],
        );
        await audit.write(client, {
          actorKind: 'parent',
          actorId: parentId,
          actorLabel: req.auth!.displayName,
          actorIp: clientIp(req),
          schoolId: null,
        }, {
          action: AUDIT_ACTIONS.ANNOUNCEMENT_READ,
          severity: 'info',
          result: 'succes',
          entityType: 'announcement',
          entityId: id,
          entityLabel: announcement.title,
        });
      }

      return { communique: { ...announcement, read_at: announcement.read_at ?? new Date().toISOString() } };
    });

    return noStore(reply).send(data);
  });

  app.post('/api/parent/communiques/lus', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const ecoleId = ecoleIdCourante(req);
    const parsed = z.object({ ids: z.array(uuid).max(500).optional() }).safeParse(req.body ?? {});

    const count = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const res = await client.query(
        `UPDATE app.announcement_recipients r SET read_at = now()
           FROM app.announcements a
          WHERE a.id = r.announcement_id
            AND r.parent_id = $1 AND r.read_at IS NULL
            AND ($2::uuid[] IS NULL OR r.announcement_id = ANY($2))
            AND ($3::uuid IS NULL OR a.school_id = $3)`,
        [
          parentId,
          parsed.success && parsed.data.ids?.length ? parsed.data.ids : null,
          ecoleId,
        ],
      );
      return res.rowCount ?? 0;
    });

    return noStore(reply).send({ message: `${count} communiqué(s) marqué(s) comme lu(s).` });
  });

  /* ====================================================================== */
  /*  CALENDRIER PARENT                                                     */
  /* ====================================================================== */

  app.get('/api/parent/calendrier', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const ecoleId = ecoleIdCourante(req);

    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT DISTINCT e.id, e.kind, e.title, e.description, e.starts_on, e.ends_on,
                e.start_time, e.end_time, e.all_day, e.location,
                e.school_id, sch.official_name AS ecole,
                CASE
                  WHEN e.audience_kind = 'toute_ecole' THEN 'Toute l’école'
                  WHEN e.audience_kind = 'classe' THEN 'Classe concernée'
                  ELSE 'Concerné'
                END AS portee,
                (SELECT string_agg(DISTINCT s.full_name, ', ')
                   FROM app.parent_student_links l
                   JOIN app.students s ON s.id = l.student_id
                  WHERE l.parent_id = $1 AND l.status = 'actif'
                    AND (e.audience_kind = 'toute_ecole'
                         OR (e.audience_kind = 'classe'
                             AND s.class_id::text = ANY(
                                   SELECT jsonb_array_elements_text(
                                     coalesce(e.audience_filter->'classIds','[]'::jsonb)))))
                ) AS enfants_concernes
           FROM app.calendar_events e
           JOIN app.schools sch ON sch.id = e.school_id
          WHERE e.is_published
            AND e.school_id IN (SELECT DISTINCT school_id FROM app.parent_student_links
                                 WHERE parent_id = $1 AND status = 'actif')
            AND ($2::uuid IS NULL OR e.school_id = $2)
            AND coalesce(e.ends_on, e.starts_on) >= CURRENT_DATE - INTERVAL '7 days'
          ORDER BY e.starts_on
          LIMIT 200`,
        [parentId, ecoleId],
      );
      return rows;
    });

    // Regroupement par semaine, comme attendu dans l'agenda parent
    const thisWeek: any[] = [];
    const later: any[] = [];
    const now = new Date();
    const weekEnd = new Date(now.getTime() + 7 * 86_400_000);
    for (const e of rows) {
      const start = new Date(e.starts_on);
      (start <= weekEnd ? thisWeek : later).push(e);
    }

    return noStore(reply).send({ cetteSemaine: thisWeek, aVenir: later, tous: rows });
  });

  /* ====================================================================== */
  /*  DOCUMENTS DE L'ÉCOLE                                                  */
  /* ====================================================================== */

  app.get('/api/parent/documents', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const ecoleId = ecoleIdCourante(req);

    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT d.id, d.category, d.title, d.description, d.file_url, d.file_name,
                d.mime_type, d.file_size, d.created_at,
                d.school_id, sch.official_name AS ecole
           FROM app.school_documents d
           JOIN app.schools sch ON sch.id = d.school_id
          WHERE d.is_active
            AND d.visibility = 'parents'
            AND d.school_id IN (SELECT DISTINCT school_id FROM app.parent_student_links
                                 WHERE parent_id = $1 AND status = 'actif')
            AND ($2::uuid IS NULL OR d.school_id = $2)
          ORDER BY d.category, d.created_at DESC`,
        [parentId, ecoleId],
      );
      return rows;
    });

    return noStore(reply).send({ documents: rows });
  });

  /* ====================================================================== */
  /*  DEMANDES DU PARENT                                                    */
  /* ====================================================================== */

  app.get('/api/parent/demandes', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const ecoleId = ecoleIdCourante(req);

    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT r.id, r.reference, r.kind, r.subject, r.message, r.status, r.priority,
                r.absence_date, r.absence_reason, r.justification_decision,
                r.created_at, r.handled_at, r.closed_at, r.school_id,
                s.full_name AS eleve, cl.name AS classe,
                (SELECT coalesce(json_agg(json_build_object(
                          'auteur', m.author_type, 'nom', m.author_name,
                          'message', m.body, 'date', m.created_at)
                        ORDER BY m.created_at), '[]'::json)
                   FROM app.request_messages m
                  WHERE m.request_id = r.id AND m.is_internal = false) AS echanges
           FROM app.requests r
           LEFT JOIN app.students s ON s.id = r.student_id
           LEFT JOIN app.classes cl ON cl.id = s.class_id
          WHERE r.parent_id = $1
            AND ($2::uuid IS NULL OR r.school_id = $2)
          ORDER BY r.created_at DESC LIMIT 100`,
        [parentId, ecoleId],
      );
      return rows;
    });

    return noStore(reply).send({ demandes: rows });
  });

  app.post('/api/parent/demandes', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const parsed = z
      .object({
        studentId: z.string().uuid().optional().nullable(),
        kind: z.enum([
          'reclamation', 'demande_information', 'demande_derogation',
          'correction_information', 'question_presence', 'justification_absence', 'autre',
        ]),
        subject: z.string().trim().min(2).max(200),
        message: z.string().trim().min(2).max(8000),
        absenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
        absenceReason: optionalText(1000),
        clientUuid: z.string().uuid().optional().nullable(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Demande incomplète.', {
        details: parsed.error.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
      });
    }
    const input = parsed.data;

    const created = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      await guard.consume(client, 'sync', { kind: 'parent', key: parentId });

      // L'élève doit être rattaché au parent ; l'école en découle.
      let schoolId: string | null = null;
      if (input.studentId) {
        const access = await assertAccess(client, parentId, input.studentId);
        schoolId = access.school_id;
      } else {
        const { rows } = await client.query<{ school_id: string }>(
          `SELECT school_id FROM app.parent_student_links
            WHERE parent_id = $1 AND status = 'actif' LIMIT 1`,
          [parentId],
        );
        schoolId = rows[0]?.school_id ?? null;
      }

      if (!schoolId) {
        const err = new Error(
          'Connectez d’abord un enfant à votre compte pour contacter son établissement.',
        ) as Error & { statusCode?: number; code?: string };
        err.statusCode = 400;
        err.code = 'AUCUN_ENFANT_CONNECTE';
        throw err;
      }

      if (input.kind === 'justification_absence' && !input.absenceDate) {
        const err = new Error('Indiquez la date de l’absence à justifier.') as Error & {
          statusCode?: number;
          code?: string;
        };
        err.statusCode = 400;
        err.code = 'DATE_ABSENCE_REQUISE';
        throw err;
      }

      // Référence lisible pour le suivi administratif : calculée par la base
      // sous verrou par école — un comptage côté application ne voyait que les
      // demandes du parent connecté et provoquait un 409 dès la deuxième.
      const seq = await client.query<{ ref: string }>(
        `SELECT app.nouvelle_reference_demande($1) AS ref`,
        [schoolId],
      );
      const reference = seq.rows[0]?.ref ?? `DEM/${new Date().getFullYear()}/0001`;

      const { rows } = await client.query(
        `INSERT INTO app.requests
           (school_id, reference, parent_id, student_id, kind, subject, message,
            absence_date, absence_reason, priority, client_uuid)
         VALUES ($1,$2,$3,$4,$5::app.request_kind,$6,$7,$8::date,$9,$10,$11)
         ON CONFLICT (client_uuid) DO UPDATE SET updated_at = now()
         RETURNING id, reference, status, created_at`,
        [
          schoolId,
          reference,
          parentId,
          input.studentId ?? null,
          input.kind,
          input.subject,
          input.message,
          input.absenceDate ?? null,
          input.absenceReason ?? null,
          input.kind === 'justification_absence' ? 3 : 2,
          input.clientUuid ?? null,
        ],
      );

      const request = rows[0]!;

      // Le message initial est conservé dans le fil d'échanges
      await client.query(
        `INSERT INTO app.request_messages (request_id, author_type, author_id, author_name, body)
         VALUES ($1,'parent',$2,$3,$4)`,
        [request.id, parentId, req.auth!.displayName, input.message],
      );

      await audit.write(client, {
        actorKind: 'parent',
        actorId: parentId,
        actorLabel: req.auth!.displayName,
        actorIp: clientIp(req),
        schoolId,
      }, {
        action: AUDIT_ACTIONS.REQUEST_CREATED,
        severity: 'info',
        result: 'succes',
        entityType: 'request',
        entityId: request.id,
        entityLabel: request.reference,
        payload: { type: input.kind, objet: input.subject, eleve: input.studentId },
      });

      // L'administration est prévenue
      await client.query(
        `INSERT INTO app.notifications
           (school_id, audience, kind, title, body, severity, entity_type, entity_id, action_url)
         VALUES ($1,'ecole','nouvelle_demande',$2,$3,$4,'request',$5,'/ecole/demandes')`,
        [
          schoolId,
          `${input.kind === 'justification_absence' ? 'Justification d’absence' : 'Nouvelle demande'} : ${input.subject}`,
          input.message.slice(0, 400),
          input.kind === 'justification_absence' ? 'attention' : 'info',
          request.id,
        ],
      );

      return request;
    });

    return noStore(reply).code(201).send({
      message:
        'Votre demande a été transmise à l’administration. ' +
        'Vous serez informé dès qu’elle sera traitée.',
      demande: created,
    });
  });

  /** Le parent peut ajouter un message à une demande existante. */
  app.post('/api/parent/demandes/:id/messages', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const id = String((req.params as any).id);
    const parsed = z.object({ message: z.string().trim().min(1).max(8000) }).safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Message vide.');
    }

    const result = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const owned = await client.query<{ id: string; status: string; school_id: string }>(
        `SELECT id, status, school_id FROM app.requests WHERE id = $1 AND parent_id = $2`,
        [id, parentId],
      );
      if (!owned.rows[0]) {
        const err = new Error('Demande introuvable.') as Error & { statusCode?: number; code?: string };
        err.statusCode = 404;
        err.code = 'DEMANDE_INTROUVABLE';
        throw err;
      }
      if (owned.rows[0].status === 'cloture') {
        const err = new Error(
          'Cette demande est clôturée. Créez une nouvelle demande si nécessaire.',
        ) as Error & { statusCode?: number; code?: string };
        err.statusCode = 409;
        err.code = 'DEMANDE_CLOTUREE';
        throw err;
      }

      await client.query(
        `INSERT INTO app.request_messages (request_id, author_type, author_id, author_name, body)
         VALUES ($1,'parent',$2,$3,$4)`,
        [id, parentId, req.auth!.displayName, parsed.data.message],
      );

      // Une demande répondue qui reçoit un nouveau message redevient à traiter.
      await client.query(
        `UPDATE app.requests SET status = 'en_attente',
                handled_at = NULL
          WHERE id = $1 AND status IN ('repondu')`,
        [id],
      );

      await client.query(
        `INSERT INTO app.notifications
           (school_id, audience, kind, title, body, severity, entity_type, entity_id, action_url)
         VALUES ($1,'ecole','message_parent','Nouveau message d’un parent',$2,'info','request',$3,'/ecole/demandes')`,
        [owned.rows[0].school_id, parsed.data.message.slice(0, 400), id],
      );

      return { ok: true };
    });

    return noStore(reply).send({ message: 'Message ajouté à votre demande.', ...result });
  });

  /* ====================================================================== */
  /*  NOTIFICATIONS PARENT                                                  */
  /* ====================================================================== */

  app.get('/api/parent/notifications', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const ecoleId = ecoleIdCourante(req);

    const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `SELECT id, kind, title, body, severity, entity_type, entity_id, action_url, read_at, created_at
           FROM app.notifications
          WHERE parent_id = $1 AND audience = 'parent'
            AND ($2::uuid IS NULL OR school_id = $2)
          ORDER BY read_at NULLS FIRST, created_at DESC
          LIMIT 100`,
        [parentId, ecoleId],
      );
      return rows;
    });

    return noStore(reply).send({
      notifications: rows,
      nonLues: rows.filter((r: any) => !r.read_at).length,
    });
  });

  app.post('/api/parent/notifications/lues', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const ecoleId = ecoleIdCourante(req);
    const count = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const res = await client.query(
        `UPDATE app.notifications SET read_at = now()
          WHERE parent_id = $1 AND audience = 'parent' AND read_at IS NULL
            AND ($2::uuid IS NULL OR school_id = $2)`,
        [parentId, ecoleId],
      );
      return res.rowCount ?? 0;
    });
    return noStore(reply).send({ message: `${count} notification(s) marquée(s) comme lue(s).` });
  });

  /* ====================================================================== */
  /*  PROFIL PARENT                                                         */
  /* ====================================================================== */

  app.patch('/api/parent/profil', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const parsed = z
      .object({
        fullName: z.string().trim().min(3).max(160).optional(),
        email: z.string().email().optional().nullable(),
        phone: z.string().trim().max(32).optional().nullable(),
        photoUrl: optionalText(500),
        preferredLanguage: z.string().trim().max(8).optional(),
        notificationPrefs: z
          .object({
            push: z.boolean().optional(),
            email: z.boolean().optional(),
            sms: z.boolean().optional(),
            quietHours: z.string().max(40).optional().nullable(),
          })
          .optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Profil invalide.');
    }
    const input = parsed.data;

    const updated = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { rows } = await client.query(
        `UPDATE app.parents SET
           full_name = coalesce($2, full_name),
           email = coalesce($3, email),
           phone = coalesce($4, phone),
           photo_url = coalesce($5, photo_url),
           preferred_language = coalesce($6, preferred_language),
           notification_prefs = coalesce($7::jsonb, notification_prefs)
         WHERE id = $1
         RETURNING id, full_name, email, phone, photo_url, preferred_language, notification_prefs`,
        [
          parentId,
          input.fullName ?? null,
          input.email ?? null,
          input.phone ?? null,
          input.photoUrl ?? null,
          input.preferredLanguage ?? null,
          input.notificationPrefs ? JSON.stringify(input.notificationPrefs) : null,
        ],
      );
      return rows[0];
    });

    return noStore(reply).send({ message: 'Profil mis à jour.', profil: updated });
  });

  /** Appareils connectés au compte parent (sécurité du compte). */
  app.get('/api/parent/appareils', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const rows = await db.withIdentity(dbIdentityFrom(req), (client) =>
      deps.sessions.listActive(client, { parentId, staffUserId: null }),
    );
    return noStore(reply).send({
      appareils: rows,
      conseil:
        'Si vous ne reconnaissez pas un appareil, déconnectez-vous de partout puis changez votre mot de passe.',
    });
  });

  app.delete('/api/parent/appareils/:id', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const sessionId = String((req.params as any).id);

    const revoked = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const check = await client.query(
        `SELECT id FROM sec.sessions WHERE id = $1 AND parent_id = $2`,
        [sessionId, parentId],
      );
      if (!check.rows[0]) return false;
      return deps.sessions.revoke(client, sessionId, 'déconnexion demandée par le parent');
    });

    if (!revoked) {
      return sendError(reply, 404, 'SESSION_INTROUVABLE', 'Appareil introuvable.');
    }
    return noStore(reply).send({ message: 'Appareil déconnecté.' });
  });

  /* ====================================================================== */
  /*  SUPPRESSION DE COMPTE (droit à l'effacement — RGPD)                   */
  /* ====================================================================== */

  app.post('/api/parent/compte/supprimer', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;

    const parsed = z
      .object({
        password: z.string().min(1),
        confirmation: z.literal('SUPPRIMER'),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'CONFIRMATION_REQUISE',
        'Saisissez votre mot de passe et le mot SUPPRIMER pour confirmer.',
      );
    }

    await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const { verifyPassword } = await import('../security/crypto.js');
      const { rows } = await client.query<{ password_hash: string }>(
        `SELECT password_hash FROM sec.parent_credentials WHERE parent_id = $1`,
        [parentId],
      );

      const check = await verifyPassword(parsed.data.password, rows[0]?.password_hash ?? '', secrets.passwordPeppers());
      if (!check.ok) {
        const err = new Error('Mot de passe incorrect.') as Error & { statusCode?: number; code?: string };
        err.statusCode = 401;
        err.code = 'MOT_DE_PASSE_INCORRECT';
        throw err;
      }

      // Effacement : les liaisons et identifiants sont supprimés, le profil est
      // anonymisé. L'historique de présence de l'élève appartient à l'école et
      // reste donc intact, conformément à son intérêt légitime de scolarité.
      await client.query(`DELETE FROM app.parent_student_links WHERE parent_id = $1`, [parentId]);
      await client.query(`DELETE FROM sec.parent_credentials WHERE parent_id = $1`, [parentId]);
      await client.query(`DELETE FROM app.push_subscriptions WHERE parent_id = $1`, [parentId]);
      await client.query(
        `UPDATE app.parents
            SET full_name = 'Compte supprimé', email = NULL, phone = NULL,
                photo_url = NULL, is_active = false
          WHERE id = $1`,
        [parentId],
      );

      await audit.write(client, {
        actorKind: 'parent',
        actorId: parentId,
        actorIp: clientIp(req),
        schoolId: null,
      }, {
        action: AUDIT_ACTIONS.GDPR_ERASURE,
        severity: 'warning',
        result: 'succes',
        entityType: 'parent',
        entityId: parentId,
        payload: {
          motif: 'demande du parent',
          conserve: 'historique de présence conservé par l’établissement',
        },
      });
    });

    reply.clearCookie('mwana_rt', { path: '/api/auth' });
    return noStore(reply).send({
      message:
        'Votre compte a été supprimé. Les informations conservées par l’école ' +
        '(présences, scolarité) restent sous sa responsabilité.',
    });
  });

  /* ====================================================================== */
  /*  RECHERCHE DANS SES PROPRES DONNÉES                                    */
  /* ====================================================================== */

  app.get('/api/parent/recherche', { preHandler: guardHooks }, async (req, reply) => {
    const parentId = req.auth!.userId;
    const q = String((req.query as any)?.q ?? '').trim();
    if (q.length < 2) {
      return noStore(reply).send({ enfants: [], communiques: [], demandes: [] });
    }
    const key = q.toLowerCase();

    const result = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const children = await client.query(
        `SELECT s.id, s.full_name, cl.name AS classe, s.public_code
           FROM app.parent_student_links l
           JOIN app.students s ON s.id = l.student_id
           JOIN app.classes cl ON cl.id = s.class_id
          WHERE l.parent_id = $1 AND s.search_name LIKE '%' || $2 || '%'
          LIMIT 10`,
        [parentId, key],
      );

      const announcements = await client.query(
        `SELECT DISTINCT a.id, a.title, a.published_at, a.is_urgent
           FROM app.announcement_recipients r
           JOIN app.announcements a ON a.id = r.announcement_id
          WHERE r.parent_id = $1 AND a.status = 'publie'
            AND app.search_key(a.title) LIKE '%' || $2 || '%'
          ORDER BY a.published_at DESC LIMIT 10`,
        [parentId, key],
      );

      const requests = await client.query(
        `SELECT id, reference, subject, status, created_at
           FROM app.requests
          WHERE parent_id = $1 AND app.search_key(subject) LIKE '%' || $2 || '%'
          ORDER BY created_at DESC LIMIT 10`,
        [parentId, key],
      );

      return {
        enfants: children.rows,
        communiques: announcements.rows,
        demandes: requests.rows,
      };
    });

    return noStore(reply).send(result);
  });
}
