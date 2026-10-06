import { Component, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { ConfirmationService } from '../../core/confirmation.service';
import { Classe, Eleve } from '../../core/models';
import { SyncService } from '../../core/sync.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut, OverlayFormulaire } from '../../shared/ui';
import { NouvelEleve } from './eleves-nouveau';

interface ReponseEleves {
  eleves: Eleve[];
  total: number;
  limit: number;
  offset: number;
}

/** Liste des élèves de l'école (spec §5 — gestion des élèves). */
@Component({
  selector: 'app-eleves-ecole',
  imports: [FormsModule, RouterLink, Chargement, EtatVide, Etiquette, OverlayFormulaire, NouvelEleve],
  templateUrl: './eleves.html',
  styleUrl: './pages.scss',
})
export class ElevesEcole {
  private readonly api = inject(ApiService);
  private readonly sync = inject(SyncService);
  private readonly route = inject(ActivatedRoute);
  private readonly confirmation = inject(ConfirmationService);
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
  protected readonly nouveau = signal(false);

  protected readonly parPage = 50;

  @ViewChild(NouvelEleve) private formNouveau?: NouvelEleve;

  constructor() {
    // Liens « Inscrire » déjà positionnés sur /ecole/eleves/nouveau.
    if (this.route.snapshot.data['ouvrirNouveau']) this.nouveau.set(true);
    void this.chargerClasses();
    void this.charger();
  }

  /* ---------------------------------------------------------------- */
  /*  Overlay « Inscrire un élève »                                     */
  /* ---------------------------------------------------------------- */

  protected ouvrirNouveau(): void {
    this.nouveau.set(true);
  }

  protected fermerNouveau(): void {
    void this.fermerNouveauAsync();
  }

  protected onEleveEnregistre(): void {
    this.nouveau.set(false);
    void this.charger();
  }

  /** En-cours du formulaire embarqué (pied de l'overlay). */
  protected enCoursNouveau(): boolean {
    return this.formNouveau?.enCours() ?? false;
  }

  /** Déclenche l'enregistrement du formulaire embarqué (pied de l'overlay). */
  protected enregistrerNouveau(): void {
    void this.formNouveau?.enregistrer();
  }

  private async fermerNouveauAsync(): Promise<void> {
    if (this.formNouveau?.modifie()) {
      const choix = await this.confirmation.demander({
        message: "L'élève n'a pas encore été inscrit.",
        texteEnregistrer: "Inscrire l'élève",
        texteAbandonner: 'Abandonner',
      });
      if (choix === 'reprendre') return;
      if (choix === 'enregistrer') {
        await this.formNouveau.enregistrer();
        // En cas d'échec de validation le formulaire reste ouvert.
        if (this.nouveau()) return;
        return;
      }
    }
    this.nouveau.set(false);
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
