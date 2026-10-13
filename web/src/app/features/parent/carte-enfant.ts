import { Component, input, output, signal } from '@angular/core';
import { Enfant } from '../../core/models';
import { CarteEleve } from '../../shared/carte-eleve';

/**
 * Aperçu plein écran de la carte élève (QR du code unique).
 *
 * La carte est générée localement à partir du code de l'enfant : elle reste
 * affichable hors ligne et peut être agrandie d'un doigt pour être montrée
 * à l'école ou photographiée.
 */
@Component({
  selector: 'app-carte-enfant',
  imports: [CarteEleve],
  template: `
    <div
      class="feuille-voile"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="'Carte de ' + enfant().full_name"
      (click)="fermeture.emit()"
      (keydown.escape)="fermeture.emit()"
    >
      <section class="carte-apercu" (click)="$event.stopPropagation()">
        <div class="feuille__tirette" aria-hidden="true"></div>
        <button class="feuille__fermer" type="button" aria-label="Fermer" (click)="fermeture.emit()">✕</button>

        <header class="carte-apercu__entete">
          <h2>Carte de {{ enfant().full_name }}</h2>
          <p>Le QR contient le code unique de l'enfant, jamais son nom ni sa photo.</p>
        </header>

        <div class="carte-apercu__zone" [class.carte-apercu__zone--zoom]="zoom()">
          <button
            type="button"
            class="carte-apercu__surface"
            [class.carte-apercu__surface--zoom]="zoom()"
            [attr.aria-pressed]="zoom()"
            [attr.aria-label]="zoom() ? 'Réduire la carte' : 'Agrandir la carte'"
            (click)="basculerZoom()"
          >
            <app-carte-eleve
              [nom]="enfant().full_name"
              [code]="enfant().public_code ?? ''"
              [ecole]="enfant().ecole ?? ''"
              [classe]="libelleClasse()"
            />
          </button>
        </div>

        <p class="carte-apercu__aide">
          {{ zoom() ? 'Touchez la carte pour réduire' : 'Touchez la carte pour agrandir' }}
        </p>
      </section>
    </div>
  `,
  styleUrl: './pages.scss',
})
export class CarteEnfantModal {
  readonly enfant = input.required<Enfant>();
  readonly fermeture = output<void>();

  protected readonly zoom = signal(false);

  protected basculerZoom(): void {
    this.zoom.update((actuel) => !actuel);
  }

  protected libelleClasse(): string {
    const e = this.enfant();
    return [e.classe, e.section].filter(Boolean).join(' · ');
  }
}
