import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from './api.service';

/** Enfant rattaché au compte parent, avec le contexte de son établissement. */
export interface EnfantContexte {
  id: string;
  full_name: string;
  public_code?: string;
  classe?: string | null;
  section?: string | null;
  school_id: string;
  ecole: string;
  primary_color?: string | null;
  logo_url?: string | null;
  lien_statut?: string;
  presence_aujourdhui?: string;
}

const CLE_ENFANT = 'mwana.enfantActif';
/** Valeur stockée quand le parent veut voir toutes ses écoles. */
const TOUS = '__tous__';

/**
 * Enfant actif de l'espace parent.
 *
 * Sélectionner un enfant recentre toute l'interface sur SON établissement :
 * couleur, logo, communiqués, calendrier, documents et demandes.
 * `ecoleId` vaut `null` quand on affiche « tous les enfants ».
 */
@Injectable({ providedIn: 'root' })
export class EnfantActifService {
  private readonly api = inject(ApiService);

  readonly enfants = signal<EnfantContexte[]>([]);
  readonly chargement = signal(false);
  readonly erreur = signal('');

  private readonly brut = signal<string | null>(localStorage.getItem(CLE_ENFANT));

  readonly modeTous = computed(() => this.brut() === TOUS);

  readonly enfantActif = computed(() => {
    const b = this.brut();
    if (!b || b === TOUS) return null;
    return this.enfants().find((e) => e.id === b) ?? null;
  });

  /** École à imposer aux requêtes (`null` = toutes les écoles). */
  readonly ecoleId = computed(() => {
    if (this.modeTous()) return null;
    return this.enfantActif()?.school_id ?? null;
  });
  readonly ecoleNom = computed(() => this.enfantActif()?.ecole ?? '');
  readonly couleurEcole = computed(() => this.enfantActif()?.primary_color ?? null);
  readonly logoEcole = computed(() => this.enfantActif()?.logo_url ?? null);

  /** Paramètres à transmettre à l'API pour filtrer sur l'école active. */
  get params(): { ecoleId: string | null } {
    return { ecoleId: this.ecoleId() };
  }

  private chargeEnCours: Promise<void> | null = null;

  /**
   * Charge (ou recharge) la liste des enfants rattachés.
   * Les appels concurrents partagent la même requête : une page qui s'ouvre
   * pendant le chargement attend la liste avant de filtrer.
   */
  async charger(force = false): Promise<void> {
    if (this.chargeEnCours) {
      await this.chargeEnCours;
      if (!force) return;
    }
    if (this.enfants().length > 0 && !force) return;
    const promesse = this.chargerEnfants();
    this.chargeEnCours = promesse;
    try {
      await promesse;
    } finally {
      if (this.chargeEnCours === promesse) this.chargeEnCours = null;
    }
  }

  private async chargerEnfants(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.api.lire<{ enfants: EnfantContexte[] }>('parent/enfants');
      this.enfants.set(r.enfants ?? []);
      // Un enfant supprimé / déconnecté ne doit pas rester sélectionné.
      const b = this.brut();
      if (b && b !== TOUS && !this.enfants().some((e) => e.id === b)) {
        this.selectionner(null);
      }
    } catch (err) {
      this.erreur.set((err as Error).message);
    } finally {
      this.chargement.set(false);
    }
  }

  /** Change d'enfant (ou revient à « tous les enfants » avec `null`). */
  selectionner(id: string | null): void {
    const valeur = id ?? TOUS;
    this.brut.set(valeur);
    localStorage.setItem(CLE_ENFANT, valeur);
  }

  /** Oublie la sélection (déconnexion, changement de compte). */
  reinitialiser(): void {
    this.brut.set(null);
    this.enfants.set([]);
    localStorage.removeItem(CLE_ENFANT);
  }
}
