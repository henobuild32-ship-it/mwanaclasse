import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';

const TYPES_ECOLE = [
  { valeur: 'primaire', libelle: 'Primaire' },
  { valeur: 'maternelle', libelle: 'Maternelle' },
  { valeur: 'secondaire', libelle: 'Secondaire' },
  { valeur: 'humanites', libelle: 'Humanités' },
  { valeur: 'technique', libelle: 'Technique' },
  { valeur: 'professionnel', libelle: 'Professionnel' },
  { valeur: 'mixte', libelle: 'Mixte' },
  { valeur: 'autre', libelle: 'Autre' },
];

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
  imports: [FormsModule, RouterLink],
  templateUrl: './inscription-ecole.html',
  styleUrl: './connexion.scss',
})
export class InscriptionEcole {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);

  protected readonly types = TYPES_ECOLE;
  protected readonly enCours = signal(false);
  protected readonly erreur = signal('');
  protected readonly details = signal<DetailErreur[]>([]);
  protected readonly forceMotDePasse = signal<string>('');

  // Établissement
  officialName = '';
  type = 'primaire';
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
    if (this.password !== this.confirmation) {
      this.erreur.set('Les deux mots de passe ne correspondent pas.');
      return;
    }
    this.enCours.set(true);
    try {
      await this.api.envoyer('auth/ecole/inscription', {
        officialName: this.officialName.trim(),
        type: this.type,
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
        acceptTerms: true,
      });
      this.toasts.succes('École créée. Vous pouvez maintenant vous connecter.');
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
