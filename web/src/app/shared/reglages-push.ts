import { Component, inject, signal } from '@angular/core';
import { PushService, ReglagesPush, estIosSafari, estApplicationInstallee } from '../core/push.service';
import { ToastService } from '../core/toast.service';
import { toApiError } from '../core/api.service';

/**
 * Panneau de réglages des notifications push (partagé parent / école) :
 * activation de l'appareil, interrupteurs par type, guide iOS.
 */
@Component({
  selector: 'app-reglages-push',
  templateUrl: './reglages-push.html',
  styleUrl: './reglages-push.css',
})
export class ReglagesPushComponent {
  protected readonly push = inject(PushService);
  protected readonly toasts = inject(ToastService);

  protected readonly reglages = signal<ReglagesPush>(this.push.lireReglages());
  protected readonly abonne = signal(this.push.estAbonne());
  protected readonly enCours = signal(false);
  protected readonly message = signal('');
  protected readonly guideIosVisible = signal(false);

  constructor() {
    this.guideIosVisible.set(estIosSafari() && !this.push.estAbonne());
    if (this.push.supportePush && this.push.autorise) {
      void this.push.chargerReglagesServeur();
    }
  }

  get supportePush(): boolean {
    return this.push.supportePush;
  }

  get permission(): string {
    return this.push.permission;
  }

  get estIos(): boolean {
    return estIosSafari();
  }

  get estInstallee(): boolean {
    return estApplicationInstallee();
  }

  async activer(): Promise<void> {
    this.enCours.set(true);
    this.message.set('');
    try {
      const r = await this.push.activer();
      this.message.set(r.message);
      this.abonne.set(r.ok);
      if (r.ok) {
        this.toasts.succes(r.message);
        await this.push.chargerReglagesServeur();
        this.reglages.set(this.push.lireReglages());
      } else {
        this.toasts.erreur(r.message);
      }
    } finally {
      this.enCours.set(false);
    }
  }

  async desactiver(): Promise<void> {
    this.enCours.set(true);
    try {
      await this.push.desactiver();
      this.abonne.set(false);
      this.toasts.info('Notifications désactivées sur cet appareil.');
    } finally {
      this.enCours.set(false);
    }
  }

  async basculer(cle: keyof ReglagesPush, valeur: boolean): Promise<void> {
    this.reglages.update((r) => ({ ...r, [cle]: valeur }));
    try {
      await this.push.majReglages({ [cle]: valeur });
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    }
  }

  async envoyerTest(): Promise<void> {
    this.enCours.set(true);
    try {
      const msg = await this.push.envoyerTest();
      this.toasts.succes(msg);
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }
}
