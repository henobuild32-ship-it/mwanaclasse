import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';
import { CalendrierPresence } from './calendrier-presence';

interface SuiviEnfant {
  eleve: {
    id: string;
    full_name: string;
    public_code: string;
    gender?: string | null;
    date_of_birth?: string | null;
    photo_url?: string | null;
    classe?: string | null;
    section?: string | null;
    ecole?: string | null;
    phone_contact?: string | null;
    email_ecole?: string | null;
    annee_scolaire?: string | null;
    relationship?: string | null;
    lien_statut?: string | null;
    presence_aujourdhui?: string | null;
    arrival_time?: string | null;
    departure_time?: string | null;
    method?: string | null;
    reason?: string | null;
  };
  resume30Jours: { presents?: number; absents?: number; retards?: number; departs?: number };
  jourAujourdhui?: { ferme?: boolean; libelle?: string | null; regime?: string };
  communiquesNonLus?: number;
  clarification?: string;
}

interface Jour {
  attendance_date: string;
  status: string;
  arrival_time?: string | null;
  departure_time?: string | null;
  reason?: string | null;
}

interface Historique {
  resumeMensuel: { mois: string; presents: number; absents: number; retards: number; departs: number }[];
  jours: Jour[];
}

/** Suivi détaillé d'un enfant (spec §6). */
@Component({
  selector: 'app-detail-enfant',
  imports: [SlicePipe, RouterLink, Chargement, EtatVide, Etiquette, CalendrierPresence],
  templateUrl: './enfants-detail.html',
  styleUrl: './pages.scss',
})
export class DetailEnfant {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly etiquetteStatut = etiquetteStatut;

  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly detail = signal<SuiviEnfant | null>(null);
  protected readonly historique = signal<Historique | null>(null);
  protected readonly id = signal('');

  constructor() {
    this.id.set(this.route.snapshot.paramMap.get('id') ?? '');
    void this.charger();
  }

  protected eleve(): SuiviEnfant['eleve'] | null {
    return this.detail()?.eleve ?? null;
  }

  /** Statut du jour : jour férié / école fermée / jour non scolaire d'abord. */
  protected etiquetteAujourdhui(): { texte: string; variante: 'neutre' | 'succes' | 'danger' | 'attention' | 'info' } {
    const jour = this.detail()?.jourAujourdhui;
    const e = this.detail()?.eleve;
    if (jour?.ferme) {
      const libelle = jour.libelle ?? '';
      if (libelle.startsWith('Jour férié')) return { texte: libelle, variante: 'danger' };
      if (libelle.startsWith('École fermée')) return { texte: libelle, variante: 'attention' };
      return { texte: libelle || 'Jour non scolaire', variante: 'neutre' };
    }
    return etiquetteStatut(e?.presence_aujourdhui ?? 'non_enregistre');
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const d = await this.api.lire<SuiviEnfant>(`parent/enfants/${this.id()}`);
      this.detail.set(d);
      try {
        const h = await this.api.lire<Historique>(`parent/enfants/${this.id()}/historique`);
        this.historique.set(h);
      } catch {
        this.historique.set(null);
      }
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : suivi indisponible.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected async creerDemande(): Promise<void> {
    try {
      await this.api.envoyer('parent/demandes', {
        studentId: this.id(),
        kind: 'question_presence',
        subject: 'Demande de clarification',
        message: "Bonjour, je souhaite obtenir des précisions sur la journée d'aujourd'hui.",
      });
      this.toasts.succes('Demande envoyée à l\'école.');
      void this.router.navigate(['/parent/demandes']);
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    }
  }

  protected retour(): void {
    void this.router.navigate(['/parent/enfants']);
  }
}
