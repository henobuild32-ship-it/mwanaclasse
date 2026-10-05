import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';

interface Ecole {
  id: string;
  public_code?: string;
  slug?: string | null;
  official_name: string;
  short_name?: string | null;
  type?: string | null;
  logo_url?: string | null;
  primary_color?: string | null;
  secondary_color?: string | null;
  address_line?: string | null;
  commune?: string | null;
  city?: string | null;
  province?: string | null;
  phones?: string[];
  email?: string | null;
  website?: string | null;
  description?: string | null;
  opening_hours?: string | null;
  current_year_label?: string | null;
  parent_link_mode?: string | null;
  signature_name?: string | null;
  signature_title?: string | null;
}

interface AnneeScolaire {
  id: string;
  label: string;
  starts_on?: string;
  ends_on?: string;
  is_current?: boolean;
  is_archived?: boolean;
}

interface Membre {
  id: string;
  email: string;
  full_name: string;
  job_title?: string | null;
  phone?: string | null;
  is_active?: boolean;
  is_owner?: boolean;
  totp_enabled?: boolean;
  last_login_at?: string | null;
  roles?: string[];
}

interface Parametres {
  ecole: Ecole;
  anneesScolaires: AnneeScolaire[];
  personnel: Membre[];
  statistiques: { eleves?: number; classes?: number; presences?: number; communiques?: number };
}

/** Paramètres de l'établissement (identité école, années, personnel). */
@Component({
  selector: 'app-parametres-ecole',
  imports: [SlicePipe, FormsModule, Chargement, EtatVide, Etiquette],
  templateUrl: './parametres.html',
  styleUrl: './pages.scss',
})
export class ParametresEcole {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  protected readonly etiquetteStatut = etiquetteStatut;

  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly enCours = signal(false);
  protected readonly donnees = signal<Parametres | null>(null);

  officialName = '';
  shortName = '';
  addressLine = '';
  commune = '';
  city = '';
  province = '';
  phone = '';
  email = '';
  website = '';
  description = '';
  openingHours = '';
  primaryColor = '#0f766e';
  parentLinkMode = 'validation';
  signatureName = '';
  signatureTitle = '';

  constructor() {
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.api.lire<Parametres>('ecole/parametres');
      this.donnees.set(r);
      const e = r.ecole;
      this.officialName = e.official_name ?? '';
      this.shortName = e.short_name ?? '';
      this.addressLine = e.address_line ?? '';
      this.commune = e.commune ?? '';
      this.city = e.city ?? '';
      this.province = e.province ?? '';
      this.phone = e.phones?.[0] ?? '';
      this.email = e.email ?? '';
      this.website = e.website ?? '';
      this.description = e.description ?? '';
      this.openingHours = e.opening_hours ?? '';
      this.primaryColor = e.primary_color ?? '#0f766e';
      this.parentLinkMode = e.parent_link_mode ?? 'validation';
      this.signatureName = e.signature_name ?? '';
      this.signatureTitle = e.signature_title ?? '';
    } catch (err) {
      const ex = toApiError(err);
      this.erreur.set(ex.horsLigne ? 'Hors ligne : paramètres indisponibles.' : ex.message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected async enregistrer(): Promise<void> {
    if (this.officialName.trim().length < 3) {
      this.toasts.erreur('Le nom officiel doit contenir au moins 3 caractères.');
      return;
    }
    this.enCours.set(true);
    try {
      await this.api.modifier('ecole/parametres', {
        officialName: this.officialName.trim(),
        shortName: this.shortName.trim() || null,
        addressLine: this.addressLine.trim() || null,
        commune: this.commune.trim() || null,
        city: this.city.trim() || null,
        province: this.province.trim() || null,
        phones: this.phone.trim() ? [this.phone.trim()] : [],
        email: this.email.trim() || null,
        website: this.website.trim() || null,
        description: this.description.trim() || null,
        openingHours: this.openingHours.trim() || null,
        primaryColor: this.primaryColor,
        parentLinkMode: this.parentLinkMode,
        signatureName: this.signatureName.trim() || null,
        signatureTitle: this.signatureTitle.trim() || null,
      });
      this.toasts.succes('Paramètres enregistrés.');
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCours.set(false);
    }
  }
}
