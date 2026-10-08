/**
 * ============================================================================
 *  MWANA CLASSE — Application Fastify
 * ============================================================================
 *  Assemble le serveur HTTP avec toutes les protections transverses :
 *    - Helmet : CSP stricte, HSTS, nosniff, frameguard, referrer-policy ;
 *    - CORS : liste blanche explicite d'origines (jamais « * » avec cookies) ;
 *    - cookies : HttpOnly + SameSite + Secure en production ;
 *    - limitation de débit globale puis ciblée par route ;
 *    - corps de requête borné (protection contre l'épuisement mémoire) ;
 *    - identifiant de corrélation sur chaque requête et chaque réponse ;
 *    - gestionnaire d'erreurs qui ne divulgue jamais l'intérieur du serveur.
 * ============================================================================
 */

import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimitPlugin from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';

import { loadConfig, type AppConfig } from './config/index.js';
import { Database, translatePgError } from './db/pool.js';
import { SecretsManager } from './security/secrets.js';
import { AuditLogger } from './security/audit.js';
import { BruteForceGuard } from './security/bruteforce.js';
import { SessionService } from './security/sessions.js';
import { AuthService } from './security/auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSchoolRoutes } from './routes/school.js';
import { registerParentRoutes } from './routes/parent.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerSecurityRoutes } from './routes/security-routes.js';
import { clientIp } from './http/middleware.js';

export interface AppDependencies {
  app: FastifyInstance;
  config: AppConfig;
  db: Database;
  secrets: SecretsManager;
  audit: AuditLogger;
  guard: BruteForceGuard;
  sessions: SessionService;
  authService: AuthService;
}

/**
 * Catégorise une erreur de base pour la sonde /sante sans exposer d'information
 * d'infrastructure (hôte, utilisateur, mot de passe) : uniquement un mot-clé
 * et, s'il figure dans le message, le SQLSTATE.
 */
function diagnosticBase(message?: string): string {
  const m = message ?? '';
  if (/tenant\/user/i.test(m)) return 'tenant_inconnu';
  if (/SELF_SIGNED|CERT/i.test(m)) return 'ssl_certificat';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return 'dns';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(m)) return 'connexion';
  if (/password|28P01|28000/i.test(m)) return 'authentification';
  if (/timeout|ETIMEOUT|57014/i.test(m)) return 'delai_depasse';
  const sqlstate = /\(([0-9A-Z]{5})\)/.exec(m);
  return sqlstate ? `inconnu:${sqlstate[1]}` : 'inconnu';
}

/* ==========================================================================
 *  Constructeur
 * ========================================================================== */

export async function buildApp(overrides: Record<string, string | undefined> = {}): Promise<AppDependencies> {
  const config = loadConfig(overrides);

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Les données personnelles et les secrets ne doivent jamais atteindre
      // les journaux du serveur.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.newPassword',
          'req.body.currentPassword',
          'req.body.totpCode',
          'req.body.token',
          'req.body.refreshToken',
          '*.password_hash',
          '*.totp_secret_enc',
          '*.pepper',
        ],
        censor: '[MASQUÉ]',
      },
      ...(config.isDevelopment
        ? {
            transport: undefined,
            serializers: {
              req(req: any) {
                return { methode: req.method, chemin: req.url, ip: req.ip };
              },
            },
          }
        : {}),
    },
    trustProxy: config.TRUST_PROXY,
    // Bornes de taille : une requête ne doit pas pouvoir saturer la mémoire.
    bodyLimit: 1024 * 1024, // 1 Mio pour le JSON
    requestTimeout: 30_000,
    // Identifiant de corrélation repris dans toutes les réponses
    genReqId: (req) => (req.headers['x-correlation-id'] as string) ?? randomUUID(),
    disableRequestLogging: false,
    // Empêche l'exposition de la pile d'appels en production
    onProtoPoisoning: 'remove',
    onConstructorPoisoning: 'remove',
  });

  /* ---------------------------------------------------------------------- */
  /*  Secrets et services                                                   */
  /* ---------------------------------------------------------------------- */

  const secrets = new SecretsManager({
    provider: config.MWANA_SECRET_PROVIDER,
    ...(config.MWANA_SECRETS_DIR ? { secretsDir: config.MWANA_SECRETS_DIR } : {}),
    isProduction: config.isProduction,
  });
  // Une clé manquante en production fait échouer le démarrage : c'est voulu.
  secrets.loadAll();

  const db = new Database(config);
  const audit = new AuditLogger(secrets);
  const guard = new BruteForceGuard(db, config);

  /* ---------------------------------------------------------------------- */
  /*  Sécurité des en-têtes HTTP                                            */
  /* ---------------------------------------------------------------------- */

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Angular a besoin de styles injectés à l'exécution ; les scripts
        // restent strictement limités aux fichiers de l'application.
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", config.API_PUBLIC_URL, config.WEB_PUBLIC_URL],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"], // anti-clickjacking
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.isProduction ? [] : null,
      },
    },
    hsts: config.isProduction
      ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
      : false,
    crossOriginEmbedderPolicy: false, // nécessaire au service worker PWA
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xFrameOptions: { action: 'deny' },
    noSniff: true,
    hidePoweredBy: true,
  });

  /* ---------------------------------------------------------------------- */
  /*  CORS                                                                  */
  /* ---------------------------------------------------------------------- */

  await app.register(cors, {
    origin(origin, callback) {
      // Requête sans en-tête Origin (application mobile, curl) : autorisée.
      if (!origin) return callback(null, true);
      if (config.corsOrigins.includes(origin)) return callback(null, true);
      // Origine refusée : on renvoie `false` (aucun en-tête CORS) et surtout
      // JAMAIS une Error — elle serait traitée comme une erreur serveur (500)
      // alors que la requête est parfaitement légitime côté HTTP.
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id', 'X-Device-Id'],
    exposedHeaders: ['X-Correlation-Id', 'X-RateLimit-Remaining', 'Retry-After'],
    maxAge: 600,
  });

  /* ---------------------------------------------------------------------- */
  /*  Cookies                                                               */
  /* ---------------------------------------------------------------------- */

  await app.register(cookie, {
    secret: secrets.get('key.tokens').current.value,
    parseOptions: { httpOnly: true, sameSite: config.COOKIE_SAMESITE, path: '/' },
  });

  /* ---------------------------------------------------------------------- */
  /*  Jetons JWT (jeton d'accès uniquement)                                 */
  /* ---------------------------------------------------------------------- */

  await app.register(jwt as any, {
    secret: secrets.get('key.tokens').current.value,
    sign: {
      algorithm: 'HS512', // clé de 48+ octets : HS512 approprié
      iss: 'mwana-classe',
      expiresIn: config.ACCESS_TOKEN_TTL,
    },
    verify: {
      algorithms: ['HS512'],
      iss: 'mwana-classe',
      maxAge: config.ACCESS_TOKEN_TTL,
    },
    // Le jeton est transmis par en-tête Authorization uniquement : un cookie
    // de jeton d'accès exposerait l'API au CSRF.
    cookie: false,
  });

  /* ---------------------------------------------------------------------- */
  /*  Téléversements de fichiers (imports, communiqués, pièces jointes)     */
  /* ---------------------------------------------------------------------- */

  await app.register(multipart as any, {
    limits: {
      fileSize: config.MAX_UPLOAD_MB * 1024 * 1024,
      files: 1,
      fields: 30,
      fieldSize: 1024 * 1024,
    },
    // Accepte uniquement les formats utiles au produit : modèles de communiqué
    // (PDF, DOCX), listes d'élèves (CSV, XLSX) et images de logo.
    fileFilter: (_req: unknown, file: { mimetype: string }, cb: (err: Error | null, ok: boolean) => void) => {
      const allowed = [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/msword',
        'text/csv',
        'text/plain',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'image/png',
        'image/jpeg',
        'image/webp',
      ];
      cb(null, allowed.includes(file.mimetype));
    },
  });

  /* ---------------------------------------------------------------------- */
  /*  Limitation de débit globale (première barrière)                       */
  /* ---------------------------------------------------------------------- */

  await app.register(rateLimitPlugin, {
    global: true,
    max: config.RATE_LIMIT_GLOBAL_PER_MINUTE,
    timeWindow: '1 minute',
    // Le compteur est clé par adresse IP ; les limites fines, elles, sont
    // gérées en base (voir BruteForceGuard) pour être partagées entre
    // instances et survivre à un redémarrage.
    keyGenerator: (req) => clientIp(req) ?? 'inconnue',
    errorResponseBuilder: (_req, context) => ({
      erreur: 'TROP_DE_REQUETES',
      message: 'Trop de requêtes envoyées en peu de temps. Merci de patienter.',
      reessayerDansSecondes: Math.ceil(context.ttl / 1000),
    }),
    allowList: (req) => req.url === '/sante',
  });

  /* ---------------------------------------------------------------------- */
  /*  Corrélation et sécurité des réponses                                  */
  /* ---------------------------------------------------------------------- */

  app.addHook('onRequest', async (req, reply) => {
    req.correlationId = String(req.id);
    req.clientIp = clientIp(req);
    reply.header('X-Correlation-Id', req.correlationId);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    // Aucune page de l'application ne doit être mise en cache par un
    // intermédiaire : toutes les réponses contiennent des données personnelles.
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });

  /* ---------------------------------------------------------------------- */
  /*  Gestionnaire d'erreurs uniforme                                       */
  /* ---------------------------------------------------------------------- */

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & {
      statusCode?: number;
      code?: string;
      validation?: unknown;
      violations?: string[];
    };

    // Erreurs de validation Zod / Fastify
    if (err.validation) {
      return reply.code(400).send({
        erreur: 'DONNEES_INVALIDES',
        message: 'Les données envoyées sont incomplètes ou incorrectes.',
        details: err.validation,
        correlationId: req.correlationId,
      });
    }

    // Erreurs PostgreSQL traduites en messages compréhensibles
    if ((err as { code?: string }).code && /^\d{5}$/.test(String(err.code))) {
      const translated = translatePgError(err);
      req.log.warn(
        {
          correlationId: req.correlationId,
          pgCode: err.code,
          constraint: (err as any).constraint,
          table: (err as any).table,
          colonne: (err as any).column,
          detail: (err as any).detail,
          message: err.message,
        },
        'erreur base de données',
      );
      return reply.code(translated.status).send({
        erreur: translated.code,
        message: translated.message,
        correlationId: req.correlationId,
      });
    }

    const status = err.statusCode ?? 500;

    if (status >= 500) {
      // On journalise le détail côté serveur, mais on n'expose rien au client :
      // un message d'erreur interne est une source d'information pour un attaquant.
      req.log.error(
        { correlationId: req.correlationId, err, chemin: req.url, methode: req.method },
        'erreur interne',
      );
      return reply.code(500).send({
        erreur: 'ERREUR_INTERNE',
        message:
          'Une erreur interne est survenue. Si elle persiste, communiquez ce code à l’assistance : ' +
          req.correlationId,
        correlationId: req.correlationId,
      });
    }

    return reply.code(status).send({
      erreur: err.code ?? 'ERREUR',
      message: err.message,
      ...(err.violations ? { violations: err.violations } : {}),
      correlationId: req.correlationId,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      erreur: 'RESSOURCE_INTROUVABLE',
      message: 'La ressource demandée n’existe pas.',
      correlationId: req.correlationId,
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  Services d'authentification                                           */
  /* ---------------------------------------------------------------------- */

  // @fastify/jwt n'applique les options `sign` d'enregistrement QUE si aucun
  // objet d'options n'est transmis à l'appel. Transmettre uniquement
  // `expiresIn` faisait donc signer les jetons en HS256 (défaut de jsonwebtoken)
  // alors que la vérification, elle, utilisait bien HS512 : CHAQUE jeton était
  // refusé à la lecture. On explicite donc toutes les options de signature.
  const signAccessToken = (payload: Record<string, unknown>, ttlSeconds: number): string =>
    app.jwt.sign(payload, {
      algorithm: 'HS512',
      iss: 'mwana-classe',
      expiresIn: ttlSeconds,
    });

  const sessions = new SessionService(config, signAccessToken);

  const authService = new AuthService(config, secrets, audit, guard, signAccessToken);

  const deps: AppDependencies = { app, config, db, secrets, audit, guard, sessions, authService };

  /* ---------------------------------------------------------------------- */
  /*  Routes                                                                */
  /* ---------------------------------------------------------------------- */

  // Sonde de disponibilité : volontairement sans authentification, mais ne
  // révèle ni version applicative, ni détail d'infrastructure : sur échec on
  // n'expose qu'une catégorie et un SQLSTATE, jamais l'hôte ni l'utilisateur.
  app.get('/sante', async (_req, reply) => {
    const health = await db.health();
    return reply.code(health.ok ? 200 : 503).send({
      statut: health.ok ? 'operationnel' : 'degrade',
      base: health.ok ? 'connectee' : 'indisponible',
      latenceMs: health.latencyMs,
      isolationActives: health.rlsForcedTables,
      ...(health.ok
        ? {}
        : {
            diagnostic: diagnosticBase(health.error),
          }),
    });
  });

  await registerAuthRoutes(deps);
  await registerSchoolRoutes(deps);
  await registerParentRoutes(deps);
  await registerSyncRoutes(deps);
  await registerSecurityRoutes(deps);

  return deps;
}

/* ==========================================================================
 *  Arrêt propre
 * ========================================================================== */

export async function shutdown(deps: AppDependencies, reason: string): Promise<void> {
  deps.app.log.info({ raison: reason }, 'arrêt du serveur en cours');
  await deps.app.close();
  await deps.db.close();
}

/* ==========================================================================
 *  Point d'entrée Serverless (Vercel / RequestListener)
 * ========================================================================== */

let serverlessApp: FastifyInstance | null = null;

export async function handler(req: any, res: any): Promise<void> {
  // Identifiant de corrélation : permet de tracer l'erreur dans les logs
  // sans exposer d'information interne au client.
  const correlationId =
    (req.headers?.['x-correlation-id'] as string) ??
    randomUUID();

  try {
    if (!serverlessApp) {
      const deps = await buildApp();
      await deps.app.ready();
      serverlessApp = deps.app;
    }
    serverlessApp.server.emit('request', req, res);
  } catch (err) {
    // On journalise le détail côté serveur uniquement — jamais côté client.
    console.error('[serverless] erreur d\'initialisation :', err);
    try {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('x-correlation-id', correlationId);
      }
      res.end(
        JSON.stringify({
          erreur: 'ERREUR_INTERNE',
          message:
            'Une erreur de connexion est survenue. Veuillez réessayer. ' +
            'Si le problème persiste, communiquez ce code à l\'assistance\u00a0: ' +
            correlationId,
          correlationId,
        }),
      );
    } catch {
      /* la réponse est déjà terminée */
    }
  }
}

export default handler;

