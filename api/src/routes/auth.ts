/**
 * ============================================================================
 *  MWANA CLASSE — Routes d'authentification
 * ============================================================================
 *  Toutes les réponses contenant des données personnelles sont en no-store.
 *  Le jeton de rafraîchissement circule exclusivement par cookie HttpOnly :
 *  il n'est jamais exposé au JavaScript de la page.
 * ============================================================================
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDependencies } from '../app.js';
import { clientIp, dbIdentityFrom, requireAuth, sendError, noStore } from '../http/middleware.js';
import { refreshCookieOptions, REFRESH_COOKIE } from '../security/sessions.js';
import { AUDIT_ACTIONS } from '../security/audit.js';

/* ==========================================================================
 *  Schémas de validation
 * ========================================================================== */

const PasswordSchema = z
  .string()
  .min(12, 'Le mot de passe doit contenir au moins 12 caractères.')
  .max(256, 'Le mot de passe ne peut pas dépasser 256 caractères.');

const LoginStaffSchema = z.object({
  email: z.string().email('Adresse e-mail invalide.'),
  password: z.string().min(1, 'Mot de passe obligatoire.'),
  totpCode: z.string().trim().regex(/^\d{6}$/, 'Code à 6 chiffres attendu.').optional().nullable(),
  deviceId: z.string().trim().max(120).optional().nullable(),
});

const LoginParentSchema = z.object({
  emailOrPhone: z.string().trim().min(3).max(160),
  password: z.string().min(1, 'Mot de passe obligatoire.'),
  totpCode: z.string().trim().regex(/^\d{6}$/).optional().nullable(),
  deviceId: z.string().trim().max(120).optional().nullable(),
});

const TYPES_ECOLE = [
  'maternelle', 'primaire', 'secondaire', 'humanites',
  'technique', 'professionnel', 'mixte', 'autre',
] as const;

const SchoolTypeSchema = z.enum(TYPES_ECOLE);

const RegisterSchoolSchema = z.object({
  officialName: z.string().trim().min(3).max(180),
  // Type principal (ancien champ mono, encore accepté pour compatibilité).
  type: SchoolTypeSchema.optional(),
  // Sélection multiple : les cycles réellement proposés.
  types: z.array(SchoolTypeSchema).min(1).max(TYPES_ECOLE.length).optional(),
  // Précision « mixte / non mixte », demandée notamment pour le collège.
  isMixed: z.boolean().optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  commune: z.string().trim().max(120).optional().nullable(),
  addressLine: z.string().trim().max(240).optional().nullable(),
  phone: z.string().trim().max(32).optional().nullable(),
  email: z.string().email().optional().nullable(),
  description: z.string().trim().max(4000).optional().nullable(),
  openingHours: z.string().trim().max(600).optional().nullable(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
  directorName: z.string().trim().min(3).max(160),
  directorEmail: z.string().email(),
  directorPhone: z.string().trim().max(32).optional().nullable(),
  directorJobTitle: z.string().trim().max(80).optional().nullable(),
  password: PasswordSchema,
  yearLabel: z.string().trim().regex(/^\d{4}\s*[-/]\s*\d{4}$/, 'Année scolaire au format 2026-2027.'),
  parentLinkMode: z.enum(['automatique', 'validation']).optional(),
  acceptTerms: z.literal(true, { message: 'Vous devez accepter les conditions d’utilisation.' }),
});

const RegisterParentSchema = z.object({
  fullName: z.string().trim().min(3).max(160),
  email: z.string().email().optional().nullable(),
  phone: z.string().trim().max(32).optional().nullable(),
  password: PasswordSchema,
  relationship: z.string().trim().max(40).optional(),
  // Le code de l'élève suffit : il rattache le compte au compte à
  // l'établissement de l'enfant, sans jamais saisir de code école.
  codeEleve: z.string().trim().min(6, 'Code élève obligatoire.').max(32),
  acceptTerms: z.literal(true, { message: 'Vous devez accepter les conditions d’utilisation.' }),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: PasswordSchema,
});

const TotpConfirmSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Code à 6 chiffres attendu.'),
});

const TotpDisableSchema = z.object({
  password: z.string().min(1, 'Mot de passe obligatoire pour désactiver la double authentification.'),
});

/* ==========================================================================
 *  Routes
 * ========================================================================== */

export async function registerAuthRoutes(deps: AppDependencies): Promise<void> {
  const { app, db, config, authService, sessions, audit, guard } = deps;

  const authDeps = {
    db,
    sessions,
    jwtVerify: (token: string) => app.jwt.verify(token) as Record<string, any>,
  };

  /* ---------------------------------------------------------------------- */
  /*  Inscription d'une école                                               */
  /* ---------------------------------------------------------------------- */

  app.post('/api/auth/ecole/inscription', async (req, reply) => {
    const parsed = RegisterSchoolSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Formulaire incomplet ou incorrect.', {
        details: parsed.error.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
      });
    }

    // Sélection multiple : au moins un cycle doit être coché.
    const types = parsed.data.types ?? (parsed.data.type ? [parsed.data.type] : []);
    if (types.length === 0) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Formulaire incomplet ou incorrect.', {
        details: [
          { champ: 'types', message: 'Sélectionnez au moins un type d’établissement.' },
        ],
      });
    }

    const ip = clientIp(req);
    const ctx = {
      ip,
      userAgent: req.headers['user-agent'] ?? null,
      deviceId: (req.headers['x-device-id'] as string) ?? null,
    };

    const result = await db.withIdentity({ actor: 'system', ip }, async (client) => {
      // Limitation de débit : la création d'école est une opération rare.
      const quota = await guard.consume(client, 'register', { kind: 'ip', key: ip ?? 'inconnue' });
      if (!quota.allowed) {
        const err = new Error(
          'Trop de créations d’établissement depuis cette connexion. Réessayez plus tard.',
        ) as Error & { statusCode?: number; code?: string };
        err.statusCode = 429;
        err.code = 'TROP_DE_REQUETES';
        throw err;
      }

      // Unicité de l'e-mail du directeur
      const existing = await client.query(
        `SELECT 1 FROM sec.staff_users WHERE email = $1 LIMIT 1`,
        [parsed.data.directorEmail.trim().toLowerCase()],
      );
      if ((existing.rowCount ?? 0) > 0) {
        const err = new Error('Cette adresse e-mail est déjà utilisée par un compte.') as Error & {
          statusCode?: number;
          code?: string;
        };
        err.statusCode = 409;
        err.code = 'EMAIL_EXISTANT';
        throw err;
      }

      return authService.registerSchool(
        client,
        {
          ...parsed.data,
          type: types[0]!,
          types,
          isMixed: parsed.data.isMixed ?? null,
          parentLinkMode: parsed.data.parentLinkMode ?? 'validation',
        },
        ctx,
      );
    });

    return noStore(reply).code(201).send({
      message: 'Votre établissement a été créé.',
      ecole: {
        id: result.schoolId,
        anneeScolaire: result.yearLabel,
      },
      compte: { email: parsed.data.directorEmail },
      prochaineEtape:
        'Connectez-vous avec votre adresse e-mail et votre mot de passe, ' +
        'puis suivez l’assistant de configuration pour créer vos classes.',
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Inscription d'un parent                                               */
  /* ---------------------------------------------------------------------- */

  app.post('/api/auth/parent/inscription', async (req, reply) => {
    const parsed = RegisterParentSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Formulaire incomplet ou incorrect.', {
        details: parsed.error.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
      });
    }

    const ip = clientIp(req);
    const ctx = { ip, userAgent: req.headers['user-agent'] ?? null, deviceId: null };

    const result = await db.withIdentity({ actor: 'system', ip }, async (client) => {
      const quota = await guard.consume(client, 'register', { kind: 'ip', key: ip ?? 'inconnue' });
      if (!quota.allowed) {
        const err = new Error('Trop de créations de compte depuis cette connexion.') as Error & {
          statusCode?: number;
          code?: string;
        };
        err.statusCode = 429;
        err.code = 'TROP_DE_REQUETES';
        throw err;
      }

      if (parsed.data.email) {
        const existing = await client.query(`SELECT 1 FROM app.parents WHERE email = $1 LIMIT 1`, [
          parsed.data.email.trim().toLowerCase(),
        ]);
        if ((existing.rowCount ?? 0) > 0) {
          const err = new Error('Cette adresse e-mail est déjà utilisée.') as Error & {
            statusCode?: number;
            code?: string;
          };
          err.statusCode = 409;
          err.code = 'EMAIL_EXISTANT';
          throw err;
        }
      }

      // Code élève obligatoire : il identifie l'enfant ET son établissement,
      // ce qui évite tout code école à retenir ou à diffuser.
      const normalizedCode = parsed.data.codeEleve
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
      const studentCode = normalizedCode.startsWith('MCELV')
        ? `MC-ELV-${normalizedCode.slice(4)}`
        : normalizedCode;

      const student = await client.query<{
        student_id: string;
        full_name: string;
        class_name: string | null;
        school_id: string;
        official_name: string;
        parent_link_mode: string;
      }>(
        `SELECT s.id AS student_id, s.full_name, cl.name AS class_name,
                sch.id AS school_id, sch.official_name, sch.parent_link_mode
           FROM app.students s
           JOIN app.schools sch ON sch.id = s.school_id
           LEFT JOIN app.classes cl ON cl.id = s.class_id
          WHERE s.public_code = $1 AND sch.is_active
          LIMIT 1`,
        [studentCode],
      );

      if ((student.rowCount ?? 0) === 0) {
        const err = new Error(
          'Aucun élève ne correspond à ce code. Vérifiez le code unique remis par l’établissement.',
        ) as Error & { statusCode?: number; code?: string };
        err.statusCode = 404;
        err.code = 'ELEVE_INTROUVABLE';
        throw err;
      }

      const enfant = student.rows[0]!;

      const result = await authService.registerParent(
        client,
        {
          fullName: parsed.data.fullName,
          email: parsed.data.email ?? null,
          phone: parsed.data.phone ?? null,
          password: parsed.data.password,
          relationship: parsed.data.relationship ?? 'parent',
          acceptTerms: true,
        },
        ctx,
      );

      // Rattachement immédiat à l'enfant (et donc à son établissement) :
      // le compte n'est jamais créé orphelin.
      const autoApprove = enfant.parent_link_mode === 'automatique';
      await client.query(
        `INSERT INTO app.parent_student_links
           (school_id, parent_id, student_id, relationship, status, is_primary,
            requested_method, decided_at, decision_note)
         VALUES ($1,$2,$3,$4,$5::app.link_status,true,'code_enfant',
                 CASE WHEN $5 = 'actif' THEN now() ELSE NULL END,
                 CASE WHEN $5 = 'actif' THEN 'Validation automatique (configuration de l''école)' ELSE NULL END)
         ON CONFLICT (parent_id, student_id) DO NOTHING`,
        [
          enfant.school_id,
          result.parentId,
          enfant.student_id,
          parsed.data.relationship ?? 'parent',
          autoApprove ? 'actif' : 'en_attente',
        ],
      );

      return { parent: result, eleve: enfant, autoApprove };
    });

    return noStore(reply).code(201).send({
      message: result.autoApprove
        ? `Votre compte parent a été créé : ${result.eleve.full_name} est déjà rattaché(e).`
        : `Votre compte parent a été créé. Une validation de ${result.eleve.official_name} est requise pour accéder au suivi de ${result.eleve.full_name}.`,
      parent: { id: result.parent.parentId, code: result.parent.publicCode },
      eleve: {
        nom: result.eleve.full_name,
        classe: result.eleve.class_name,
      },
      ecole: { nom: result.eleve.official_name },
      prochaineEtape:
        'Connectez-vous : vos présences, demandes et communiqués sont déjà disponibles.',
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Connexion école                                                       */
  /* ---------------------------------------------------------------------- */

  app.post('/api/auth/ecole/connexion', async (req, reply) => {
    const parsed = LoginStaffSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Identifiants incomplets.');
    }

    const ip = clientIp(req);
    const ctx = {
      ip,
      userAgent: req.headers['user-agent'] ?? null,
      deviceId: parsed.data.deviceId ?? (req.headers['x-device-id'] as string) ?? null,
      fingerprint: null,
    };

    const outcome = await db.withIdentity({ actor: 'system', ip }, (client) =>
      authService.loginStaff(client, parsed.data, ctx),
    );

    if (outcome.status === 'succes') {
      reply.setCookie(
        REFRESH_COOKIE,
        outcome.tokens.refreshToken,
        refreshCookieOptions(config, config.REFRESH_TOKEN_TTL_DAYS * 86_400),
      );
      return noStore(reply).send({
        message: `Bienvenue, ${outcome.profile.fullName}.`,
        jetonAcces: outcome.tokens.accessToken,
        expireDans: outcome.tokens.accessExpiresIn,
        profil: outcome.profile,
      });
    }

    if (outcome.status === '2fa_requis') {
      return noStore(reply).code(202).send({
        message: 'Saisissez le code à 6 chiffres de votre application d’authentification.',
        deuxiemeFacteurRequis: true,
        jetonDefi: outcome.challengeToken,
        expireDans: outcome.expiresInSeconds,
      });
    }

    if (outcome.status === 'verrouille') {
      reply.header('Retry-After', String(outcome.retryAfterSeconds));
      return noStore(reply).code(429).send({
        erreur: 'COMPTE_VERROUILLE',
        message: outcome.message,
        reessayerDansSecondes: outcome.retryAfterSeconds,
      });
    }

    if (outcome.status === 'mot_de_passe_a_changer') {
      return noStore(reply).code(428).send({
        erreur: 'MOT_DE_PASSE_A_CHANGER',
        message: outcome.message,
      });
    }

    return noStore(reply).code(401).send({ erreur: 'IDENTIFIANTS_INCORRECTS', message: outcome.message });
  });

  /* ---------------------------------------------------------------------- */
  /*  Connexion parent                                                      */
  /* ---------------------------------------------------------------------- */

  app.post('/api/auth/parent/connexion', async (req, reply) => {
    const parsed = LoginParentSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Identifiants incomplets.');
    }

    const ip = clientIp(req);
    const ctx = {
      ip,
      userAgent: req.headers['user-agent'] ?? null,
      deviceId: parsed.data.deviceId ?? (req.headers['x-device-id'] as string) ?? null,
    };

    const outcome = await db.withIdentity({ actor: 'system', ip }, (client) =>
      authService.loginParent(client, parsed.data, ctx),
    );

    if (outcome.status === 'succes') {
      reply.setCookie(
        REFRESH_COOKIE,
        outcome.tokens.refreshToken,
        refreshCookieOptions(config, config.REFRESH_TOKEN_TTL_DAYS * 86_400),
      );
      return noStore(reply).send({
        message: `Bonjour ${outcome.profile.fullName} 👋`,
        jetonAcces: outcome.tokens.accessToken,
        expireDans: outcome.tokens.accessExpiresIn,
        profil: outcome.profile,
      });
    }

    if (outcome.status === '2fa_requis') {
      return noStore(reply).code(202).send({
        message: 'Saisissez le code de vérification.',
        deuxiemeFacteurRequis: true,
        jetonDefi: outcome.challengeToken,
        expireDans: outcome.expiresInSeconds,
      });
    }

    if (outcome.status === 'verrouille') {
      reply.header('Retry-After', String(outcome.retryAfterSeconds));
      return noStore(reply).code(429).send({
        erreur: 'COMPTE_VERROUILLE',
        message: outcome.message,
        reessayerDansSecondes: outcome.retryAfterSeconds,
      });
    }

    return noStore(reply).code(401).send({ erreur: 'IDENTIFIANTS_INCORRECTS', message: outcome.message });
  });

  /* ---------------------------------------------------------------------- */
  /*  Validation du deuxième facteur                                        */
  /* ---------------------------------------------------------------------- */

  app.post('/api/auth/2fa/valider', async (req, reply) => {
    const schema = z.object({
      jetonDefi: z.string().min(10),
      code: z.string().trim().regex(/^\d{6}$/),
      deviceId: z.string().trim().max(120).optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Code de vérification invalide.');
    }

    const ip = clientIp(req);
    const ctx = {
      ip,
      userAgent: req.headers['user-agent'] ?? null,
      deviceId: parsed.data.deviceId ?? (req.headers['x-device-id'] as string) ?? null,
    };

    const result = await db.withIdentity({ actor: 'system', ip }, async (client) => {
      const challenge = await authService.consumeChallenge(client, parsed.data.jetonDefi);
      if (!challenge.ok) {
        const err = new Error(
          'Votre demande de vérification a expiré. Reconnectez-vous.',
        ) as Error & { statusCode?: number; code?: string };
        err.statusCode = 401;
        err.code = 'DEFI_EXPIRE';
        throw err;
      }

      // Limitation de débit sur les tentatives de code : sans cela, un code à
      // 6 chiffres serait trouvable par force brute en quelques minutes.
      const quota = await guard.consume(client, 'totp', {
        kind: challenge.audience === 'parent' ? 'parent' : 'staff',
        key: challenge.subjectId,
      });
      if (!quota.allowed) {
        const err = new Error('Trop de tentatives de code. Patientez puis reconnectez-vous.') as Error & {
          statusCode?: number;
          code?: string;
        };
        err.statusCode = 429;
        err.code = 'TROP_DE_TENTATIVES';
        throw err;
      }

      if (challenge.audience === 'staff') {
        const { rows } = await client.query<{
          school_id: string;
          full_name: string;
          email: string;
          is_owner: boolean;
          job_title: string | null;
          totp_secret_enc: Buffer | null;
          totp_last_used_step: string | null;
          school_name: string;
          types: string[];
          primary_color: string;
        }>(
          `SELECT u.school_id, u.full_name, u.email, u.is_owner, u.job_title,
                  u.totp_secret_enc, u.totp_last_used_step,
                  s.official_name AS school_name, s.types, s.primary_color
             FROM sec.staff_users u JOIN app.schools s ON s.id = u.school_id
            WHERE u.id = $1`,
          [challenge.subjectId],
        );
        const user = rows[0];
        if (!user) {
          const err = new Error('Compte introuvable.') as Error & { statusCode?: number; code?: string };
          err.statusCode = 401;
          err.code = 'COMPTE_INTROUVABLE';
          throw err;
        }

        const verification = await authService.verifySecondFactor(
          client,
          challenge.subjectId,
          parsed.data.code,
          user.totp_secret_enc,
          user.totp_last_used_step ? Number(user.totp_last_used_step) : null,
        );

        if (!verification.ok) {
          const err = new Error('Code de vérification incorrect ou déjà utilisé.') as Error & {
            statusCode?: number;
            code?: string;
          };
          err.statusCode = 401;
          err.code = 'CODE_INCORRECT';
          throw err;
        }

        const tokens = await sessions.create(client, {
          audience: 'ecole',
          staffUserId: challenge.subjectId,
          schoolId: user.school_id,
          ip,
          userAgent: ctx.userAgent,
          deviceId: ctx.deviceId,
          mfaSatisfied: true,
          mfaMethod: 'totp',
        });

        await client.query(
          `UPDATE sec.staff_users SET last_login_at = now(), last_login_ip = $2 WHERE id = $1`,
          [challenge.subjectId, ip],
        );

        const permissions = (
          await client.query<{ permission_code: string }>(
            `SELECT permission_code FROM sec.effective_permissions($1)`,
            [challenge.subjectId],
          )
        ).rows.map((r) => r.permission_code);

        await audit.write(client, {
          actorKind: 'staff',
          actorId: challenge.subjectId,
          actorLabel: user.full_name,
          actorIp: ip,
          schoolId: user.school_id,
        }, {
          action: AUDIT_ACTIONS.LOGIN_SUCCESS,
          severity: 'info',
          result: 'succes',
          entityType: 'staff',
          entityId: challenge.subjectId,
          payload: { deuxiemeFacteur: 'validé' },
        });

        return {
          audience: 'ecole' as const,
          tokens,
          profile: {
            kind: 'ecole' as const,
            id: challenge.subjectId,
            schoolId: user.school_id,
            schoolName: user.school_name,
            types: user.types ?? [],
            fullName: user.full_name,
            jobTitle: user.job_title,
            email: user.email,
            isOwner: user.is_owner,
            permissions,
            mustChangePassword: false,
            twoFactorEnabled: true,
            primaryColor: user.primary_color,
          },
        };
      }

      // Parent
      const { rows } = await client.query<{
        full_name: string;
        email: string | null;
        phone: string | null;
        totp_secret_enc: Buffer | null;
        totp_last_used_step: string | null;
        children_count: string;
      }>(
        `SELECT p.full_name, p.email, p.phone, c.totp_secret_enc, c.totp_last_used_step,
                (SELECT count(*) FROM app.parent_student_links l
                  WHERE l.parent_id = p.id AND l.status = 'actif')::text AS children_count
           FROM app.parents p JOIN sec.parent_credentials c ON c.parent_id = p.id
          WHERE p.id = $1`,
        [challenge.subjectId],
      );
      const parent = rows[0];
      if (!parent) {
        const err = new Error('Compte introuvable.') as Error & { statusCode?: number; code?: string };
        err.statusCode = 401;
        err.code = 'COMPTE_INTROUVABLE';
        throw err;
      }

      const secret = authService.decryptTotpSecretFor(parent.totp_secret_enc, challenge.subjectId, 'parent');
      const { verifyTotp: verify, DEFAULT_TOTP: cfg } = await import('../security/totp.js');
      const check = secret
        ? verify(parsed.data.code, secret, {
            ...cfg,
            lastUsedStep: parent.totp_last_used_step ? Number(parent.totp_last_used_step) : null,
          })
        : { valid: false };

      if (!check.valid) {
        const err = new Error('Code de vérification incorrect.') as Error & {
          statusCode?: number;
          code?: string;
        };
        err.statusCode = 401;
        err.code = 'CODE_INCORRECT';
        throw err;
      }

      await client.query(
        `UPDATE sec.parent_credentials SET totp_last_used_step = $2, last_login_at = now()
          WHERE parent_id = $1`,
        [challenge.subjectId, check.valid ? check.step : null],
      );

      const tokens = await sessions.create(client, {
        audience: 'parent',
        parentId: challenge.subjectId,
        ip,
        userAgent: ctx.userAgent,
        deviceId: ctx.deviceId,
        mfaSatisfied: true,
        mfaMethod: 'totp',
      });

      return {
        audience: 'parent' as const,
        tokens,
        profile: {
          kind: 'parent' as const,
          id: challenge.subjectId,
          fullName: parent.full_name,
          email: parent.email,
          phone: parent.phone,
          childrenCount: Number(parent.children_count),
          twoFactorEnabled: true,
        },
      };
    });

    reply.setCookie(
      REFRESH_COOKIE,
      result.tokens.refreshToken,
      refreshCookieOptions(config, config.REFRESH_TOKEN_TTL_DAYS * 86_400),
    );

    return noStore(reply).send({
      message: 'Vérification réussie.',
      jetonAcces: result.tokens.accessToken,
      expireDans: result.tokens.accessExpiresIn,
      profil: result.profile,
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Renouvellement de session                                             */
  /* ---------------------------------------------------------------------- */

  app.post('/api/auth/renouveler', async (req, reply) => {
    const token = (req.cookies as Record<string, string | undefined>)?.[REFRESH_COOKIE];
    if (!token) {
      return sendError(reply, 401, 'SESSION_ABSENTE', 'Aucune session active.');
    }

    const ip = clientIp(req);
    const result = await db.withIdentity({ actor: 'system', ip }, (client) =>
      sessions.rotate(client, {
        refreshToken: token,
        ip,
        userAgent: req.headers['user-agent'] ?? null,
      }),
    );

    if (!result.ok) {
      // Cookie invalide : on le supprime pour éviter une boucle de tentatives.
      reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      return sendError(reply, 401, result.replayed ? 'REJEU_DETECTE' : 'SESSION_INVALIDE', result.reason);
    }

    reply.setCookie(
      REFRESH_COOKIE,
      result.tokens.refreshToken,
      refreshCookieOptions(config, config.REFRESH_TOKEN_TTL_DAYS * 86_400),
    );

    return noStore(reply).send({
      jetonAcces: result.tokens.accessToken,
      expireDans: result.tokens.accessExpiresIn,
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Déconnexion                                                           */
  /* ---------------------------------------------------------------------- */

  app.post('/api/auth/deconnexion', { preHandler: requireAuth(authDeps) }, async (req, reply) => {
    const auth = req.auth!;
    await db.withIdentity(dbIdentityFrom(req), async (client) => {
      await sessions.revoke(client, auth.identity.sessionId, 'déconnexion volontaire');
      await audit.write(client, {
        actorKind: auth.identity.audience === 'parent' ? 'parent' : 'staff',
        actorId: auth.userId,
        actorLabel: auth.displayName,
        actorIp: clientIp(req),
        schoolId: auth.schoolId,
      }, {
        action: AUDIT_ACTIONS.LOGOUT,
        severity: 'info',
        result: 'succes',
      });
    });

    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return noStore(reply).send({ message: 'Vous êtes déconnecté.' });
  });

  /** Déconnexion de tous les appareils. */
  app.post('/api/auth/deconnexion-partout', { preHandler: requireAuth(authDeps) }, async (req, reply) => {
    const auth = req.auth!;
    const count = await db.withIdentity(dbIdentityFrom(req), (client) =>
      sessions.revokeAll(
        client,
        {
          parentId: auth.identity.parentId ?? null,
          staffUserId: auth.identity.staffUserId ?? null,
        },
        'déconnexion de tous les appareils',
      ),
    );

    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return noStore(reply).send({
      message: `${count} session(s) fermée(s) sur tous vos appareils.`,
      sessionsFermees: count,
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Profil courant                                                        */
  /* ---------------------------------------------------------------------- */

  app.get('/api/auth/moi', { preHandler: requireAuth(authDeps) }, async (req, reply) => {
    const auth = req.auth!;

    const profile = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      if (auth.identity.audience === 'parent') {
        const { rows } = await client.query(
          `SELECT p.id, p.full_name, p.email, p.phone, p.relationship, p.photo_url,
                  p.notification_prefs, p.public_code,
                  c.totp_enabled,
                  (SELECT count(*) FROM app.parent_student_links l
                    WHERE l.parent_id = p.id AND l.status = 'actif')::int AS enfants_actifs
             FROM app.parents p
             JOIN sec.parent_credentials c ON c.parent_id = p.id
            WHERE p.id = $1`,
          [auth.userId],
        );
        return { interface: 'parent' as const, ...rows[0] };
      }

      const { rows } = await client.query(
        `SELECT u.id, u.full_name, u.email, u.job_title, u.phone, u.is_owner,
                u.totp_enabled, u.must_change_password, u.last_login_at,
                s.id AS school_id, s.official_name, s.logo_url, s.types,
                s.primary_color, s.secondary_color, s.parent_link_mode,
                s.current_year_label, s.city, s.settings
           FROM sec.staff_users u
           JOIN app.schools s ON s.id = u.school_id
          WHERE u.id = $1`,
        [auth.userId],
      );
      return { interface: 'ecole' as const, ...rows[0], permissions: auth.permissions };
    });

    return noStore(reply).send({ profil: profile });
  });

  /* ---------------------------------------------------------------------- */
  /*  Changement de mot de passe                                            */
  /* ---------------------------------------------------------------------- */

  app.post('/api/auth/mot-de-passe', { preHandler: requireAuth(authDeps) }, async (req, reply) => {
    const parsed = ChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Nouveau mot de passe invalide.', {
        details: parsed.error.issues.map((i) => ({ champ: i.path.join('.'), message: i.message })),
      });
    }

    const auth = req.auth!;
    const result = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const service = authService.passwords;
      if (auth.identity.audience === 'parent') {
        return service.setParentPassword(client, {
          parentId: auth.userId,
          newPassword: parsed.data.newPassword,
          requireCurrent: true,
          currentPassword: parsed.data.currentPassword ?? null,
        });
      }
      return service.setStaffPassword(client, {
        staffUserId: auth.userId,
        newPassword: parsed.data.newPassword,
        requireCurrent: true,
        currentPassword: parsed.data.currentPassword ?? null,
        actorLabel: auth.displayName,
      });
    });

    if (!result.ok) {
      return sendError(reply, 400, 'MOT_DE_PASSE_REFUSE', result.reason, {
        ...('violations' in result && result.violations ? { violations: result.violations } : {}),
      });
    }

    // Le changement de mot de passe a révoqué toutes les sessions : on efface
    // le cookie pour éviter toute confusion côté client.
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return noStore(reply).send({
      message: 'Mot de passe modifié. Toutes vos sessions ont été fermées par sécurité ; reconnectez-vous.',
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Activation du deuxième facteur                                        */
  /* ---------------------------------------------------------------------- */

  app.post('/api/auth/2fa/activer', { preHandler: requireAuth(authDeps) }, async (req, reply) => {
    const auth = req.auth!;
    const kind = auth.identity.audience === 'parent' ? 'parent' : 'staff';

    const enrollment = await db.withIdentity(dbIdentityFrom(req), async (client) => {
      const schoolName =
        kind === 'staff'
          ? (
              await client.query<{ official_name: string }>(
                `SELECT official_name FROM app.schools WHERE id = $1`,
                [auth.schoolId],
              )
            ).rows[0]?.official_name
          : undefined;
      return authService.beginTotpEnrollment(client, {
        kind,
        id: auth.userId,
        label:
          kind === 'staff'
            ? (
                await client.query<{ email: string }>(`SELECT email FROM sec.staff_users WHERE id = $1`, [
                  auth.userId,
                ])
              ).rows[0]?.email ?? auth.displayName
            : (
                await client.query<{ email: string | null; phone: string | null }>(
                  `SELECT email, phone FROM app.parents WHERE id = $1`,
                  [auth.userId],
                )
              ).rows[0]?.email ?? 'compte-parent',
        ...(schoolName ? { schoolName } : {}),
      });
    });

    return noStore(reply).send({
      message:
        'Scannez ce QR code avec votre application d’authentification ' +
        '(Google Authenticator, Authy, Microsoft Authenticator…), puis saisissez le code affiché.',
      secret: enrollment.secretBase32,
      uri: enrollment.otpauthUri,
      qrCode: enrollment.qrDataUrl,
      etapes: [
        'Ouvrez votre application d’authentification.',
        'Ajoutez un compte en scannant le QR code.',
        'Saisissez le code à 6 chiffres pour confirmer l’activation.',
        'Conservez les codes de secours qui vous seront affichés : ils permettent de vous connecter si vous perdez votre téléphone.',
      ],
    });
  });

  app.post('/api/auth/2fa/confirmer', { preHandler: requireAuth(authDeps) }, async (req, reply) => {
    const parsed = TotpConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Code à 6 chiffres attendu.');
    }

    const auth = req.auth!;
    const kind = auth.identity.audience === 'parent' ? 'parent' : 'staff';

    const result = await db.withIdentity(dbIdentityFrom(req), (client) =>
      authService.confirmTotpEnrollment(client, { kind, id: auth.userId }, parsed.data.code),
    );

    if (!result.ok) {
      return sendError(reply, 400, 'CODE_INCORRECT', result.message);
    }

    return noStore(reply).send({
      message:
        'Double authentification activée. Conservez ces codes de secours : ' +
        'ils ne seront plus jamais affichés.',
      codesSecours: result.recoveryCodes,
      avertissement:
        'Chaque code de secours ne fonctionne qu’une seule fois. ' +
        'Imprimez-les ou notez-les dans un endroit sûr, séparé de votre téléphone.',
    });
  });

  app.post('/api/auth/2fa/desactiver', { preHandler: requireAuth(authDeps) }, async (req, reply) => {
    const parsed = TotpDisableSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Mot de passe obligatoire.');
    }

    const auth = req.auth!;
    const kind = auth.identity.audience === 'parent' ? 'parent' : 'staff';

    await db.withIdentity(dbIdentityFrom(req), async (client) => {
      // Vérification du mot de passe : désactiver la 2FA est une opération
      // sensible, elle ne doit pas être possible depuis une session volée.
      const { verifyPassword } = await import('../security/crypto.js');
      const { rows } =
        kind === 'staff'
          ? await client.query<{ password_hash: string }>(
              `SELECT password_hash FROM sec.staff_users WHERE id = $1`,
              [auth.userId],
            )
          : await client.query<{ password_hash: string }>(
              `SELECT password_hash FROM sec.parent_credentials WHERE parent_id = $1`,
              [auth.userId],
            );

      const check = await verifyPassword(
        parsed.data.password,
        rows[0]?.password_hash ?? '',
        deps.secrets.passwordPeppers(),
      );
      if (!check.ok) {
        const err = new Error('Mot de passe incorrect.') as Error & { statusCode?: number; code?: string };
        err.statusCode = 401;
        err.code = 'MOT_DE_PASSE_INCORRECT';
        throw err;
      }

      await authService.disableTotp(client, { kind, id: auth.userId });
    });

    return noStore(reply).send({
      message:
        'Double authentification désactivée. Votre compte est moins protégé : ' +
        'réactivez-la dès que possible.',
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Mot de passe oublié                                                   */
  /* ---------------------------------------------------------------------- */

  app.post('/api/auth/mot-de-passe-oublie', async (req, reply) => {
    const parsed = z
      .object({
        identifiant: z.string().trim().min(3).max(160),
        interface: z.enum(['parent', 'ecole']),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Identifiant obligatoire.');
    }

    const ip = clientIp(req);

    await db.withIdentity({ actor: 'system', ip }, async (client) => {
      const quota = await guard.consume(client, 'password_reset', { kind: 'ip', key: ip ?? 'inconnue' });

      // La réponse est IDENTIQUE que le compte existe ou non : sinon, l'API
      // permettrait de découvrir les adresses e-mail enregistrées.
      if (!quota.allowed) return;

      const identifier = parsed.data.identifiant.toLowerCase();

      if (parsed.data.interface === 'ecole') {
        const { rows } = await client.query<{ id: string; full_name: string; email: string }>(
          `SELECT id, full_name, email FROM sec.staff_users WHERE email = $1 AND is_active LIMIT 1`,
          [identifier],
        );
        if (rows[0]) {
          const { token } = await authService.passwords.createResetToken(client, {
            audience: 'ecole',
            staffUserId: rows[0].id,
            ip,
          });
          await audit.write(client, {
            actorKind: 'anonyme',
            actorIp: ip,
            actorLabel: rows[0].full_name,
          }, {
            action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
            severity: 'notice',
            result: 'succes',
            entityType: 'staff',
            entityId: rows[0].id,
            // Le jeton lui-même n'est PAS journalisé : il est masqué par redact().
            payload: { canal: 'e-mail', destinataire: rows[0].email },
          });
          // En production, l'envoi de l'e-mail est délégué au service de
          // messagerie ; le jeton n'est jamais renvoyé dans la réponse HTTP.
          app.log.info(
            { staffUserId: rows[0].id, expireMinutes: 30 },
            'jeton de réinitialisation créé (envoi par e-mail à implémenter côté messagerie)',
          );
          void token;
        }
      } else {
        const { rows } = await client.query<{ id: string; full_name: string }>(
          `SELECT p.id, p.full_name FROM app.parents p
            WHERE lower(p.email::text) = $1 AND p.is_active LIMIT 1`,
          [identifier],
        );
        if (rows[0]) {
          await authService.passwords.createResetToken(client, {
            audience: 'parent',
            parentId: rows[0].id,
            ip,
          });
          await audit.write(client, {
            actorKind: 'anonyme',
            actorIp: ip,
            actorLabel: rows[0].full_name,
          }, {
            action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
            severity: 'notice',
            result: 'succes',
            entityType: 'parent',
            entityId: rows[0].id,
          });
        }
      }
    });

    return noStore(reply).send({
      message:
        'Si un compte correspond à cette information, un lien de réinitialisation vient d’être envoyé. ' +
        'Pensez à vérifier vos courriers indésirables.',
    });
  });

  app.post('/api/auth/reinitialiser', async (req, reply) => {
    const parsed = z
      .object({ token: z.string().min(10), nouveauMotDePasse: PasswordSchema })
      .safeParse(req.body);

    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Lien ou mot de passe invalide.');
    }

    const ip = clientIp(req);
    const result = await db.withIdentity({ actor: 'system', ip }, async (client) => {
      const service = authService.passwords;
      return service.consumeResetToken(client, {
        token: parsed.data.token,
        newPassword: parsed.data.nouveauMotDePasse,
      });
    });

    if (!result.ok) {
      return sendError(reply, 400, 'REINITIALISATION_REFUSEE', result.reason);
    }

    return noStore(reply).send({ message: 'Mot de passe réinitialisé. Vous pouvez vous connecter.' });
  });

  /* ---------------------------------------------------------------------- */
  /*  Vérification de la robustesse d'un mot de passe (sans le transmettre) */
  /* ---------------------------------------------------------------------- */

  app.post('/api/auth/verifier-mot-de-passe', async (req, reply) => {
    const parsed = z
      .object({
        motDePasse: z.string().min(1).max(256),
        email: z.string().optional(),
        nomComplet: z.string().optional(),
        nomEcole: z.string().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return sendError(reply, 400, 'DONNEES_INVALIDES', 'Données invalides.');
    }

    const { checkPasswordStrength } = await import('../security/crypto.js');
    const check = checkPasswordStrength(parsed.data.motDePasse, {
      ...(parsed.data.email ? { email: parsed.data.email } : {}),
      ...(parsed.data.nomComplet ? { fullName: parsed.data.nomComplet } : {}),
      ...(parsed.data.nomEcole ? { schoolName: parsed.data.nomEcole } : {}),
    });

    // Le mot de passe n'est ni journalisé, ni stocké : seul son score est renvoyé.
    return noStore(reply).send({
      acceptable: check.ok,
      score: check.score,
      problemes: check.violations,
      conseils: check.suggestions,
    });
  });
}
