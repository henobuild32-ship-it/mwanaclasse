import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { jsPDF } from 'jspdf';
import { ApiService, toApiError } from '../../core/api.service';
import { Classe, Eleve } from '../../core/models';
import { ConnectiviteService } from '../../core/connectivite.service';
import { QrService } from '../../core/qr.service';
import { SessionService } from '../../core/session.service';
import { SyncService } from '../../core/sync.service';
import { ToastService } from '../../core/toast.service';
import { CarteEleve } from '../../shared/carte-eleve';
import { Chargement, EtatVide } from '../../shared/ui';

interface ReponseEleves {
  eleves: Eleve[];
  total: number;
  limit: number;
  offset: number;
}

/* Géométrie A4 (mm) : 2 colonnes × 5 rangées, marges de 8 mm. */
const MARGE = 8;
const LARGEUR_CARTE = 85.6;
const HAUTEUR_CARTE = 54;
const ESPACE_X = 10;
const ESPACE_Y = 2.5;
const PAR_PAGE = 10;

/**
 * Module « Carte des élèves » (spec §5) : aperçu des cartes PVC, sélection,
 * impression A4 avec traits de coupe et export PDF — tout est calculé
 * **localement** à partir du code unique de l'élève, donc utilisable hors ligne.
 */
@Component({
  selector: 'app-cartes-eleves',
  imports: [FormsModule, CarteEleve, Chargement, EtatVide],
  templateUrl: './cartes.html',
  styleUrl: './cartes.scss',
})
export class CartesEleves {
  private readonly api = inject(ApiService);
  private readonly sync = inject(SyncService);
  private readonly connectivite = inject(ConnectiviteService);
  private readonly qr = inject(QrService);
  private readonly toasts = inject(ToastService);
  protected readonly session = inject(SessionService);

  protected readonly classes = signal<Classe[]>([]);
  protected readonly classeId = signal('');
  protected readonly recherche = signal('');
  protected readonly catalogue = signal<Eleve[]>([]);
  protected readonly selection = signal<Record<string, boolean>>({});
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly pdfEnCours = signal(false);
  /** Carte à imprimer toute seule ; sinon c'est la sélection qui part. */
  private readonly carteSeule = signal<Eleve | null>(null);

  private minuterieRecherche: ReturnType<typeof setTimeout> | null = null;

  protected readonly nomEcole = (): string => this.session.ecole()?.nom ?? 'Établissement scolaire';

  /** Élèves visibles : classe choisie + recherche, triés par nom. */
  protected readonly affiches = computed<Eleve[]>(() => {
    const terme = this.recherche().trim().toLocaleLowerCase();
    const classeId = this.classeId();
    return this.catalogue()
      .filter(
        (e) =>
          (!classeId || e.class_id === classeId) &&
          (!terme || `${e.full_name} ${e.public_code}`.toLocaleLowerCase().includes(terme)),
      )
      .sort((a, b) => a.full_name.localeCompare(b.full_name, 'fr'));
  });

  /** Cartes cochées (une carte décochée reste affichée mais grisée). */
  protected readonly selectionnees = computed<Eleve[]>(() =>
    this.affiches().filter((e) => this.selection()[e.id] !== false),
  );

  protected readonly toutesSelectionnees = computed(
    () =>
      this.affiches().length > 0 &&
      this.affiches().every((e) => this.selection()[e.id] !== false),
  );

  /** Contenu de la zone d'impression : une carte isolée, sinon la sélection. */
  protected readonly cartesImprimees = computed<Eleve[]>(() => {
    const seule = this.carteSeule();
    return seule ? [seule] : this.selectionnees();
  });

  constructor() {
    void this.chargerClasses();
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
      if (!this.classeId() && classes.length) this.classeId.set(classes[0].id);
    } catch {
      this.classes.set(await this.sync.depuisLeCache<Classe>('classes'));
    }
    await this.chargerCatalogue();
  }

  /**
   * Catalogue complet des élèves actifs (pages de 200) : les cartes doivent
   * pouvoir être imprimées hors ligne après une seule visite de la page.
   */
  private async chargerCatalogue(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      let eleves: Eleve[] = [];
      if (this.connectivite.enLigne()) {
        let offset = 0;
        let total = Number.MAX_SAFE_INTEGER;
        while (offset < total && offset < 1000) {
          const r = await this.api.lire<ReponseEleves>('ecole/eleves', {
            limit: 200,
            offset,
            statut: 'actif',
          });
          const lot = (r.eleves ?? []) as unknown as Eleve[];
          eleves = [...eleves, ...lot];
          total = r.total ?? eleves.length;
          offset += r.limit || 200;
          if (!lot.length) break;
        }
        await this.sync.mettreEnCache('eleves', eleves);
      } else {
        eleves = await this.sync.depuisLeCache<Eleve>('eleves');
      }
      this.catalogue.set(eleves.filter((e) => !e.status || e.status === 'actif'));
      this.selection.set({});
    } catch (err) {
      const e = toApiError(err);
      const cache = await this.sync.depuisLeCache<Eleve>('eleves');
      if (cache.length) {
        this.catalogue.set(cache.filter((eleve) => !eleve.status || eleve.status === 'actif'));
        this.selection.set({});
      } else {
        this.erreur.set(
          e.horsLigne ? 'Hors ligne : aucune carte disponible sur cet appareil.' : e.message,
        );
      }
    } finally {
      this.chargement.set(false);
    }
  }

  protected changerClasse(valeur: string): void {
    this.classeId.set(valeur);
    this.selection.set({});
  }

  protected changerRecherche(valeur: string): void {
    this.recherche.set(valeur);
    if (this.minuterieRecherche) clearTimeout(this.minuterieRecherche);
    this.minuterieRecherche = setTimeout(() => {
      this.minuterieRecherche = null;
    }, 250);
  }

  protected estSelectionne(id: string): boolean {
    return this.selection()[id] !== false;
  }

  protected basculer(id: string, coche: boolean): void {
    this.selection.update((etat) => ({ ...etat, [id]: coche }));
  }

  protected toutSelectionner(coche: boolean): void {
    this.selection.update((etat) => {
      const suivant = { ...etat };
      for (const eleve of this.affiches()) suivant[eleve.id] = coche;
      return suivant;
    });
  }

  protected libelleClasse(eleve: Eleve): string {
    return [eleve.classe, eleve.section].filter(Boolean).join(' · ');
  }

  /* ---------------------------------------------------------------- */
  /*  Impression                                                       */
  /* ---------------------------------------------------------------- */

  protected imprimer(): void {
    const cartes = this.cartesImprimees();
    if (!cartes.length) {
      this.toasts.info('Sélectionnez au moins une carte à imprimer.');
      return;
    }
    document.body.classList.add('impression-cartes');
    let rendu = false;
    const restaurer = (): void => {
      if (rendu) return;
      rendu = true;
      document.body.classList.remove('impression-cartes');
      this.carteSeule.set(null);
      window.removeEventListener('afterprint', restaurer);
    };
    window.addEventListener('afterprint', restaurer);
    window.print();
    // Repli pour les navigateurs qui n'émettent pas `afterprint`.
    setTimeout(restaurer, 5000);
  }

  protected imprimerCarteSeule(eleve: Eleve): void {
    this.carteSeule.set(eleve);
    this.imprimer();
  }

  /* ---------------------------------------------------------------- */
  /*  Export PDF                                                       */
  /* ---------------------------------------------------------------- */

  protected async exporterPdf(): Promise<void> {
    const cartes = this.cartesImprimees();
    if (!cartes.length) {
      this.toasts.info('Sélectionnez au moins une carte à exporter.');
      return;
    }
    this.pdfEnCours.set(true);
    try {
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const ecole = this.nomEcole();

      for (let i = 0; i < cartes.length; i++) {
        const position = i % PAR_PAGE;
        if (i > 0 && position === 0) doc.addPage();
        const x = MARGE + (position % 2) * (LARGEUR_CARTE + ESPACE_X);
        const y = MARGE + Math.floor(position / 2) * (HAUTEUR_CARTE + ESPACE_Y);
        await this.dessinerCarte(doc, cartes[i], x, y, ecole);
      }

      const suffixe = this.classeId()
        ? (this.classes().find((c) => c.id === this.classeId())?.name ?? '')
        : '';
      doc.save(`cartes-eleves${suffixe ? '-' + this.slug(suffixe) : ''}.pdf`);
      this.toasts.succes(`${cartes.length} carte(s) exportée(s) en PDF.`);
    } catch (err) {
      this.toasts.erreur(`Échec de la génération du PDF. ${toApiError(err).message}`);
    } finally {
      this.pdfEnCours.set(false);
    }
  }

  private async dessinerCarte(
    doc: jsPDF,
    eleve: Eleve,
    x: number,
    y: number,
    ecole: string,
  ): Promise<void> {
    doc.setFillColor(255, 255, 255);
    doc.rect(x, y, LARGEUR_CARTE, HAUTEUR_CARTE, 'F');
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.2);
    doc.rect(x, y, LARGEUR_CARTE, HAUTEUR_CARTE, 'S');

    const droite = x + LARGEUR_CARTE - 4;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(71, 85, 105);
    doc.text(this.tronquer(ecole, 44), x + 4, y + 8);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(15, 23, 42);
    const nom = doc.splitTextToSize(eleve.full_name, 48) as string[];
    doc.text(nom.slice(0, 3), x + 4, y + 22);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(51, 65, 85);
    const classe = this.libelleClasse(eleve);
    if (classe) doc.text(this.tronquer(classe, 40), x + 4, y + 40);

    doc.setFontSize(6);
    doc.setTextColor(148, 163, 184);
    doc.text('Carte élève · MwanaClasse', x + 4, y + HAUTEUR_CARTE - 4);

    const code = this.qr.normaliser(eleve.public_code ?? '');
    if (code) {
      const image = await this.qr.generer(code, { largeur: 256, marge: 1 });
      const taille = 26;
      doc.addImage(image, 'PNG', droite - taille, y + 7, taille, taille);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(15, 23, 42);
      doc.text(code, droite, y + 37, { align: 'right' });
    }

    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.1);
    doc.line(x + 4, y + HAUTEUR_CARTE - 9, droite, y + HAUTEUR_CARTE - 9);
  }

  private tronquer(texte: string, taille: number): string {
    return texte.length > taille ? `${texte.slice(0, taille - 1)}…` : texte;
  }

  private slug(texte: string): string {
    return texte
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
  }
}
