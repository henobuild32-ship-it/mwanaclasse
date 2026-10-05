/**
 * ============================================================================
 *  MWANA CLASSE — Gestionnaire de secrets
 * ============================================================================
 *  Toutes les clés de chiffrement, le pepper des mots de passe et les clés de
 *  signature proviennent d'ici. Le code métier ne manipule jamais de secret
 *  directement et aucune clé n'est écrite en dur.
 *
 *  Fournisseurs supportés :
 *    - env            : variables d'environnement (développement, petits déploiements)
 *    - file           : fichiers de secrets montés (Docker secrets, Kubernetes)
 *    - vault          : HashiCorp Vault (KV v2)
 *    - aws_kms        : AWS Secrets Manager / KMS
 *    - azure_keyvault : Azure Key Vault
 *    - gcp_kms        : Google Secret Manager
 *
 *  Règles appliquées :
 *    - une clé absente ou trop courte fait ÉCHOUER le démarrage (fail closed) ;
 *    - les secrets ne sont jamais journalisés ni renvoyés par l'API ;
 *    - rotation : plusieurs versions de pepper coexistent, la plus récente
 *      signe, les anciennes continuent de vérifier.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  deriveKey,
  sha256Hex,
  hmacHex,
  encryptSymmetric,
  decryptSymmetric,
  type SelfTestResult,
} from './crypto.js';

/** Secret aléatoire à haute entropie, encodé en base64url. */
function newSecret(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

export type SecretProvider = 'env' | 'file' | 'vault' | 'aws_kms' | 'azure_keyvault' | 'gcp_kms';

export interface SecretDefinition {
  /** Identifiant logique, ex. 'pepper.password' */
  id: string;
  /** Variable d'environnement principale */
  envVar: string;
  /** Variables d'environnement acceptées en secours (rotation) */
  fallbackEnvVars?: string[];
  /** Nom du fichier de secret (mode `file`) */
  fileName?: string;
  /** Usage : détermine la clé dérivée */
  purpose: 'donnees' | 'jetons' | 'audit' | 'pepper' | 'totp' | 'documents' | 'transport';
  /** Longueur minimale exigée en octets */
  minBytes: number;
  /** Valeur générée automatiquement en développement si absente */
  devFallback?: 'random' | 'none';
  description: string;
  /** Rotation recommandée, en jours */
  rotateAfterDays: number;
}

/* ==========================================================================
 *  Catalogue des secrets attendus
 * ========================================================================== */

export const SECRET_CATALOG: SecretDefinition[] = [
  {
    id: 'pepper.password',
    envVar: 'MWANA_PEPPER_PASSWORD',
    fallbackEnvVars: ['MWANA_PEPPER_PASSWORD_OLD'],
    fileName: 'pepper_password',
    purpose: 'pepper',
    minBytes: 32,
    devFallback: 'random',
    description:
      'Pepper serveur ajouté aux mots de passe avant hachage. Jamais stocké en base : ' +
      'une fuite du seul dump SQL ne permet alors aucune attaque hors ligne.',
    rotateAfterDays: 365,
  },
  {
    id: 'key.data',
    envVar: 'MWANA_KEY_DATA',
    fileName: 'key_data',
    purpose: 'donnees',
    minBytes: 32,
    devFallback: 'random',
    description: 'Clé maîtresse AES-256-GCM des données personnelles sensibles (santé, adresse, téléphone)',
    rotateAfterDays: 180,
  },
  {
    id: 'key.audit',
    envVar: 'MWANA_KEY_AUDIT',
    fileName: 'key_audit',
    purpose: 'audit',
    minBytes: 32,
    devFallback: 'random',
    description: 'Clé HMAC de signature du journal d’audit (détection de falsification)',
    rotateAfterDays: 180,
  },
  {
    id: 'key.tokens',
    envVar: 'MWANA_KEY_TOKENS',
    fileName: 'key_tokens',
    purpose: 'jetons',
    minBytes: 32,
    devFallback: 'random',
    description: 'Clé de signature des jetons de session (JWT)',
    rotateAfterDays: 90,
  },
  {
    id: 'key.totp',
    envVar: 'MWANA_KEY_TOTP',
    fileName: 'key_totp',
    purpose: 'totp',
    minBytes: 32,
    devFallback: 'random',
    description: 'Clé de chiffrement des secrets TOTP (double authentification)',
    rotateAfterDays: 365,
  },
  {
    id: 'key.documents',
    envVar: 'MWANA_KEY_DOCUMENTS',
    fileName: 'key_documents',
    purpose: 'documents',
    minBytes: 32,
    devFallback: 'random',
    description: 'Clé de chiffrement des pièces jointes et modèles importés',
    rotateAfterDays: 180,
  },
];

/* ==========================================================================
 *  Résolution des secrets
 * ========================================================================== */

export interface ResolvedSecret {
  id: string;
  purpose: SecretDefinition['purpose'];
  /** Version courante (index 0 = la plus récente) */
  current: { id: string; value: string };
  /** Versions antérieures conservées pour la vérification pendant la rotation */
  previous: { id: string; value: string }[];
  fingerprint: string;
  provider: SecretProvider;
  generatedInDev: boolean;
}

export class SecretsManager {
  private readonly cache = new Map<string, ResolvedSecret>();
  private readonly provider: SecretProvider;
  private readonly secretsDir?: string;
  private readonly isProduction: boolean;
  private readonly generatedIds: string[] = [];

  constructor(opts: {
    provider?: SecretProvider;
    secretsDir?: string;
    isProduction?: boolean;
  } = {}) {
    this.provider = opts.provider ?? (process.env.MWANA_SECRET_PROVIDER as SecretProvider) ?? 'env';
    this.secretsDir = opts.secretsDir ?? process.env.MWANA_SECRETS_DIR;
    this.isProduction = opts.isProduction ?? process.env.NODE_ENV === 'production';
  }

  /** Charge et valide tous les secrets. Échoue si un secret requis manque. */
  loadAll(): { loaded: string[] } {
    const loaded: string[] = [];
    for (const def of SECRET_CATALOG) {
      this.get(def.id);
      loaded.push(def.id);
    }
    return { loaded };
  }

  get(id: string): ResolvedSecret {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const def = SECRET_CATALOG.find((d) => d.id === id);
    if (!def) throw new Error(`Secret inconnu demandé : ${id}`);

    const resolved = this.resolve(def);
    this.cache.set(id, resolved);
    return resolved;
  }

  /** Clé binaire dérivée pour un usage précis, jamais réutilisée telle quelle. */
  deriveKeyFor(id: string, usage: string): Buffer {
    const secret = this.get(id);
    // HKDF : la clé maîtresse n'est jamais utilisée directement.
    return deriveKey(secret.current.value, `${secret.purpose}:${usage}`);
  }

  /** Pepper courant + historique, dans l'ordre de préférence. */
  passwordPeppers(): { id: string; value: string }[] {
    const s = this.get('pepper.password');
    return [s.current, ...s.previous];
  }

  /** Empreintes pour l'écran d'administration (jamais les secrets eux-mêmes). */
  inventory(): {
    id: string;
    purpose: string;
    provider: SecretProvider;
    fingerprint: string;
    versions: number;
    generatedInDev: boolean;
    rotateAfterDays: number;
    description: string;
  }[] {
    return SECRET_CATALOG.map((def) => {
      const s = this.get(def.id);
      return {
        id: def.id,
        purpose: def.purpose,
        provider: s.provider,
        fingerprint: s.fingerprint,
        versions: 1 + s.previous.length,
        generatedInDev: s.generatedInDev,
        rotateAfterDays: def.rotateAfterDays,
        description: def.description,
      };
    });
  }

  /** Identifiants des secrets générés automatiquement (à persister en dev). */
  devGenerated(): string[] {
    return [...this.generatedIds];
  }

  /** Crée un jeu de secrets pour un nouveau déploiement (mode développement). */
  static generateEnvFile(): string {
    const lines = [
      '# MWANA CLASSE — secrets générés',
      '# Conservez ce fichier hors du dépôt Git et sauvegardez-le :',
      '# sa perte rend les mots de passe et les données chiffrées irrécupérables.',
      '',
      'NODE_ENV=production',
      'MWANA_SECRET_PROVIDER=env',
      '',
    ];
    for (const def of SECRET_CATALOG) {
      lines.push(`# ${def.description}`);
      lines.push(`# renouveler tous les ${def.rotateAfterDays} jours`);
      lines.push(`${def.envVar}=${newSecret(48)}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /* ---------------------------------------------------------------------- */

  private resolve(def: SecretDefinition): ResolvedSecret {
    const versions: { id: string; value: string }[] = [];
    let generatedInDev = false;

    const current = this.read(def.envVar, def);
    if (current) {
      versions.push({ id: 'v1', value: current });
    }

    // Versions antérieures (rotation)
    let idx = 2;
    for (const fb of def.fallbackEnvVars ?? []) {
      const old = this.read(fb, def, /*lenient*/ true);
      if (old) versions.push({ id: `v${idx}`, value: old });
      idx += 1;
    }

    if (versions.length === 0) {
      if (this.isProduction || def.devFallback === 'none') {
        throw new Error(
          `Secret obligatoire manquant en production : ${def.id} (variable ${def.envVar}). ` +
            'Générez-le avec « npm run secrets:generate ».',
        );
      }
      // Développement : on génère et on prévient bruyamment.
      const value = newSecret(48);
      versions.push({ id: 'dev', value });
      generatedInDev = true;
      this.generatedIds.push(def.id);
      // eslint-disable-next-line no-console
      console.warn(
        `[secrets] ${def.id} absent : valeur aléatoire générée pour ce démarrage. ` +
          'Les données chiffrées et les mots de passe ne survivront PAS au redémarrage. ' +
          'Définissez ' + def.envVar + ' avant toute mise en production.',
      );
    }

    const currentVersion = versions[0]!;
    return {
      id: def.id,
      purpose: def.purpose,
      current: currentVersion,
      previous: versions.slice(1),
      fingerprint: sha256Hex(currentVersion.value).slice(0, 16),
      provider: this.provider,
      generatedInDev,
    };
  }

  private read(envVar: string, def: SecretDefinition, lenient = false): string | null {
    // 1) fichier monté (recommandé en conteneur)
    if ((this.provider === 'file' || this.secretsDir) && def.fileName) {
      const base = this.secretsDir ?? '/run/secrets';
      try {
        const value = readFileSync(`${base}/${def.fileName}`, 'utf8').trim();
        if (value) return this.validate(value, def, lenient);
      } catch {
        /* on tente la variable d'environnement */
      }
    }

    // 2) gestionnaire de secrets distant
    //    Vault / KMS sont lus au démarrage dans les variables par un init
    //    (entrypoint ou injecteur), puis exposés ici : évite un appel réseau
    //    à chaque requête HTTP.
    if (this.provider !== 'env' && this.provider !== 'file') {
      const injected = process.env[`MWANA_SECRET_${def.id.replace(/\./g, '_').toUpperCase()}`];
      if (injected) return this.validate(injected, def, lenient);
    }

    // 3) variable d'environnement
    const value = process.env[envVar];
    if (value && value.trim().length > 0) return this.validate(value.trim(), def, lenient);

    return null;
  }

  private validate(value: string, def: SecretDefinition, lenient: boolean): string {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes < def.minBytes) {
      const msg =
        `${def.id} trop court : ${bytes} octets (minimum ${def.minBytes}). ` +
        'Utilisez « npm run secrets:generate ».';
      if (lenient) {
        // eslint-disable-next-line no-console
        console.warn(`[secrets] ${msg} — version ignorée.`);
        return '';
      }
      throw new Error(msg);
    }
    return value;
  }
}

/* ==========================================================================
 *  Vérification d'intégrité des secrets au démarrage
 * ========================================================================== */

export function secretSelfTest(manager: SecretsManager): SelfTestResult {
  const checks: SelfTestResult['checks'] = [];

  const pepper = manager.get('pepper.password');
  checks.push({
    name: 'Pepper serveur présent et suffisamment long',
    ok: Buffer.byteLength(pepper.current.value, 'utf8') >= 32,
    detail: `empreinte ${pepper.fingerprint}`,
  });

  checks.push({
    name: 'Les clés dérivées diffèrent selon leur usage',
    ok: !manager
      .deriveKeyFor('key.data', 'students.medical')
      .equals(manager.deriveKeyFor('key.data', 'students.address')),
  });

  checks.push({
    name: 'Secrets générés automatiquement en développement uniquement',
    ok: !manager.devGenerated().length || process.env.NODE_ENV !== 'production',
    detail: manager.devGenerated().length
      ? `générés : ${manager.devGenerated().join(', ')}`
      : 'aucun',
  });

  return { ok: checks.every((c) => c.ok), checks };
}

/** Signature HMAC d'une charge d'audit avec la clé dédiée. */
export function signAuditPayload(canonical: string, manager: SecretsManager): string {
  const key = manager.deriveKeyFor('key.audit', 'audit.signature');
  return hmacHex(canonical, key);
}

/** Chiffre une donnée sensible prête à être stockée en base. */
export function encryptField(
  plaintext: string | null | undefined,
  manager: SecretsManager,
  context: string,
): Buffer | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const key = manager.deriveKeyFor('key.data', 'champ');
  // Le contexte (ex. « student:ID:medical ») est lié au chiffré : impossible de
  // copier la valeur chiffrée d'un élève vers un autre enregistrement.
  return encryptSymmetric(plaintext, key, context);
}

/** Déchiffre une donnée sensible. Renvoie null si absente ou illisible. */
export function decryptField(
  payload: Buffer | null | undefined,
  manager: SecretsManager,
  context: string,
): string | null {
  if (!payload || payload.length === 0) return null;
  const key = manager.deriveKeyFor('key.data', 'champ');
  try {
    return decryptSymmetric(payload, key, context);
  } catch {
    return null;
  }
}
