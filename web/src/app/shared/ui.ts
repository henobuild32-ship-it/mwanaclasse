import { CommonModule } from '@angular/common';
import { Component, HostListener, inject, input, model, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConfirmationService } from '../core/confirmation.service';
import { ToastService } from '../core/toast.service';

/* ==========================================================================
 *  Composants partagés (design system)
 * ========================================================================== */

/** Conteneur de toasts (notifications temporaires) — design system */
@Component({
  selector: 'app-toast-container',
  imports: [CommonModule],
  template: `
    <div class="toast-conteneur" role="status" aria-live="polite" aria-atomic="true">
      @for (t of toasts.messages(); track t.id) {
        <div class="toast toast--{{ t.type }}">
          <span class="toast__icone">
            @if (t.type === 'succes') { ✅ }
            @else if (t.type === 'erreur') { ❌ }
            @else if (t.type === 'info') { ℹ️ }
            @else { ⚠️ }
          </span>
          <span class="toast__texte">{{ t.texte }}</span>
          <button type="button" class="toast__fermer" (click)="toasts.fermer(t.id)" aria-label="Fermer" title="Fermer">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      }
    </div>
  `,
  styles: [`
    /* Styles déplacés dans styles.scss global (.toast-conteneur, .toast, etc.) */
    /* Ce composant n'a pas besoin de styles inline supplémentaires */
  `],
})
export class ToastContainerComponent {
  readonly toasts = inject(ToastService);
}

/* ==========================================================================
 *  Titre de page avec actions
 * ========================================================================== */
@Component({
  selector: 'app-titre-page',
  imports: [CommonModule, RouterLink],
  template: `
    <header class="page-header">
      <div class="page-header__principal">
        @if (retour()) {
          <a [routerLink]="retour()" class="btn btn--discret btn--petit" aria-label="Retour">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          </a>
        }
        <div>
          <h1 class="page-header__titre">{{ titre() }}</h1>
          @if (sousTitre()) {
            <p class="page-header__sous">{{ sousTitre() }}</p>
          }
        </div>
      </div>
      @if (actions()) {
        <div class="page-header__actions"><ng-content /></div>
      }
    </header>
  `,
  styles: [``],
})
export class TitrePage {
  readonly titre = input.required<string>();
  readonly sousTitre = input<string>('');
  readonly retour = input<string | null>(null);
  readonly actions = input<boolean>(true);
}

/* ==========================================================================
 *  Carte statistique (KPI)
 * ========================================================================== */
@Component({
  selector: 'app-carte-stat',
  imports: [CommonModule],
  template: `
    <div class="kpi" [class.kpi--color]="accent()">
      <span class="kpi__label">{{ libelle() }}</span>
      <span class="kpi__valeur">{{ valeur() }}</span>
      @if (detail()) { <span class="kpi__sous">{{ detail() }}</span> }
    </div>
  `,
  styles: [``],
})
export class CarteStat {
  readonly valeur = input.required<string | number>();
  readonly libelle = input.required<string>();
  readonly detail = input<string>('');
  readonly accent = input(false);
}

/* ==========================================================================
 *  État vide
 * ========================================================================== */
@Component({
  selector: 'app-etat-vide',
  imports: [CommonModule, RouterLink],
  template: `
    <div class="etat-vide">
      @if (icone()) { <div class="etat-vide__icone">{{ icone() }}</div> }
      <h3 class="etat-vide__titre">{{ texte() }}</h3>
      @if (actionTexte() && actionLien()) {
        <a class="btn btn--primaire btn--ligne" [routerLink]="actionLien()">{{ actionTexte() }}</a>
      }
      <ng-content />
    </div>
  `,
  styles: [``],
})
export class EtatVide {
  readonly texte = input.required<string>();
  readonly icone = input('📋');
  readonly actionTexte = input<string>('');
  readonly actionLien = input<string | string[] | null>(null);
}

/* ==========================================================================
 *  Chargement
 * ========================================================================== */
@Component({
  selector: 'app-chargement',
  imports: [CommonModule],
  template: `
    <div class="chargement" role="status">
      <span class="chargement__pastille"></span>
      <span>{{ texte() }}</span>
    </div>
  `,
  styles: [``],
})
export class Chargement {
  readonly texte = input('Chargement…');
}

/* ==========================================================================
 *  Étiquette / Badge
 * ========================================================================== */
@Component({
  selector: 'app-etiquette',
  imports: [CommonModule],
  template: `<span class="badge badge--{{ variante() }}">{{ texte() }}</span>`,
  styles: [``],
})
export class Etiquette {
  readonly texte = input.required<string>();
  readonly variante = input<'neutre' | 'succes' | 'danger' | 'attention' | 'info'>('neutre');
}

/* ==========================================================================
 *  Overlay de formulaire (modal posé au-dessus du module)
 * ========================================================================== */
@Component({
  selector: 'app-overlay',
  imports: [CommonModule],
  template: `
    <div
      class="overlay"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="titre()"
      (click)="fermetureDemandee.emit()"
    >
      <div class="overlay__panneau" (click)="$event.stopPropagation()">
        <header class="overlay__entete">
          <h2>{{ titre() }}</h2>
          <button
            type="button"
            class="overlay__fermer"
            (click)="fermetureDemandee.emit()"
            aria-label="Fermer"
            title="Fermer"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </header>

        <div class="overlay__corps"><ng-content /></div>

        @if (!sansPied()) {
          <footer class="overlay__pied">
            <button type="button" class="btn btn--discret btn--ligne" (click)="fermetureDemandee.emit()">
              {{ texteAnnuler() }}
            </button>
            <button
              type="button"
              class="btn btn--primaire btn--ligne"
              [disabled]="enCours()"
              (click)="validerDemande.emit()"
            >
              {{ enCours() ? '…' : validerTexte() }}
            </button>
          </footer>
        }
      </div>
    </div>
  `,
  styles: [``],
})
export class OverlayFormulaire {
  readonly titre = input.required<string>();
  readonly validerTexte = input('Enregistrer');
  readonly texteAnnuler = input('Annuler');
  readonly enCours = input(false);
  readonly sansPied = input(false);

  /** L'utilisateur veut fermer (Échap, croix, clic à côté, bouton Annuler). */
  readonly fermetureDemandee = output<void>();
  /** L'utilisateur veut enregistrer. */
  readonly validerDemande = output<void>();

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.fermetureDemandee.emit();
  }
}

/* ==========================================================================
 *  Dialogue de confirmation « modifications non enregistrées »
 * ========================================================================== */
@Component({
  selector: 'app-confirmation',
  imports: [CommonModule],
  template: `
    @if (confirmation.visible()) {
      <div
        class="overlay overlay--devant"
        role="alertdialog"
        aria-modal="true"
        [attr.aria-label]="confirmation.titre()"
        (click)="confirmation.reprendre()"
      >
        <div class="overlay__panneau overlay__panneau--etroit" (click)="$event.stopPropagation()">
          <div class="overlay__corps">
            <h2 class="overlay__titre-confirm">{{ confirmation.titre() }}</h2>
            <p class="texte-doux">{{ confirmation.message() }}</p>
          </div>
          <footer class="overlay__pied">
            <button type="button" class="btn btn--discret btn--ligne" (click)="confirmation.reprendre()">
              Reprendre
            </button>
            <button type="button" class="btn btn--secondaire btn--ligne" (click)="confirmation.abandonner()">
              {{ confirmation.texteAbandonner() }}
            </button>
            <button type="button" class="btn btn--primaire btn--ligne" (click)="confirmation.enregistrer()">
              {{ confirmation.texteEnregistrer() }}
            </button>
          </footer>
        </div>
      </div>
    }
  `,
  styles: [``],
})
export class Confirmation {
  readonly confirmation = inject(ConfirmationService);

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.confirmation.visible()) this.confirmation.reprendre();
  }
}

/* ==========================================================================
 *  Sélection multiple (pastilles cochables) — design system
 * ========================================================================== */
export interface OptionChoix {
  valeur: string;
  libelle: string;
}

@Component({
  selector: 'app-choix-multiples',
  imports: [CommonModule],
  template: `
    <div class="choix-multiples" role="group" [attr.aria-label]="libelle()">
      @for (o of options(); track o.valeur) {
        <label class="choix-multiple" [class.choix-multiple--actif]="coche(o.valeur)">
          <input type="checkbox" [checked]="coche(o.valeur)" (change)="basculer(o.valeur)" />
          <span>{{ o.libelle }}</span>
        </label>
      }
    </div>
  `,
  styles: [``],
})
export class ChoixMultiples {
  readonly options = input.required<OptionChoix[]>();
  readonly libelle = input('Sélection multiple');
  readonly selection = model<string[]>([]);

  coche(valeur: string): boolean {
    return this.selection().includes(valeur);
  }

  basculer(valeur: string): void {
    this.selection.update((courant) =>
      courant.includes(valeur) ? courant.filter((v) => v !== valeur) : [...courant, valeur],
    );
  }
}

/** Convertit un statut API en classe badge lisible. */
export function etiquetteStatut(statut: string): {
  texte: string;
  variante: 'neutre' | 'succes' | 'danger' | 'attention' | 'info';
} {
  const map: Record<
    string,
    { texte: string; variante: 'neutre' | 'succes' | 'danger' | 'attention' | 'info' }
  > = {
    present: { texte: 'Présent', variante: 'succes' },
    absent: { texte: 'Absent', variante: 'danger' },
    retard: { texte: 'Retard', variante: 'attention' },
    depart_anticipe: { texte: 'Départ anticipé', variante: 'info' },
    non_enregistre: { texte: 'Non enregistré', variante: 'neutre' },
    actif: { texte: 'Actif', variante: 'succes' },
    en_attente: { texte: 'En attente', variante: 'attention' },
    revoque: { texte: 'Révoqué', variante: 'danger' },
    refuse: { texte: 'Refusé', variante: 'danger' },
    ouvert: { texte: 'Ouverte', variante: 'info' },
    en_cours: { texte: 'En cours', variante: 'attention' },
    traite: { texte: 'Traitée', variante: 'succes' },
    resolu: { texte: 'Résolue', variante: 'succes' },
    publie: { texte: 'Publié', variante: 'succes' },
    brouillon: { texte: 'Brouillon', variante: 'neutre' },
    programme: { texte: 'Programmé', variante: 'info' },
    archive: { texte: 'Archivé', variante: 'neutre' },
    archeve: { texte: 'Archivé', variante: 'neutre' },
  };
  return map[statut] ?? { texte: statut, variante: 'neutre' };
}