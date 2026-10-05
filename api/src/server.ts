/**
 * ============================================================================
 *  MWANA CLASSE — Point d'entrée du serveur
 * ============================================================================
 *  Au démarrage :
 *    1. chargement de la configuration (échec si non conforme) ;
 *    2. auto-test cryptographique : si une primitive ne fonctionne pas, le
 *       serveur REFUSE de démarrer. Un serveur dont le chiffrement est cassé
 *       est plus dangereux qu'un serveur arrêté ;
 *    3. vérification de la base et de l'isolation par école ;
 *    4. écoute HTTP avec arrêt propre sur SIGINT / SIGTERM.
 * ============================================================================
 */

import 'dotenv/config';
import { buildApp, shutdown, type AppDependencies } from './app.js';
import { selfTest, hashingReport } from './security/crypto.js';
import { totpSelfTest } from './security/totp.js';
import { secretSelfTest } from './security/secrets.js';

async function main(): Promise<void> {
  const startedAt = Date.now();

  /* ---------------------------------------------------------------------- */
  /*  1. Application                                                        */
  /* ---------------------------------------------------------------------- */

  let deps: AppDependencies;
  try {
    deps = await buildApp();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('\n⛔ Démarrage impossible :\n' + (err as Error).message + '\n');
    process.exit(1);
    return;
  }

  const { app, config, db, secrets } = deps;

  /* ---------------------------------------------------------------------- */
  /*  2. Auto-test de sécurité (bloquant)                                   */
  /* ---------------------------------------------------------------------- */

  const crypto = await selfTest();
  const totp = totpSelfTest();
  const secretChecks = secretSelfTest(secrets);

  const allChecks = [...crypto.checks, ...totp.checks, ...secretChecks.checks];
  const failures = allChecks.filter((c) => !c.ok);

  if (config.isProduction || process.env.MWANA_STRICT_SELFTEST === '1') {
    if (!crypto.ok || !totp.ok || !secretChecks.ok) {
      // eslint-disable-next-line no-console
      console.error('\n⛔ Auto-test de sécurité en échec — démarrage refusé :\n');
      for (const f of failures) {
        // eslint-disable-next-line no-console
        console.error(`   • ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      }
      // eslint-disable-next-line no-console
      console.error('');
      await shutdown(deps, 'auto-test échoué');
      process.exit(1);
      return;
    }
  }

  const hashing = hashingReport();
  app.log.info(
    {
      hachage: hashing.active,
      hachagesDisponibles: hashing.available,
      testsSecurite: `${allChecks.length - failures.length}/${allChecks.length}`,
    },
    'auto-test de sécurité effectué',
  );

  if (!crypto.ok || !totp.ok) {
    for (const f of failures) {
      app.log.warn({ test: f.name, detail: f.detail }, 'auto-test de sécurité en échec (mode développement)');
    }
  }

  // TOTP doit être conforme à la RFC : c'est le fondement de la 2FA.
  if (!totp.ok) {
    app.log.error('TOTP non conforme à la RFC 6238 : la double authentification est inutilisable.');
  }

  /* ---------------------------------------------------------------------- */
  /*  3. Base de données                                                    */
  /* ---------------------------------------------------------------------- */

  const health = await db.health();
  if (!health.ok) {
    app.log.error({ erreur: health.error }, 'base de données injoignable');
    // On continue tout de même : la sonde /sante le signalera et l'API
    // renverra des erreurs explicites plutôt que de rester muette.
  } else {
    app.log.info(
      {
        version: health.version,
        latenceMs: health.latencyMs,
        tablesIsolees: health.rlsEnabledTables,
        isolationForcee: health.rlsForcedTables,
      },
      'base de données connectée',
    );

    if (health.rlsForcedTables < health.rlsEnabledTables) {
      app.log.warn(
        'Certaines tables ne forcent pas l’isolation par école (FORCE ROW LEVEL SECURITY). ' +
          'Vérifiez l’exécution du script 004_rls_views.sql.',
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  4. Écoute                                                             */
  /* ---------------------------------------------------------------------- */

  try {
    await app.listen({ port: config.API_PORT, host: config.API_HOST });
  } catch (err) {
    app.log.error({ err }, 'impossible d’ouvrir le port d’écoute');
    process.exit(1);
    return;
  }

  const policy = config.isProduction ? 'HTTPS/TLS 1.3' : 'HTTP (développement local)';
  app.log.info(
    {
      environnement: config.NODE_ENV,
      transport: policy,
      demarrageMs: Date.now() - startedAt,
      interfaceParents: config.WEB_PUBLIC_URL,
    },
    `MwanaClasse API en écoute sur ${config.API_HOST}:${config.API_PORT}`,
  );

  if (secrets.devGenerated().length > 0) {
    app.log.warn(
      { secretsGeneres: secrets.devGenerated() },
      'Secrets générés automatiquement : les données chiffrées et les mots de passe ' +
        'ne survivront pas à un redémarrage. Générez un fichier .env avec « npm run secrets:generate ».',
    );
  }

  /* ---------------------------------------------------------------------- */
  /*  Arrêt propre                                                          */
  /* ---------------------------------------------------------------------- */

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void shutdown(deps, signal).then(() => process.exit(0));
    });
  }

  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'promesse rejetée non traitée');
  });
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'exception non capturée : arrêt du serveur');
    void shutdown(deps, 'uncaughtException').then(() => process.exit(1));
  });
}

void main();
