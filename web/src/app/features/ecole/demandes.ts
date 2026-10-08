import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { dateHeureFr } from '../../core/format';
import { Demande } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';

type Filtre = 'tous' | 'en_attente' | 'en_cours' | 'repondu' | 'cloture';

interface DemandeEcole extends Demande {
  parent?: string | null;
  eleve?: string | null;
  classe?: string | null;
  messages_parent?: unknown[];
  messages_ecole?: unknown[];
  echanges?: { auteur: string; nom: string | null; message: string; date: string }[];
}

/** Priorité stockée en petit entier (1..4) — voir app.requests.priority. */
const LIBELLES_PRIORITE: Record<number, string> = { 1: 'faible', 2: 'normale', 3: 'haute', 4: 'urgente' };

/** Demandes des parents (traitement côté école, spec §5). */
@Component({
  selector: 'app-demandes-ecole',
  imports: [SlicePipe, FormsModule, Chargement, EtatVide, Etiquette],
  templateUrl: './demandes.html',
  styleUrl: './pages.scss',
})
export class DemandesEcole {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  protected readonly etiquetteStatut = etiquetteStatut;
  protected readonly dateHeureFr = dateHeureFr;

  protected readonly filtre = signal<Filtre>('tous');
  protected readonly filtres: Filtre[] = ['tous', 'en_attente', 'en_cours', 'repondu', 'cloture'];
  protected readonly demandes = signal<DemandeEcole[]>([]);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly enCours = signal(false);
  protected readonly idReponse = signal('');

  reponse = '';
  nouveauStatut: 'en_cours' | 'repondu' | 'cloture' | 'en_attente' = 'repondu';
  decision: 'acceptee' | 'refusee' | 'a_verifier' = 'acceptee';

  constructor() {
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const statut = this.filtre() === 'tous' ? undefined : this.filtre();
      const r = await this.api.lire<{ demandes: DemandeEcole[] }>('ecole/demandes', { statut, limit: 200 });
      this.demandes.set(r.demandes ?? []);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : demandes indisponibles.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected changerFiltre(f: Filtre): void {
    this.filtre.set(f);
    void this.charger();
  }

  protected basculer(id: string): void {
    this.idReponse.set(this.idReponse() === id ? '' : id);
    this.reponse = '';
    this.nouveauStatut = 'repondu';
  }

  protected priorite(d: DemandeEcole): number {
    return typeof d.priority === 'number' ? d.priority : 2;
  }

  protected libellePriorite(d: DemandeEcole): string {
    return LIBELLES_PRIORITE[this.priorite(d)] ?? 'normale';
  }

  protected echanges(d: DemandeEcole): { auteur: string; nom: string | null; message: string; date: string }[] {
    return Array.isArray(d.echanges) ? d.echanges : [];
  }

  protected async envoyerReponse(id: string): Promise<void> {
    if (!this.reponse.trim()) {
      this.toasts.erreur('La réponse ne peut pas être vide.');
      return;
    }
    this.enCours.set(true);
    try {
      await this.api.envoyer(`ecole/demandes/${id}/repondre`, {
        message: this.reponse.trim(),
        nouveauStatut: this.nouveauStatut,
        decisionJustification: this.decision,
      });
      this.toasts.succes('Réponse envoyée au parent.');
      this.idReponse.set('');
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }
}
