/**
 * ============================================================================
 *  MWANA CLASSE — Administration de la sécurité
 * ============================================================================
 *  Ces routes donnent à la direction les moyens de vérifier elle-même que le
 *  système se comporte correctement :
 *    - état réel des primitives (hachage, chiffrement, 2FA, journal) ;
 *    - consultation du journal d'audit et vérification de son intégrité ;
 *    - alertes de sécurité et verrouillages en cours ;
 *    - gestion du personnel et des permissions ;
 *    - révocation de jetons et déconnexion forcée.
 * ============================================================================
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../app.js';
import {
  clientIp,
  dbIdentityFrom,
  requireAudience,
  requireAuth,
  requirePermission,
  sendError,
  noStore,
} from '../http/middleware.js';
import { securityPolicySummary } from '../config/index.js';
import { hashingReport, hashPassword, generateRsaKeyPair, selfTest } from '../security/crypto.js';
import { totpSelfTest } from '../security/totp.js';
import { AUDIT_ACTIONS } from '../security/audit.js';

export async function registerSecurityRoutes(deps: AppDependencies): Promise<void> {
  const { app, db, audit, secrets, guard, config, sessions } = deps;

  const authDeps = {
    db,
    sessions,
    jwtVerify: (token: string) => app.jwt.verify(token) as Record<string, any>,
  };

  const schoolGuard = [requireAuth(authDeps), requireAudience('ecole')];

  /* ====================================================================== */
  /*  TABLEAU DE BORD SÉCURITÉ                                              */
  /* ====================================================================== */

  app.get(
    '/api/ecole/securite',
    { preHandler: [...schoolGuard, requirePermission('securite.gerer')] },
    async (req, reply) => {
      const schoolId = req.auth!.schoolId!;

      const report = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const logins = await client.query(
          `SELECT
             count(*) FILTER (WHERE success)::int                                  AS succes,
             count(*) FILTER (WHERE NOT success)::int                              AS echecs,
             count(*) FILTER (WHERE NOT success AND created_at > now() - interval '24 hours')::int AS echecs24h,
             count(DISTINCT ip)::int                                               AS adresses_distinctes
           FROM sec.login_attempts
          WHERE created_at > now() - interval '30 days'
            AND (school_id = $1 OR school_id IS NULL)`,
          [schoolId],
        );

        const recentFailures = await client.query(
          `SELECT la.created_at, la.identifier, la.failure_reason, la.ip, la.user_agent,
                  su.full_name AS compte
             FROM sec.login_attempts la
             LEFT JOIN sec.staff_users su ON su.id = la.staff_user_id
            WHERE NOT la.success AND la.school_id = $1
            ORDER BY la.created_at DESC LIMIT 30`,
          [schoolId],
        );

        const alerts = await guard.openAlerts(client, 50);

        const lockouts = await client.query(
          `SELECT id, scope, subject_key, reason, failed_count, locked_at, locked_until
             FROM sec.lockouts
            WHERE released_at IS NULL AND locked_until > now()
            ORDER BY locked_until DESC LIMIT 50`,
        );

        const activeSessions = await client.query(
          `SELECT s.id, s.ip, s.user_agent, s.device_label, s.created_at, s.last_used_at,
                  s.mfa_satisfied, s.mfa_method,
                  u.full_name, u.email, u.job_title
             FROM sec.sessions s
             JOIN sec.staff_users u ON u.id = s.staff_user_id
            WHERE u.school_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
            ORDER BY s.last_used_at DESC LIMIT 50`,
          [schoolId],
        );

        const staff2fa = await client.query(
          `SELECT
             count(*)::int                                   AS total,
             count(*) FILTER (WHERE totp_enabled)::int        AS avec_2fa,
             count(*) FILTER (WHERE NOT totp_enabled)::int    AS sans_2fa
           FROM sec.staff_users WHERE school_id = $1 AND is_active`,
          [schoolId],
        );

        const auditStats = await client.query(
          `SELECT
             count(*)::int                AS entrees,
             count(*) FILTER (WHERE severity IN ('warning','error','critique')
                                AND occurred_at > now() - interval '7 days')::int AS sensibles7j,
             min(occurred_at)             AS depuis,
             max(occurred_at)             AS dernier
           FROM sec.audit_log WHERE school_id = $1`,
          [schoolId],
        );

        const auditActions = await client.query(
          `SELECT action, count(*)::int AS n, max(occurred_at) AS dernier
             FROM sec.audit_log
            WHERE school_id = $1 AND occurred_at > now() - interval '30 days'
            GROUP BY action ORDER BY n DESC LIMIT 20`,
          [schoolId],
        );

        return {
          connexions: logins.rows[0],
          echecsRecents: recentFailures.rows,
          alertes: alerts,
          verrouillages: lockouts.rows,
          sessionsActives: activeSessions.rows,
          personnel2fa: staff2fa.rows[0],
          journal: { ...auditStats.rows[0], actionsFrequentes: auditActions.rows },
        };
      });

      const crypto = await selfTest();
      const totp = totpSelfTest();

      return noStore(reply).send({
        ...report,
        configuration: securityPolicySummary(config),
        primitives: {
          hachageActif: hashingReport().active,
          hachagesDisponibles: hashingReport().available,
          testsCryptographiques: {
            reussis: crypto.checks.filter((c) => c.ok).length,
            total: crypto.checks.length,
            conforme: crypto.ok,
          },
          testsDeuxiemeFacteur: {
            reussis: totp.checks.filter((c) => c.ok).length,
            total: totp.checks.length,
            conformeRfc6238: totp.ok,
          },
          secrets: secrets.inventory().map((s) => ({
            identifiant: s.id,
            usage: s.purpose,
            fournisseur: s.provider,
            empreinte: s.fingerprint,
            versions: s.versions,
            genereAutomatiquement: s.generatedInDev,
            rotationConseilleeJours: s.rotateAfterDays,
            description: s.description,
          })),
        },
        cles: {
          fournisseur: config.MWANA_SECRET_PROVIDER,
          recommande: 'vault, aws_kms, azure_keyvault ou gcp_kms en production',
          note:
            'Aucune clé n’est stockée en base. Les empreintes ci-dessus permettent de vérifier ' +
            'quelle version est active sans jamais exposer la clé.',
        },
      });
    },
  );

  /* ====================================================================== */
  /*  JOURNAL D'AUDIT                                                       */
  /* ====================================================================== */

  app.get(
    '/api/ecole/audit',
    { preHandler: [...schoolGuard, requirePermission('audit.consulter')] },
    async (req, reply) => {
      const schoolId = req.auth!.schoolId!;
      const q = (req.query as any) ?? {};
      const limit = Math.min(500, Math.max(1, Number(q.limite ?? 100)));
      const offset = Math.max(0, Number(q.decalage ?? 0));

      const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const { rows } = await client.query(
          `SELECT id, occurred_at, actor_kind, actor_id, actor_label, actor_ip, actor_device,
                  action, entity_type, entity_id, entity_label, severity, result,
                  payload_hash, prev_hash, entry_hash, signature, key_id,
                  (signature IS NOT NULL) AS signee
             FROM sec.audit_log
            WHERE school_id = $1
              AND ($2::text IS NULL OR action = $2)
              AND ($3::text IS NULL OR severity = $3)
              AND ($4::text IS NULL OR actor_kind = $4)
              AND ($5::timestamptz IS NULL OR occurred_at >= $5)
              AND ($6::timestamptz IS NULL OR occurred_at <= $6)
            ORDER BY id DESC
            LIMIT $7 OFFSET $8`,
          [
            schoolId,
            q.action ?? null,
            q.gravite ?? null,
            q.acteur ?? null,
            q.du ?? null,
            q.au ?? null,
            limit,
            offset,
          ],
        );

        const total = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM sec.audit_log
            WHERE school_id = $1
              AND ($2::text IS NULL OR action = $2)
              AND ($3::text IS NULL OR severity = $3)`,
          [schoolId, q.action ?? null, q.gravite ?? null],
        );

        return { entrees: rows, total: Number(total.rows[0]?.n ?? 0) };
      });

      return noStore(reply).send({
        ...rows,
        limite: limit,
        decalage: offset,
        explication:
          'Chaque entrée est chiffrée et son empreinte chaîne la précédente. ' +
          'Toute suppression ou modification casse la chaîne et devient détectable.',
      });
    },
  );

  /** Vérification d'intégrité de la chaîne d'audit. */
  app.get(
    '/api/ecole/audit/verifier',
    { preHandler: [...schoolGuard, requirePermission('audit.consulter')] },
    async (req, reply) => {
      const q = (req.query as any) ?? {};
      const fromId = Math.max(0, Number(q.depuis ?? 0));
      const limit = Math.min(200_000, Math.max(1, Number(q.limite ?? 100_000)));

      const result = await db.withTransaction((client) =>
        audit.verify((sql, params) => client.query(sql, params as any[]), { fromId, limit }),
      );

      if (result.intact) {
        return noStore(reply).send({
          integre: true,
          entreesVerifiees: result.checked,
          message:
            `Chaîne d’audit intègre : ${result.checked} entrée(s) vérifiée(s), ` +
            'aucune modification ni suppression détectée.',
        });
      }

      return noStore(reply).code(409).send({
        integre: false,
        entreesVerifiees: result.checked,
        entreesRomprees: result.brokenEntries,
        signaturesInvalides: result.signatureFailures,
        message:
          'ANOMALIE DÉTECTÉE : la chaîne du journal d’audit est rompue ou une signature est invalide. ' +
          'Cela signifie qu’une entrée a été modifiée ou supprimée directement en base. ' +
          'Conservez ce rapport et contactez immédiatement l’assistance.',
      });
    },
  );

  /** Détail chiffré d'une entrée du journal (accès restreint et tracé). */
  app.get(
    '/api/ecole/audit/:id',
    { preHandler: [...schoolGuard, requirePermission('audit.consulter')] },
    async (req, reply) => {
      const schoolId = req.auth!.schoolId!;
      const id = String((req.params as any).id);

      const detail = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const { rows } = await client.query(
          `SELECT id, occurred_at, actor_kind, actor_label, actor_ip, actor_device,
                  action, entity_type, entity_id, entity_label, severity, result,
                  metadata, payload_hash, prev_hash, entry_hash, signature, key_id
             FROM sec.audit_log WHERE id = $1 AND school_id = $2`,
          [id, schoolId],
        );
        if (!rows[0]) {
          const err = new Error('Entrée d’audit introuvable.') as Error & { statusCode?: number; code?: string };
          err.statusCode = 404;
          err.code = 'ENTREE_INTROUVABLE';
          throw err;
        }

        const payload = await audit.readPayload(
          (sql, params) => client.query(sql, params as any[]),
          id,
        );

        // La consultation d'une entrée détaillée est elle-même journalisée :
        // consulter le journal ne doit pas être une zone d'ombre.
        await audit.write(client, {
          actorKind: 'staff',
          actorId: req.auth!.userId,
          actorLabel: req.auth!.displayName,
          actorIp: clientIp(req),
          schoolId,
        }, {
          action: 'audit.consultation_detail',
          severity: 'notice',
          result: 'succes',
          entityType: 'audit_log',
          entityId: id,
        });

        return { ...rows[0], contenu: payload };
      });

      return noStore(reply).send({ entree: detail });
    },
  );

  /* ====================================================================== */
  /*  ALERTES DE SÉCURITÉ                                                   */
  /* ====================================================================== */

  app.get(
    '/api/ecole/securite/alertes',
    { preHandler: [...schoolGuard, requirePermission('securite.gerer')] },
    async (req, reply) => {
      const rows = await db.withIdentity(dbIdentityFrom(req), async (client) =>
        guard.openAlerts(client, 100),
      );
      return noStore(reply).send({
        alertes: rows,
        regles: [
          { code: 'bruteforce_ip', description: 'Plus de 10 échecs de connexion depuis une même adresse' },
          { code: 'bourrage_identifiants', description: 'Un même compte attaqué depuis 5 adresses ou plus' },
          { code: 'enumeration_codes', description: 'Plus de 15 recherches de code infructueuses' },
          { code: 'acces_hors_horaires', description: 'Actions sensibles entre 21 h et 5 h' },
        ],
      });
    },
  );

  /** Lance manuellement l'analyse de détection d'anomalies. */
  app.post(
    '/api/ecole/securite/analyser',
    { preHandler: [...schoolGuard, requirePermission('securite.gerer')] },
    async (req, reply) => {
      const windowMinutes = Math.min(1440, Math.max(5, Number((req.body as any)?.fenetreMinutes ?? 15)));

      const inserted = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const count = await guard.detectAnomalies(client, windowMinutes);
        await audit.write(client, {
          actorKind: 'staff',
          actorId: req.auth!.userId,
          actorLabel: req.auth!.displayName,
          actorIp: clientIp(req),
          schoolId: req.auth!.schoolId,
        }, {
          action: AUDIT_ACTIONS.SUSPICIOUS_ACTIVITY,
          severity: 'notice',
          result: 'succes',
          payload: { analyse: 'manuelle', fenetreMinutes: windowMinutes, alertesCreees: count },
        });
        return count;
      });

      return noStore(reply).send({
        message:
          inserted > 0
            ? `Analyse terminée : ${inserted} nouvelle(s) alerte(s) de sécurité.`
            : 'Analyse terminée : aucune anomalie détectée sur la période.',
        alertesCreees: inserted,
      });
    },
  );

  app.post(
    '/api/ecole/securite/alertes/:id/traiter',
    { preHandler: [...schoolGuard, requirePermission('securite.gerer')] },
    async (req, reply) => {
      const parsed = z
        .object({
          statut: z.enum(['en_cours', 'traitee', 'ignoree', 'faux_positif']),
          commentaire: z.string().max(2000).optional().nullable(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Statut invalide.');
      }

      const id = String((req.params as any).id);

      await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const res = await client.query(
          `UPDATE sec.security_alerts SET status = $2, handled_by_name = $3, handled_at = now(),
                  detail = coalesce(detail, '') || CASE WHEN $4::text IS NULL THEN '' ELSE E'\n' || $4 END
            WHERE id = $1`,
          [id, parsed.data.statut, req.auth!.displayName, parsed.data.commentaire ?? null],
        );
        if ((res.rowCount ?? 0) === 0) {
          const err = new Error('Alerte introuvable.') as Error & { statusCode?: number; code?: string };
          err.statusCode = 404;
          err.code = 'ALERTE_INTROUVABLE';
          throw err;
        }
      });

      return noStore(reply).send({ message: 'Alerte mise à jour.' });
    },
  );

  /* ====================================================================== */
  /*  VERROUILLAGES                                                         */
  /* ====================================================================== */

  app.get(
    '/api/ecole/securite/verrouillages',
    { preHandler: [...schoolGuard, requirePermission('securite.gerer')] },
    async (req, reply) => {
      const rows = await db.withIdentity(dbIdentityFrom(req), async (client) =>
        guard.activeLockouts(client, 100),
      );
      return noStore(reply).send({
        verrouillages: rows,
        explication:
          'Un verrouillage protège un compte ou une adresse après plusieurs échecs. ' +
          'La durée augmente à chaque palier : 1 min, 5 min, 30 min puis 24 h.',
      });
    },
  );

  app.post(
    '/api/ecole/securite/verrouillages/lever',
    { preHandler: [...schoolGuard, requirePermission('securite.gerer')] },
    async (req, reply) => {
      const parsed = z
        .object({
          portee: z.enum(['compte', 'ip', 'appareil', 'ecole']),
          cle: z.string().trim().min(1).max(300),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Portée ou clé invalide.');
      }

      const released = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const count = await guard.release(
          client,
          parsed.data.portee,
          parsed.data.cle,
          req.auth!.displayName,
        );
        await audit.write(client, {
          actorKind: 'staff',
          actorId: req.auth!.userId,
          actorLabel: req.auth!.displayName,
          actorIp: clientIp(req),
          schoolId: req.auth!.schoolId,
        }, {
          action: 'securite.verrouillage_leve',
          severity: 'warning',
          result: 'succes',
          payload: { portee: parsed.data.portee, cle: parsed.data.cle, nombre: count },
        });
        return count;
      });

      return noStore(reply).send({
        message: released > 0 ? `${released} verrouillage(s) levé(s).` : 'Aucun verrouillage actif pour cette clé.',
        leves: released,
      });
    },
  );

  /* ====================================================================== */
  /*  SESSIONS DU PERSONNEL                                                 */
  /* ====================================================================== */

  app.get(
    '/api/ecole/securite/sessions',
    { preHandler: [...schoolGuard, requirePermission('securite.gerer')] },
    async (req, reply) => {
      const rows = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const { rows } = await client.query(
          `SELECT s.id, s.ip, s.user_agent, s.device_label, s.created_at, s.last_used_at,
                  s.expires_at, s.mfa_satisfied, s.mfa_method, s.revoked_at, s.revoked_reason,
                  u.id AS staff_user_id, u.full_name, u.email, u.job_title
             FROM sec.sessions s
             JOIN sec.staff_users u ON u.id = s.staff_user_id
            WHERE u.school_id = $1
            ORDER BY s.last_used_at DESC LIMIT 200`,
          [req.auth!.schoolId],
        );
        return rows;
      });
      return noStore(reply).send({ sessions: rows });
    },
  );

  /** Révoque une session précise (déconnexion forcée d'un appareil). */
  app.delete(
    '/api/ecole/securite/sessions/:id',
    { preHandler: [...schoolGuard, requirePermission('personnel.gerer')] },
    async (req, reply) => {
      const id = String((req.params as any).id);

      const done = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const check = await client.query(
          `SELECT s.id, s.staff_user_id FROM sec.sessions s
             JOIN sec.staff_users u ON u.id = s.staff_user_id
            WHERE s.id = $1 AND u.school_id = $2`,
          [id, req.auth!.schoolId],
        );
        if (!check.rows[0]) return false;

        const ok = await sessions.revoke(client, id, `révocation par ${req.auth!.displayName}`);

        await audit.write(client, {
          actorKind: 'staff',
          actorId: req.auth!.userId,
          actorLabel: req.auth!.displayName,
          actorIp: clientIp(req),
          schoolId: req.auth!.schoolId,
        }, {
          action: AUDIT_ACTIONS.TOKEN_REVOKED,
          severity: 'warning',
          result: 'succes',
          entityType: 'staff',
          entityId: check.rows[0].staff_user_id,
          payload: { session: id },
        });

        return ok;
      });

      if (!done) {
        return sendError(reply, 404, 'SESSION_INTROUVABLE', 'Session introuvable ou déjà fermée.');
      }
      return noStore(reply).send({ message: 'Session révoquée : l’appareil est déconnecté immédiatement.' });
    },
  );

  /** Déconnecte tout le personnel d'un coup (incident de sécurité). */
  app.post(
    '/api/ecole/securite/deconnecter-tous',
    { preHandler: [...schoolGuard, requirePermission('personnel.gerer')] },
    async (req, reply) => {
      const parsed = z
        .object({ saufMoi: z.boolean().default(true), motif: z.string().max(500).optional().nullable() })
        .safeParse(req.body ?? {});
      const saufMoi = parsed.success ? parsed.data.saufMoi : true;

      const count = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const res = await client.query(
          `UPDATE sec.sessions s
              SET revoked_at = now(),
                  revoked_reason = coalesce($2, 'déconnexion générale de sécurité')
            FROM sec.staff_users u
           WHERE u.id = s.staff_user_id
             AND u.school_id = $1
             AND s.revoked_at IS NULL
             AND ($3::boolean = false OR s.id <> $4)`,
          [
            req.auth!.schoolId,
            parsed.success ? parsed.data.motif ?? null : null,
            saufMoi,
            req.auth!.identity.sessionId,
          ],
        );

        await audit.write(client, {
          actorKind: 'staff',
          actorId: req.auth!.userId,
          actorLabel: req.auth!.displayName,
          actorIp: clientIp(req),
          schoolId: req.auth!.schoolId,
        }, {
          action: AUDIT_ACTIONS.TOKEN_REVOKED,
          severity: 'warning',
          result: 'succes',
          payload: {
            portee: 'tout le personnel',
            sessions_fermees: res.rowCount ?? 0,
            ma_session_conservee: saufMoi,
            motif: parsed.success ? parsed.data.motif : null,
          },
        });

        return res.rowCount ?? 0;
      });

      return noStore(reply).send({
        message: `${count} session(s) fermée(s). Le personnel devra se reconnecter.`,
        sessionsFermees: count,
      });
    },
  );

  /* ====================================================================== */
  /*  PERSONNEL ET PERMISSIONS                                              */
  /* ====================================================================== */

  app.get(
    '/api/ecole/personnel',
    { preHandler: [...schoolGuard, requirePermission('personnel.gerer')] },
    async (req, reply) => {
      const schoolId = req.auth!.schoolId!;

      const data = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const staff = await client.query(
          `SELECT u.id, u.email, u.username, u.full_name, u.job_title, u.phone, u.is_active,
                  u.is_owner, u.totp_enabled, u.last_login_at, u.last_login_ip, u.created_at,
                  u.must_change_password,
                  coalesce(json_agg(json_build_object('id', r.id, 'code', r.code, 'nom', r.name)
                                    ORDER BY r.name) FILTER (WHERE r.id IS NOT NULL), '[]'::json) AS roles,
                  (SELECT coalesce(json_agg(json_build_object(
                            'permission', o.permission_code, 'autorise', o.allowed, 'motif', o.reason)), '[]'::json)
                     FROM sec.staff_permission_overrides o
                    WHERE o.staff_user_id = u.id) AS derogations
             FROM sec.staff_users u
             LEFT JOIN sec.staff_roles sr ON sr.staff_user_id = u.id
             LEFT JOIN sec.roles r ON r.id = sr.role_id
            WHERE u.school_id = $1
            GROUP BY u.id
            ORDER BY u.is_owner DESC, u.full_name`,
          [schoolId],
        );

        const roles = await client.query(
          `SELECT r.id, r.code, r.name, r.description, r.is_system,
                  coalesce(json_agg(rp.permission_code ORDER BY rp.permission_code)
                           FILTER (WHERE rp.permission_code IS NOT NULL), '[]'::json) AS permissions
             FROM sec.roles r
             LEFT JOIN sec.role_permissions rp ON rp.role_id = r.id
            WHERE r.school_id = $1 OR r.school_id IS NULL
            GROUP BY r.id
            ORDER BY r.is_system DESC, r.name`,
          [schoolId],
        );

        const permissions = await client.query(
          `SELECT code, module, label, description, is_dangerous
             FROM ref.permissions ORDER BY module, code`,
        );

        return { personnel: staff.rows, roles: roles.rows, permissions: permissions.rows };
      });

      return noStore(reply).send(data);
    },
  );

  /** Crée un compte administratif avec mot de passe provisoire. */
  app.post(
    '/api/ecole/personnel',
    { preHandler: [...schoolGuard, requirePermission('personnel.gerer')] },
    async (req, reply) => {
      const schoolId = req.auth!.schoolId!;

      const parsed = z
        .object({
          fullName: z.string().trim().min(3).max(160),
          email: z.string().email(),
          jobTitle: z.string().trim().max(80).optional().nullable(),
          phone: z.string().trim().max(32).optional().nullable(),
          password: z.string().min(12).max(256),
          roleCodes: z.array(z.string().trim().max(40)).min(1).max(6),
        })
        .safeParse(req.body);

      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Formulaire de compte incomplet.', {
          details: parsed.error.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
        });
      }
      const input = parsed.data;

      const created = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const pepper = secrets.get('pepper.password');
        const { hash, algo, pepperId } = await hashPassword(
          input.password,
          pepper.current.value,
          pepper.current.id,
          {
            email: input.email,
            fullName: input.fullName,
            ...(req.auth!.schoolId
              ? {
                  schoolName: (
                    await client.query<{ official_name: string }>(
                      `SELECT official_name FROM app.schools WHERE id = $1`,
                      [schoolId],
                    )
                  ).rows[0]?.official_name,
                }
              : {}),
          } as any,
        );

        const { rows } = await client.query<{
          id: string;
          email: string;
          full_name: string;
          job_title: string | null;
        }>(
          `INSERT INTO sec.staff_users
             (school_id, email, full_name, job_title, phone, password_hash, password_algo,
              password_pepper_id, must_change_password, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,true)
           RETURNING id, email, full_name, job_title`,
          [
            schoolId,
            input.email.trim().toLowerCase(),
            input.fullName.trim(),
            input.jobTitle ?? null,
            input.phone ?? null,
            hash,
            algo,
            pepperId,
          ],
        );

        const staff = rows[0]!;

        for (const code of input.roleCodes) {
          const role = await client.query<{ id: string }>(
            `SELECT id FROM sec.roles WHERE school_id = $1 AND code = $2`,
            [schoolId, code],
          );
          if (role.rows[0]) {
            await client.query(
              `INSERT INTO sec.staff_roles (staff_user_id, role_id, assigned_by)
               VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
              [staff.id, role.rows[0].id, req.auth!.userId],
            );
          }
        }

        await audit.write(client, {
          actorKind: 'staff',
          actorId: req.auth!.userId,
          actorLabel: req.auth!.displayName,
          actorIp: clientIp(req),
          schoolId,
        }, {
          action: AUDIT_ACTIONS.STAFF_CREATED,
          severity: 'notice',
          result: 'succes',
          entityType: 'staff',
          entityId: staff.id,
          entityLabel: staff.full_name,
          payload: { email: staff.email, roles: input.roleCodes, changement_mot_de_passe_impose: true },
        });

        return staff;
      });

      return noStore(reply).code(201).send({
        message:
          `Compte créé pour ${created.full_name}. ` +
          'Le mot de passe est provisoire : la personne devra le changer à sa première connexion.',
        personnel: created,
        consigne:
          'Communiquez les identifiants par un canal sécurisé, et invitez la personne à activer ' +
          'la double authentification dès sa première connexion.',
      });
    },
  );

  /** Active / désactive un compte ou modifie ses rôles. */
  app.patch(
    '/api/ecole/personnel/:id',
    { preHandler: [...schoolGuard, requirePermission('personnel.gerer')] },
    async (req, reply) => {
      const schoolId = req.auth!.schoolId!;
      const staffId = String((req.params as any).id);

      const parsed = z
        .object({
          fullName: z.string().trim().min(3).max(160).optional(),
          jobTitle: z.string().trim().max(80).optional().nullable(),
          phone: z.string().trim().max(32).optional().nullable(),
          isActive: z.boolean().optional(),
          roleCodes: z.array(z.string().max(40)).max(6).optional(),
          disabledReason: z.string().max(500).optional().nullable(),
        })
        .safeParse(req.body);

      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Modification invalide.');
      }
      const input = parsed.data;

      const result = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const target = await client.query<{ id: string; is_owner: boolean; full_name: string }>(
          `SELECT id, is_owner, full_name FROM sec.staff_users
            WHERE id = $1 AND school_id = $2 FOR UPDATE`,
          [staffId, schoolId],
        );
        if (!target.rows[0]) {
          const err = new Error('Compte introuvable.') as Error & { statusCode?: number; code?: string };
          err.statusCode = 404;
          err.code = 'COMPTE_INTROUVABLE';
          throw err;
        }

        // On ne se désactive pas soi-même, et on ne désactive pas le dernier
        // propriétaire : l'établissement ne doit jamais se retrouver sans accès.
        if (input.isActive === false) {
          if (staffId === req.auth!.userId) {
            const err = new Error('Vous ne pouvez pas désactiver votre propre compte.') as Error & {
              statusCode?: number;
              code?: string;
            };
            err.statusCode = 409;
            err.code = 'AUTO_DESACTIVATION';
            throw err;
          }
          if (target.rows[0].is_owner) {
            const owners = await client.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM sec.staff_users
                WHERE school_id = $1 AND is_owner AND is_active AND id <> $2`,
              [schoolId, staffId],
            );
            if (owners.rows[0]!.n === '0') {
              const err = new Error(
                'Impossible de désactiver le dernier compte de direction actif.',
              ) as Error & { statusCode?: number; code?: string };
              err.statusCode = 409;
              err.code = 'DERNIER_PROPRIETAIRE';
              throw err;
            }
          }
        }

        const { rows } = await client.query(
          `UPDATE sec.staff_users SET
             full_name = coalesce($3, full_name),
             job_title = coalesce($4, job_title),
             phone = coalesce($5, phone),
             is_active = coalesce($6, is_active),
             disabled_reason = coalesce($7, disabled_reason)
           WHERE id = $1 AND school_id = $2
           RETURNING id, email, full_name, job_title, is_active`,
          [
            staffId,
            schoolId,
            input.fullName ?? null,
            input.jobTitle ?? null,
            input.phone ?? null,
            input.isActive ?? null,
            input.disabledReason ?? null,
          ],
        );

        if (input.roleCodes) {
          await client.query(`DELETE FROM sec.staff_roles WHERE staff_user_id = $1`, [staffId]);
          for (const code of input.roleCodes) {
            const role = await client.query<{ id: string }>(
              `SELECT id FROM sec.roles WHERE school_id = $1 AND code = $2`,
              [schoolId, code],
            );
            if (role.rows[0]) {
              await client.query(
                `INSERT INTO sec.staff_roles (staff_user_id, role_id, assigned_by)
                 VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
                [staffId, role.rows[0].id, req.auth!.userId],
              );
            }
          }

          await audit.write(client, {
            actorKind: 'staff',
            actorId: req.auth!.userId,
            actorLabel: req.auth!.displayName,
            actorIp: clientIp(req),
            schoolId,
          }, {
            action: AUDIT_ACTIONS.STAFF_ROLE_CHANGED,
            severity: 'warning',
            result: 'succes',
            entityType: 'staff',
            entityId: staffId,
            entityLabel: target.rows[0].full_name,
            payload: { nouveaux_roles: input.roleCodes },
          });
        }

        // Un compte désactivé perd immédiatement toutes ses sessions.
        if (input.isActive === false) {
          await sessions.revokeAll(client, { parentId: null, staffUserId: staffId }, 'compte désactivé');
          await audit.write(client, {
            actorKind: 'staff',
            actorId: req.auth!.userId,
            actorLabel: req.auth!.displayName,
            actorIp: clientIp(req),
            schoolId,
          }, {
            action: AUDIT_ACTIONS.STAFF_DISABLED,
            severity: 'warning',
            result: 'succes',
            entityType: 'staff',
            entityId: staffId,
            entityLabel: target.rows[0].full_name,
            payload: { motif: input.disabledReason ?? null },
          });
        }

        return rows[0];
      });

      return noStore(reply).send({
        message: result.is_active
          ? `Compte de ${result.full_name} mis à jour.`
          : `Compte de ${result.full_name} désactivé : ses sessions sont fermées immédiatement.`,
        personnel: result,
      });
    },
  );

  /**
   * Dérogation de permission : accorde ou retire une permission précise à un
   * compte, indépendamment de ses rôles. Utile pour un remplacement temporaire.
   */
  app.post(
    '/api/ecole/personnel/:id/permissions',
    { preHandler: [...schoolGuard, requirePermission('personnel.gerer')] },
    async (req, reply) => {
      const schoolId = req.auth!.schoolId!;
      const staffId = String((req.params as any).id);

      const parsed = z
        .object({
          permission: z.string().trim().min(3).max(80),
          autorise: z.boolean(),
          motif: z.string().trim().max(500).optional().nullable(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Dérogation invalide.');
      }

      await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const target = await client.query(
          `SELECT id, full_name, is_owner FROM sec.staff_users WHERE id = $1 AND school_id = $2`,
          [staffId, schoolId],
        );
        if (!target.rows[0]) {
          const err = new Error('Compte introuvable.') as Error & { statusCode?: number; code?: string };
          err.statusCode = 404;
          err.code = 'COMPTE_INTROUVABLE';
          throw err;
        }
        if (target.rows[0].is_owner) {
          const err = new Error(
            'La direction dispose déjà de toutes les permissions ; aucune dérogation n’est nécessaire.',
          ) as Error & { statusCode?: number; code?: string };
          err.statusCode = 409;
          err.code = 'PROPRIETAIRE_COMPLET';
          throw err;
        }

        const perm = await client.query(
          `SELECT code FROM ref.permissions WHERE code = $1`,
          [parsed.data.permission],
        );
        if (!perm.rows[0]) {
          return sendError(reply, 400, 'PERMISSION_INCONNUE', 'Cette permission n’existe pas.');
        }

        await client.query(
          `INSERT INTO sec.staff_permission_overrides (staff_user_id, permission_code, allowed, reason)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (staff_user_id, permission_code)
           DO UPDATE SET allowed = EXCLUDED.allowed, reason = EXCLUDED.reason`,
          [staffId, parsed.data.permission, parsed.data.autorise, parsed.data.motif ?? null],
        );

        await audit.write(client, {
          actorKind: 'staff',
          actorId: req.auth!.userId,
          actorLabel: req.auth!.displayName,
          actorIp: clientIp(req),
          schoolId,
        }, {
          action: AUDIT_ACTIONS.STAFF_ROLE_CHANGED,
          severity: 'warning',
          result: 'succes',
          entityType: 'staff',
          entityId: staffId,
          entityLabel: target.rows[0].full_name,
          payload: {
            type: 'derogation_permission',
            permission: parsed.data.permission,
            autorise: parsed.data.autorise,
            motif: parsed.data.motif,
          },
        });
      });

      return noStore(reply).send({
        message: parsed.data.autorise
          ? `Permission « ${parsed.data.permission} » accordée.`
          : `Permission « ${parsed.data.permission} » retirée.`,
      });
    },
  );

  /* ====================================================================== */
  /*  ROTATION DES CLÉS                                                     */
  /* ====================================================================== */

  /**
   * Génère une nouvelle paire RSA-4096 pour les échanges sécurisés.
   * La clé privée n'est jamais renvoyée par l'API : seules la clé publique et
   * son empreinte le sont. La clé privée doit être stockée dans le
   * gestionnaire de secrets.
   */
  app.post(
    '/api/ecole/securite/cles/rsa',
    { preHandler: [...schoolGuard, requirePermission('securite.gerer')] },
    async (req, reply) => {
      const pair = generateRsaKeyPair();

      await db.withIdentity(dbIdentityFrom(req), async (client) => {
        await client.query(
          `INSERT INTO sec.encryption_keys
             (key_id, purpose, algorithm, key_fingerprint, provider, is_active, activated_at)
           VALUES ($1,'transport','rsa-4096-oaep-sha256',$2,$3,true, now())
           ON CONFLICT (key_id) DO UPDATE SET
             key_fingerprint = EXCLUDED.key_fingerprint, activated_at = now(), is_active = true`,
          [`transport-${pair.fingerprint.slice(0, 12)}`, pair.fingerprint, config.MWANA_SECRET_PROVIDER],
        );

        await audit.write(client, {
          actorKind: 'staff',
          actorId: req.auth!.userId,
          actorLabel: req.auth!.displayName,
          actorIp: clientIp(req),
          schoolId: req.auth!.schoolId,
        }, {
          action: 'securite.cle_generee',
          severity: 'warning',
          result: 'succes',
          payload: { algorithme: 'RSA-4096-OAEP-SHA256', empreinte: pair.fingerprint },
        });
      });

      return noStore(reply).send({
        message:
          'Nouvelle paire RSA-4096 générée. Enregistrez la clé privée dans votre gestionnaire de secrets ' +
          '(Vault, AWS KMS, Azure Key Vault…) puis détruisez-la de cette réponse.',
        clePublique: pair.publicKeyPem,
        clePrivee: pair.privateKeyPem,
        empreinte: pair.fingerprint,
        avertissement:
          'La clé privée n’est affichée qu’une seule fois et n’est pas stockée par MwanaClasse. ' +
          'Sans elle, les données chiffrées avec la clé publique correspondante deviennent illisibles.',
      });
    },
  );

  /* ====================================================================== */
  /*  VÉRIFICATION D'INTÉGRITÉ DES DONNÉES                                  */
  /* ====================================================================== */

  /**
   * Contrôle que le chiffrement des données sensibles est bien lisible avec la
   * clé courante : détecte une rotation de clé mal effectuée avant qu'elle ne
   * devienne un incident.
   */
  app.get(
    '/api/ecole/securite/chiffrement',
    { preHandler: [...schoolGuard, requirePermission('securite.gerer')] },
    async (req, reply) => {
      const schoolId = req.auth!.schoolId!;

      const check = await db.withIdentity(dbIdentityFrom(req), async (client) => {
        const { rows } = await client.query<{
          id: string;
          medical_notes_enc: Buffer | null;
          guardian_phone_enc: Buffer | null;
          address_enc: Buffer | null;
        }>(
          `SELECT id, medical_notes_enc, guardian_phone_enc, address_enc
             FROM app.students
            WHERE school_id = $1
              AND (medical_notes_enc IS NOT NULL
                OR guardian_phone_enc IS NOT NULL
                OR address_enc IS NOT NULL)
            LIMIT 50`,
          [schoolId],
        );

        const { decryptField } = await import('../security/secrets.js');
        let lus = 0;
        let illisibles = 0;

        for (const row of rows) {
          const results = [
            decryptField(row.medical_notes_enc, secrets, `student:${row.id}:medical`),
            decryptField(row.guardian_phone_enc, secrets, `student:${row.id}:phone`),
            decryptField(row.address_enc, secrets, `student:${row.id}:address`),
          ];
          for (const [index, value] of results.entries()) {
            const enc = [row.medical_notes_enc, row.guardian_phone_enc, row.address_enc][index];
            if (!enc) continue;
            if (value === null) illisibles++;
            else lus++;
          }
        }

        const counts = await client.query(
          `SELECT
             count(*) FILTER (WHERE medical_notes_enc IS NOT NULL)::int    AS notes_medicales,
             count(*) FILTER (WHERE guardian_phone_enc IS NOT NULL)::int   AS telephones,
             count(*) FILTER (WHERE address_enc IS NOT NULL)::int          AS adresses
           FROM app.students WHERE school_id = $1`,
          [schoolId],
        );

        return { echantillon: rows.length, lus, illisibles, totaux: counts.rows[0] };
      });

      return noStore(reply).send({
        ...check,
        algorithme: 'AES-256-GCM, clé dérivée par HKDF-SHA512 avec contexte lié',
        integre: check.illisibles === 0,
        message:
          check.illisibles === 0
            ? `Chiffrement vérifié : ${check.lus} valeur(s) déchiffrée(s) correctement sur un échantillon de ${check.echantillon} élève(s).`
            : `ANOMALIE : ${check.illisibles} valeur(s) chiffrée(s) sont illisibles. ` +
              'Cela survient lorsqu’une clé de chiffrement a été remplacée sans migration. ' +
              'Restaurez l’ancienne clé (MWANA_KEY_DATA) puis relancez la vérification.',
      });
    },
  );
}
