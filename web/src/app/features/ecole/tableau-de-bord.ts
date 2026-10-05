import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { TableauBordEcole as TableauBordEcoleDTO } from '../../core/models';
import { SessionService } from '../../core/session.service';
import {
  CarteStat,
  Chargement,
  EtatVide,
  Etiquette,
  etiquetteStatut,
} from '../../shared/ui';

/** Tableau de bord de l'espace école (spec §5). */
@Component({
  selector: 'app-tableau-bord-ecole',
  imports: [RouterLink, CarteStat, Chargement, EtatVide],
  templateUrl: './tableau-de-bord.html',
  styleUrl: './pages.scss',
})
export class PageTableauBordEcole {
  private readonly api = inject(ApiService);
  protected readonly session = inject(SessionService);
  protected readonly etiquetteStatut = etiquetteStatut;

  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly donnees = signal<TableauBordEcoleDTO | null>(null);

  constructor() {
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      this.donnees.set(await this.api.lire<TableauBordEcoleDTO>('ecole/tableau-de-bord'));
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(
        e.horsLigne
          ? 'Vous êtes hors ligne : le tableau de bord sera disponible au retour de la connexion.'
          : e.message,
      );
    } finally {
      this.chargement.set(false);
    }
  }
}
