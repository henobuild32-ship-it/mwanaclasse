import { SlicePipe } from '@angular/common';
import { Component, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { EnfantActifService } from '../../core/enfant-actif.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette } from '../../shared/ui';

interface Notification {
  id: string;
  kind?: string;
  title: string;
  body?: string | null;
  severity?: string | null;
  entity_type?: string | null;
  action_url?: string | null;
  read_at?: string | null;
  created_at: string;
}

/** Centre de notifications du parent (spec §6). */
@Component({
  selector: 'app-notifications-parent',
  imports: [SlicePipe, Chargement, EtatVide],
  templateUrl: './notifications.html',
  styleUrl: './pages.scss',
})
export class NotificationsParent {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  protected readonly selection = inject(EnfantActifService);

  protected readonly notifications = signal<Notification[]>([]);
  protected readonly nonLues = signal(0);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly enCours = signal(false);

  private premier = true;

  constructor() {
    // Changer d'enfant change d'école : on recharge les notifications.
    effect(
      () => {
        this.selection.ecoleId();
        if (this.premier) {
          this.premier = false;
          return;
        }
        void this.charger();
      },
      { allowSignalWrites: true },
    );
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      await this.selection.charger();
      const r = await this.api.lire<{ notifications: Notification[]; nonLues: number }>(
        'parent/notifications',
        this.selection.params,
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

  protected ouvrir(n: Notification): void {
    if (n.action_url) {
      void this.router.navigateByUrl(n.action_url);
    }
  }

  protected async marquerLues(): Promise<void> {
    this.enCours.set(true);
    try {
      const r = await this.api.envoyer<{ message: string }>(
        'parent/notifications/lues',
        {},
        this.selection.params,
      );
      this.toasts.succes(r?.message ?? 'Notifications marquées comme lues.');
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }
}
