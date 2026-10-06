import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { ConfirmationService } from '../../core/confirmation.service';
import { SessionService } from '../../core/session.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut, OverlayFormulaire } from '../../shared/ui';

interface Communique {
  id: string;
  reference?: string | null;
  title: string;
  subject?: string | null;
  summary?: string | null;
  kind?: string;
  is_urgent?: boolean;
  status: string;
  audience_kind?: string;
  publish_at?: string | null;
  published_at?: string | null;
  created_by_name?: string | null;
  created_at?: string;
  destinataires?: number;
  lus?: number;
  non_lus?: number;
  attachment_name?: string | null;
}

type Filtre = 'tous' | 'brouillon' | 'programme' | 'publie';

const TYPES = [
  'communique', 'note_parents', 'rappel', 'annonce', 'invitation',
  'urgent', 'changement_horaire', 'reunion', 'calendrier', 'administratif',
];

/** Communiqués de l'école (spec §5). */
@Component({
  selector: 'app-communiques-ecole',
  imports: [SlicePipe, FormsModule, Chargement, EtatVide, Etiquette, OverlayFormulaire],
  templateUrl: './communiques.html',
  styleUrl: './pages.scss',
})
export class CommuniquesEcole {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  protected readonly confirmation = inject(ConfirmationService);
  /** Sections masquées pour un établissement maternelle/primaire seul. */
  protected readonly sectionsVisibles = inject(SessionService).sectionsVisibles;
  protected readonly etiquetteStatut = etiquetteStatut;
  protected readonly types = TYPES;

  protected readonly filtre = signal<Filtre>('tous');
  protected readonly filtres: Filtre[] = ['tous', 'brouillon', 'programme', 'publie'];
  protected readonly communiques = signal<Communique[]>([]);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly enCours = signal(false);
  protected readonly formulaire = signal(false);

  titre = '';
  objet = '';
  resume = '';
  corps = '';
  type = 'communique';
  urgent = false;
  audience = 'toute_ecole';
  action: 'brouillon' | 'publier' | 'programmer' = 'publier';
  dateProgrammation = '';

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
        message: 'Le communiqué n\'a pas encore été envoyé.',
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
      this.objet,
      this.resume,
      this.corps,
      this.type,
      this.urgent,
      this.audience,
      this.action,
      this.dateProgrammation,
    ]);
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const statut = this.filtre() === 'tous' ? undefined : this.filtre();
      const r = await this.api.lire<{ communiques: Communique[] }>('ecole/communiques', { statut });
      this.communiques.set(r.communiques ?? []);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : communiqués indisponibles.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected changerFiltre(f: Filtre): void {
    this.filtre.set(f);
    void this.charger();
  }

  protected async creer(): Promise<void> {
    if (!this.titre.trim() || !this.corps.trim()) {
      this.toasts.erreur('Titre et corps du message sont obligatoires.');
      return;
    }
    this.enCours.set(true);
    try {
      await this.api.envoyer('ecole/communiques', {
        title: this.titre.trim(),
        subject: this.objet.trim() || null,
        summary: this.resume.trim() || null,
        bodyHtml: this.corps.trim(),
        kind: this.type,
        isUrgent: this.urgent,
        audienceKind:
          this.audience === 'section' && !this.sectionsVisibles()
            ? 'toute_ecole'
            : this.audience,
        audienceFilter: {},
        action: this.action,
        publishAt:
          this.action === 'programmer' && this.dateProgrammation
            ? new Date(this.dateProgrammation).toISOString()
            : null,
      });
      this.toasts.succes(
        this.action === 'publier' ? 'Communiqué publié.' : this.action === 'programmer' ? 'Communiqué programmé.' : 'Brouillon enregistré.',
      );
      this.formulaire.set(false);
      this.titre = this.objet = this.resume = this.corps = '';
      this.urgent = false;
      this.depart = this.etat();
      await this.charger();
    } catch (err) {
      const e = toApiError(err);
      this.toasts.erreur(e.message);
    } finally {
      this.enCours.set(false);
    }
  }

  protected async publier(id: string): Promise<void> {
    this.enCours.set(true);
    try {
      await this.api.envoyer(`ecole/communiques/${id}/publier`, {});
      this.toasts.succes('Communiqué publié.');
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }
}
