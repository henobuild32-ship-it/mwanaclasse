import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { ApiService, toApiError } from '../../core/api.service';
import { Chargement, EtatVide, Etiquette } from '../../shared/ui';

interface Evenement {
  id: string;
  kind?: string;
  title: string;
  description?: string | null;
  starts_on: string;
  ends_on?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  all_day?: boolean;
  location?: string | null;
  ecole?: string | null;
  portee?: string | null;
  enfants_concernes?: string[] | null;
}

interface DonneesCalendrier {
  cetteSemaine: Evenement[];
  aVenir: Evenement[];
  tous: Evenement[];
}

/** Calendrier scolaire vu par le parent (spec §6). */
@Component({
  selector: 'app-calendrier-parent',
  imports: [SlicePipe, Chargement, EtatVide, Etiquette],
  templateUrl: './calendrier.html',
  styleUrl: './pages.scss',
})
export class CalendrierParent {
  private readonly api = inject(ApiService);

  protected readonly donnees = signal<DonneesCalendrier | null>(null);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');

  constructor() {
    void this.charger();
  }

  protected evenements(): Evenement[] {
    const d = this.donnees();
    return d?.aVenir?.length ? d.aVenir : (d?.tous ?? []);
  }

  protected semaine(): Evenement[] {
    return this.donnees()?.cetteSemaine ?? [];
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      this.donnees.set(await this.api.lire<DonneesCalendrier>('parent/calendrier'));
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : calendrier indisponible.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }
}
