import { DatePipe } from '@angular/common';
import { Component, effect, inject, input, signal } from '@angular/core';
import { ApiService, toApiError } from '../../core/api.service';
import { SyncService } from '../../core/sync.service';
import { Etiquette } from '../../shared/ui';

export interface EntreeCalendrier {
  titre: string;
  kind: string;
  schoolClosed: boolean;
}

export interface JourMois {
  date: string;
  numero: number;
  /** Case vide avant le 1er jour du mois (grille lun→dim). */
  vide: boolean;
  scolaire: boolean;
  ferme: boolean;
  present: boolean;
  statut: string | null;
  evenements: EntreeCalendrier[];
  aujourdhui: boolean;
}

interface ReponseCalendrierMois {
  mois: string;
  regime: string;
  jours: {
    date: string;
    scolaire: boolean;
    ferme: boolean;
    evenements: EntreeCalendrier[];
    presence: string | null;
  }[];
  resume: { presents: number; absents: number; retards: number; departs: number };
}

const MOIS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];
const JOURS_SEMAINE = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

/**
 * Calendrier mensuel de présence (spec B2) : point vert sous les jours de
 * présence, repères pour fériés/événements, jours hors régime en grisé.
 * Les données viennent de l'API ; hors ligne, elles sont reconstruites à
 * partir du cache IndexedDB alimenté par la synchronisation.
 */
@Component({
  selector: 'app-calendrier-presence',
  imports: [DatePipe, Etiquette],
  templateUrl: './calendrier-presence.html',
  styleUrl: './pages.scss',
})
export class CalendrierPresence {
  private readonly api = inject(ApiService);
  private readonly sync = inject(SyncService);

  readonly enfantId = input.required<string>();

  protected readonly mois = signal(new Date());
  protected readonly chargement = signal(false);
  protected readonly erreur = signal('');
  protected readonly jourSelectionne = signal<JourMois | null>(null);
  protected readonly grille = signal<JourMois[]>([]);
  protected readonly resume = signal<{ presents: number; absents: number; retards: number; departs: number }>({
    presents: 0, absents: 0, retards: 0, departs: 0,
  });
  protected readonly regime = signal<string | null>(null);
  protected readonly horsLigne = signal(false);

  protected readonly joursSemaine = JOURS_SEMAINE;

  constructor() {
    effect(() => {
      // Rechargement à chaque changement d'enfant ou de mois affiché.
      this.enfantId();
      const m = this.mois();
      void this.charger(m);
    });
  }

  protected libelleMois(): string {
    const m = this.mois();
    return `${MOIS_FR[m.getMonth()]} ${m.getFullYear()}`;
  }

  protected moisPrecedent(): void {
    this.avancerMois(-1);
  }

  protected moisSuivant(): void {
    this.avancerMois(1);
  }

  private avancerMois(delta: number): void {
    const m = new Date(this.mois().getTime());
    m.setDate(1);
    m.setMonth(m.getMonth() + delta);
    this.mois.set(m);
    this.jourSelectionne.set(null);
  }

  /** Appui sur un jour : affiche le titre du férié/événement le cas échéant. */
  protected selectionner(j: JourMois): void {
    if (j.vide) return;
    this.jourSelectionne.set(this.jourSelectionne()?.date === j.date ? null : j);
  }

  protected libelleSelection(): string {
    const j = this.jourSelectionne();
    if (!j) return '';
    const titres = j.evenements.map((e) =>
      e.schoolClosed
        ? e.kind === 'ferie'
          ? `Jour férié : ${e.titre}`
          : `École fermée : ${e.titre}`
        : e.titre,
    );
    if (titres.length) return titres.join(' · ');
    if (!j.scolaire) return 'Jour non scolaire — pas d’appel';
    if (j.present) return 'Présent';
    return 'Aucune présence enregistrée ce jour.';
  }

  protected varianteSelection(): 'neutre' | 'succes' | 'attention' | 'danger' | 'info' {
    const j = this.jourSelectionne();
    if (!j) return 'neutre';
    if (j.evenements.some((e) => e.schoolClosed)) {
      return j.evenements.some((e) => e.kind === 'ferie') ? 'danger' : 'attention';
    }
    if (j.present) return 'succes';
    if (!j.scolaire) return 'neutre';
    return 'info';
  }

  /* ---------------------------------------------------------------- */
  /*  Chargement (API, secours hors ligne)                             */
  /* ---------------------------------------------------------------- */

  private async charger(date: Date): Promise<void> {
    const id = this.enfantId();
    if (!id) return;
    const mois = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.api.lire<ReponseCalendrierMois>(
        `parent/enfants/${id}/calendrier-mois`,
        { mois },
      );
      this.horsLigne.set(false);
      this.appliquer(r);
    } catch (err) {
      const e = toApiError(err);
      if (e.horsLigne) {
        const secours = await this.construireDepuisCache(id, mois);
        if (secours) {
          this.horsLigne.set(true);
          this.appliquer(secours);
        } else {
          this.erreur.set('Hors ligne : calendrier non encore synchronisé.');
        }
      } else {
        this.erreur.set(e.message);
      }
    } finally {
      this.chargement.set(false);
    }
  }

  private appliquer(r: ReponseCalendrierMois): void {
    this.regime.set(r.regime);
    this.resume.set(r.resume ?? { presents: 0, absents: 0, retards: 0, departs: 0 });
    this.grille.set(this.construireGrille(r));
  }

  /** Grille lun→dim complète : cases vides de tète + jours du mois. */
  private construireGrille(r: ReponseCalendrierMois): JourMois[] {
    const [annee, moisNum] = r.mois.split('-').map(Number);
    const premier = new Date(annee, moisNum - 1, 1);
    const decalage = (premier.getDay() + 6) % 7; // lundi = 0
    const totalJours = new Date(annee, moisNum, 0).getDate();
    const aujourdhui = new Date().toISOString().slice(0, 10);

    const parDate = new Map(r.jours.map((j) => [j.date, j]));
    const cases: JourMois[] = [];
    for (let i = 0; i < decalage; i++) {
      cases.push({
        date: `vide-${i}`, numero: 0, vide: true, scolaire: false, ferme: false,
        present: false, statut: null, evenements: [], aujourdhui: false,
      });
    }
    for (let d = 1; d <= totalJours; d++) {
      const iso = `${r.mois}-${String(d).padStart(2, '0')}`;
      const jour = parDate.get(iso);
      const statut = jour?.presence ?? null;
      cases.push({
        date: iso,
        numero: d,
        vide: false,
        scolaire: jour?.scolaire ?? true,
        ferme: jour?.ferme ?? false,
        present: statut === 'present',
        statut,
        evenements: jour?.evenements ?? [],
        aujourdhui: iso === aujourdhui,
      });
    }
    return cases;
  }

  /**
   * Hors ligne : le calendrier est reconstruit à partir des présences et
   * événements tirés par la synchronisation (IndexedDB).
   */
  private async construireDepuisCache(
    enfantId: string,
    mois: string,
  ): Promise<ReponseCalendrierMois | null> {
    const presences = await this.sync.depuisLeCache<{
      student_id: string;
      attendance_date: string;
      status: string;
    }>('presences');
    const ecoles = await this.sync.depuisLeCache<{ id: string; activity_days: string }>('ecoles');
    const evenements = await this.sync.depuisLeCache<{
      id: string;
      kind: string;
      title: string;
      starts_on: string;
      ends_on?: string | null;
      school_closed?: boolean;
      school_id?: string;
    }>('calendrier');

    const miennes = presences.filter(
      (p) => p.student_id === enfantId && String(p.attendance_date).slice(0, 7) === mois,
    );
    const parDate = new Map(
      miennes.map((p) => [String(p.attendance_date).slice(0, 10), p.status]),
    );

    const du = `${mois}-01`;
    const annee = Number(mois.slice(0, 4));
    const moisNum = Number(mois.slice(5, 7));
    const au = `${mois}-${String(new Date(annee, moisNum, 0).getDate()).padStart(2, '0')}`;

    const regime = ecoles[0]?.activity_days ?? 'lundi_vendredi';
    const dernierActif = regime === 'lundi_samedi' ? 6 : 5;

    const totalJours = new Date(annee, moisNum, 0).getDate();
    const jours: ReponseCalendrierMois['jours'] = [];
    const resume = { presents: 0, absents: 0, retards: 0, departs: 0 };

    for (let d = 1; d <= totalJours; d++) {
      const iso = `${mois}-${String(d).padStart(2, '0')}`;
      const isodow = (new Date(`${iso}T12:00:00Z`).getUTCDay() || 7);
      const scolaire = isodow <= dernierActif;
      const couvertes = evenements.filter(
        (e) => e.starts_on <= iso && (e.ends_on ?? e.starts_on) >= iso,
      );
      const ferme = !scolaire || couvertes.some((e) => e.school_closed === true);
      const presence = parDate.get(iso) ?? null;
      if (presence) {
        if (presence === 'present') resume.presents++;
        else if (presence === 'absent') resume.absents++;
        else if (presence === 'retard') resume.retards++;
        else if (presence === 'depart_anticipe') resume.departs++;
      }
      jours.push({
        date: iso,
        scolaire,
        ferme,
        presence,
        evenements: couvertes.map((e) => ({
          titre: e.title,
          kind: e.kind,
          schoolClosed: e.school_closed === true,
        })),
      });
    }

    return { mois, regime, jours, resume };
  }
}
