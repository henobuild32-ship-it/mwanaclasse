import { Component, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { ConnectiviteService } from './core/connectivite.service';
import { SessionService } from './core/session.service';
import { SyncService } from './core/sync.service';
import { Confirmation, ToastContainerComponent } from './shared/ui';

/** Routes publiques : accueil, connexions, inscription, mot de passe oublié. */
const ROUTES_PUBLIQUES = /^\/(connexion\/|inscription\/|mot-de-passe-oublie$|conditions-utilisation$|politique-confidentialite$|aide$|a-propos$|$)/;

/** Dernière page intérieure visitée : un rechargement y revient au lieu de l'accueil. */
const CLE_DERNIER_CHEMIN = 'mwana.dernier_chemin';
const CHEMIN_INTERIEUR = /^\/(ecole|parent)(\/|$)/;

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
  private readonly synchronisationSession = effect(() => {
    if (this.session.connecte()) void this.sync.demarrer().catch(() => undefined);
    else this.sync.arreter();
  });

  private readonly urlCourante = signal(this.router.url);
  /** Première navigation du chargement de page (un rechargement, pas un clic). */
  private premiereNavigation = true;
  private readonly navigationSubscription = this.router.events
    .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
    .subscribe((e) => {
      const url = e.urlAfterRedirects.split('?')[0];
      this.urlCourante.set(e.urlAfterRedirects);

      if (CHEMIN_INTERIEUR.test(url)) {
        try {
          localStorage.setItem(CLE_DERNIER_CHEMIN, url);
        } catch {
          /* stockage indisponible (mode privé) : sans conséquence */
        }
        return;
      }

      // Rechargement de page atterri sur l'accueil alors que la session est
      // valide : on rouvre la dernière page au lieu de renvoyer l'utilisateur
      // à l'accueil. Un clic vers l'accueil en cours de session n'est pas
      // concerné (seule la première navigation du chargement est traitée).
      if (this.premiereNavigation) {
        this.premiereNavigation = false;
        if (url === '/' && this.session.connecte()) {
          const dernier = this.lireDernierChemin();
          if (dernier && dernier !== '/') void this.router.navigateByUrl(dernier);
        }
      }
    });

  private lireDernierChemin(): string | null {
    try {
      return localStorage.getItem(CLE_DERNIER_CHEMIN);
    } catch {
      return null;
    }
  }

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
