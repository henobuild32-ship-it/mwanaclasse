import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toApiError } from '../../core/api.service';
import { SessionService } from '../../core/session.service';

/** Connexion à l'espace parent (spec §2 / §6). */
@Component({
  selector: 'app-connexion-parent',
  imports: [FormsModule, RouterLink],
  templateUrl: './connexion-parent.html',
  styleUrl: './connexion.scss',
})
export class ConnexionParent {
  private readonly session = inject(SessionService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  identifiant = '';
  motDePasse = '';

  protected readonly enCours = signal(false);
  protected readonly erreur = signal('');

  constructor() {
    const identifiant =
      this.route.snapshot.queryParamMap.get('identifiant') ??
      this.route.snapshot.queryParamMap.get('email');
    if (identifiant) this.identifiant = identifiant;
  }

  protected async seConnecter(): Promise<void> {
    if (this.enCours()) return;
    this.erreur.set('');
    this.enCours.set(true);
    try {
      await this.session.connecterParent({
        emailOrPhone: this.identifiant.trim(),
        password: this.motDePasse,
      });
      const retour = this.route.snapshot.queryParamMap.get('retour') ?? '/parent';
      this.router.navigateByUrl(retour.startsWith('/ecole') ? '/parent' : retour);
    } catch (err) {
      this.erreur.set(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }

  protected motDePasseOublie(): void {
    const email = this.identifiant.trim();
    void this.router.navigate(['/mot-de-passe-oublie'], {
      queryParams: email ? { email } : undefined,
    });
  }
}
