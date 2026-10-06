import { Injectable, signal } from '@angular/core';

/**
 * Ce que l'utilisateur a choisi de faire d'un formulaire fermé.
 *
 * - `reprendre`   : il reste dans le formulaire (Échap, clic hors cadre)
 * - `abandonner`  : il ferme sans enregistrer
 * - `enregistrer` : il ferme en demandant l'enregistrement d'abord
 */
export type ReponseConfirmation = 'reprendre' | 'abandonner' | 'enregistrer';

export interface DemandeConfirmation {
  titre?: string;
  message?: string;
  texteAbandonner?: string;
  texteEnregistrer?: string;
}

/**
 * Dialogue « vos modifications ne sont pas enregistrées » posé au-dessus de
 * l'application. Une seule instance est montée dans `app.html` ; chaque page
 * attend la réponse sous forme de promesse.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmationService {
  readonly visible = signal(false);
  readonly titre = signal('Modifications non enregistrées');
  readonly message = signal('Vos saisies seront perdues si vous quittez ce formulaire.');
  readonly texteAbandonner = signal('Abandonner');
  readonly texteEnregistrer = signal('Enregistrer');

  private attendu: ((r: ReponseConfirmation) => void) | null = null;

  /** Ouvre le dialogue et attend le choix de l'utilisateur. */
  demander(demande: DemandeConfirmation = {}): Promise<ReponseConfirmation> {
    this.titre.set(demande.titre ?? 'Modifications non enregistrées');
    this.message.set(
      demande.message ?? 'Vos saisies seront perdues si vous quittez ce formulaire.',
    );
    this.texteAbandonner.set(demande.texteAbandonner ?? 'Abandonner');
    this.texteEnregistrer.set(demande.texteEnregistrer ?? 'Enregistrer');
    this.visible.set(true);
    return new Promise<ReponseConfirmation>((resolve) => {
      this.attendu = resolve;
    });
  }

  /** Revenir au formulaire (Échap, clic à côté). */
  reprendre(): void {
    this.clore('reprendre');
  }

  /** Fermer sans enregistrer. */
  abandonner(): void {
    this.clore('abandonner');
  }

  /** Fermer en demandant l'enregistrement. */
  enregistrer(): void {
    this.clore('enregistrer');
  }

  private clore(reponse: ReponseConfirmation): void {
    const resolve = this.attendu;
    if (!resolve) return;
    this.attendu = null;
    this.visible.set(false);
    resolve(reponse);
  }
}
