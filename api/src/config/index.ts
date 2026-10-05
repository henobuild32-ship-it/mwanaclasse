/**
 * ============================================================================
 *  MWANA CLASSE — Configuration de l'API
 * ============================================================================
 *  Toute la configuration est validée au démarrage. Une valeur manquante ou
 *  dangereuse en production empêche le serveur de démarrer (fail closed) :
 *  il vaut mieux un service indisponible qu'un service non sécurisé.
 * ============================================================================
 */

import { z } from 'zod';

/* ==========================================================================
 *  Schéma de validation
 * ========================================================================== */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'oui', 'yes', 'on'].includes(v.toLowerCase())));

const EnvSchema = z.object({
  /* --- Application ------------------------------------------------------ */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:4200'),
  /** Origines autorisées pour CORS, séparées par des virgules */
  CORS_ORIGINS: z.string().default('http://localhost:4200'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: booleanish.default(false),

  /* --- Base de données -------------------------------------------------- */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL est obligatoire'),
  DB_POOL_MIN: z.coerce.number().int().min(0).default(2),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  DB_SSL: booleanish.default(false),
  DB_SSL_REJECT_UNAUTHORIZED: booleanish.default(true),
  SUPABASE_PROJECT_URL: z.string().url().optional(),

  /* --- Secrets ---------------------------------------------------------- */
  MWANA_SECRET_PROVIDER: z
    .enum(['env', 'file', 'vault', 'aws_kms', 'azure_keyvault', 'gcp_kms'])
    .default('env'),
  MWANA_SECRETS_DIR: z.string().optional(),
  MWANA_PEPPER_PASSWORD: z.string().optional(),
  MWANA_PEPPER_PASSWORD_OLD: z.string().optional(),
  MWANA_KEY_DATA: z.string().optional(),
  MWANA_KEY_AUDIT: z.string().optional(),
  MWANA_KEY_TOKENS: z.string().optional(),
  MWANA_KEY_TOTP: z.string().optional(),
  MWANA_KEY_DOCUMENTS: z.string().optional(),

  /* --- Sessions et jetons ---------------------------------------------- */
  /** Durée de vie du jeton d'accès (court : limite la portée d'un vol) */
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  /** Durée de vie du jeton de rafraîchissement */
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Durée de vie absolue d'une session, même rafraîchie */
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: booleanish.default(false),
  COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('lax'),

  /* --- Anti-bruteforce -------------------------------------------------- */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().min(10).default(300),
  RATE_LIMIT_LOGIN_PER_MINUTE: z.coerce.number().int().min(3).default(10),
  CODE_LOOKUP_PER_HOUR: z.coerce.number().int().min(5).default(40),

  /* --- Deuxième facteur ------------------------------------------------- */
  /** 2FA obligatoire pour le personnel en production */
  REQUIRE_2FA_STAFF: booleanish.default(false),
  REQUIRE_2FA_DIRECTOR: booleanish.default(true),
  TOTP_ISSUER: z.string().default('MwanaClasse'),
  TOTP_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(6),

  /* --- Divers ----------------------------------------------------------- */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(20),
  APP_DEFAULT_LOCALE: z.string().default('fr-CD'),
  APP_TIMEZONE: z.string().default('Africa/Kinshasa'),
  /** Active le contenu de démonstration */
  SEED_DEMO_DATA: booleanish.default(false),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  isProduction: boolean;
  isDevelopment: boolean;
  corsOrigins: string[];
};

/* ==========================================================================
 *  Chargement
 * ========================================================================== */

let cached: AppConfig | null = null;

export function loadConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  if (cached) return cached;

  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const vercelOrigin = vercelHost ? `https://${vercelHost.replace(/^https?:\/\//, '')}` : undefined;

  const defaultsForPlatform: Record<string, string | undefined> = {};
  if (process.env.VERCEL) {
    defaultsForPlatform.TRUST_PROXY = process.env.TRUST_PROXY ?? 'true';
    defaultsForPlatform.COOKIE_SECURE = process.env.COOKIE_SECURE ?? 'true';
    if (vercelOrigin) {
      if (!process.env.API_PUBLIC_URL) defaultsForPlatform.API_PUBLIC_URL = vercelOrigin;
      if (!process.env.WEB_PUBLIC_URL) defaultsForPlatform.WEB_PUBLIC_URL = vercelOrigin;
      if (!process.env.CORS_ORIGINS) defaultsForPlatform.CORS_ORIGINS = vercelOrigin;
    }
  }

  const raw = { ...defaultsForPlatform, ...process.env, ...overrides };
  const parsed = EnvSchema.safeParse(raw);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(racine)'} : ${i.message}`)
      .join('\n');
    throw new Error(
      `Configuration invalide : le serveur refuse de démarrer.\n${details}\n\n` +
        'Copiez .env.example vers .env puis complétez les valeurs manquantes.',
    );
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  // ---------------------------------------------------------------------
  //  Contrôles de sécurité renforcés en production
  // ---------------------------------------------------------------------
  const problems: string[] = [];

  if (isProduction) {
    if (!env.COOKIE_SECURE) {
      problems.push('COOKIE_SECURE doit être à true en production (cookies uniquement via HTTPS).');
    }
    if (!env.MWANA_PEPPER_PASSWORD) {
      problems.push('MWANA_PEPPER_PASSWORD est obligatoire en production.');
    }
    if (!env.MWANA_KEY_DATA || !env.MWANA_KEY_AUDIT || !env.MWANA_KEY_TOKENS) {
      problems.push(
        'MWANA_KEY_DATA, MWANA_KEY_AUDIT et MWANA_KEY_TOKENS sont obligatoires en production.',
      );
    }
    if (env.CORS_ORIGINS.includes('*')) {
      problems.push('CORS_ORIGINS ne doit pas contenir « * » en production.');
    }
    if (env.API_PUBLIC_URL.startsWith('http://')) {
      problems.push('API_PUBLIC_URL doit utiliser HTTPS en production.');
    }
    if (env.WEB_PUBLIC_URL.startsWith('http://')) {
      problems.push('WEB_PUBLIC_URL doit utiliser HTTPS en production.');
    }
  }

  for (const key of [
    'MWANA_PEPPER_PASSWORD',
    'MWANA_KEY_DATA',
    'MWANA_KEY_AUDIT',
    'MWANA_KEY_TOKENS',
    'MWANA_KEY_TOTP',
  ] as const) {
    const value = env[key];
    if (value && Buffer.byteLength(value, 'utf8') < 32) {
      problems.push(`${key} doit contenir au moins 32 octets (valeur actuelle trop courte).`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Configuration non conforme aux exigences de sécurité :\n${problems.map((p) => `  • ${p}`).join('\n')}`,
    );
  }

  const corsOrigins = env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (process.env.VERCEL && process.env.VERCEL_URL) {
    const previewOrigin = `https://${process.env.VERCEL_URL.replace(/^https?:\/\//, '')}`;
    if (!corsOrigins.includes(previewOrigin)) {
      corsOrigins.push(previewOrigin);
    }
  }

  cached = {
    ...env,
    isProduction,
    isDevelopment: env.NODE_ENV === 'development',
    corsOrigins,
  };

  return cached;
}

/** Réinitialise le cache (utile aux tests). */
export function resetConfig(): void {
  cached = null;
}

/* ==========================================================================
 *  Politiques de sécurité exposées à l'API (pour l'interface d'administration)
 * ========================================================================== */

export function securityPolicySummary(cfg: AppConfig) {
  return {
    hachage: 'Argon2id (64 Mio, 3 passes) → repli bcrypt(12) → PBKDF2-SHA512 600 000',
    pepper: 'Actif — secret serveur, jamais stocké en base',
    chiffrementSymetrique: 'AES-256-GCM, clé dérivée par HKDF-SHA512 par usage',
    chiffrementAsymetrique: 'RSA-4096-OAEP-SHA256 + signature PSS',
    transport: cfg.isProduction ? 'HTTPS/TLS 1.3 exigé' : 'HTTP autorisé en développement local',
    deuxiemeFacteur: {
      fournisseur: `${cfg.TOTP_ISSUER} (TOTP, RFC 6238)`,
      obligatoirePersonnel: cfg.REQUIRE_2FA_STAFF,
      obligatoireDirection: cfg.REQUIRE_2FA_DIRECTOR,
      tentativesMax: cfg.TOTP_MAX_ATTEMPTS,
    },
    antiBruteforce: {
      tentativesAvantVerrouillage: cfg.LOGIN_MAX_ATTEMPTS,
      verrouillageMinutes: cfg.LOGIN_LOCKOUT_MINUTES,
      paliers: ['5 échecs → 1 min', '8 échecs → 5 min', '12 échecs → 30 min', '20 échecs → 24 h'],
    },
    limitationDebit: {
      globalParMinute: cfg.RATE_LIMIT_GLOBAL_PER_MINUTE,
      connexionsParMinute: cfg.RATE_LIMIT_LOGIN_PER_MINUTE,
      rechercheCodeParHeure: cfg.CODE_LOOKUP_PER_HOUR,
    },
    journal: {
      chiffrement: 'AES-256-GCM (charge utile)',
      integrite: 'Chaînage SHA-256 + signature HMAC-SHA256 hors base',
      immuable: 'Interdiction de modification et de suppression au niveau PostgreSQL',
    },
    normes: ['OWASP Top 10 (2021)', 'OWASP ASVS niveau 2', 'RGPD', 'ISO 27001 (principes)'],
  };
}
