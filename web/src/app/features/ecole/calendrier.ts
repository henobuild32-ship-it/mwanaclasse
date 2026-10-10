import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { ConfirmationService } from '../../core/confirmation.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut, OverlayFormulaire } from '../../shared/ui';

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
  audience_kind?: string;
  is_published?: boolean;
  school_closed?: boolean;
  created_by_name?: string | null;
}

const TYPES = [
  'rentree', 'cours', 'conge', 'vacances', 'examen', 'reunion',
  'evenement', 'journee_speciale', 'ferie', 'autre',
];

const LIBELLES_TYPES: Record<string, string> = {
  rentree: 'Rentrée',
  cours: 'Cours',
  conge: 'Congé',
  vacances: 'Vacances',
  examen: 'Examen',
  reunion: 'Réunion',
  evenement: 'Événement',
  journee_speciale: 'Journée spéciale',
  ferie: 'Jour férié',
  autre: 'Autre',
};

/** Types qui ferment l'école par défaut (appel désactivé). */
const FERMENT_ECOLE = ['ferie', 'conge', 'vacances'];

/** Calendrier scolaire de l'école (fériés, événements, fermetures). */
@Component({
  selector: 'app-calendrier-ecole',
  imports: [SlicePipe, FormsModule, Chargement, EtatVide, Etiquette, OverlayFormulaire],
  templateUrl: './calendrier.html',
  styleUrl: './pages.scss',
})
export class CalendrierEcole {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  protected readonly confirmation = inject(ConfirmationService);
  protected readonly etiquetteStatut = etiquetteStatut;
  protected readonly types = TYPES;
  protected readonly libelleType = (t: string | undefined) => LIBELLES_TYPES[t ?? ''] ?? t ?? '—';

  protected readonly evenements = signal<Evenement[]>([]);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly formulaire = signal(false);
  protected readonly enCours = signal(false);
  protected readonly preRemplissage = signal(false);
  /** Identifiant de l'entrée en cours de modification (null = création). */
  protected readonly editionId = signal<string | null>(null);

  titre = '';
  description = '';
  type = 'cours';
  debut = '';
  fin = '';
  heureDebut = '';
  heureFin = '';
  toutLaJournee = true;
  lieu = '';
  audience = 'toute_ecole';
  /** École fermée sur cette entrée : aucun appel, aucune absence comptée. */
  ecoleFermee = false;

  /** Saisie relevée à l'ouverture, pour détecter une fermeture avec modifications. */
  private depart = '';

  constructor() {
    void this.charger();
  }

  protected get editionEnCours(): boolean {
    return this.editionId() !== null;
  }

  protected ouvrirFormulaire(): void {
    if (this.formulaire()) {
      void this.fermerFormulaire();
      return;
    }
    this.editionId.set(null);
    this.titre = this.description = this.lieu = '';
    this.debut = this.fin = '';
    this.heureDebut = this.heureFin = '';
    this.toutLaJournee = true;
    this.type = 'cours';
    this.audience = 'toute_ecole';
    this.ecoleFermee = false;
    this.depart = this.etat();
    this.formulaire.set(true);
  }

  protected ouvrirEdition(e: Evenement): void {
    this.editionId.set(e.id);
    this.titre = e.title;
    this.description = e.description ?? '';
    this.type = e.kind ?? 'autre';
    this.debut = e.starts_on;
    this.fin = e.ends_on ?? '';
    this.heureDebut = e.start_time?.slice(0, 5) ?? '';
    this.heureFin = e.end_time?.slice(0, 5) ?? '';
    this.toutLaJournee = e.all_day ?? true;
    this.lieu = e.location ?? '';
    this.audience = e.audience_kind ?? 'toute_ecole';
    this.ecoleFermee = e.school_closed ?? FERMENT_ECOLE.includes(this.type);
    this.depart = this.etat();
    this.formulaire.set(true);
  }

  /** Change le type : les fériés/congés/vacances ferment l'école par défaut. */
  protected changerType(valeur: string): void {
    this.type = valeur;
    if (FERMENT_ECOLE.includes(valeur)) this.ecoleFermee = true;
  }

  protected fermerFormulaire(): void {
    void this.fermerFormulaireAsync();
  }

  private async fermerFormulaireAsync(): Promise<void> {
    if (this.etat() !== this.depart) {
      const choix = await this.confirmation.demander({
        message: this.editionEnCours
          ? "L'événement a été modifié mais pas encore enregistré."
          : "L'événement n'a pas encore été ajouté au calendrier.",
      });
      if (choix === 'reprendre') return;
      if (choix === 'enregistrer') {
        await this.enregistrer();
        return;
      }
    }
    this.formulaire.set(false);
  }

  private etat(): string {
    return JSON.stringify([
      this.titre,
      this.description,
      this.type,
      this.debut,
      this.fin,
      this.heureDebut,
      this.heureFin,
      this.toutLaJournee,
      this.lieu,
      this.audience,
      this.ecoleFermee,
    ]);
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.api.lire<{ evenements: Evenement[] }>('ecole/calendrier');
      this.evenements.set(r.evenements ?? []);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : calendrier indisponible.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected async enregistrer(): Promise<void> {
    if (!this.titre.trim() || !this.debut) {
      this.toasts.erreur('Titre et date de début sont obligatoires.');
      return;
    }
    this.enCours.set(true);
    const corps = {
      title: this.titre.trim(),
      description: this.description.trim() || null,
      kind: this.type,
      startsOn: this.debut,
      endsOn: this.fin || null,
      startTime: this.toutLaJournee ? null : this.heureDebut || null,
      endTime: this.toutLaJournee ? null : this.heureFin || null,
      allDay: this.toutLaJournee,
      location: this.lieu.trim() || null,
      audienceKind: this.audience,
      audienceFilter: {},
      schoolClosed: this.ecoleFermee,
    };
    try {
      if (this.editionEnCours) {
        await this.api.modifier(`ecole/calendrier/${this.editionId()}`, corps);
        this.toasts.succes('Événement mis à jour.');
      } else {
        await this.api.envoyer('ecole/calendrier', corps);
        this.toasts.succes('Événement ajouté au calendrier.');
      }
      this.formulaire.set(false);
      this.editionId.set(null);
      this.titre = this.description = this.lieu = '';
      this.debut = this.fin = '';
      this.depart = this.etat();
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }

  protected async supprimer(e: Evenement): Promise<void> {
    const choix = await this.confirmation.demander({
      titre: 'Supprimer du calendrier',
      message: `« ${e.title} » sera retiré du calendrier de l'école.`,
      texteAbandonner: 'Annuler',
      texteEnregistrer: 'Supprimer',
    });
    if (choix !== 'enregistrer') return;
    try {
      await this.api.supprimer(`ecole/calendrier/${e.id}`);
      this.toasts.succes(`« ${e.title} » supprimé du calendrier.`);
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    }
  }

  /** Pré-remplit les jours fériés officiels de la RDC (année suivante). */
  protected async preRemplirRdc(): Promise<void> {
    this.preRemplissage.set(true);
    try {
      const r = await this.api.envoyer<{ message: string }>('ecole/calendrier/feries-rdc', {});
      this.toasts.succes(r.message);
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.preRemplissage.set(false);
    }
  }
}
