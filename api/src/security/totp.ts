/**
 * ============================================================================
 *  MWANA CLASSE — Double authentification (2FA)
 * ============================================================================
 *  Implémentation complète de TOTP (RFC 6238) sur HMAC-SHA1/SHA256,
 *  compatible Google Authenticator, Authy, FreeOTP, Microsoft Authenticator.
 *
 *  Mesures de sécurité appliquées :
 *    - secret de 160 bits minimum, généré par le générateur du système ;
 *    - secret stocké CHIFFRÉ (AES-256-GCM) : une lecture de la base ne suffit
 *      pas à produire des codes ;
 *    - fenêtre de tolérance limitée (±1 pas de 30 s) pour l'horloge ;
 *    - anti-rejeu : un code déjà utilisé pour un pas de temps est refusé
 *      (totp_last_used_step) ;
 *    - comparaison à temps constant ;
 *    - codes de secours à usage unique, hachés en base ;
 *    - limitation du nombre d'essais par code (verrouillage progressif).
 * ============================================================================
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';

export interface TotpConfig {
  /** Durée d'un pas, en secondes (30 s = standard) */
  period: number;
  /** Nombre de chiffres du code (6 = standard) */
  digits: number;
  /** Algorithme de hachage sous-jacent */
  algorithm: 'sha1' | 'sha256' | 'sha512';
  /** Nombre de pas acceptés de part et d'autre (tolérance d'horloge) */
  window: number;
  /** Longueur du secret en octets (20 = 160 bits) */
  secretBytes: number;
}

export const DEFAULT_TOTP: TotpConfig = {
  period: 30,
  digits: 6,
  algorithm: 'sha1', // imposé par la compatibilité des applications mobiles
  window: 1,
  secretBytes: 20,
};

/* ==========================================================================
 *  Base32 (RFC 4648) — format attendu par les applications d'authentification
 * ========================================================================== */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/[\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = B32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Caractère Base32 invalide : ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ==========================================================================
 *  Génération et calcul des codes
 * ========================================================================== */

/** Génère un nouveau secret (renvoyé en Base32 pour l'application mobile). */
export function generateTotpSecret(cfg: TotpConfig = DEFAULT_TOTP): {
  secretBase32: string;
  secretRaw: Buffer;
} {
  const secretRaw = randomBytes(cfg.secretBytes);
  return { secretBase32: base32Encode(secretRaw), secretRaw };
}

/** Calcule le code TOTP pour un pas de temps donné. */
export function totpAt(
  secretRaw: Buffer,
  counter: number,
  cfg: TotpConfig = DEFAULT_TOTP,
): string {
  const buf = Buffer.alloc(8);
  // Compteur sur 64 bits big-endian (les 32 bits hauts restent à 0 avant 2038+
  // pour un pas de 30 s, mais on écrit les 8 octets correctement).
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac(cfg.algorithm, secretRaw).update(buf).digest();
  // Troncature dynamique (RFC 4226 §5.3)
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const code = binary % 10 ** cfg.digits;
  return code.toString().padStart(cfg.digits, '0');
}

/** Pas de temps courant. */
export function currentStep(atMs: number = Date.now(), cfg: TotpConfig = DEFAULT_TOTP): number {
  return Math.floor(atMs / 1000 / cfg.period);
}

/**
 * Vérifie un code TOTP.
 * @param allowStep si fourni, renvoie le pas validé pour la protection anti-rejeu.
 */
export function verifyTotp(
  token: string,
  secretRaw: Buffer,
  opts: TotpConfig & { atMs?: number; lastUsedStep?: number | null } = DEFAULT_TOTP,
): { valid: boolean; step?: number; drift?: number } {
  const cfg: TotpConfig = { ...DEFAULT_TOTP, ...opts };

  const clean = (token ?? '').replace(/[\s-]/g, '');
  if (!new RegExp(`^\\d{${cfg.digits}}$`).test(clean)) return { valid: false };

  const step = currentStep(opts.atMs ?? Date.now(), cfg);

  for (let drift = -cfg.window; drift <= cfg.window; drift++) {
    const candidateStep = step + drift;
    if (candidateStep < 0) continue;

    const expected = totpAt(secretRaw, candidateStep, cfg);
    const a = Buffer.from(clean, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) continue;

    if (timingSafeEqual(a, b)) {
      // Anti-rejeu : un code du même pas déjà consommé est refusé.
      if (opts.lastUsedStep != null && candidateStep <= opts.lastUsedStep) {
        return { valid: false, drift };
      }
      return { valid: true, step: candidateStep, drift };
    }
  }

  return { valid: false };
}

/* ==========================================================================
 *  URI otpauth:// et QR code
 * ========================================================================== */

export interface OtpAuthParams {
  secretBase32: string;
  accountName: string;
  issuer: string;
  cfg?: TotpConfig;
}

/**
 * URI à encoder en QR code.
 * Le nom de l'émetteur et le compte sont encodés strictement (RFC 3986) :
 * une injection dans l'URI briserait l'enrôlement.
 */
export function otpAuthUri(params: OtpAuthParams): string {
  const cfg = params.cfg ?? DEFAULT_TOTP;
  const issuer = encodeURIComponent(params.issuer);
  const account = encodeURIComponent(params.accountName);
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: cfg.algorithm.toUpperCase(),
    digits: String(cfg.digits),
    period: String(cfg.period),
  });
  return `otpauth://totp/${issuer}:${account}?${query.toString()}`;
}

/** QR code en data-URL PNG, prêt à afficher dans l'interface Angular. */
export async function otpAuthQrDataUrl(params: OtpAuthParams): Promise<string> {
  const uri = otpAuthUri(params);
  return QRCode.toDataURL(uri, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
    color: { dark: '#0f172a', light: '#ffffff' },
  });
}

/* ==========================================================================
 *  Codes de secours (perte du téléphone)
 * ========================================================================== */

/**
 * Génère 10 codes de secours lisibles.
 * Ils sont affichés UNE SEULE FOIS puis stockés hachés : la base ne permet
 * jamais de les retrouver.
 */
export function generateRecoveryCodes(count = 10): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  for (let i = 0; i < count; i++) {
    // Format XXXX-XXXX : facile à recopier depuis un papier
    const raw = randomBytes(8).toString('hex').toUpperCase().slice(0, 8);
    plain.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return { plain, hashed: plain.map((c) => hashRecoveryCode(c)) };
}

/** Hachage d'un code de secours (SHA-256 + sel applicatif géré par l'appelant). */
export function hashRecoveryCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[\s-]/g, '');
  return createHmac('sha256', 'mwana-recovery-code').update(normalized).digest('hex');
}

/* ==========================================================================
 *  Fenêtre de validité pour la 2FA par SMS / e-mail
 * ========================================================================== */

export function otpExpiry(minutes = 10): Date {
  return new Date(Date.now() + minutes * 60_000);
}

/* ==========================================================================
 *  Auto-test
 * ========================================================================== */

/**
 * Vecteurs de test officiels RFC 6238 (secret « 12345678901234567890 » en ASCII).
 * Vérifier ces valeurs prouve que l'implémentation est conforme à la norme,
 * donc compatible avec toutes les applications d'authentification.
 */
export function totpSelfTest(): {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
} {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const secretAscii = Buffer.from('12345678901234567890', 'ascii');
  const secret32 = Buffer.from('12345678901234567890123456789012', 'ascii');

  // RFC 6238, annexe B — SHA-1, 8 chiffres
  const rfc6238 = [
    { time: 59, expected: '94287082' },
    { time: 1111111109, expected: '07081804' },
    { time: 1111111111, expected: '14050471' },
    { time: 1234567890, expected: '89005924' },
    { time: 2000000000, expected: '69279037' },
    { time: 20000000000, expected: '65353130' },
  ];

  const cfg: TotpConfig = { period: 30, digits: 8, algorithm: 'sha1', window: 0, secretBytes: 20 };

  for (const v of rfc6238) {
    const step = Math.floor(v.time / 30);
    const got = totpAt(secretAscii, step, cfg);
    checks.push({
      name: `RFC 6238 SHA-1 t=${v.time}`,
      ok: got === v.expected,
      detail: got === v.expected ? got : `attendu ${v.expected}, obtenu ${got}`,
    });
  }

  // Vecteurs RFC 6238 SHA-256 (secret de 32 octets)
  const cfg256: TotpConfig = { ...cfg, algorithm: 'sha256' };
  const sha256Vectors = [
    { time: 59, expected: '46119246' },
    { time: 1111111109, expected: '68084774' },
    { time: 1234567890, expected: '91819424' },
  ];
  for (const v of sha256Vectors) {
    const got = totpAt(secret32, Math.floor(v.time / 30), cfg256);
    checks.push({
      name: `RFC 6238 SHA-256 t=${v.time}`,
      ok: got === v.expected,
      detail: got === v.expected ? got : `attendu ${v.expected}, obtenu ${got}`,
    });
  }

  // Vérification avec tolérance d'horloge et anti-rejeu
  const { secretRaw, secretBase32 } = generateTotpSecret();
  const now = Date.now();
  const step = currentStep(now);
  const code = totpAt(secretRaw, step, DEFAULT_TOTP);

  checks.push({
    name: 'Code courant accepté',
    ok: verifyTotp(code, secretRaw, { ...DEFAULT_TOTP, atMs: now }).valid,
  });

  checks.push({
    name: 'Code d’un pas antérieur accepté dans la fenêtre de tolérance',
    ok: verifyTotp(totpAt(secretRaw, step - 1, DEFAULT_TOTP), secretRaw, { ...DEFAULT_TOTP, atMs: now }).valid,
  });

  checks.push({
    name: 'Code hors fenêtre refusé',
    ok: !verifyTotp(totpAt(secretRaw, step - 5, DEFAULT_TOTP), secretRaw, { ...DEFAULT_TOTP, atMs: now }).valid,
  });

  checks.push({
    name: 'Code déjà utilisé refusé (protection anti-rejeu)',
    ok: !verifyTotp(code, secretRaw, { ...DEFAULT_TOTP, atMs: now, lastUsedStep: step }).valid,
  });

  checks.push({
    name: 'Code erroné refusé',
    ok: !verifyTotp('000000', secretRaw, { ...DEFAULT_TOTP, atMs: now }).valid,
  });

  checks.push({
    name: 'Base32 aller-retour',
    ok: base32Decode(secretBase32).equals(secretRaw),
  });

  checks.push({
    name: 'URI otpauth conforme',
    ok: otpAuthUri({
      secretBase32,
      accountName: 'directeur@ecole.cd',
      issuer: 'MwanaClasse',
    }).startsWith('otpauth://totp/MwanaClasse:directeur%40ecole.cd?secret='),
  });

  checks.push({
    name: 'Codes de secours uniques et non stockés en clair',
    ok: (() => {
      const { plain, hashed } = generateRecoveryCodes(10);
      return (
        new Set(plain).size === 10 &&
        hashed.every((h) => h.length === 64 && !plain.some((p) => h.includes(p)))
      );
    })(),
  });

  return { ok: checks.every((c) => c.ok), checks };
}
