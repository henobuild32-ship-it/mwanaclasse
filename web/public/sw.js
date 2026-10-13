/* eslint-disable no-undef */
/**
 * ============================================================================
 *  MWANA CLASSE — Service Worker (PWA + Web Push)
 * ============================================================================
 *  Ce SW remplace ngsw-worker.js comme point d'entrée, mais DÉLÈGUE le
 *  travail de cache (précachage, runtime, navigation hors ligne) au SW
 *  Angular officiel importé via importScripts.
 *
 *  Il ajoute ensuite les gestionnaires Web Push :
 *    - « push »          : affiche la notification ou la transmet à l'app
 *                          ouverte (toast en premier plan) ;
 *    - « notificationclick » : ouvre / centre l'onglet de l'app ;
 *    - « pushsubscriptionchange » : notifie l'app pour renouveler l'abonnement.
 * ============================================================================
 */

// Le SW Angular gère le précachage, les stratégies de runtime et la navigation.
importScripts('/ngsw-worker.js');

/* ==========================================================================
 *  Push : réception
 * ========================================================================== */

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'MwanaClasse', body: event.data.text(), data: { url: '/' } };
  }

  const title = payload.title || 'MwanaClasse';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icons/icon-192.png',
    badge: payload.badge || '/icons/icon-192.png',
    tag: payload.tag || 'mwana',
    renotify: false,
    data: payload.data || { url: '/' },
  };

  // Si un onglet de l'app est déjà visible, on transmet au client pour
  // afficher un toast (pas de notification système redondante).
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.visibilityState === 'visible' && 'postMessage' in client) {
          client.postMessage({ type: 'push-visible', payload });
          return undefined;
        }
      }
      // Aucun client visible → notification système.
      return self.registration.showNotification(title, options);
    }),
  );
});

/* ==========================================================================
 *  Push : clic sur la notification
 * ========================================================================== */

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // L'onglet est déjà ouvert : on l'apporte au premier plan.
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(url);
          return undefined;
        }
      }
      // Sinon on ouvre un nouvel onglet.
      return self.clients.openWindow(url);
    }),
  );
});

/* ==========================================================================
 *  Push : renouvellement d'abonnement (ex : rotation de clés navigateur)
 * ========================================================================== */

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('postMessage' in client) {
          client.postMessage({ type: 'pushsubscriptionchange' });
        }
      }
    }),
  );
});
