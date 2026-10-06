import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { ConfirmationService } from '../../core/confirmation.service';
import { Classe, Section } from '../../core/models';
import { SessionService } from '../../core/session.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette, OverlayFormulaire } from '../../shared/ui';

type Onglet = 'classes' | 'sections';

/** Classes et sections de l'établissement (spec §5). */
@Component({
  selector: 'app-classes-ecole',
  imports: [FormsModule, Chargement, EtatVide, Etiquette, OverlayFormulaire],
  templateUrl: './classes.html',
  styleUrl: './pages.scss',
})
export class ClassesEcole {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  protected readonly confirmation = inject(ConfirmationService);
  /** Sections masquées pour un établissement maternelle/primaire seul. */
  protected readonly sectionsVisibles = inject(SessionService).sectionsVisibles;

  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly classes = signal<Classe[]>([]);
  protected readonly onglet = signal<Onglet>('classes');
  protected readonly formulaireClasse = signal(false);
  protected readonly formulaireSection = signal(false);
  protected readonly enCours = signal(false);

  nomClasse = '';
  niveau = '';
  capacite = 30;
  salle = '';
  notes = '';

  classId = '';
  nomSection = '';
  codeSection = '';
  capaciteSection = 30;

  /** Saisie relevée à l'ouverture, pour détecter une fermeture avec modifications. */
  private departClasse = '';
  private departSection = '';

  constructor() {
    void this.charger();
  }

  protected sections(): Section[] {
    const out: Section[] = [];
    for (const c of this.classes()) {
      const detail = (c as unknown as { sections_detail?: Section[] }).sections_detail;
      if (Array.isArray(detail)) {
        for (const s of detail) out.push({ ...s, class_id: c.id });
      }
    }
    return out;
  }

  protected nomDeClasse(id: string): string {
    return this.classes().find((c) => c.id === id)?.name ?? '—';
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.api.lire<{ classes: Classe[] }>('ecole/classes', {
        inactives: 'true',
      });
      this.classes.set(r.classes ?? []);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : classes indisponibles.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Ouverture / fermeture avec confirmation                          */
  /* ---------------------------------------------------------------- */

  protected basculerClasse(): void {
    if (this.formulaireClasse()) {
      void this.fermerClasse();
      return;
    }
    this.formulaireSection.set(false);
    this.departClasse = this.etatClasse();
    this.formulaireClasse.set(true);
  }

  protected basculerSection(): void {
    if (!this.sectionsVisibles()) return;
    if (this.formulaireSection()) {
      void this.fermerSection();
      return;
    }
    this.formulaireClasse.set(false);
    this.departSection = this.etatSection();
    this.formulaireSection.set(true);
  }

  protected fermerClasse(): void {
    void this.fermerClasseAsync();
  }

  protected fermerSection(): void {
    void this.fermerSectionAsync();
  }

  private async fermerClasseAsync(): Promise<void> {
    if (this.etatClasse() !== this.departClasse) {
      const choix = await this.confirmation.demander({
        message: 'La nouvelle classe n\'a pas encore été créée.',
      });
      if (choix === 'reprendre') return;
      if (choix === 'enregistrer') {
        await this.creerClasse();
        return;
      }
    }
    this.formulaireClasse.set(false);
  }

  private async fermerSectionAsync(): Promise<void> {
    if (this.etatSection() !== this.departSection) {
      const choix = await this.confirmation.demander({
        message: 'La nouvelle section n\'a pas encore été créée.',
      });
      if (choix === 'reprendre') return;
      if (choix === 'enregistrer') {
        await this.creerSection();
        return;
      }
    }
    this.formulaireSection.set(false);
  }

  private etatClasse(): string {
    return JSON.stringify([this.nomClasse, this.niveau, this.capacite, this.salle, this.notes]);
  }

  private etatSection(): string {
    return JSON.stringify([this.classId, this.nomSection, this.codeSection, this.capaciteSection]);
  }

  /* ---------------------------------------------------------------- */
  /*  Enregistrement                                                   */
  /* ---------------------------------------------------------------- */

  protected async creerClasse(): Promise<void> {
    if (!this.nomClasse.trim()) {
      this.toasts.erreur('Le nom de la classe est obligatoire.');
      return;
    }
    if (this.enCours()) return;
    this.enCours.set(true);
    try {
      await this.api.envoyer('ecole/classes', {
        name: this.nomClasse.trim(),
        level: this.niveau.trim() || null,
        levelOrder: null,
        maxCapacity: Number(this.capacite) || 30,
        room: this.salle.trim() || null,
        notes: this.notes.trim() || null,
      });
      this.toasts.succes('Classe créée.');
      this.nomClasse = '';
      this.niveau = '';
      this.salle = '';
      this.notes = '';
      this.departClasse = this.etatClasse();
      this.formulaireClasse.set(false);
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }

  protected async creerSection(): Promise<void> {
    if (!this.nomSection.trim() || !this.classId) {
      this.toasts.erreur('Choisissez une classe et donnez un nom à la section.');
      return;
    }
    if (this.enCours()) return;
    this.enCours.set(true);
    try {
      await this.api.envoyer('ecole/sections', {
        classId: this.classId,
        name: this.nomSection.trim(),
        shortCode: this.codeSection.trim() || null,
        maxCapacity: Number(this.capaciteSection) || null,
      });
      this.toasts.succes('Section créée.');
      this.nomSection = '';
      this.codeSection = '';
      this.classId = '';
      this.departSection = this.etatSection();
      this.formulaireSection.set(false);
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }
}
