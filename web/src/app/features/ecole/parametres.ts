import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { dateFr } from '../../core/format';
import { TYPES_ECOLE, inclutCollege } from '../../core/types-ecole';
import { ToastService } from '../../core/toast.service';
import { Chargement, ChoixMultiples, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';

interface Ecole {
  id: string;
  slug?: string | null;
  official_name: string;
  short_name?: string | null;
  type?: string | null;
  types?: string[] | null;
  is_mixed?: boolean | null;
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
  activity_days?: string | null;
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
  imports: [ChoixMultiples, SlicePipe, FormsModule, Chargement, EtatVide, Etiquette],
  templateUrl: './parametres.html',
  styleUrl: './pages.scss',
})
export class ParametresEcole {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  protected readonly etiquetteStatut = etiquetteStatut;
  protected readonly dateFr = dateFr;
  protected readonly typesDisponibles = TYPES_ECOLE;

  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly enCours = signal(false);
  protected readonly donnees = signal<Parametres | null>(null);

  officialName = '';
  shortName = '';
  /** Sélection multiple des cycles proposés. */
  types: string[] = [];
  /** Précision « mixte / non mixte », demandée pour le collège. */
  isMixed: boolean | null = null;
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
  /** Régime d'activité : les jours hors régime sont non scolaires. */
  activityDays = 'lundi_vendredi';
  signatureName = '';
  signatureTitle = '';

  /** Vrai si un cycle de collège est coché : la précision mixte/non s'affiche. */
  protected get college(): boolean {
    return inclutCollege(this.types);
  }

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
      this.types = e.types?.length
        ? [...e.types]
        : e.type
          ? [e.type]
          : [];
      this.isMixed = e.is_mixed ?? null;
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
      this.activityDays = e.activity_days ?? 'lundi_vendredi';
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
    if (this.types.length === 0) {
      this.toasts.erreur('Sélectionnez au moins un type d’établissement.');
      return;
    }
    if (this.college && this.isMixed === null) {
      this.toasts.erreur('Précisez si votre collège est mixte ou non.');
      return;
    }
    this.enCours.set(true);
    try {
      await this.api.modifier('ecole/parametres', {
        officialName: this.officialName.trim(),
        shortName: this.shortName.trim() || null,
        types: [...this.types],
        ...(this.college ? { isMixed: this.isMixed } : {}),
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
        activityDays: this.activityDays,
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
