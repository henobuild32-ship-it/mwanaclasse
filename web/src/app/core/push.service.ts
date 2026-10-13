/**
 * ============================================================================
 *  MWANA CLASSE — Service de notifications push (client)
 * ============================================================================
 *  - Récupération de la clé publique VAPID auprès de l'API ;
 *  - Demande de permission (avec explication préalable sur iOS) ;
 *  - Abonnement / renouvellement / désabonnement de l'appareil ;
 *  - Réglages par type de notification (offline-first : localStorage) ;
 *  - Écoute des messages du service worker (toast en premier plan) ;
 *  - Badge d'application (setAppBadge) quand le navigateur le supporte.
 * ============================================================================
 */

import { Injectable, NgZone } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, firstValueFrom } from 'rxjs';
import { ToastService } from './toast.service';

const BASE_API = '/api';
const CLE_STOCKAGE_REGLAGES = 'mwana.push.reglages';
const CLE_STOCKAGE_ABONNE = 'mwana.push.abonne';

export interface ReglagesPush {
  push: boolean;
  demandes: boolean;
  communiques: boolean;
  presences: boolean;
  calendrier: boolean;
  documents: boolean;
}

const REGLAGES_DEFAUT: ReglagesPush = {
  push: true,
  demandes: true,
  communiques: true,
  presences: true,
  calendrier: true,
  documents: true,
};

/** Existe-t-on sur iOS Safari non installé (« Ajouter à l'accueil » requis) ? */
export function estIosSafari(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = /^((?!chrome|android).)*safari/i.test(ua);
  const standalone = (window.navigator as any).standalone === true;
  return ios && safari && !standalone;
}

export function estApplicationInstallee(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true
  );
}

@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly reglagesSubject = new BehaviorSubject<ReglagesPush>(this.lireReglages());
  readonly reglages$ = this.reglagesSubject.asObservable();

  private clePublique: string | null = null;
  private swMessageListener = false;

  constructor(
    private readonly http: HttpClient,
    private readonly toast: ToastService,
    private readonly zone: NgZone,
  ) {
    this.ecouterMessagesSw();
  }

  /* ====================================================================== */
  /*  Capacité du navigateur                                                */
  /* ====================================================================== */

  get supportePush(): boolean {
    return (
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  get permission(): NotificationPermission | 'non-supporte' {
    if (!this.supportePush) return 'non-supporte';
    return Notification.permission;
  }

  /** L'utilisateur a déjà autorisé les notifications. */
  get autorise(): boolean {
    return this.permission === 'granted';
  }

  /* ====================================================================== */
  /*  Clé publique VAPID                                                   */
  /* ====================================================================== */

  private async chargerClePublique(): Promise<string | null> {
    if (this.clePublique) return this.clePublique;
    try {
      const res = await firstValueFrom(
        this.http.get<{ disponible: boolean; clePublique: string | null }>(
          `${BASE_API}/push/config`,
        ),
      );
      this.clePublique = res.clePublique;
      return this.clePublique;
    } catch {
      return null;
    }
  }

  /* ====================================================================== */
  /*  Abonnement                                                            */
  /* ====================================================================== */

  /**
   * Demande la permission puis enregistre l'abonnement auprès de l'API.
   * Retourne le résultat pour afficher le message adapté.
   */
  async activer(): Promise<{ ok: boolean; message: string }> {
    if (!this.supportePush) {
      return {
        ok: false,
        message: 'Ce navigateur ne supporte pas les notifications push.',
      };
    }

    // Explication avant la boîte de dialogue système (obligatoire sur iOS).
    const confirme = await this.demanderConfirmation();
    if (!confirme) {
      return { ok: false, message: 'Activation annulée.' };
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return {
        ok: false,
        message:
          'Permission refusée. Ouvrez les réglages de votre navigateur pour autoriser les notifications.',
      };
    }

    const ok = await this.enregistrerAbonnement();
    return ok
      ? { ok: true, message: 'Notifications activées sur cet appareil.' }
      : { ok: false, message: 'Impossible d’enregistrer l’abonnement. Réessayez plus tard.' };
  }

  private async demanderConfirmation(): Promise<boolean> {
    // Sur iOS Safari, l'utilisateur doit d'abord ajouter l'app à l'écran
    // d'accueil : on l'explique avant de demander la permission.
    if (estIosSafari()) {
      return window.confirm(
        'Sur iPhone / iPad, ouvrez le menu Partager puis « Sur l’écran d’accueil » pour activer les notifications.\n\n' +
          'Cliquez sur OK pour continuer.',
      );
    }
    return true;
  }

  /** (Ré)enregistre l'abonnement Web Push auprès de l'API. */
  async enregistrerAbonnement(): Promise<boolean> {
    try {
      const cle = await this.chargerClePublique();
      if (!cle) return false;

      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      let subscription = await reg.pushManager.getSubscription();
      if (!subscription) {
        subscription = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this.urlBase64ToUint8Array(cle) as unknown as BufferSource,
        });
      }

      const json = subscription.toJSON() as {
        endpoint?: string;
        keys?: Record<string, string>;
      };
      const deviceId = this.deviceId();

      await firstValueFrom(
        this.http.post(`${BASE_API}/push/abonner`, {
          abonnement: {
            endpoint: json.endpoint,
            keys: { p256dh: json.keys?.['p256dh'], auth: json.keys?.['auth'] },
          },
          deviceId,
        }),
      );

      this.marquerAbonne(true);
      return true;
    } catch {
      return false;
    }
  }

  /** Désactive les notifications sur cet appareil (sans révoquer la session). */
  async desactiver(): Promise<void> {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const subscription = await reg?.pushManager.getSubscription();
      await firstValueFrom(
        this.http.post(`${BASE_API}/push/desabonner`, {
          endpoint: subscription?.endpoint,
          deviceId: this.deviceId(),
        }),
      );
      await subscription?.unsubscribe();
      this.marquerAbonne(false);
    } catch {
      /* best effort */
    }
  }

  /** Désabonnement silencieux (appelé à la déconnexion). */
  async desactiverSilencieusement(): Promise<void> {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const subscription = await reg?.pushManager.getSubscription();
      if (!subscription) return;
      await firstValueFrom(
        this.http.post(`${BASE_API}/push/desabonner`, {
          endpoint: subscription.endpoint,
          deviceId: this.deviceId(),
        }),
      );
      await subscription.unsubscribe();
      this.marquerAbonne(false);
    } catch {
      /* best effort */
    }
  }

  /** Renouvelle l'abonnement (appelé à chaque ouverture si permission accordée). */
  async resynchroniser(): Promise<void> {
    if (!this.supportePush || Notification.permission !== 'granted') return;
    await this.enregistrerAbonnement();
  }

  /* ====================================================================== */
  /*  Réglages par type                                                     */
  /* ====================================================================== */

  lireReglages(): ReglagesPush {
    try {
      const brut = localStorage.getItem(CLE_STOCKAGE_REGLAGES);
      if (!brut) return { ...REGLAGES_DEFAUT };
      return { ...REGLAGES_DEFAUT, ...JSON.parse(brut) };
    } catch {
      return { ...REGLAGES_DEFAUT };
    }
  }

  estAbonne(): boolean {
    return localStorage.getItem(CLE_STOCKAGE_ABONNE) === '1';
  }

  private marquerAbonne(valeur: boolean): void {
    if (valeur) localStorage.setItem(CLE_STOCKAGE_ABONNE, '1');
    else localStorage.removeItem(CLE_STOCKAGE_ABONNE);
  }

  async majReglages(partiel: Partial<ReglagesPush>): Promise<void> {
    const maj = { ...this.lireReglages(), ...partiel };
    this.reglagesSubject.next(maj);
    // Offline-first : sauvegarde locale immédiate, synchronisation en arrière-plan.
    localStorage.setItem(CLE_STOCKAGE_REGLAGES, JSON.stringify(maj));
    try {
      await firstValueFrom(
        this.http.put(`${BASE_API}/push/reglages`, maj),
      );
    } catch {
      /* la synchronisation reprendra à la prochaine ouverture */
    }
  }

  /** Récupère les réglages depuis le serveur (fusionne avec le local). */
  async chargerReglagesServeur(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ reglages: Partial<ReglagesPush> }>(
          `${BASE_API}/push/reglages`,
        ),
      );
      const maj = { ...this.lireReglages(), ...res.reglages };
      this.reglagesSubject.next(maj);
      localStorage.setItem(CLE_STOCKAGE_REGLAGES, JSON.stringify(maj));
    } catch {
      /* offline : le local fait foi */
    }
  }

  async envoyerTest(): Promise<string> {
    const res = await firstValueFrom(
      this.http.post<{ message: string }>(`${BASE_API}/push/test`, {}),
    );
    return res.message;
  }

  /* ====================================================================== */
  /*  Badge d'application                                                   */
  /* ====================================================================== */

  async majBadge(compteur: number): Promise<void> {
    try {
      const nav = navigator as any;
      if (nav.setAppBadge) {
        if (compteur > 0) await nav.setAppBadge(compteur);
        else if (nav.clearAppBadge) await nav.clearAppBadge();
      }
    } catch {
      /* best effort */
    }
  }

  /* ====================================================================== */
  /*  Messages du service worker                                            */
  /* ====================================================================== */

  private ecouterMessagesSw(): void {
    if (this.swMessageListener || typeof navigator === 'undefined') return;
    this.swMessageListener = true;
    navigator.serviceWorker?.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      this.zone.run(() => {
        if (data.type === 'push-visible' && data.payload) {
          this.toast.info(`${data.payload.title} — ${data.payload.body}`);
        } else if (data.type === 'pushsubscriptionchange') {
          void this.enregistrerAbonnement();
        }
      });
    });
  }

  /* ====================================================================== */
  /*  Utilitaires                                                           */
  /* ====================================================================== */

  private deviceId(): string {
    let id = localStorage.getItem('mwana.deviceId');
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem('mwana.deviceId', id);
    }
    return id;
  }

  /** Convertit la clé VAPID base64url en Uint8Array attendu par l'API Push. */
  private urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
}
