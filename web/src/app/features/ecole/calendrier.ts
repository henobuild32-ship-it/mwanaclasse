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
  created_by_name?: string | null;
}

const TYPES = [
  'rentree', 'cours', 'conge', 'vacances', 'examen', 'reunion',
  'evenement', 'journee_speciale', 'ferie', 'autre',
];

/** Calendrier scolaire de l'école. */
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

  protected readonly evenements = signal<Evenement[]>([]);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly formulaire = signal(false);
  protected readonly enCours = signal(false);

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

  /** Saisie relevée à l'ouverture, pour détecter une fermeture avec modifications. */
  private depart = '';

  constructor() {
    void this.charger();
  }

  protected ouvrirFormulaire(): void {
    if (this.formulaire()) {
      void this.fermerFormulaire();
      return;
    }
    this.depart = this.etat();
    this.formulaire.set(true);
  }

  protected fermerFormulaire(): void {
    void this.fermerFormulaireAsync();
  }

  private async fermerFormulaireAsync(): Promise<void> {
    if (this.etat() !== this.depart) {
      const choix = await this.confirmation.demander({
        message: "L'événement n'a pas encore été ajouté au calendrier.",
      });
      if (choix === 'reprendre') return;
      if (choix === 'enregistrer') {
        await this.creer();
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

  protected async creer(): Promise<void> {
    if (!this.titre.trim() || !this.debut) {
      this.toasts.erreur('Titre et date de début sont obligatoires.');
      return;
    }
    this.enCours.set(true);
    try {
      await this.api.envoyer('ecole/calendrier', {
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
      });
      this.toasts.succes('Événement ajouté au calendrier.');
      this.formulaire.set(false);
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
}
