/**
 * ============================================================================
 *  MWANA CLASSE — Auto-test de sécurité
 * ============================================================================
 *  Usage : npm run security:selftest
 *
 *  Vérifie que les primitives cryptographiques fonctionnent RÉELLEMENT :
 *    - chiffrement symétrique AES-256-GCM (aller-retour, altération, AAD) ;
 *    - hachage des mots de passe (Argon2id/bcrypt/PBKDF2 + pepper) ;
 *    - politiques de mot de passe ;
 *    - signature RSA-PSS et enveloppe hybride ;
 *    - TOTP conforme à la RFC 6238 (vecteurs officiels SHA-1 et SHA-256) ;
 *    - intégrité des secrets configurés.
 *
 *  Un serveur qui démarre avec une cryptographie cassée est plus dangereux
 *  qu'un serveur qui refuse de démarrer : ce contrôle échoue donc en code 1.
 * ============================================================================
 */

import 'dotenv/config';
import { finish, out } from './_shared.js';
import { hashingReport, selfTest, type SelfTestResult } from '../security/crypto.js';
import { totpSelfTest } from '../security/totp.js';
import { secretSelfTest, SecretsManager } from '../security/secrets.js';

interface Section {
  title: string;
  result: SelfTestResult;
}

async function main(): Promise<void> {
  out.step('Auto-test de sécurité MwanaClasse');

  const sections: Section[] = [];

  sections.push({ title: 'Cryptographie et mots de passe', result: await selfTest() });
  sections.push({ title: 'Double authentification (RFC 6238)', result: totpSelfTest() });

  try {
    const manager = new SecretsManager();
    manager.loadAll();
    sections.push({ title: 'Secrets du serveur', result: secretSelfTest(manager) });
  } catch (err) {
    sections.push({
      title: 'Secrets du serveur',
      result: { ok: false, checks: [{ name: 'Chargement', ok: false, detail: (err as Error).message }] },
    });
  }

  const hash = hashingReport();
  console.log('');
  out.info(`Hachage actif : ${hash.active} (disponibles : ${hash.available.join(', ')})`);

  let failures = 0;
  for (const section of sections) {
    console.log('');
    console.log(`  ${section.title}`);
    for (const check of section.result.checks) {
      if (!check.ok) failures += 1;
      console.log(`    ${check.ok ? '[ok]' : '[x]'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
    }
  }

  if (failures > 0) {
    finish(1, `\n${failures} vérification(s) en échec : le serveur ne doit pas démarrer.`);
  }
  finish(0, '\nToutes les vérifications de sécurité sont réussies.');
}

main().catch((err: unknown) => {
  console.error(`\n[x] ${(err as Error).message}\n`);
  process.exit(1);
});
