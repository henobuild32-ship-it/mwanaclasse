import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { Classe, Section } from '../../core/models';
import { ToastService } from '../../core/toast.service';

interface DetailErreur {
  champ: string;
  message: string;
}

/** Inscription d'un élève (spec §5). */
@Component({
  selector: 'app-nouvel-eleve',
  imports: [FormsModule, RouterLink],
  templateUrl: './eleves-nouveau.html',
  styleUrl: './pages.scss',
})
export class NouvelEleve {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);

  protected readonly classes = signal<Classe[]>([]);
  protected readonly sections = signal<Section[]>([]);
  protected readonly enCours = signal(false);
  protected readonly erreur = signal('');
  protected readonly details = signal<DetailErreur[]>([]);

  lastName = '';
  middleName = '';
  firstName = '';
  gender: 'M' | 'F' = 'M';
  dateOfBirth = '';
  placeOfBirth = '';
  classId = '';
  sectionId = '';
  internalNumber = '';
  guardianPhone = '';
  address = '';
  medicalNotes = '';

  constructor() {
    void this.chargerClasses();
  }

  private async chargerClasses(): Promise<void> {
    try {
      const r = await this.api.lire<{ classes: Classe[] }>('ecole/classes');
      this.classes.set(r.classes ?? []);
    } catch (err) {
      this.erreur.set(toApiError(err).message);
    }
  }

  protected sectionsDeClasse(): Section[] {
    const c = this.classes().find((x) => x.id === this.classId);
    const detail = (c as unknown as { sections_detail?: Section[] } | undefined)?.sections_detail;
    if (detail?.length) return detail;
    const basiques = (c as unknown as { sections?: Section[] } | undefined)?.sections;
    return Array.isArray(basiques) && basiques.length && typeof basiques[0] === 'object'
      ? (basiques as Section[])
      : [];
  }

  protected changerClasse(): void {
    this.sectionId = '';
  }

  protected async enregistrer(): Promise<void> {
    this.erreur.set('');
    this.details.set([]);
    if (!this.lastName.trim() || !this.firstName.trim() || !this.classId) {
      this.erreur.set('Nom, prénom et classe sont obligatoires.');
      return;
    }
    this.enCours.set(true);
    try {
      await this.api.envoyer('ecole/eleves', {
        lastName: this.lastName.trim(),
        middleName: this.middleName.trim() || null,
        firstName: this.firstName.trim(),
        gender: this.gender,
        dateOfBirth: this.dateOfBirth || null,
        placeOfBirth: this.placeOfBirth.trim() || null,
        classId: this.classId,
        sectionId: this.sectionId || null,
        internalNumber: this.internalNumber.trim() || null,
        guardianPhone: this.guardianPhone.trim() || null,
        address: this.address.trim() || null,
        medicalNotes: this.medicalNotes.trim() || null,
      });
      this.toasts.succes('Élève inscrit avec succès.');
      void this.router.navigate(['/ecole/eleves']);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.message);
      this.details.set(e.details ?? []);
    } finally {
      this.enCours.set(false);
    }
  }
}
