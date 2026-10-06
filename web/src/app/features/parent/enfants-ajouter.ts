import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';

const RELATIONS = [
  'pere', 'mere', 'tuteur', 'oncle', 'tante', 'grand_parent', 'frere', 'soeur', 'parent', 'autre',
];

/**
 * Formulaire « Ajouter un enfant » par son code unique (spec §6).
 *
 * Rendu à l'intérieur d'un `<app-overlay>` ouvert depuis la liste des enfants :
 * il ne possède ni en-tête de page, ni boutons d'action.
 */
@Component({
  selector: 'app-ajouter-enfant',
  imports: [FormsModule],
  templateUrl: './enfants-ajouter.html',
  styleUrl: './pages.scss',
})
export class AjouterEnfant {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  protected readonly relations = RELATIONS;

  /** Enfant rattaché : la liste parente referme l'overlay et recharge. */
  readonly enregistre = output<void>();

  readonly enCours = signal(false);
  protected readonly erreur = signal('');

  codeEnfant = '';
  relation = 'parent';

  /** Saisie relevée à l'ouverture, pour détecter une fermeture avec modifications. */
  private depart = '';

  constructor() {
    this.depart = this.etat();
  }

  /** Vrai si le parent a commencé à remplir le formulaire. */
  modifie(): boolean {
    return this.etat() !== this.depart;
  }

  private etat(): string {
    return JSON.stringify([this.codeEnfant, this.relation]);
  }

  /** Validation + enregistrement (appelée par le pied de l'overlay). */
  async ajouter(): Promise<void> {
    this.erreur.set('');
    if (this.codeEnfant.trim().length < 6) {
      this.erreur.set('Le code enfant doit contenir au moins 6 caractères.');
      return;
    }
    if (this.enCours()) return;
    this.enCours.set(true);
    try {
      const r = await this.api.envoyer<{ message?: string }>('parent/enfants', {
        codeEnfant: this.codeEnfant.trim(),
        relation: this.relation,
      });
      this.toasts.succes(r?.message ?? "Demande d'ajout envoyée.");
      this.enregistre.emit();
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : action impossible pour le moment.' : e.message);
    } finally {
      this.enCours.set(false);
    }
  }
}
