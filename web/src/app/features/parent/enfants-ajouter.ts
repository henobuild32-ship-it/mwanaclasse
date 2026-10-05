import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';

const RELATIONS = [
  'pere', 'mere', 'tuteur', 'oncle', 'tante', 'grand_parent', 'frere', 'soeur', 'parent', 'autre',
];

/** Ajout d'un enfant par codes école + enfant (spec §6). */
@Component({
  selector: 'app-ajouter-enfant',
  imports: [FormsModule, RouterLink],
  templateUrl: './enfants-ajouter.html',
  styleUrl: './pages.scss',
})
export class AjouterEnfant {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly relations = RELATIONS;

  protected readonly enCours = signal(false);
  protected readonly erreur = signal('');

  codeEcole = '';
  codeEnfant = '';
  relation = 'parent';

  protected async ajouter(): Promise<void> {
    this.erreur.set('');
    if (this.codeEcole.trim().length < 6 || this.codeEnfant.trim().length < 6) {
      this.erreur.set('Le code école et le code enfant doivent contenir au moins 6 caractères.');
      return;
    }
    this.enCours.set(true);
    try {
      const r = await this.api.envoyer<{ message?: string }>('parent/enfants', {
        codeEcole: this.codeEcole.trim(),
        codeEnfant: this.codeEnfant.trim(),
        relation: this.relation,
      });
      this.toasts.succes(r?.message ?? 'Demande d\'ajout envoyée.');
      void this.router.navigate(['/parent/enfants']);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : action impossible pour le moment.' : e.message);
    } finally {
      this.enCours.set(false);
    }
  }
}
