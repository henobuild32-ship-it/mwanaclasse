import { Injectable, signal } from '@angular/core';

/**
 * État de la connexion réseau + horodatage du dernier passage en ligne.
 * Les services de synchronisation s'appuient sur ces signaux.
 */
@Injectable({ providedIn: 'root' })
export class ConnectiviteService {
  readonly enLigne = signal<boolean>(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  readonly derniereConnexion = signal<number | null>(null);

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.enLigne.set(true);
        this.derniereConnexion.set(Date.now());
      });
      window.addEventListener('offline', () => this.enLigne.set(false));
    }
  }

  get horsLigne(): boolean {
    return !this.enLigne();
  }
}
