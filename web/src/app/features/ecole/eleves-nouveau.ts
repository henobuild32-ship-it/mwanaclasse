import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { Classe, Section } from '../../core/models';
import { SessionService } from '../../core/session.service';
import { ToastService } from '../../core/toast.service';

interface DetailErreur {
  champ: string;
  message: string;
}

/**
 * Formulaire « Inscrire un élève ».
 *
 * Rendu à l'intérieur d'un `<app-overlay>` ouvert par la liste des élèves :
 * il ne possède ni en-tête de page, ni boutons d'action (le pied de l'overlay
 * gère Annuler / Enregistrer).
 */
@Component({
  selector: 'app-nouvel-eleve',
  imports: [FormsModule],
  templateUrl: './eleves-nouveau.html',
  styleUrl: './pages.scss',
})
export class NouvelEleve {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  /** Sections masquées pour un établissement maternelle/primaire seul. */
  protected readonly sectionsVisibles = inject(SessionService).sectionsVisibles;

  /** Élève enregistré : la liste parente referme l'overlay et recharge. */
  readonly enregistre = output<void>();

  protected readonly classes = signal<Classe[]>([]);
  protected readonly sections = signal<Section[]>([]);
  readonly enCours = signal(false);
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

  /** Saisie relevée à l'ouverture, pour détecter une fermeture avec modifications. */
  private depart = '';

  constructor() {
    this.depart = this.etat();
    void this.chargerClasses();
  }

  /** Vrai si l'élève a commencé à remplir le formulaire. */
  modifie(): boolean {
    return this.etat() !== this.depart;
  }

  private etat(): string {
    return JSON.stringify([
      this.lastName,
      this.middleName,
      this.firstName,
      this.gender,
      this.dateOfBirth,
      this.placeOfBirth,
      this.classId,
      this.sectionId,
      this.internalNumber,
      this.guardianPhone,
      this.address,
      this.medicalNotes,
    ]);
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

  /** Validation + enregistrement (appelée par le pied de l'overlay). */
  async enregistrer(): Promise<void> {
    this.erreur.set('');
    this.details.set([]);
    if (!this.lastName.trim() || !this.firstName.trim() || !this.classId) {
      this.erreur.set('Nom, prénom et classe sont obligatoires.');
      return;
    }
    if (this.enCours()) return;
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
      this.enregistre.emit();
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.message);
      this.details.set(e.details ?? []);
    } finally {
      this.enCours.set(false);
    }
  }
}
