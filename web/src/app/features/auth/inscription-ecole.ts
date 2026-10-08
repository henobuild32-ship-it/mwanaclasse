import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { TYPES_ECOLE, inclutCollege } from '../../core/types-ecole';
import { ToastService } from '../../core/toast.service';
import { ChoixMultiples } from '../../shared/ui';

interface DetailErreur {
  champ: string;
  message: string;
}

/**
 * Création d'une école (spec §3) : informations de l'établissement puis
 * identifiants du responsable.
 */
@Component({
  selector: 'app-inscription-ecole',
  imports: [ChoixMultiples, FormsModule, RouterLink],
  templateUrl: './inscription-ecole.html',
  styleUrl: './connexion.scss',
})
export class InscriptionEcole {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly session = inject(SessionService);
  private readonly toasts = inject(ToastService);

  protected readonly typesDisponibles = TYPES_ECOLE;
  protected readonly enCours = signal(false);
  protected readonly erreur = signal('');
  protected readonly details = signal<DetailErreur[]>([]);
  protected readonly forceMotDePasse = signal<string>('');

  // Établissement
  officialName = '';
  /** Sélection multiple des cycles proposés. */
  types: string[] = ['primaire'];
  /** Précision « mixte / non mixte », demandée pour le collège. */
  isMixed: boolean | null = null;
  city = '';
  commune = '';
  addressLine = '';
  phone = '';
  emailEcole = '';
  description = '';
  openingHours = '';
  yearLabel = new Date().getFullYear() + '-' + (new Date().getFullYear() + 1);
  parentLinkMode: 'automatique' | 'validation' = 'validation';

  // Responsable
  directorName = '';
  directorEmail = '';
  directorPhone = '';
  directorJobTitle = 'Directeur';
  password = '';
  confirmation = '';
  acceptTerms = false;

  protected champEnErreur(cle: string): boolean {
    return this.details().some((d) => d.champ === cle || d.champ.startsWith(cle + '.'));
  }

  /** Vrai si un cycle de collège est coché : la précision mixte/non devient obligatoire. */
  protected get college(): boolean {
    return inclutCollege(this.types);
  }

  /** Vérifie la robustesse du mot de passe côté API (sans le transmettre au serveur de logs). */
  protected async verifierMotDePasse(): Promise<void> {
    if (this.password.length < 8) {
      this.forceMotDePasse.set('');
      return;
    }
    try {
      const r = await this.api.envoyer<{ force: string; verifie?: boolean }>(
        'auth/verifier-mot-de-passe',
        {
          motDePasse: this.password,
          email: this.directorEmail || undefined,
          nomComplet: this.directorName || undefined,
          nomEcole: this.officialName || undefined,
        },
      );
      this.forceMotDePasse.set(r.force ?? '');
    } catch {
      this.forceMotDePasse.set('');
    }
  }

  protected async creerEcole(): Promise<void> {
    this.erreur.set('');
    this.details.set([]);
    if (!this.acceptTerms) {
      this.erreur.set('Veuillez lire et accepter les conditions d’utilisation et la politique de confidentialité.');
      return;
    }
    if (this.password !== this.confirmation) {
      this.erreur.set('Les deux mots de passe ne correspondent pas.');
      return;
    }
    if (this.types.length === 0) {
      this.erreur.set('Sélectionnez au moins un type d’établissement.');
      return;
    }
    if (this.college && this.isMixed === null) {
      this.erreur.set('Précisez si votre collège est mixte ou non.');
      return;
    }
    this.enCours.set(true);
    try {
      await this.api.envoyer('auth/ecole/inscription', {
        officialName: this.officialName.trim(),
        types: [...this.types],
        isMixed: this.isMixed,
        city: this.city.trim() || null,
        commune: this.commune.trim() || null,
        addressLine: this.addressLine.trim() || null,
        phone: this.phone.trim() || null,
        email: this.emailEcole.trim() || null,
        description: this.description.trim() || null,
        openingHours: this.openingHours.trim() || null,
        directorName: this.directorName.trim(),
        directorEmail: this.directorEmail.trim(),
        directorPhone: this.directorPhone.trim() || null,
        directorJobTitle: this.directorJobTitle.trim() || null,
        password: this.password,
        yearLabel: this.yearLabel.trim(),
        parentLinkMode: this.parentLinkMode,
        acceptTerms: this.acceptTerms,
      });
      this.toasts.succes('École créée. Bienvenue dans votre tableau de bord.');
      // Connexion automatique : l'utilisateur accède directement à son
      // tableau de bord école, sans repasser par l'écran de connexion.
      try {
        await this.session.connecterEcole({
          email: this.directorEmail.trim(),
          password: this.password,
        });
        if (this.session.connecte()) {
          await this.router.navigate(['/ecole']);
          return;
        }
      } catch {
        /* repli sur la page de connexion ci-dessous */
      }
      this.router.navigate(['/connexion/ecole'], {
        queryParams: { email: this.directorEmail.trim() },
      });
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.message);
      this.details.set(e.details ?? []);
    } finally {
      this.enCours.set(false);
    }
  }
}
