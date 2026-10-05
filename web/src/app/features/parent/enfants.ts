import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { Enfant } from '../../core/models';
import { SyncService } from '../../core/sync.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';

/** Liste des enfants rattachés au compte parent (spec §6). */
@Component({
  selector: 'app-enfants-parent',
  imports: [RouterLink, Chargement, EtatVide, Etiquette],
  templateUrl: './enfants.html',
  styleUrl: './pages.scss',
})
export class EnfantsParent {
  private readonly api = inject(ApiService);
  private readonly sync = inject(SyncService);
  protected readonly etiquetteStatut = etiquetteStatut;

  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly enfants = signal<Enfant[]>([]);

  constructor() {
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.sync.lire(
        'eleves',
        () => this.api.lire<{ enfants: Enfant[] }>('parent/enfants'),
        (rep) => rep.enfants ?? [],
      );
      this.enfants.set(((r.enfants ?? []) as unknown as Enfant[]) ?? []);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : enfants indisponibles.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }
}
