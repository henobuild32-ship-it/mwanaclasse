import { Component, computed, HostListener, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ConnectiviteService } from '../../core/connectivite.service';
import { SessionService } from '../../core/session.service';
import { ToastContainerComponent } from '../../shared/ui';

interface Onglet { chemin: string; libelle: string; icone: string; }

/** Coquille de l'espace Ministère : même structure que les espaces école/parent. */
@Component({
  selector: 'app-ministere-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ToastContainerComponent],
  templateUrl: './ministere-layout.html',
  styleUrl: './ministere-layout.scss',
})
export class EspaceMinistereLayout {
  protected readonly session = inject(SessionService);
  protected readonly connectivite = inject(ConnectiviteService);
  protected readonly router = inject(Router);

  protected readonly _menuOuvert = signal(false);
  protected readonly menuOuvert = computed(() => this._menuOuvert());
  /** Rappel sécurité tant que le mot de passe de départ n'a pas été changé. */
  protected readonly rappelMotDePasse = computed(
    () => this.session.profil()?.isDefaultPassword === true,
  );

  protected readonly onglets: Onglet[] = [
    { chemin: '/ministere', libelle: 'Écoles', icone: '🏫' },
    { chemin: '/ministere/communiques', libelle: 'Communiqués', icone: '📢' },
    { chemin: '/ministere/parametres', libelle: 'Paramètres', icone: '⚙️' },
  ];

  protected toggleMenu(): void {
    this._menuOuvert.update((v) => !v);
  }

  @HostListener('document:click', ['$event'])
  protected fermerMenuEnDehors(event: Event): void {
    const cible = event.target as HTMLElement;
    if (this._menuOuvert() && !cible.closest('.dropdown')) this._menuOuvert.set(false);
  }

  protected async deconnexion(): Promise<void> {
    this._menuOuvert.set(false);
    await this.session.deconnexion();
  }
}
