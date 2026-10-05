import { Component, inject, signal } from '@angular/core';
import { SlicePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { Liaison } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';

type Filtre = 'en_attente' | 'actif' | 'rejete' | 'tous';

/** Demandes de liaison parent ⇄ élève (spec §5). */
@Component({
  selector: 'app-liaisons-ecole',
  imports: [SlicePipe, FormsModule, Chargement, EtatVide, Etiquette],
  templateUrl: './liaisons.html',
  styleUrl: './pages.scss',
})
export class LiaisonsEcole {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  protected readonly etiquetteStatut = etiquetteStatut;

  protected readonly filtres: Filtre[] = ['en_attente', 'actif', 'rejete', 'tous'];
  protected readonly filtre = signal<Filtre>('en_attente');
  protected readonly liaisons = signal<Liaison[]>([]);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly enCoursId = signal('');
  protected noteOuverte = '';
  protected note = '';

  constructor() {
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const statut = this.filtre() === 'tous' ? undefined : this.filtre();
      const r = await this.api.lire<{ liaisons: Liaison[] }>('ecole/liaisons', {
        statut,
        limit: 200,
      });
      this.liaisons.set(r.liaisons ?? []);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : liaisons indisponibles.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected changerFiltre(f: Filtre): void {
    this.filtre.set(f);
    void this.charger();
  }

  protected basculerNote(id: string): void {
    this.noteOuverte = this.noteOuverte === id ? '' : id;
    this.note = '';
  }

  protected async decider(id: string, decision: 'approuver' | 'refuser'): Promise<void> {
    this.enCoursId.set(id);
    try {
      await this.api.envoyer(`ecole/liaisons/${id}/decision`, {
        decision,
        note: this.note.trim() || undefined,
      });
      this.toasts.succes(decision === 'approuver' ? 'Liaison approuvée.' : 'Liaison refusée.');
      this.noteOuverte = '';
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCoursId.set('');
    }
  }
}
