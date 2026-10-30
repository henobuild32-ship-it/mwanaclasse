import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide } from '../../shared/ui';

interface ReglagesMinistere {
  compte: {
    id: string;
    identifier: string;
    isDefaultPassword: boolean;
    passwordChangedAt?: string | null;
    createdAt: string;
  };
}

/** Paramètres du compte unique Ministère : mot de passe + identifiant. */
@Component({
  selector: 'app-parametres-ministere',
  imports: [SlicePipe, FormsModule, Chargement, EtatVide],
  templateUrl: './parametres.html',
  styleUrl: '../ecole/pages.scss',
})
export class ParametresMinistere {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);

  protected readonly session = inject(SessionService);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly donnees = signal<ReglagesMinistere | null>(null);

  protected readonly enCoursMdp = signal(false);
  protected readonly enCoursId = signal(false);

  ancienMdp = '';
  nouveauMdp = '';
  confirmationMdp = '';
  nouvelIdentifiant = '';

  constructor() {
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.api.lire<ReglagesMinistere>('ministere/parametres');
      this.donnees.set(r);
      this.nouvelIdentifiant = r.compte.identifier;
    } catch (err) {
      this.erreur.set(toApiError(err).message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected motDePasseValide(): boolean {
    return (
      this.ancienMdp.length > 0 &&
      this.nouveauMdp.length >= 8 &&
      this.nouveauMdp === this.confirmationMdp
    );
  }

  protected async changerMotDePasse(): Promise<void> {
    if (!this.motDePasseValide() || this.enCoursMdp()) return;
    this.enCoursMdp.set(true);
    try {
      await this.api.put('ministere/parametres/mot-de-passe', {
        currentPassword: this.ancienMdp,
        newPassword: this.nouveauMdp,
        confirmPassword: this.confirmationMdp,
      });
      this.toasts.succes('Mot de passe modifié avec succès.');
      this.ancienMdp = '';
      this.nouveauMdp = '';
      this.confirmationMdp = '';
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCoursMdp.set(false);
    }
  }

  protected identifiantValide(): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.nouvelIdentifiant.trim());
  }

  protected async changerIdentifiant(): Promise<void> {
    if (!this.identifiantValide() || this.enCoursId()) return;
    this.enCoursId.set(true);
    try {
      await this.api.put('ministere/parametres/identifiant', {
        newIdentifier: this.nouvelIdentifiant.trim(),
      });
      this.toasts.succes('Identifiant mis à jour.');
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCoursId.set(false);
    }
  }
}
