import { Component, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { EnfantActifService } from '../../core/enfant-actif.service';
import { dateFr, dateHeureFr } from '../../core/format';
import { Demande, Enfant, EvenementCalendrier, TableauBordParent as TableauBordParentDTO } from '../../core/models';
import { SessionService } from '../../core/session.service';
import { SyncService } from '../../core/sync.service';
import { EtatVide, Etiquette, etiquetteStatut, Squelette } from '../../shared/ui';
import { SuiviEnfant } from './suivi-enfant';

/** Tableau de bord du parent (spec §6). */
@Component({
  selector: 'app-tableau-bord-parent',
  imports: [RouterLink, EtatVide, Etiquette, SuiviEnfant, Squelette],
  templateUrl: './tableau-de-bord.html',
  styleUrl: './pages.scss',
})
export class PageTableauBordParent {
  private readonly api = inject(ApiService);
  private readonly sync = inject(SyncService);
  protected readonly session = inject(SessionService);
  protected readonly selection = inject(EnfantActifService);
  protected readonly etiquetteStatut = etiquetteStatut;
  protected readonly dateFr = dateFr;
  protected readonly dateHeureFr = dateHeureFr;

  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly donnees = signal<TableauBordParentDTO | null>(null);
  /** Enfant dont le suivi complet est ouvert en modal (spec B1). */
  protected readonly suiviOuvert = signal<string | null>(null);

  private premier = true;

  constructor() {
    // Changer d'enfant change d'école : on recharge le tableau de bord.
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

  protected enfants(): Enfant[] {
    return this.donnees()?.enfants ?? [];
  }

  protected calendrier(): EvenementCalendrier[] {
    return this.donnees()?.calendrier ?? [];
  }

  protected demandes(): Demande[] {
    return this.donnees()?.demandes ?? [];
  }

  protected nonLues(): number {
    const n = this.donnees()?.notifications as { nonLues?: number } | undefined;
    return n?.nonLues ?? 0;
  }

  /** Ouvre le suivi complet en modal par-dessus l'accueil (spec B1). */
  protected ouvrirSuivi(id: string): void {
    this.suiviOuvert.set(id);
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      // Attend la liste des enfants pour filtrer sur l'école active.
      await this.selection.charger();
      const ecoleId = this.selection.ecoleId();
      const cle = `parent.tableau-de-bord:${ecoleId ?? 'toutes'}`;
      await this.sync.lireDabord<TableauBordParentDTO>(
        cle,
        () => this.api.lire<TableauBordParentDTO>('parent/tableau-de-bord', this.selection.params),
        (d) => this.donnees.set(d),
      );
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(
        e.horsLigne || (err as Error)?.message === 'HORS_LIGNE'
          ? 'Hors ligne et aucune donnée locale : réessayez au retour du réseau.'
          : e.message,
      );
    } finally {
      this.chargement.set(false);
    }
  }
}
