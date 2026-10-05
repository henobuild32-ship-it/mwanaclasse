/**
 * ============================================================================
 *  MWANA CLASSE — Génération des secrets du serveur
 * ============================================================================
 *  Usage :
 *    npm run secrets:generate                 écrit api/.env.secrets
 *    npm run secrets:generate -- --print      affiche seulement (terminal)
 *    npm run secrets:generate -- --out mon-fichier --force
 *
 *  Les valeurs produites sont des secrets réels à haute entropie (48 octets,
 *  base64url). Ils doivent :
 *    - être conservés HORS du dépôt (jamais commités) ;
 *    - être sauvegardés : leur perte rend les données chiffrées et les mots de
 *      passe irrécupérables ;
 *    - être renouvelés selon la période indiquée pour chaque clé.
 * ============================================================================
 */

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findRepoRoot, finish, out } from './_shared.js';
import { SECRET_CATALOG } from '../security/secrets.js';

function buildEnvFragment(): string {
  const lines: string[] = [
    '# ============================================================================',
    '#  MWANA CLASSE — secrets du serveur (générés)',
    '#',
    '#  CE FICHIER EST SECRET.',
    '#   - ne jamais le committer dans Git ;',
    '#   - ne jamais le transmettre par e-mail ni par messagerie instantanée ;',
    '#   - le conserver dans un gestionnaire de mots de passe ou un coffre-fort ;',
    '#   - en cas de perte, les données chiffrées et les mots de passe',
    '#     existants deviennent irrécupérables (il faudra réinitialiser).',
    '#',
    '#  Utilisation : copiez les valeurs dans votre fichier .env (ou importez-lez',
    '#  dans votre orchestrateur : Docker secrets, Vault, cloud KMS…).',
    '# ============================================================================',
    '',
    'MWANA_SECRET_PROVIDER=env',
    '',
  ];

  for (const def of SECRET_CATALOG) {
    lines.push(`# ${def.description}`);
    lines.push(`# à renouveler tous les ${def.rotateAfterDays} jours`);
    lines.push(`${def.envVar}=${randomBytes(48).toString('base64url')}`);
    lines.push('');
  }

  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const printOnly = args.includes('--print');
  const force = args.includes('--force');
  const outIdx = args.indexOf('--out');
  const root = findRepoRoot();

  const target =
    outIdx >= 0 && args[outIdx + 1]
      ? path.resolve(process.cwd(), args[outIdx + 1]!)
      : path.join(root, 'api', '.env.secrets');

  out.step('Génération des secrets MwanaClasse');

  if (printOnly) {
    console.log('');
    console.log(buildEnvFragment());
    finish(0, 'Affichage seulement : rien n’a été écrit sur le disque.');
  }

  if (existsSync(target) && !force) {
    finish(
      1,
      `Le fichier existe déjà : ${target}\n` +
        'Régénérer ces valeurs REND LES DONNÉES CHIFFRÉES ET LES MOTS DE PASSE IRRÉCUPÉRABLES.\n' +
        'Si c’est vraiment voulu, relancez avec : --force',
    );
  }

  writeFileSync(target, buildEnvFragment(), { encoding: 'utf8', mode: 0o600 });

  out.ok(`Fichier écrit : ${target}`);
  out.info('Ce fichier ne doit JAMAIS être commité dans Git.');
  out.info('Copiez ensuite les valeurs dans votre .env de déploiement et archivez ce fichier en lieu sûr.');

  finish(0, 'Secrets générés.');
}

main();
