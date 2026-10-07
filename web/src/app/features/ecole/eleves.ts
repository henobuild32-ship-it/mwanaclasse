import { Component, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { ConfirmationService } from '../../core/confirmation.service';
import { Classe, Eleve, Section } from '../../core/models';
import { ConnectiviteService } from '../../core/connectivite.service';
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
  styleUrl: './eleves.scss',
})
export class ElevesEcole {
  private readonly api = inject(ApiService);
  private readonly sync = inject(SyncService);
  private readonly connectivite = inject(ConnectiviteService);
  private readonly route = inject(ActivatedRoute);
  private readonly confirmation = inject(ConfirmationService);
  protected readonly etiquetteStatut = etiquetteStatut;

  protected readonly recherche = signal('');
  protected readonly statut = signal<'actif' | 'archive' | 'tous'>('actif');
  protected readonly classeId = signal('');
  protected readonly sectionId = signal('');
  protected readonly filtresOuverts = signal(false);
  protected readonly rechercheEnCours = signal(false);
  protected readonly classes = signal<Classe[]>([]);
  protected readonly eleves = signal<Eleve[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(0);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly nouveau = signal(false);

  protected readonly parPage = 50;

  protected readonly sectionsDisponibles = computed(() => {
    const classes = this.classes().filter((classe) => !this.classeId() || classe.id === this.classeId());
    const sections = classes.flatMap((classe) => classe.sections_detail ?? classe.sections ?? []);
    return [...new Map(sections.map((section) => [section.id, section])).values()];
  });

  protected readonly filtresActifs = computed(() => [
    this.recherche().trim(),
    this.statut() !== 'actif',
    this.classeId(),
    this.sectionId(),
  ].filter(Boolean).length);

  protected readonly debutResultats = computed(() => this.total() === 0 ? 0 : this.page() * this.parPage + 1);
  protected readonly finResultats = computed(() => Math.min((this.page() + 1) * this.parPage, this.total()));

  private minuterieRecherche: ReturnType<typeof setTimeout> | null = null;
  private numeroRequete = 0;

  @ViewChild(NouvelEleve) private formNouveau?: NouvelEleve;

  constructor() {
    // Liens « Inscrire » déjà positionnés sur /ecole/eleves/nouveau.
    if (this.route.snapshot.data['ouvrirNouveau']) this.nouveau.set(true);
    void this.chargerClasses();
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
      let classes: Classe[];
      if (this.connectivite.enLigne()) {
        const r = await this.api.lire<{ classes: Classe[] }>('ecole/classes');
        classes = r.classes ?? [];
        await this.sync.mettreEnCache('classes', classes);
      } else {
        classes = await this.sync.depuisLeCache<Classe>('classes');
      }
      this.classes.set(classes);
    } catch {
      this.classes.set(await this.sync.depuisLeCache<Classe>('classes'));
    }
    await this.charger();
  }

  protected async charger(silencieux = false): Promise<void> {
    const requete = ++this.numeroRequete;
    if (silencieux) this.rechercheEnCours.set(true);
    else this.chargement.set(true);
    this.erreur.set('');
    try {
      let r: ReponseEleves;
      if (this.connectivite.enLigne()) {
        r = await this.sync.lire(
          'eleves',
          () => this.api.lire<ReponseEleves>('ecole/eleves', {
            limit: this.parPage,
            offset: this.page() * this.parPage,
            statut: this.statut(),
            classeId: this.classeId() || undefined,
            sectionId: this.sectionId() || undefined,
            recherche: this.recherche().trim() || undefined,
          }),
          (rep) => rep.eleves ?? [],
        );
      } else {
        const toutes = await this.sync.depuisLeCache<Eleve>('eleves');
        const terme = this.recherche().trim().toLocaleLowerCase();
        const filtrees = toutes.filter((eleve) =>
          (this.statut() === 'tous' || eleve.status === this.statut()) &&
          (!this.classeId() || eleve.class_id === this.classeId()) &&
          (!this.sectionId() || eleve.section_id === this.sectionId()) &&
          (!terme || `${eleve.full_name} ${eleve.public_code}`.toLocaleLowerCase().includes(terme)),
        );
        r = {
          eleves: filtrees.slice(this.page() * this.parPage, (this.page() + 1) * this.parPage),
          total: filtrees.length,
          limit: this.parPage,
          offset: this.page() * this.parPage,
        };
      }
      if (requete !== this.numeroRequete) return;
      const eleves = (r.eleves ?? []) as unknown as Eleve[];
      this.eleves.set(eleves);
      this.total.set(r.total ?? eleves.length);
    } catch (err) {
      if (requete !== this.numeroRequete) return;
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : liste indisponible.' : e.message);
      this.eleves.set([]);
    } finally {
      if (requete === this.numeroRequete) {
        this.chargement.set(false);
        this.rechercheEnCours.set(false);
      }
    }
  }

  protected changerRecherche(valeur: string): void {
    this.recherche.set(valeur);
    this.page.set(0);
    this.rechercheEnCours.set(true);
    if (this.minuterieRecherche) clearTimeout(this.minuterieRecherche);
    this.minuterieRecherche = setTimeout(() => {
      this.minuterieRecherche = null;
      void this.charger(true);
    }, 280);
  }

  protected viderRecherche(): void {
    this.changerRecherche('');
  }

  protected changerStatut(valeur: 'actif' | 'archive' | 'tous'): void {
    this.annulerRechercheDifferee();
    this.statut.set(valeur);
    this.page.set(0);
    void this.charger();
  }

  protected changerClasse(valeur: string): void {
    this.annulerRechercheDifferee();
    this.classeId.set(valeur);
    this.sectionId.set('');
    this.page.set(0);
    void this.charger();
  }

  protected changerSection(valeur: string): void {
    this.annulerRechercheDifferee();
    this.sectionId.set(valeur);
    this.page.set(0);
    void this.charger();
  }

  protected basculerFiltres(): void {
    this.filtresOuverts.update((ouvert) => !ouvert);
  }

  protected effacerFiltres(): void {
    this.annulerRechercheDifferee();
    this.recherche.set('');
    this.statut.set('actif');
    this.classeId.set('');
    this.sectionId.set('');
    this.page.set(0);
    void this.charger();
  }

  protected pageSuivante(): void {
    if ((this.page() + 1) * this.parPage >= this.total()) return;
    this.annulerRechercheDifferee();
    this.page.update((p) => p + 1);
    void this.charger();
  }

  protected pagePrecedente(): void {
    if (this.page() === 0) return;
    this.annulerRechercheDifferee();
    this.page.update((p) => p - 1);
    void this.charger();
  }

  protected nombrePages(): number {
    return Math.max(1, Math.ceil(this.total() / this.parPage));
  }

  protected libelleStatut(): string {
    return this.statut() === 'actif' ? 'Élèves actifs' : this.statut() === 'archive' ? 'Élèves archivés' : 'Tous les élèves';
  }

  protected nomClasseFiltree(): string {
    return this.classes().find((classe) => classe.id === this.classeId())?.name ?? '';
  }

  protected nomSectionFiltree(): string {
    return this.sectionsDisponibles().find((section) => section.id === this.sectionId())?.name ?? '';
  }

  protected initiales(nom: string): string {
    return (nom ?? '')
      .split(/\s+/)
      .slice(0, 2)
      .map((m) => m[0]?.toUpperCase() ?? '')
      .join('');
  }

  private annulerRechercheDifferee(): void {
    if (this.minuterieRecherche) clearTimeout(this.minuterieRecherche);
    this.minuterieRecherche = null;
    this.rechercheEnCours.set(false);
  }
}
