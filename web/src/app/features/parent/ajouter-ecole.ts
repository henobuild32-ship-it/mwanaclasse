import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';

/** Rejoindre une école avec son code public (spec §6). */
@Component({
  selector: 'app-ajouter-ecole',
  imports: [FormsModule, RouterLink],
  templateUrl: './ajouter-ecole.html',
  styleUrl: './pages.scss',
})
export class AjouterEcole {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);

  protected readonly enCours = signal(false);
  protected readonly erreur = signal('');

  codeEcole = '';

  protected async rejoindre(): Promise<void> {
    this.erreur.set('');
    if (this.codeEcole.trim().length < 6) {
      this.erreur.set('Le code de l\'école doit contenir au moins 6 caractères.');
      return;
    }
    this.enCours.set(true);
    try {
      const r = await this.api.envoyer<{ message?: string }>('parent/ecoles', {
        codeEcole: this.codeEcole.trim(),
      });
      this.toasts.succes(r?.message ?? 'École rejointe.');
      void this.router.navigate(['/parent/tableau-de-bord']);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : action impossible pour le moment.' : e.message);
    } finally {
      this.enCours.set(false);
    }
  }
}
