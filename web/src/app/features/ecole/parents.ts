import { Component, inject, signal } from '@angular/core';
import { SlicePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { ParentEcole } from '../../core/models';
import { Chargement, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';

/** Comptes parents de l'école (spec §5). */
@Component({
  selector: 'app-parents-ecole',
  imports: [FormsModule, SlicePipe, RouterLink, Chargement, EtatVide, Etiquette],
  templateUrl: './parents.html',
  styleUrl: './pages.scss',
})
export class ParentsEcole {
  private readonly api = inject(ApiService);
  protected readonly etiquetteStatut = etiquetteStatut;

  protected readonly recherche = signal('');
  protected readonly parents = signal<ParentEcole[]>([]);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');

  constructor() {
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.api.lire<{ parents: ParentEcole[] }>('ecole/parents', {
        recherche: this.recherche().trim() || undefined,
      });
      this.parents.set(r.parents ?? []);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : parents indisponibles.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected initiales(nom: string): string {
    return (nom ?? '')
      .split(/\s+/)
      .slice(0, 2)
      .map((m) => m[0]?.toUpperCase() ?? '')
      .join('');
  }
}
