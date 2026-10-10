import { SlicePipe } from '@angular/common';
import { Component, effect, inject, signal } from '@angular/core';
import { ApiService, toApiError } from '../../core/api.service';
import { EnfantActifService } from '../../core/enfant-actif.service';
import { SyncService } from '../../core/sync.service';
import { EtatVide, Etiquette, Squelette } from '../../shared/ui';

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
  school_closed?: boolean;
  ecole?: string | null;
  school_id?: string | null;
  portee?: string | null;
  enfants_concernes?: string[] | null;
}

interface RegimeEcole {
  school_id: string;
  ecole?: string | null;
  activity_days: string;
}

interface DonneesCalendrier {
  cetteSemaine: Evenement[];
  aVenir: Evenement[];
  tous: Evenement[];
  regimes?: RegimeEcole[];
}

/** Calendrier scolaire vu par le parent (spec §6). */
@Component({
  selector: 'app-calendrier-parent',
  imports: [SlicePipe, EtatVide, Etiquette, Squelette],
  templateUrl: './calendrier.html',
  styleUrl: './pages.scss',
})
export class CalendrierParent {
  private readonly api = inject(ApiService);
  private readonly sync = inject(SyncService);
  protected readonly selection = inject(EnfantActifService);

  protected readonly donnees = signal<DonneesCalendrier | null>(null);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');

  private premier = true;

  constructor() {
    // Changer d'enfant change d'école : on recharge le calendrier.
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

  protected evenements(): Evenement[] {
    const d = this.donnees();
    return d?.aVenir?.length ? d.aVenir : (d?.tous ?? []);
  }

  protected semaine(): Evenement[] {
    return this.donnees()?.cetteSemaine ?? [];
  }

  /** « Lundi → Vendredi » / « Lundi → Samedi », par école. */
  protected libelleRegime(regime?: RegimeEcole): string {
    if (!regime) return '';
    return regime.activity_days === 'lundi_samedi'
      ? 'Jours d’activité : lundi → samedi'
      : 'Jours d’activité : lundi → vendredi';
  }

  protected regimes(): RegimeEcole[] {
    return this.donnees()?.regimes ?? [];
  }

  protected libelleEvenement(e: Evenement): string {
    if (e.school_closed) return e.kind === 'ferie' ? 'Jour férié' : 'École fermée';
    return e.kind ?? '—';
  }

  protected varianteEvenement(e: Evenement): 'neutre' | 'attention' | 'danger' {
    if (!e.school_closed) return 'neutre';
    return e.kind === 'ferie' ? 'danger' : 'attention';
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      await this.selection.charger();
      const ecoleId = this.selection.ecoleId();
      const cle = `parent.calendrier:${ecoleId ?? 'toutes'}`;
      await this.sync.lireDabord<DonneesCalendrier & { calendrier?: Evenement[] }>(
        cle,
        () => this.api.lire<DonneesCalendrier>('parent/calendrier', this.selection.params),
        (reponse) => {
          const lignes = reponse.tous ?? reponse.calendrier ?? [];
          let regimes: RegimeEcole[] = reponse.regimes ?? [];
          if (!regimes.length) {
            void this.sync.depuisLeCache<{
              id: string;
              official_name?: string;
              activity_days: string;
            }>('ecoles').then((enCache) => {
              const r = enCache.map((x) => ({
                school_id: x.id,
                ecole: x.official_name,
                activity_days: x.activity_days,
              }));
              if (r.length) {
                this.donnees.set({
                  cetteSemaine: reponse.cetteSemaine ?? [],
                  aVenir: reponse.aVenir ?? [],
                  tous: lignes,
                  regimes: r,
                });
              }
            });
          }
          this.donnees.set({
            cetteSemaine: reponse.cetteSemaine ?? [],
            aVenir: reponse.aVenir ?? [],
            tous: lignes,
            regimes,
          });
        },
        { entite: 'calendrier', extraire: (d) => d.tous ?? [] },
      );
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne || (err as Error)?.message === 'HORS_LIGNE' ? 'Hors ligne : calendrier indisponible.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }
}
