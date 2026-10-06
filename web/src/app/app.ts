import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { ConnectiviteService } from './core/connectivite.service';
import { SessionService } from './core/session.service';
import { SyncService } from './core/sync.service';
import { Confirmation, ToastContainerComponent } from './shared/ui';

/** Routes publiques : accueil, connexions, inscription, mot de passe oublié. */
const ROUTES_PUBLIQUES = /^\/(connexion\/|inscription\/|mot-de-passe-oublie$|$)/;

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, ToastContainerComponent, Confirmation],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly session = inject(SessionService);
  protected readonly connectivite = inject(ConnectiviteService);
  protected readonly sync = inject(SyncService);
  private readonly router = inject(Router);

  private readonly urlCourante = signal(this.router.url);
  private readonly navigationSubscription = this.router.events
    .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
    .subscribe((e) => this.urlCourante.set(e.urlAfterRedirects));

  /** true quand on est sur une page « vitrine » (sans barre d'application). */
  protected readonly pagePublique = computed(() =>
    ROUTES_PUBLIQUES.test(this.urlCourante().split('?')[0]),
  );

  /**
   * true quand on est dans un espace protégé (école / parent) : ces layouts
   * possèdent déjà leur propre bandeau, la barre racine ne doit pas s'empiler.
   */
  protected readonly dansInterface = computed(() =>
    /^\/(ecole|parent)(\/|$)/.test(this.urlCourante().split('?')[0]),
  );

  protected readonly initiales = computed(() => {
    const nom = this.session.nomAffiche();
    if (!nom) return '?';
    return nom
      .split(/\s+/)
      .slice(0, 2)
      .map((m) => m[0]?.toUpperCase() ?? '')
      .join('');
  });

  protected async deconnexion(): Promise<void> {
    this.sync.arreter();
    await this.session.deconnexion();
  }
}
