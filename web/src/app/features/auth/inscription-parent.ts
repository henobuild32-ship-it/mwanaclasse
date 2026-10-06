import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';

const RELATIONS = [
  { valeur: 'pere', libelle: 'Père' },
  { valeur: 'mere', libelle: 'Mère' },
  { valeur: 'tuteur', libelle: 'Tuteur / Tutrice' },
  { valeur: 'parent', libelle: 'Parent' },
  { valeur: 'grand_parent', libelle: 'Grand-parent' },
  { valeur: 'oncle', libelle: 'Oncle' },
  { valeur: 'tante', libelle: 'Tante' },
  { valeur: 'frere', libelle: 'Frère' },
  { valeur: 'soeur', libelle: 'Sœur' },
  { valeur: 'autre', libelle: 'Autre' },
];

interface DetailErreur {
  champ: string;
  message: string;
}

/**
 * Création d'un compte parent (spec §3) : identité, contact, code élève
 * obligatoire puis mot de passe.
 */
@Component({
  selector: 'app-inscription-parent',
  imports: [FormsModule, RouterLink],
  templateUrl: './inscription-parent.html',
  styleUrl: './connexion.scss',
})
export class InscriptionParent {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);

  protected readonly relations = RELATIONS;
  protected readonly enCours = signal(false);
  protected readonly erreur = signal('');
  protected readonly details = signal<DetailErreur[]>([]);
  protected readonly forceMotDePasse = signal<string>('');

  fullName = '';
  email = '';
  phone = '';
  codeEleve = '';
  relationship = 'parent';
  password = '';
  confirmation = '';
  acceptTerms = false;

  protected champEnErreur(cle: string): boolean {
    return this.details().some((d) => d.champ === cle || d.champ.startsWith(cle + '.'));
  }

  /** Vérifie la robustesse du mot de passe côté API. */
  protected async verifierMotDePasse(): Promise<void> {
    if (this.password.length < 8) {
      this.forceMotDePasse.set('');
      return;
    }
    try {
      const r = await this.api.envoyer<{ force: string }>('auth/verifier-mot-de-passe', {
        motDePasse: this.password,
        email: this.email || undefined,
        nomComplet: this.fullName || undefined,
      });
      this.forceMotDePasse.set(r.force ?? '');
    } catch {
      this.forceMotDePasse.set('');
    }
  }

  protected async creerCompte(): Promise<void> {
    this.erreur.set('');
    this.details.set([]);

    if (!this.email.trim() && !this.phone.trim()) {
      this.erreur.set('Indiquez au moins une adresse e-mail ou un numéro de téléphone.');
      return;
    }
    if (!this.codeEleve.trim()) {
      this.erreur.set('Le code de l’enfant est obligatoire : demandez-le à l’établissement.');
      return;
    }
    if (this.password !== this.confirmation) {
      this.erreur.set('Les deux mots de passe ne correspondent pas.');
      return;
    }

    this.enCours.set(true);
    try {
      const r = await this.api.envoyer<{
        message: string;
        ecole?: { nom: string };
      }>('auth/parent/inscription', {
        fullName: this.fullName.trim(),
        email: this.email.trim() || null,
        phone: this.phone.trim() || null,
        codeEleve: this.codeEleve.trim(),
        relationship: this.relationship,
        password: this.password,
        acceptTerms: true,
      });
      this.toasts.succes(r.message ?? 'Compte parent créé.');
      this.router.navigate(['/connexion/parent'], {
        queryParams: { identifiant: this.email.trim() || this.phone.trim() },
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
