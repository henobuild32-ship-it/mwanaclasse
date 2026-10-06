/**
 * ============================================================================
 *  MWANA CLASSE — Noyau cryptographique
 * ============================================================================
 *  Ce module concentre toutes les primitives de sécurité du serveur :
 *
 *   1. Hachage de mots de passe : Argon2id → bcrypt → PBKDF2-SHA512
 *      (sélection automatique de la meilleure primitive disponible)
 *   2. Salt unique par utilisateur (généré par la primitive)
 *   3. Pepper côté serveur : secret jamais stocké en base, ajouté au mot de
 *      passe avant hachage. Une fuite de la base seule est alors inexploitable.
 *   4. Vérification à temps constant (timingSafeEqual) — jamais de ===
 *   5. Chiffrement symétrique AES-256-GCM (données au repos)
 *   6. Chiffrement asymétrique RSA-4096-OAEP-SHA256 + signature PSS
 *   7. Dérivation de clés HKDF-SHA512
 *   8. Comparaison et génération de secrets à temps constant
 *
 *  Aucune clé n'est écrite en dur : tout provient du gestionnaire de secrets
 *  (Vault, AWS KMS, Azure Key Vault…) via la couche de configuration.
 * ============================================================================
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  createHash,
  pbkdf2 as pbkdf2Cb,
  publicEncrypt,
  privateDecrypt,
  constants as cryptoConstants,
  type KeyObject,
} from 'node:crypto';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

// Sortie CommonJS : createRequire(__filename) permet de charger paresseusement
// les modules natifs (argon2, bcrypt) sans que leur absence ne casse le
// démarrage.
const requireNative = createRequire(__filename);

const pbkdf2 = promisify(pbkdf2Cb) as (
  password: string | Buffer,
  salt: string | Buffer,
  iterations: number,
  keylen: number,
  digest: string,
) => Promise<Buffer>;

/* ==========================================================================
 *  Paramètres (conformes aux recommandations OWASP 2024)
 * ========================================================================== */

export const PASSWORD_POLICY = {
  /** Longueur minimale exigée */
  minLength: 12,
  /** Longueur maximale acceptée (évite les attaques par déni de service) */
  maxLength: 256,
  /** Argon2id — 64 Mio, 3 passes, 4 voies (OWASP « second choice » renforcé) */
  argon2: { memoryCost: 65536, timeCost: 3, parallelism: 4, hashLength: 32 },
  /** PBKDF2-HMAC-SHA512 — recommandation OWASP : 210 000 itérations minimum */
  pbkdf2: { iterations: 600_000, keylen: 64, digest: 'sha512' },
  /** bcrypt — coût 12 (≈ 250 ms sur matériel moderne) */
  bcrypt: { rounds: 12 },
  /** Longueur minimale du pepper serveur, en octets */
  minPepperBytes: 32,
} as const;

export const CIPHER = {
  algorithm: 'aes-256-gcm',
  keyBytes: 32,
  ivBytes: 12,
  tagBytes: 16,
  /** Préfixe de version : permet la rotation d'algorithme sans migration lourde */
  version: 'v1',
} as const;

export const RSA = {
  modulusLength: 4096,
  publicExponent: 0x10001,
  oaepHash: 'sha256',
  signatureHash: 'sha256',
  /** Taille maximale d'un message chiffré avec RSA-4096-OAEP-SHA256 */
  maxPlaintextBytes: 4096 / 8 - 2 * 32 - 2, // = 446 octets
} as const;

/* ==========================================================================
 *  Erreurs typées — l'API ne doit jamais divulguer de détail interne
 * ========================================================================== */

export class CryptoError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

export class PasswordPolicyError extends CryptoError {
  constructor(readonly violations: string[]) {
    super(`Mot de passe refusé : ${violations.join(' ; ')}`, 'WEAK_PASSWORD');
    this.name = 'PasswordPolicyError';
  }
}

/* ==========================================================================
 *  1. Sélection de la primitive de hachage disponible
 * ========================================================================== */

type Algo = 'argon2id' | 'bcrypt' | 'pbkdf2-sha512';

interface Hasher {
  readonly algo: Algo;
  readonly available: boolean;
  hash(secret: string, pepper: string): Promise<string>;
  verify(secret: string, pepper: string, encoded: string): Promise<boolean>;
  needsRehash(encoded: string): boolean;
}

/**
 * Argon2id via le module natif `argon2` s'il est installé.
 * Le chargement est paresseux : l'API démarre même si le binaire natif manque.
 */
class Argon2Hasher implements Hasher {
  readonly algo = 'argon2id' as const;
  private mod: any = null;
  private loadFailed = false;

  get available(): boolean {
    this.tryLoad();
    return this.mod !== null;
  }

  private tryLoad(): void {
    if (this.mod !== null || this.loadFailed) return;
    try {
      // Import paresseux : évite un crash au démarrage si absent
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.mod = requireNative('argon2');
    } catch {
      this.loadFailed = true;
      this.mod = null;
    }
  }

  async hash(secret: string, pepper: string): Promise<string> {
    this.tryLoad();
    if (!this.mod) throw new CryptoError('Argon2 indisponible', 'NO_ARGON2');
    // Le pepper est concaténé au secret AVANT hachage : il agit comme un
    // secret serveur supplémentaire que l'attaquant ne possède pas.
    const peppered = `${secret}${pepper}`;
    return this.mod.hash(peppered, {
      type: this.mod.argon2id,
      memoryCost: PASSWORD_POLICY.argon2.memoryCost,
      timeCost: PASSWORD_POLICY.argon2.timeCost,
      parallelism: PASSWORD_POLICY.argon2.parallelism,
      hashLength: PASSWORD_POLICY.argon2.hashLength,
    });
  }

  async verify(secret: string, pepper: string, encoded: string): Promise<boolean> {
    this.tryLoad();
    if (!this.mod) throw new CryptoError('Argon2 indisponible', 'NO_ARGON2');
    try {
      return await this.mod.verify(encoded, `${secret}${pepper}`);
    } catch {
      return false;
    }
  }

  needsRehash(encoded: string): boolean {
    this.tryLoad();
    if (!this.mod) return true;
    try {
      return this.mod.needsRehash(encoded, {
        memoryCost: PASSWORD_POLICY.argon2.memoryCost,
        timeCost: PASSWORD_POLICY.argon2.timeCost,
        parallelism: PASSWORD_POLICY.argon2.parallelism,
      });
    } catch {
      return true;
    }
  }
}

/** bcrypt via le module natif `bcrypt` s'il est installé. */
class BcryptHasher implements Hasher {
  readonly algo = 'bcrypt' as const;
  private mod: any = null;
  private loadFailed = false;

  get available(): boolean {
    this.tryLoad();
    return this.mod !== null;
  }

  private tryLoad(): void {
    if (this.mod !== null || this.loadFailed) return;
    try {
      this.mod = requireNative('bcrypt');
    } catch {
      this.loadFailed = true;
      this.mod = null;
    }
  }

  async hash(secret: string, pepper: string): Promise<string> {
    this.tryLoad();
    if (!this.mod) throw new CryptoError('bcrypt indisponible', 'NO_BCRYPT');
    // bcrypt tronque silencieusement à 72 octets : on hache d'abord le secret
    // avec SHA-512 (encodé base64) pour ne perdre aucune entropie.
    const pre = createHash('sha512').update(`${secret}${pepper}`, 'utf8').digest('base64');
    const salt = await this.mod.genSalt(PASSWORD_POLICY.bcrypt.rounds);
    return this.mod.hash(pre, salt);
  }

  async verify(secret: string, pepper: string, encoded: string): Promise<boolean> {
    this.tryLoad();
    if (!this.mod) throw new CryptoError('bcrypt indisponible', 'NO_BCRYPT');
    const pre = createHash('sha512').update(`${secret}${pepper}`, 'utf8').digest('base64');
    try {
      return await this.mod.compare(pre, encoded);
    } catch {
      return false;
    }
  }

  needsRehash(encoded: string): boolean {
    try {
      const rounds = parseInt(encoded.split('$')[2] ?? '0', 10);
      return !Number.isFinite(rounds) || rounds < PASSWORD_POLICY.bcrypt.rounds;
    } catch {
      return true;
    }
  }
}

/**
 * PBKDF2-HMAC-SHA512 — repli 100 % Node.js, sans dépendance native.
 * Format : pbkdf2-sha512$iterations$salt$hash (tout en base64 sauf l'algo).
 */
class Pbkdf2Hasher implements Hasher {
  readonly algo = 'pbkdf2-sha512' as const;
  readonly available = true;

  async hash(secret: string, pepper: string): Promise<string> {
    const salt = randomBytes(32);
    const { iterations, keylen, digest } = PASSWORD_POLICY.pbkdf2;
    // Le pepper est injecté dans le mot de passe avant dérivation.
    const dk = await pbkdf2(`${secret}${pepper}`, salt, iterations, keylen, digest);
    return [
      'pbkdf2-sha512',
      String(iterations),
      salt.toString('base64'),
      dk.toString('base64'),
    ].join('$');
  }

  async verify(secret: string, pepper: string, encoded: string): Promise<boolean> {
    const parts = encoded.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha512') return false;

    const iterations = Number.parseInt(parts[1]!, 10);
    if (!Number.isFinite(iterations) || iterations < 1000) return false;

    const salt = Buffer.from(parts[2]!, 'base64');
    const expected = Buffer.from(parts[3]!, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;

    const dk = await pbkdf2(`${secret}${pepper}`, salt, iterations, expected.length, 'sha512');
    return timingSafeEqual(dk, expected);
  }

  needsRehash(encoded: string): boolean {
    const parts = encoded.split('$');
    if (parts[0] !== 'pbkdf2-sha512') return true;
    const iterations = Number.parseInt(parts[1] ?? '0', 10);
    return !Number.isFinite(iterations) || iterations < PASSWORD_POLICY.pbkdf2.iterations;
  }
}

const argon2Hasher = new Argon2Hasher();
const bcryptHasher = new BcryptHasher();
const pbkdf2Hasher = new Pbkdf2Hasher();

const HASHERS: Hasher[] = [argon2Hasher, bcryptHasher, pbkdf2Hasher];

/** Primitive de hachage effectivement utilisée (la meilleure disponible). */
export function activeHasher(): Hasher {
  for (const h of HASHERS) if (h.available) return h;
  return pbkdf2Hasher;
}

export function hashingReport(): { active: Algo; available: Algo[] } {
  const available = HASHERS.filter((h) => h.available).map((h) => h.algo);
  return { active: activeHasher().algo, available };
}

/* ==========================================================================
 *  2. Politique de robustesse des mots de passe
 * ========================================================================== */

/** Mots de passe les plus exposés — refusés d'office. */
const COMMON_PASSWORDS = new Set(
  [
    'password', 'motdepasse', 'mot de passe', '123456', '12345678', '123456789',
    'qwerty', 'azerty', 'azertyuiop', 'qwertyuiop', 'admin', 'administrateur',
    'mwana', 'mwanaclasse', 'ecole', 'school', 'parent', 'eleve', 'bonjour',
    'iloveyou', 'welcome', 'bienvenue', 'soleil', 'dragon', 'monkey', 'football',
    'letmein', 'trustno1', 'abc123', 'passw0rd', 'p@ssw0rd', 'changeme',
    'kinshasa', 'congo', 'rdc', 'lubumbashi', 'matadi', 'bukavu',
  ].map((p) => p.toLowerCase()),
);

const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  'qwertyuiop',
  'azertyuiop',
  'qsdfghjklm',
];

export interface PasswordCheck {
  ok: boolean;
  score: number; // 0..4 (0 très faible → 4 excellent)
  violations: string[];
  suggestions: string[];
}

/**
 * Évalue un mot de passe : longueur, variété, motifs interdits, répétitions,
 * suites de clavier, données personnelles évidentes.
 */
export function checkPasswordStrength(
  password: string,
  context: { email?: string; fullName?: string; schoolName?: string } = {},
): PasswordCheck {
  const violations: string[] = [];
  const suggestions: string[] = [];

  if (typeof password !== 'string' || password.length < PASSWORD_POLICY.minLength) {
    violations.push(`au moins ${PASSWORD_POLICY.minLength} caractères requis`);
  }
  if (typeof password === 'string' && password.length > PASSWORD_POLICY.maxLength) {
    violations.push(`au plus ${PASSWORD_POLICY.maxLength} caractères`);
  }

  const pw = (password ?? '').normalize('NFKC');
  const lower = pw.toLowerCase();

  if (COMMON_PASSWORDS.has(lower)) {
    violations.push('mot de passe trop courant');
  }

  // Variété des caractères
  const classes = [
    /[a-z]/.test(pw),
    /[A-Z]/.test(pw),
    /[0-9]/.test(pw),
    /[^A-Za-z0-9]/.test(pw),
  ].filter(Boolean).length;

  if (classes < 3) {
    suggestions.push('mélangez minuscules, majuscules, chiffres et symboles');
  }

  // Répétitions : « aaaa », « 1111 »
  if (/(.)\1{3,}/.test(pw)) {
    violations.push('caractère répété quatre fois ou plus');
  }

  // Suites de clavier ou alphabétiques
  for (const seq of SEQUENCES) {
    for (let i = 0; i + 4 <= seq.length; i++) {
      const chunk = seq.slice(i, i + 4);
      if (lower.includes(chunk) || lower.includes([...chunk].reverse().join(''))) {
        violations.push('suite de caractères prévisible (clavier ou alphabet)');
        break;
      }
    }
  }

  // Informations personnelles triviales
  const personalTokens: string[] = [];
  if (context.email) personalTokens.push(context.email.split('@')[0] ?? '');
  if (context.fullName) personalTokens.push(...context.fullName.split(/\s+/));
  if (context.schoolName) personalTokens.push(...context.schoolName.split(/\s+/));
  for (const token of personalTokens) {
    const t = token.trim().toLowerCase();
    if (t.length >= 4 && lower.includes(t)) {
      violations.push('contient une information personnelle évidente');
      break;
    }
  }

  // Estimation d'entropie
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const entropy = pw.length > 0 && pool > 0 ? pw.length * Math.log2(pool) : 0;

  let score: number;
  if (entropy < 40) score = 0;
  else if (entropy < 60) score = 1;
  else if (entropy < 80) score = 2;
  else if (entropy < 100) score = 3;
  else score = 4;

  if (violations.length > 0) score = Math.min(score, 1);
  if (score <= 1) {
    suggestions.push('préférez une phrase de passe de 4 mots sans lien entre eux');
  }

  return { ok: violations.length === 0, score, violations, suggestions };
}

/* ==========================================================================
 *  3. Hachage et vérification des mots de passe
 * ========================================================================== */

export interface HashResult {
  hash: string;
  algo: Algo;
  pepperId: string;
}

/** Hache un mot de passe avec le pepper serveur. */
export async function hashPassword(
  password: string,
  pepper: string,
  pepperId = 'v1',
  context: { email?: string; fullName?: string; schoolName?: string } = {},
): Promise<HashResult> {
  assertPepper(pepper);

  const check = checkPasswordStrength(password, context);
  if (!check.ok) throw new PasswordPolicyError(check.violations);

  const hasher = activeHasher();
  const hash = await hasher.hash(password, pepper);
  return { hash, algo: hasher.algo, pepperId };
}

/**
 * Vérifie un mot de passe.
 * - comparaison à temps constant (timingSafeEqual / primitives dédiées)
 * - supporte plusieurs peppers (rotation) : on essaie le pepper actif puis les
 *   anciens, ce qui permet de changer le pepper sans casser les comptes.
 */
export async function verifyPassword(
  password: string,
  encoded: string,
  peppers: { id: string; value: string }[],
  algo?: Algo,
): Promise<{ ok: boolean; matchedPepperId?: string; needsRehash: boolean }> {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    return { ok: false, needsRehash: false };
  }

  const hasher = resolveHasher(encoded, algo);

  for (const pepper of peppers) {
    if (!pepper?.value) continue;
    let ok = false;
    try {
      ok = await hasher.verify(password, pepper.value, encoded);
    } catch {
      ok = false;
    }
    if (ok) {
      // Un mot de passe encore valide mais haché avec un pepper obsolète doit
      // être re-haché avec le pepper courant.
      const pepperIsCurrent = pepper.id === peppers[0]?.id;
      return {
        ok: true,
        matchedPepperId: pepper.id,
        needsRehash: !pepperIsCurrent || hasher.needsRehash(encoded),
      };
    }
  }

  // Réalise un travail factice pour que le temps de réponse ne révèle pas
  // l'existence du compte (protection contre l'énumération par chronométrage).
  await hasher.hash(randomBytes(16).toString('hex'), peppers[0]?.value ?? 'x').catch(() => '');

  return { ok: false, needsRehash: false };
}

function resolveHasher(encoded: string, algo?: Algo): Hasher {
  if (algo) {
    const found = HASHERS.find((h) => h.algo === algo && h.available);
    if (found) return found;
  }
  if (encoded.startsWith('$argon2')) return argon2Hasher.available ? argon2Hasher : pbkdf2Hasher;
  if (encoded.startsWith('$2a$') || encoded.startsWith('$2b$') || encoded.startsWith('$2y$')) {
    return bcryptHasher.available ? bcryptHasher : pbkdf2Hasher;
  }
  if (encoded.startsWith('pbkdf2-sha512$')) return pbkdf2Hasher;
  return activeHasher();
}

function assertPepper(pepper: string): void {
  if (typeof pepper !== 'string' || Buffer.byteLength(pepper, 'utf8') < PASSWORD_POLICY.minPepperBytes) {
    throw new CryptoError(
      `Pepper serveur absent ou trop court (minimum ${PASSWORD_POLICY.minPepperBytes} octets)`,
      'PEPPER_TOO_SHORT',
    );
  }
}

/**
 * Re-hachage transparent lors d'une connexion réussie, si l'algorithme ou le
 * pepper ont évolué. À appeler après une vérification réussie.
 */
export async function rehashIfNeeded(
  password: string,
  current: string,
  pepper: string,
  pepperId = 'v1',
): Promise<HashResult | null> {
  const hasher = resolveHasher(current);
  if (!hasher.needsRehash(current)) return null;
  return hashPassword(password, pepper, pepperId);
}

/* ==========================================================================
 *  4. Chiffrement symétrique AES-256-GCM
 * ========================================================================== */

/**
 * Format du chiffré (binaire, compact) :
 *   [1 octet version][12 octets IV][16 octets tag GCM][N octets ciphertext]
 *
 * La clé dérivée n'est jamais stockée dans le chiffré : elle vient du
 * gestionnaire de secrets.
 */
export function encryptSymmetric(
  plaintext: string | Buffer,
  key: Buffer,
  aad?: string,
): Buffer {
  assertAesKey(key);

  const iv = randomBytes(CIPHER.ivBytes); // IV unique : jamais réutilisé
  const cipher = createCipheriv(CIPHER.algorithm, key, iv, { authTagLength: CIPHER.tagBytes });

  // Données associées : lie le chiffré à son contexte (ex. l'identifiant de
  // l'école). Un chiffré déplacé vers un autre enregistrement échoue à
  // l'authentification.
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));

  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([Buffer.from([1]), iv, tag, ciphertext]);
}

export function decryptSymmetric(
  payload: Buffer,
  key: Buffer,
  aad?: string,
): string {
  assertAesKey(key);

  if (!Buffer.isBuffer(payload) || payload.length < 1 + CIPHER.ivBytes + CIPHER.tagBytes) {
    throw new CryptoError('Données chiffrées trop courtes ou corrompues', 'BAD_CIPHERTEXT');
  }

  const version = payload[0];
  if (version !== 1) {
    throw new CryptoError(`Version de chiffrement inconnue : ${version}`, 'BAD_VERSION');
  }

  const iv = payload.subarray(1, 1 + CIPHER.ivBytes);
  const tag = payload.subarray(1 + CIPHER.ivBytes, 1 + CIPHER.ivBytes + CIPHER.tagBytes);
  const ciphertext = payload.subarray(1 + CIPHER.ivBytes + CIPHER.tagBytes);

  const decipher = createDecipheriv(CIPHER.algorithm, key, iv, { authTagLength: CIPHER.tagBytes });
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));

  try {
    // GCM authentifie : toute altération, même d'un seul bit, lève une erreur.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new CryptoError(
      'Échec de l’authentification : données chiffrées altérées ou clé incorrecte',
      'AUTH_FAILED',
    );
  }
}

export function decryptSymmetricToBuffer(payload: Buffer, key: Buffer, aad?: string): Buffer {
  return Buffer.from(decryptSymmetric(payload, key, aad), 'binary');
}

function assertAesKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== CIPHER.keyBytes) {
    throw new CryptoError(`Clé AES-256 attendue (${CIPHER.keyBytes} octets)`, 'BAD_KEY');
  }
}

/* ==========================================================================
 *  5. Chiffrement asymétrique RSA-4096-OAEP + signature PSS
 * ========================================================================== */

export interface RsaKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  fingerprint: string;
  createdAt: string;
}

/**
 * Génère une paire RSA-4096.
 * Opération coûteuse (plusieurs secondes) : à exécuter hors requête HTTP.
 */
export function generateRsaKeyPair(passphrase?: string): RsaKeyPair {
  // Note : sans passphrase la clé privée est en clair dans le PEM. En
  // production, la clé privée est chiffrée par le gestionnaire de secrets.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: RSA.modulusLength,
    publicExponent: RSA.publicExponent,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: passphrase
      ? { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }
      : { type: 'pkcs8', format: 'pem' },
  });

  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    fingerprint: publicKeyFingerprint(publicKey),
    createdAt: new Date().toISOString(),
  };
}

/** Empreinte SHA-256 d'une clé publique (identification sans révéler la clé). */
export function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 32);
}

/**
 * Chiffre un petit secret (clé de session, jeton) avec la clé publique RSA.
 * Limité à 446 octets : au-delà, on utilise le chiffrement hybride décrit
 * dans `hybridEncrypt`.
 */
export function rsaEncrypt(plaintext: string | Buffer, publicKeyPem: string): Buffer {
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  if (data.length > RSA.maxPlaintextBytes) {
    throw new CryptoError(
      `Message trop long pour RSA-OAEP (${data.length} > ${RSA.maxPlaintextBytes} octets)`,
      'TOO_LONG',
    );
  }
  return publicEncrypt(
    {
      key: publicKeyPem,
      padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: RSA.oaepHash,
    },
    data,
  );
}

export function rsaDecrypt(payload: Buffer, privateKeyPem: string, passphrase?: string): Buffer {
  const key: KeyObject = passphrase
    ? createPrivateKey({ key: privateKeyPem, passphrase })
    : createPrivateKey(privateKeyPem);
  return privateDecrypt(
    { key, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: RSA.oaepHash },
    payload,
  );
}

/** Signe un message avec la clé privée RSA (schéma PSS, plus robuste que PKCS#1 v1.5). */
export function rsaSign(message: string | Buffer, privateKeyPem: string, passphrase?: string): Buffer {
  const key = passphrase
    ? createPrivateKey({ key: privateKeyPem, passphrase })
    : createPrivateKey(privateKeyPem);
  return cryptoSign(RSA.signatureHash, Buffer.from(message as any), {
    key,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
  });
}

export function rsaVerify(
  message: string | Buffer,
  signature: Buffer,
  publicKeyPem: string,
): boolean {
  try {
    return cryptoVerify(
      RSA.signatureHash,
      Buffer.from(message as any),
      {
        key: createPublicKey(publicKeyPem),
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
      },
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * Chiffrement hybride : AES-256-GCM pour la charge utile, RSA-OAEP pour
 * protéger la clé de session. Sert aux échanges sécurisés de documents.
 */
export interface HybridEnvelope {
  v: 1;
  keyId: string;
  wrappedKey: string; // base64 (RSA-OAEP)
  iv: string; // base64
  tag: string; // base64
  data: string; // base64 (AES-256-GCM)
  aad?: string;
}

export function hybridEncrypt(
  plaintext: Buffer | string,
  publicKeyPem: string,
  keyId = 'transport-v1',
  aad?: string,
): HybridEnvelope {
  const sessionKey = randomBytes(32);
  const iv = randomBytes(CIPHER.ivBytes);
  const cipher = createCipheriv(CIPHER.algorithm, sessionKey, iv, { authTagLength: CIPHER.tagBytes });
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);

  return {
    v: 1,
    keyId,
    wrappedKey: rsaEncrypt(sessionKey, publicKeyPem).toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ct.toString('base64'),
    ...(aad ? { aad } : {}),
  };
}

export function hybridDecrypt(
  env: HybridEnvelope,
  privateKeyPem: string,
  passphrase?: string,
): Buffer {
  if (env.v !== 1) throw new CryptoError('Enveloppe hybride non supportée', 'BAD_VERSION');
  const sessionKey = rsaDecrypt(Buffer.from(env.wrappedKey, 'base64'), privateKeyPem, passphrase);
  if (sessionKey.length !== 32) throw new CryptoError('Clé de session invalide', 'BAD_KEY');

  const decipher = createDecipheriv(
    CIPHER.algorithm,
    sessionKey,
    Buffer.from(env.iv, 'base64'),
    { authTagLength: CIPHER.tagBytes },
  );
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  if (env.aad) decipher.setAAD(Buffer.from(env.aad, 'utf8'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(env.data, 'base64')),
      decipher.final(),
    ]);
  } catch {
    throw new CryptoError('Enveloppe hybride altérée', 'AUTH_FAILED');
  }
}

/* ==========================================================================
 *  6. Dérivation de clés, hachage et HMAC
 * ========================================================================== */

/**
 * Dérive une clé de 32 octets depuis un secret maître (HKDF-SHA512).
 * Les clés de chiffrement ne sont JAMAIS utilisées directement : chaque usage
 * dispose de sa propre clé dérivée avec un `info` distinct.
 */
export function deriveKey(masterSecret: Buffer | string, info: string, salt?: Buffer): Buffer {
  const ikm = Buffer.isBuffer(masterSecret) ? masterSecret : Buffer.from(masterSecret, 'utf8');
  return Buffer.from(hkdfSync('sha512', ikm, salt ?? Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
}

/** SHA-256 en hexadécimal (empreintes, jetons stockés hachés). */
export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'))
    .digest('hex');
}

/** HMAC-SHA256 en hexadécimal : signature des entrées d'audit. */
export function hmacHex(value: string | Buffer, key: Buffer | string): string {
  return createHmac('sha256', key)
    .update(Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'))
    .digest('hex');
}

/**
 * Compare deux chaînes/octets à temps constant.
 * Évite les attaques par mesure de temps sur les comparaisons de jetons.
 */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // On compare quand même pour un temps constant, puis on renvoie false.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/* ==========================================================================
 *  7. Génération de secrets
 * ========================================================================== */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY346789'; // sans caractères ambigus

/** Code numérique à 6 chiffres, cryptographiquement sûr (2FA SMS, OTP). */
export function randomNumericCode(digits = 6): string {
  let out = '';
  while (out.length < digits) {
    for (const byte of randomBytes(digits)) {
      if (byte < 250) out += (byte % 10).toString(); // rejet >249 : distribution uniforme
      if (out.length === digits) break;
    }
  }
  return out;
}

/** Code alphanymique lisible, sans caractères confondables. */
export function randomReadableCode(length = 6): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte < 232) out += CODE_ALPHABET[byte % CODE_ALPHABET.length]; // 232 = 8 × 29
      if (out.length === length) break;
    }
  }
  return out;
}

/** Jeton opaque à haute entropie (URL-safe). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Identifiant unique de terminal / opération de synchronisation. */
export function newId(): string {
  return randomUUID();
}

export function newClientUuid(): string {
  return randomUUID();
}

/* ==========================================================================
 *  8. Auto-test au démarrage : garantit que la cryptographie fonctionne
 * ========================================================================== */

export interface SelfTestResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

/**
 * Vérifie au démarrage que les primitives fonctionnent réellement.
 * Un serveur qui démarre avec une cryptographie cassée est plus dangereux
 * qu'un serveur qui refuse de démarrer.
 */
export async function selfTest(): Promise<SelfTestResult> {
  const checks: SelfTestResult['checks'] = [];
  const push = (name: string, fn: () => boolean | Promise<boolean>, detail?: string) => {
    checks.push({ name, ok: false, ...(detail ? { detail } : {}) });
    return Promise.resolve()
      .then(fn)
      .then((ok) => {
        checks[checks.length - 1]!.ok = ok;
      })
      .catch((e: unknown) => {
        checks[checks.length - 1]!.detail = `exception: ${(e as Error).message}`;
      });
  };

  await push('AES-256-GCM aller-retour', () => {
    const key = randomBytes(32);
    const enc = encryptSymmetric('données sensibles école', key, 'school:abc');
    return decryptSymmetric(enc, key, 'school:abc').includes('données sensibles');
  });

  await push('AES-256-GCM détecte une altération', () => {
    const key = randomBytes(32);
    const enc = encryptSymmetric('secret', key);
    const last = enc.length - 1;
    enc[last] = (enc[last] ?? 0) ^ 0x01; // on modifie un bit
    try {
      decryptSymmetric(enc, key);
      return false; // aurait dû échouer
    } catch {
      return true;
    }
  });

  await push('Chiffrement lié à son contexte (AAD)', () => {
    const key = randomBytes(32);
    const enc = encryptSymmetric('note médicale', key, 'student:1');
    try {
      decryptSymmetric(enc, key, 'student:2'); // mauvais contexte
      return false;
    } catch {
      return true;
    }
  });

  await push('Hachage + vérification du mot de passe (pepper)', async () => {
    const pepper = randomBytes(32).toString('hex');
    const { hash } = await hashPassword('PhraseDePasse!2026Mwana', pepper);
    const good = await verifyPassword('PhraseDePasse!2026Mwana', hash, [{ id: 'v1', value: pepper }]);
    const bad = await verifyPassword('mauvais-mot-de-passe', hash, [{ id: 'v1', value: pepper }]);
    return good.ok && !bad.ok;
  });

  await push('Politique de mot de passe rejette les cas faibles', () => {
    const weak = ['123456', 'password', 'azertyuiop', 'aaaaAAAA1111!'];
    return weak.every((p) => !checkPasswordStrength(p).ok);
  });

  await push('Comparaison à temps constant', () => {
    return safeEqual('abc123', 'abc123') && !safeEqual('abc123', 'abc124') && !safeEqual('abc', 'abcd');
  });

  await push('Signature RSA-PSS vérifiable', () => {
    const pair = generateRsaKeyPair();
    const msg = 'communiqué officiel';
    const sig = rsaSign(msg, pair.privateKeyPem);
    return rsaVerify(msg, sig, pair.publicKeyPem) && !rsaVerify(msg + '!', sig, pair.publicKeyPem);
  });

  await push('Enveloppe hybride RSA + AES', () => {
    const pair = generateRsaKeyPair();
    const env = hybridEncrypt('pièce jointe confidentielle', pair.publicKeyPem, 'v1', 'doc:42');
    return hybridDecrypt(env, pair.privateKeyPem).toString('utf8').includes('confidentielle');
  });

  await push('Dérivation HKDF : clés distinctes par usage', () => {
    const master = randomBytes(32);
    const k1 = deriveKey(master, 'donnees');
    const k2 = deriveKey(master, 'audit');
    return k1.length === 32 && !k1.equals(k2);
  });

  await push('Code aléatoire sans caractère ambigu', () => {
    const code = randomReadableCode(6);
    return /^[ABCDEFGHJKMNPQRTUVWXY346789]{6}$/.test(code);
  });

  return { ok: checks.every((c) => c.ok), checks };
}
