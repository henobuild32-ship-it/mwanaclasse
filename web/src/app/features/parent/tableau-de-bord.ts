import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { Demande, Enfant, TableauBordParent as TableauBordParentDTO } from '../../core/models';
import { SessionService } from '../../core/session.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';

/** Tableau de bord du parent (spec §6). */
@Component({
  selector: 'app-tableau-bord-parent',
  imports: [RouterLink, Chargement, EtatVide, Etiquette],
  templateUrl: './tableau-de-bord.html',
  styleUrl: './pages.scss',
})
export class PageTableauBordParent {
  private readonly api = inject(ApiService);
  protected readonly session = inject(SessionService);
  protected readonly etiquetteStatut = etiquetteStatut;

  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly donnees = signal<TableauBordParentDTO | null>(null);

  constructor() {
    void this.charger();
  }

  protected enfants(): Enfant[] {
    return this.donnees()?.enfants ?? [];
  }

  protected calendrier(): { id: string; title: string; starts_on: string; location?: string | null; ecole?: string }[] {
    return (this.donnees()?.calendrier ?? []) as never;
  }

  protected demandes(): Demande[] {
    return this.donnees()?.demandes ?? [];
  }

  protected nonLues(): number {
    const n = this.donnees()?.notifications as { nonLues?: number } | undefined;
    return n?.nonLues ?? 0;
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      this.donnees.set(await this.api.lire<TableauBordParentDTO>('parent/tableau-de-bord'));
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(
        e.horsLigne
          ? 'Hors ligne et aucune donnée locale : réessayez au retour du réseau.'
          : e.message,
      );
    } finally {
      this.chargement.set(false);
    }
  }
}
