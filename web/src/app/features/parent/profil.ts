import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { SessionService } from '../../core/session.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette } from '../../shared/ui';

interface Appareil {
  id: string;
  ip?: string | null;
  user_agent?: string | null;
  device_label?: string | null;
  created_at?: string | null;
  last_used_at?: string | null;
  expires_at?: string | null;
  mfa_satisfied?: boolean;
  mfa_method?: string | null;
}

/** Profil parent : informations, appareils, sécurité (spec §6). */
@Component({
  selector: 'app-profil-parent',
  imports: [SlicePipe, FormsModule, Chargement, EtatVide, Etiquette],
  templateUrl: './profil.html',
  styleUrl: './pages.scss',
})
export class ProfilParent {
  private readonly api = inject(ApiService);
  protected readonly session = inject(SessionService);
  private readonly toasts = inject(ToastService);

  protected readonly appareils = signal<Appareil[]>([]);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly enCours = signal(false);
  protected readonly suppression = signal(false);

  fullName = '';
  email = '';
  phone = '';
  motDePasse = '';
  confirmation = '';

  constructor() {
    const p = this.session.profil();
    this.fullName = p?.fullName ?? p?.full_name ?? '';
    this.email = p?.email ?? '';
    this.phone = p?.phone ?? '';
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.api.lire<{ appareils: Appareil[] }>('parent/appareils');
      this.appareils.set(r.appareils ?? []);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : appareils indisponibles.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected async enregistrer(): Promise<void> {
    if (this.fullName.trim().length < 3) {
      this.toasts.erreur('Le nom complet doit contenir au moins 3 caractères.');
      return;
    }
    this.enCours.set(true);
    try {
      await this.api.modifier('parent/profil', {
        fullName: this.fullName.trim(),
        email: this.email.trim() || null,
        phone: this.phone.trim() || null,
      });
      const p = this.session.profil();
      if (p) {
        this.session.profil.set({
          ...p,
          fullName: this.fullName.trim(),
          full_name: this.fullName.trim(),
          email: this.email.trim() || undefined,
          phone: this.phone.trim() || undefined,
        });
      }
      this.toasts.succes('Profil mis à jour.');
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }

  protected async revoquer(id: string): Promise<void> {
    this.enCours.set(true);
    try {
      await this.api.supprimer(`parent/appareils/${id}`);
      this.toasts.succes('Appareil déconnecté.');
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }

  protected async supprimerCompte(): Promise<void> {
    if (!this.motDePasse || this.confirmation !== 'SUPPRIMER') {
      this.toasts.erreur('Saisissez votre mot de passe et le mot SUPPRIMER pour confirmer.');
      return;
    }
    this.enCours.set(true);
    try {
      await this.api.envoyer('parent/compte/supprimer', {
        password: this.motDePasse,
        confirmation: this.confirmation,
      });
      this.toasts.succes('Compte supprimé.');
      await this.session.deconnexion();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
      this.suppression.set(false);
      this.motDePasse = '';
      this.confirmation = '';
    }
  }
}
