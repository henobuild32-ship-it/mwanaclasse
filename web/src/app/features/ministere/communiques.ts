import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { ConfirmationService } from '../../core/confirmation.service';
import { CommuniqueMinistere, EcoleKinshasa } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette } from '../../shared/ui';

/**
 * Communiqués officiels du Ministère de l'EPST :
 * rédaction, écran de confirmation (« X école(s) »), envoi, puis historique.
 */
@Component({
  selector: 'app-communiques-ministere',
  imports: [SlicePipe, FormsModule, Chargement, EtatVide, Etiquette],
  templateUrl: './communiques.html',
  styleUrl: '../ecole/pages.scss',
})
export class CommuniquesMinistere {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly confirmation = inject(ConfirmationService);

  protected readonly vue = signal<'rediger' | 'envoyer' | 'historique'>('rediger');
  protected readonly enCours = signal(false);

  /** Historique */
  protected readonly historique = signal<CommuniqueMinistere[]>([]);
  protected readonly chargementHisto = signal(true);
  protected readonly erreurHisto = signal('');

  /** Écoles pour la sélection « école précise ». */
  protected readonly ecoles = signal<EcoleKinshasa[]>([]);

  /** Fichiers / pièce jointe (Base64 en mémoire, pas de stockage côté serveur). */
  pieceJointe: File | null = null;
  nomPiece = '';
  mimePiece = '';

  // Champs du formulaire
  titre = '';
  message = '';
  urgent = false;
  destinataire: 'toutes' | 'ecole' = 'toutes';
  ecoleChoisieId = '';

  /** Derniers éléments prêts pour l'écran de confirmation. */
  confirmationVisible = signal(false);
  confirmationNombre = signal(0);

  constructor() {
    void this.chargerHistoire();
    void this.chargerEcoles();
  }

  /* ------------------------------------------------------------------ */
  /*  Chargements                                                        */
  /* ------------------------------------------------------------------ */

  protected async chargerHistoire(): Promise<void> {
    this.chargementHisto.set(true);
    this.erreurHisto.set('');
    try {
      const r = await this.api.lire<{ communiques: CommuniqueMinistere[] }>(
        'ministere/communiques/historique',
      );
      this.historique.set(r.communiques ?? []);
    } catch (err) {
      this.erreurHisto.set(toApiError(err).message);
    } finally {
      this.chargementHisto.set(false);
    }
  }

  private async chargerEcoles(): Promise<void> {
    try {
      const r = await this.api.lire<{ ecoles: EcoleKinshasa[] }>('ministere/ecoles', {
        statut: 'actif',
      });
      this.ecoles.set(r.ecoles ?? []);
    } catch {
      /* la sélection spécifique sera vide : l'envoi toutes écoles reste possible */
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Pièce jointe                                                       */
  /* ------------------------------------------------------------------ */

  protected ecouterFichier(event: Event): void {
    const cible = event.target as HTMLInputElement;
    const fichier = cible.files?.[0] ?? null;
    this.pieceJointe = fichier;
    this.nomPiece = fichier?.name ?? '';
  }

  protected formValide(): boolean {
    const destOk =
      this.destinataire === 'toutes' ||
      (this.destinataire === 'ecole' && this.ecoleChoisieId !== '');
    return this.titre.trim().length >= 3 && this.message.trim().length >= 5 && destOk;
  }

  /* ------------------------------------------------------------------ */
  /*  Confirmation puis envoi                                            */
  /* ------------------------------------------------------------------ */

  /** Premier « Envoyer » : affiche l'écran de confirmation (X école(s)). */
  protected async demanderConfirmation(): Promise<void> {
    if (!this.formValide()) return;
    let nombre = 0;
    if (this.destinataire === 'toutes') {
      try {
        const r = await this.api.lire<{ total: number }>('ministere/ecoles', { statut: 'actif' });
        nombre = r.total ?? this.ecoles().length;
      } catch {
        nombre = this.ecoles().length;
      }
    } else {
      nombre = 1;
    }
    this.confirmationNombre.set(nombre);
    this.confirmationVisible.set(true);
  }

  protected annulerEnvoi(): void {
    this.confirmationVisible.set(false);
  }

  protected async envoyer(): Promise<void> {
    if (!this.formValide()) return;
    this.enCours.set(true);
    try {
      let pieceBase64: string | null = null;
      if (this.pieceJointe) {
        pieceBase64 = await new Promise<string | null>((resolve) => {
          const lecteur = new FileReader();
          lecteur.onload = () => resolve(String(lecteur.result ?? ''));
          lecteur.onerror = () => resolve(null);
          lecteur.readAsDataURL(this.pieceJointe!);
        });
      }
      await this.api.post('ministere/communiques', {
        title: this.titre.trim(),
        message: this.message.trim(),
        attachmentUrl: pieceBase64 ?? null,
        attachmentName: pieceBase64 ? this.nomPiece : null,
        attachmentType: pieceBase64
          ? this.mimePiece || (this.nomPiece.toLowerCase().endsWith('.pdf') ? 'pdf' : 'image')
          : null,
        isUrgent: this.urgent,
        targetType: this.destinataire === 'toutes' ? 'toutes_ecoles' : 'ecole_specifique',
        targetSchoolId: this.destinataire === 'ecole' ? this.ecoleChoisieId : null,
      });
      this.confirmationVisible.set(false);
      this.toasts.succes('Communiqué envoyé.');
      this.titre = '';
      this.message = '';
      this.urgent = false;
      this.pieceJointe = null;
      this.nomPiece = '';
      this.destinataire = 'toutes';
      this.ecoleChoisieId = '';
      void this.chargerHistoire();
      this.vue.set('historique');
    } catch (err) {
      this.confirmationVisible.set(false);
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }

  /** Nom du destinataire pour l'historique. */
  protected cible(c: CommuniqueMinistere): string {
    if (c.target_type === 'toutes_ecoles') return 'Toutes les écoles';
    return c.target_school_name ?? 'École précise';
  }
}
