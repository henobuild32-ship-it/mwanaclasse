/**
 * ============================================================================
 *  MWANA CLASSE — Routes du module Ministère de l'EPST
 * ============================================================================
 *  Endpoints réservés au Ministère de l'EPST (Kinshasa) et consultation
 *  des communiqués officiels reçus par les écoles partenaires.
 * ============================================================================
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AppDependencies } from '../app.js';
import { requireAuth, sendError, noStore, clientIp } from '../http/middleware.js';
import { MinistereService } from '../services/ministere.js';

/* ==========================================================================
 *  Schémas de validation
 * ========================================================================== */

const ChangeMinisterePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Mot de passe actuel obligatoire.'),
  newPassword: z.string().min(8, 'Le nouveau mot de passe doit comporter au moins 8 caractères.'),
  confirmPassword: z.string().min(8, 'Confirmation du mot de passe obligatoire.'),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: 'La confirmation ne correspond pas au nouveau mot de passe.',
  path: ['confirmPassword'],
});

const ChangeMinistereIdentifierSchema = z.object({
  newIdentifier: z.string().email('Adresse e-mail invalide pour le nouvel identifiant.'),
});

const SendCommuniqueSchema = z.object({
  title: z.string().trim().min(3, 'Le titre doit comporter au moins 3 caractères.').max(250),
  message: z.string().trim().min(5, 'Le message est obligatoire.').max(200000),
  attachmentUrl: z.string().max(10_000_000).optional().nullable(),
  attachmentName: z.string().trim().max(250).optional().nullable(),
  attachmentType: z.enum(['pdf', 'image']).optional().nullable(),
  isUrgent: z.boolean().default(false),
  targetType: z.enum(['toutes_ecoles', 'ecole_specifique']),
  targetSchoolId: z.string().uuid().optional().nullable(),
}).refine(
  (data) => data.targetType !== 'ecole_specifique' || !!data.targetSchoolId,
  {
    message: 'Vous devez sélectionner une école destinataire.',
    path: ['targetSchoolId'],
  },
);

/* ==========================================================================
 *  Enregistrement des routes
 * ========================================================================== */

export async function registerMinistereRoutes(
  deps: AppDependencies,
  ministereService: MinistereService,
): Promise<void> {
  const { app, db, sessions } = deps;

  const authDeps = {
    db,
    sessions,
    jwtVerify: (token: string) => app.jwt.verify(token) as Record<string, any>,
  };

  /** Middleware de garde : réservé exclusivement au Ministère. */
  const guardMinistere = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.auth || req.auth.identity.audience !== 'ministere') {
      return sendError(
        reply,
        403,
        'ACCES_REFUSE',
        'Cette ressource est réservée au Ministère de l’EPST.',
      );
    }
  };

  /** Middleware de garde : réservé à une école authentifiée. */
  const guardEcole = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.auth || req.auth.identity.audience !== 'ecole' || !req.auth.schoolId) {
      return sendError(
        reply,
        403,
        'ACCES_REFUSE',
        'Cette ressource est réservée aux établissements scolaires.',
      );
    }
  };

  /* ====================================================================== */
  /*  ESPACE MINISTÈRE                                                      */
  /* ====================================================================== */

  /**
   * 1. Paramètres du Ministère (lecture)
   */
  app.get(
    '/api/ministere/parametres',
    { preHandler: [requireAuth(authDeps), guardMinistere] },
    async (_req, reply) => {
      const data = await db.withIdentity({ actor: 'system' }, (client) =>
        ministereService.getAccount(client),
      );
      if (!data) {
        return sendError(reply, 404, 'COMPTE_INTROUVABLE', 'Compte Ministère introuvable.');
      }
      return noStore(reply).send({
        compte: {
          id: data.id,
          identifier: data.identifier,
          isDefaultPassword: data.is_default_password,
          passwordChangedAt: data.password_changed_at,
          createdAt: data.created_at,
        },
      });
    },
  );

  /**
   * 2. Changement du mot de passe Ministère
   */
  app.put(
    '/api/ministere/parametres/mot-de-passe',
    { preHandler: [requireAuth(authDeps), guardMinistere] },
    async (req, reply) => {
      const parsed = ChangeMinisterePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Formulaire invalide.', {
          details: parsed.error.issues.map((i) => ({
            champ: i.path.join('.'),
            message: i.message,
          })),
        });
      }

      const accountId = req.auth!.userId;
      const result = await db.withIdentity({ actor: 'system' }, (client) =>
        ministereService.updatePassword(
          client,
          accountId,
          parsed.data.currentPassword,
          parsed.data.newPassword,
        ),
      );

      if (!result.ok) {
        return sendError(reply, 400, 'MOT_DE_PASSE_INCORRECT', result.message);
      }

      return noStore(reply).send({
        message: 'Votre mot de passe a été modifié avec succès.',
      });
    },
  );

  /**
   * 3. Modification de l'identifiant Ministère
   */
  app.put(
    '/api/ministere/parametres/identifiant',
    { preHandler: [requireAuth(authDeps), guardMinistere] },
    async (req, reply) => {
      const parsed = ChangeMinistereIdentifierSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Adresse e-mail invalide.');
      }

      const accountId = req.auth!.userId;
      const result = await db.withIdentity({ actor: 'system' }, (client) =>
        ministereService.updateIdentifier(client, accountId, parsed.data.newIdentifier),
      );

      if (!result.ok) {
        return sendError(reply, 400, 'IDENTIFIANT_INVALIDE', result.message);
      }

      return noStore(reply).send({
        message: 'Votre identifiant a été mis à jour.',
        identifier: result.identifier,
      });
    },
  );

  /**
   * 4. Liste des écoles inscrites à Kinshasa (avec filtre commune et recherche)
   */
  app.get(
    '/api/ministere/ecoles',
    { preHandler: [requireAuth(authDeps), guardMinistere] },
    async (req, reply) => {
      const query = req.query as { commune?: string; recherche?: string; statut?: string };
      const data = await db.withIdentity({ actor: 'system' }, (client) =>
        ministereService.getEcolesKinshasa(client, query),
      );
      return noStore(reply).send(data);
    },
  );

  /**
   * 5. Fiche détaillée d'une école
   */
  app.get(
    '/api/ministere/ecoles/:id',
    { preHandler: [requireAuth(authDeps), guardMinistere] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const ecole = await db.withIdentity({ actor: 'system' }, (client) =>
        ministereService.getEcoleDetails(client, id),
      );
      if (!ecole) {
        return sendError(reply, 404, 'ECOLE_INTROUVABLE', 'Établissement introuvable.');
      }
      return noStore(reply).send({ ecole });
    },
  );

  /**
   * 6. Envoyer un communiqué officiel aux écoles
   */
  app.post(
    '/api/ministere/communiques',
    { preHandler: [requireAuth(authDeps), guardMinistere] },
    async (req, reply) => {
      const parsed = SendCommuniqueSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'DONNEES_INVALIDES', 'Informations du communiqué incomplètes.', {
          details: parsed.error.issues.map((i) => ({
            champ: i.path.join('.'),
            message: i.message,
          })),
        });
      }

      const sentBy = req.auth?.displayName ?? 'Ministère de l\'EPST';

      const result = await db.withIdentity({ actor: 'system' }, (client) =>
        ministereService.sendCommunique(client, {
          title: parsed.data.title,
          message: parsed.data.message,
          attachmentUrl: parsed.data.attachmentUrl,
          attachmentName: parsed.data.attachmentName,
          attachmentType: parsed.data.attachmentType,
          isUrgent: parsed.data.isUrgent,
          targetType: parsed.data.targetType,
          targetSchoolId: parsed.data.targetSchoolId,
          sentBy,
        }),
      );

      return noStore(reply).code(201).send(result);
    },
  );

  /**
   * 7. Historique des communiqués envoyés
   */
  app.get(
    '/api/ministere/communiques/historique',
    { preHandler: [requireAuth(authDeps), guardMinistere] },
    async (_req, reply) => {
      const historique = await db.withIdentity({ actor: 'system' }, (client) =>
        ministereService.getHistorique(client),
      );
      return noStore(reply).send({ communiques: historique });
    },
  );

  /* ====================================================================== */
  /*  CÔTÉ ÉCOLE : COMMUNiQUÉS REÇUS DU MINISTÈRE                           */
  /* ====================================================================== */

  /**
   * 8. Liste des communiqués reçus par l'école
   */
  app.get(
    '/api/ecole/communiques-recus',
    { preHandler: [requireAuth(authDeps), guardEcole] },
    async (req, reply) => {
      const schoolId = req.auth!.schoolId!;
      const data = await db.withIdentity({ actor: 'system' }, (client) =>
        ministereService.getCommuniquesPourEcole(client, schoolId),
      );
      return noStore(reply).send(data);
    },
  );

  /**
   * 9. Marquer un communiqué reçu comme lu par l'école
   */
  app.post(
    '/api/ecole/communiques-recus/:id/lire',
    { preHandler: [requireAuth(authDeps), guardEcole] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const schoolId = req.auth!.schoolId!;
      await db.withIdentity({ actor: 'system' }, (client) =>
        ministereService.markAsRead(client, schoolId, id),
      );
      return noStore(reply).send({ ok: true, message: 'Communiqué marqué comme lu.' });
    },
  );
}
