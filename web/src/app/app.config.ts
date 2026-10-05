import { ApplicationConfig, inject, isDevMode, provideAppInitializer, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app.routes';
import { authInterceptor } from './core/auth.interceptor';
import { SessionService } from './core/session.service';
import { SyncService } from './core/sync.service';

/** Reprise de session puis démarrage de la synchronisation hors ligne. */
async function initialisation(): Promise<void> {
  const session = inject(SessionService);
  const sync = inject(SyncService);
  await session.restaurer();
  await sync.demarrer();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([authInterceptor])),
    provideAppInitializer(() => initialisation()),
    ...(isDevMode()
      ? []
      : [
          provideServiceWorker('ngsw-worker.js', {
            registrationStrategy: 'registerWhenStable:30000',
          }),
        ]),
  ],
};
