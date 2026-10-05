import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { Classe, Section } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette } from '../../shared/ui';

type Onglet = 'classes' | 'sections';

/** Classes et sections de l'établissement (spec §5). */
@Component({
  selector: 'app-classes-ecole',
  imports: [FormsModule, Chargement, EtatVide, Etiquette],
  templateUrl: './classes.html',
  styleUrl: './pages.scss',
})
export class ClassesEcole {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);

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

  protected async creerClasse(): Promise<void> {
    if (!this.nomClasse.trim()) return;
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
      this.formulaireClasse.set(false);
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }

  protected async creerSection(): Promise<void> {
    if (!this.nomSection.trim() || !this.classId) return;
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
      this.formulaireSection.set(false);
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }
}
