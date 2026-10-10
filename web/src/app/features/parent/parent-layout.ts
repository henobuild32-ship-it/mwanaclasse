import { Component, computed, HostListener, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ConnectiviteService } from '../../core/connectivite.service';
import { EnfantActifService } from '../../core/enfant-actif.service';
import { SessionService } from '../../core/session.service';
import { SyncService } from '../../core/sync.service';
import { ToastContainerComponent } from '../../shared/ui';

interface Onglet { chemin: string; libelle: string; icone: string; }

/** Coquille de l'espace parent : barre haute, sélecteur d'enfant, navigation, toasts. */
@Component({
  selector: 'app-parent-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ToastContainerComponent],
  templateUrl: './parent-layout.html',
  styleUrl: './parent-layout.scss',
  host: { '[style.--mc-ecole]': 'couleurEcole' },
})
export class EspaceParentLayout {
  protected readonly session = inject(SessionService);
  protected readonly sync = inject(SyncService);
  protected readonly connectivite = inject(ConnectiviteService);
  protected readonly router = inject(Router);
  protected readonly selection = inject(EnfantActifService);

  /** Couleur de l'établissement de l'enfant actif (variable CSS globale). */
  protected readonly couleurEcole = computed(
    () => this.selection.couleurEcole() ?? 'var(--mc-primaire)',
  );

  protected readonly _menuOuvert = signal(false);
  protected readonly menuOuvert = computed(() => this._menuOuvert());

  protected readonly onglets: Onglet[] = [
    { chemin: '/parent', libelle: 'Accueil', icone: '🏠' },
    { chemin: '/parent/enfants', libelle: 'Enfants', icone: '👧' },
    { chemin: '/parent/demandes', libelle: 'Demandes', icone: '📨' },
    { chemin: '/parent/plus', libelle: 'Plus', icone: '⋯' },
  ];

  constructor() {
    void this.selection.charger();
  }

  protected toggleMenu(): void { this._menuOuvert.update((v) => !v); }

  /** Clic en dehors du profil : le menu se referme (aucun chevron à fermer). */
  @HostListener('document:click', ['$event'])
  protected fermerMenuEnDehors(event: Event): void {
    const cible = event.target as HTMLElement;
    if (this._menuOuvert() && !cible.closest('.dropdown')) this._menuOuvert.set(false);
  }

  protected choisir(id: string | null): void {
    this.selection.selectionner(id);
  }

  protected async deconnexion(): Promise<void> {
    this._menuOuvert.set(false);
    await this.session.deconnexion();
  }
}