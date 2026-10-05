import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { ApiService, toApiError } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';

interface Notification {
  id: string;
  kind?: string;
  title: string;
  body?: string | null;
  severity?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  action_url?: string | null;
  read_at?: string | null;
  created_at: string;
}

/** Notifications d'administration de l'école. */
@Component({
  selector: 'app-notifications-ecole',
  imports: [SlicePipe, Chargement, EtatVide, Etiquette],
  templateUrl: './notifications.html',
  styleUrl: './pages.scss',
})
export class NotificationsEcole {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  protected readonly etiquetteStatut = etiquetteStatut;

  protected readonly notifications = signal<Notification[]>([]);
  protected readonly nonLues = signal(0);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly enCours = signal(false);

  constructor() {
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.api.lire<{ notifications: Notification[]; nonLues: number }>(
        'ecole/notifications',
      );
      this.notifications.set(r.notifications ?? []);
      this.nonLues.set(r.nonLues ?? 0);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : notifications indisponibles.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected async marquerLues(): Promise<void> {
    this.enCours.set(true);
    try {
      const r = await this.api.envoyer<{ message: string }>('ecole/notifications/lues', {});
      this.toasts.succes(r?.message ?? 'Notifications marquées comme lues.');
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }
}
