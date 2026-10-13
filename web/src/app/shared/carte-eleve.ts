import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { QrService } from '../core/qr.service';

/**
 * Carte élève PVC (85,6 × 54 mm) avec QR code de l'unique code élève.
 *
 * Le motif est généré **localement** à partir du `public_code` : rien n'est
 * envoyé sur le réseau, la carte s'imprime et se relit hors ligne. Le code
 * est aussi imprimé en clair sous le QR, pour permettre une saisie manuelle
 * quand la caméra est indisponible.
 */
@Component({
  selector: 'app-carte-eleve',
  template: `
    <div class="carte-eleve">
      <div class="carte-eleve__bloc">
        <span class="carte-eleve__ecole">{{ ecole() || 'Établissement scolaire' }}</span>
        <span class="carte-eleve__nom">{{ nom() }}</span>
        @if (classe()) {
          <span class="carte-eleve__classe">{{ classe() }}</span>
        }
        <span class="carte-eleve__mention">Carte élève · MwanaClasse</span>
      </div>
      <div class="carte-eleve__qr">
        @if (donneesQr(); as image) {
          <img
            class="carte-eleve__image"
            [src]="image"
            [alt]="'QR code du code élève ' + codeAffiche()"
          />
        } @else {
          <span class="carte-eleve__attente" role="status" aria-label="Génération du QR code…"></span>
        }
        <span class="carte-eleve__code">{{ codeAffiche() }}</span>
      </div>
    </div>
  `,
})
export class CarteEleve {
  private readonly qr = inject(QrService);

  /** Nom complet de l'élève. */
  readonly nom = input.required<string>();
  /** Code unique de l'élève (QR + texte imprimé). */
  readonly code = input.required<string>();
  readonly ecole = input('');
  readonly classe = input('');

  protected readonly donneesQr = signal('');
  /** Code sous forme canonique `MC-ELV-XXXXXX`, quel que soit le saisi. */
  protected readonly codeAffiche = computed(() => this.qr.normaliser(this.code()));

  constructor() {
    effect(() => {
      const code = this.codeAffiche();
      if (!code || code.length < 6) {
        this.donneesQr.set('');
        return;
      }
      void this.generer(code);
    });
  }

  private async generer(code: string): Promise<void> {
    try {
      const image = await this.qr.generer(code, { marge: 4, largeur: 512 });
      this.donneesQr.set(image);
    } catch {
      // QR indisponible : le code reste lisible en clair sous le bloc.
      this.donneesQr.set('');
    }
  }
}
