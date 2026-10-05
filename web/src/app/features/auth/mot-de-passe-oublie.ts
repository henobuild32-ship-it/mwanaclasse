import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';

/**
 * Réinitialisation de mot de passe (spec : récupération de compte).
 * L'API répond de façon identique que le compte existe ou non.
 */
@Component({
  selector: 'app-mot-de-passe-oublie',
  imports: [FormsModule, RouterLink],
  templateUrl: './mot-de-passe-oublie.html',
  styleUrl: './connexion.scss',
})
export class MotDePasseOublie {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  identifiant = this.route.snapshot.queryParamMap.get('email') ?? '';
  interface: 'parent' | 'ecole' = 'ecole';

  protected readonly enCours = signal(false);
  protected readonly erreur = signal('');
  protected readonly envoye = signal(false);

  protected async envoyer(): Promise<void> {
    if (this.enCours()) return;
    this.erreur.set('');
    this.enCours.set(true);
    try {
      await this.api.envoyer('auth/mot-de-passe-oublie', {
        identifiant: this.identifiant.trim(),
        interface: this.interface,
      });
      this.envoye.set(true);
    } catch (err) {
      this.erreur.set(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }
}
