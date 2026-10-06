import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toApiError } from '../../core/api.service';
import { SessionService } from '../../core/session.service';

/** Connexion à l'espace école (spec §2 / §5). */
@Component({
  selector: 'app-connexion-ecole',
  imports: [FormsModule, RouterLink],
  templateUrl: './connexion-ecole.html',
  styleUrl: './connexion.scss',
})
export class ConnexionEcole {
  private readonly session = inject(SessionService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  email = '';
  motDePasse = '';

  protected readonly enCours = signal(false);
  protected readonly erreur = signal('');

  constructor() {
    const email = this.route.snapshot.queryParamMap.get('email');
    if (email) this.email = email;
  }

  protected async seConnecter(): Promise<void> {
    if (this.enCours()) return;
    this.erreur.set('');
    this.enCours.set(true);
    try {
      await this.session.connecterEcole({
        email: this.email.trim(),
        password: this.motDePasse,
      });
      const retour = this.route.snapshot.queryParamMap.get('retour') ?? '/ecole';
      this.router.navigateByUrl(retour.startsWith('/parent') ? '/ecole' : retour);
    } catch (err) {
      this.erreur.set(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }

  protected motDePasseOublie(): void {
    const email = this.email.trim();
    void this.router.navigate(['/mot-de-passe-oublie'], {
      queryParams: email ? { email } : undefined,
    });
  }
}
