import { SlicePipe } from '@angular/common';
import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { EnfantActifService } from '../../core/enfant-actif.service';
import { SyncService } from '../../core/sync.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette } from '../../shared/ui';

interface Communique {
  id: string;
  reference?: string | null;
  title: string;
  subject?: string | null;
  summary?: string | null;
  body_html?: string | null;
  kind?: string;
  is_urgent?: boolean;
  published_at?: string | null;
  attachment_name?: string | null;
  pdf_url?: string | null;
  ecole?: string | null;
  primary_color?: string | null;
  read_at?: string | null;
  eleve?: string | null;
  classe?: string | null;
}

/** Communiqués reçus par le parent (spec §6). */
@Component({
  selector: 'app-communiques-parent',
  imports: [SlicePipe, FormsModule, Chargement, EtatVide],
  templateUrl: './communiques.html',
  styleUrl: './pages.scss',
})
export class CommuniquesParent {
  private readonly api = inject(ApiService);
  private readonly sync = inject(SyncService);
  private readonly toasts = inject(ToastService);
  protected readonly selection = inject(EnfantActifService);

  protected readonly communiques = signal<Communique[]>([]);
  protected readonly nonLus = signal(0);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly enCours = signal(false);
  protected readonly ouvert = signal('');

  private premier = true;

  constructor() {
    // Changer d'enfant change d'école : on recharge les communiqués.
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
      const ecoleId = this.selection.ecoleId();
      const cle = `parent.communiques:${ecoleId ?? 'toutes'}`;
      await this.sync.lireDabord<{ communiques: Communique[]; nonLus: number }>(
        cle,
        () => this.api.lire<{ communiques: Communique[]; nonLus: number }>(
          'parent/communiques',
          this.selection.params,
        ),
        (r) => {
          this.communiques.set(r.communiques ?? []);
          this.nonLus.set(r.nonLus ?? 0);
        },
        { entite: 'communiques', extraire: (r) => r.communiques ?? [] },
      );
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne || (err as Error)?.message === 'HORS_LIGNE' ? 'Hors ligne : communiqués indisponibles.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected basculer(id: string): void {
    this.ouvert.set(this.ouvert() === id ? '' : id);
  }

  protected async marquerLus(): Promise<void> {
    this.enCours.set(true);
    try {
      const r = await this.api.envoyer<{ message: string }>(
        'parent/communiques/lus',
        {},
        this.selection.params,
      );
      this.toasts.succes(r?.message ?? 'Communiqués marqués comme lus.');
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }
}
