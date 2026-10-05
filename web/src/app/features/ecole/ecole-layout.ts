import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ConnectiviteService } from '../../core/connectivite.service';
import { SessionService } from '../../core/session.service';
import { SyncService } from '../../core/sync.service';
import { ToastContainerComponent } from '../../shared/ui';

interface Onglet { chemin: string; libelle: string; icone: string; }

/** Coquille de l'espace école : barre haute, navigation inférieure/rail, toasts. */
@Component({
  selector: 'app-ecole-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ToastContainerComponent],
  templateUrl: './ecole-layout.html',
  styleUrl: './ecole-layout.scss',
})
export class EspaceEcoleLayout {
  protected readonly session = inject(SessionService);
  protected readonly sync = inject(SyncService);
  protected readonly connectivite = inject(ConnectiviteService);
  protected readonly router = inject(Router);

  protected readonly _menuOuvert = signal(false);
  protected readonly menuOuvert = computed(() => this._menuOuvert());

  protected readonly onglets = computed<Onglet[]>(() => {
    const base = '/ecole';
    return [
      { chemin: base, libelle: 'Accueil', icone: '🏠' },
      { chemin: `${base}/presences`, libelle: 'Présences', icone: '🗓️' },
      { chemin: `${base}/eleves`, libelle: 'Élèves', icone: '👥' },
      { chemin: `${base}/plus`, libelle: 'Plus', icone: '⋯' },
    ];
  });

  protected toggleMenu(): void {
    this._menuOuvert.update((v) => !v);
  }

  protected async deconnexion(): Promise<void> {
    this._menuOuvert.set(false);
    await this.session.deconnexion();
  }
}