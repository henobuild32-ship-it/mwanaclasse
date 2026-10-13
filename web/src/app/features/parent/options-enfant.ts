import { Component, input, output } from '@angular/core';

/**
 * Menu d'options d'un enfant (spec §6) : feuille glissante avec les deux
 * actions des cartes enfants — « Voir la carte de l'élève » (QR) et
 * « Voir le suivi complet ». Fermeture : X implicite (Annuler), clic sur le
 * fond, Échap.
 */
@Component({
  selector: 'app-options-enfant',
  template: `
    <div
      class="feuille-voile"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="'Options de ' + nom()"
      (click)="fermeture.emit()"
      (keydown.escape)="fermeture.emit()"
    >
      <section class="menu-actions" (click)="$event.stopPropagation()">
        <div class="menu-actions__tirette" aria-hidden="true"></div>
        <p class="menu-actions__titre">{{ nom() }}</p>
        <button class="menu-actions__item" type="button" (click)="carte.emit()">
          <span class="menu-actions__icone" aria-hidden="true">🪪</span>
          <span class="menu-actions__libelle">
            <strong>Voir la carte de l'élève</strong>
            <small>QR code imprimable de l'enfant</small>
          </span>
        </button>
        <button class="menu-actions__item" type="button" (click)="suivi.emit()">
          <span class="menu-actions__icone" aria-hidden="true">📊</span>
          <span class="menu-actions__libelle">
            <strong>Voir le suivi complet</strong>
            <small>Présences du mois et historique</small>
          </span>
        </button>
        <button class="btn btn--secondaire" type="button" (click)="fermeture.emit()">Annuler</button>
      </section>
    </div>
  `,
  styleUrl: './pages.scss',
})
export class OptionsEnfant {
  readonly nom = input('');
  readonly carte = output<void>();
  readonly suivi = output<void>();
  readonly fermeture = output<void>();
}
