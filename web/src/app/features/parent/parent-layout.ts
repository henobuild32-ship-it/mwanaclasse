import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ConnectiviteService } from '../../core/connectivite.service';
import { SessionService } from '../../core/session.service';
import { SyncService } from '../../core/sync.service';
import { ToastContainerComponent } from '../../shared/ui';

interface Onglet { chemin: string; libelle: string; icone: string; }

/** Coquille de l'espace parent : barre haute, navigation, toasts. */
@Component({
  selector: 'app-parent-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ToastContainerComponent],
  templateUrl: './parent-layout.html',
  styleUrl: './parent-layout.scss',
})
export class EspaceParentLayout {
  protected readonly session = inject(SessionService);
  protected readonly sync = inject(SyncService);
  protected readonly connectivite = inject(ConnectiviteService);
  protected readonly router = inject(Router);

  protected readonly _menuOuvert = signal(false);
  protected readonly menuOuvert = computed(() => this._menuOuvert());

  protected readonly onglets: Onglet[] = [
    { chemin: '/parent', libelle: 'Accueil', icone: '🏠' },
    { chemin: '/parent/enfants', libelle: 'Enfants', icone: '👧' },
    { chemin: '/parent/demandes', libelle: 'Demandes', icone: '📨' },
    { chemin: '/parent/plus', libelle: 'Plus', icone: '⋯' },
  ];

  protected toggleMenu(): void { this._menuOuvert.update((v) => !v); }

  protected async deconnexion(): Promise<void> {
    this._menuOuvert.set(false);
    await this.session.deconnexion();
  }
}