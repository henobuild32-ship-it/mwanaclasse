import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { Classe, Eleve } from '../../core/models';
import { SyncService } from '../../core/sync.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';

interface ReponseEleves {
  eleves: Eleve[];
  total: number;
  limit: number;
  offset: number;
}

/** Liste des élèves de l'école (spec §5 — gestion des élèves). */
@Component({
  selector: 'app-eleves-ecole',
  imports: [FormsModule, RouterLink, Chargement, EtatVide, Etiquette],
  templateUrl: './eleves.html',
  styleUrl: './pages.scss',
})
export class ElevesEcole {
  private readonly api = inject(ApiService);
  private readonly sync = inject(SyncService);
  protected readonly etiquetteStatut = etiquetteStatut;

  protected readonly recherche = signal('');
  protected readonly statut = signal('actif');
  protected readonly classeId = signal('');
  protected readonly classes = signal<Classe[]>([]);
  protected readonly eleves = signal<Eleve[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(0);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');

  protected readonly parPage = 50;

  constructor() {
    void this.chargerClasses();
    void this.charger();
  }

  protected async chargerClasses(): Promise<void> {
    try {
      const r = await this.api.lire<{ classes: Classe[] }>('ecole/classes');
      this.classes.set(r.classes ?? []);
    } catch {
      /* filtre facultatif */
    }
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.sync.lire(
        'eleves',
        () =>
          this.api.lire<ReponseEleves>('ecole/eleves', {
            limit: this.parPage,
            offset: this.page() * this.parPage,
            statut: this.statut(),
            classeId: this.classeId() || undefined,
            recherche: this.recherche().trim() || undefined,
          }),
        (rep) => rep.eleves ?? [],
      );
      const eleves = (r.eleves ?? []) as unknown as Eleve[];
      this.eleves.set(eleves);
      this.total.set(r.total ?? eleves.length);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : liste indisponible.' : e.message);
      this.eleves.set([]);
    } finally {
      this.chargement.set(false);
    }
  }

  protected changerRecherche(valeur: string): void {
    this.recherche.set(valeur);
    this.page.set(0);
    void this.charger();
  }

  protected changerStatut(valeur: string): void {
    this.statut.set(valeur);
    this.page.set(0);
    void this.charger();
  }

  protected changerClasse(valeur: string): void {
    this.classeId.set(valeur);
    this.page.set(0);
    void this.charger();
  }

  protected pageSuivante(): void {
    if ((this.page() + 1) * this.parPage >= this.total()) return;
    this.page.update((p) => p + 1);
    void this.charger();
  }

  protected pagePrecedente(): void {
    if (this.page() === 0) return;
    this.page.update((p) => p - 1);
    void this.charger();
  }

  protected initiales(nom: string): string {
    return (nom ?? '')
      .split(/\s+/)
      .slice(0, 2)
      .map((m) => m[0]?.toUpperCase() ?? '')
      .join('');
  }
}
