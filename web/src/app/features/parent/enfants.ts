import { Component, ViewChild, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { ConfirmationService } from '../../core/confirmation.service';
import { EnfantActifService } from '../../core/enfant-actif.service';
import { Enfant } from '../../core/models';
import { SyncService } from '../../core/sync.service';
import { EtatVide, OverlayFormulaire, Squelette, pastillePresence } from '../../shared/ui';
import { AjouterEnfant } from './enfants-ajouter';
import { CarteEnfantModal } from './carte-enfant';
import { OptionsEnfant } from './options-enfant';
import { SuiviEnfant } from './suivi-enfant';

/** Liste des enfants rattachés au compte parent (spec §6). */
@Component({
  selector: 'app-enfants-parent',
  imports: [EtatVide, OverlayFormulaire, AjouterEnfant, SuiviEnfant, OptionsEnfant, CarteEnfantModal, Squelette],
  templateUrl: './enfants.html',
  styleUrl: './pages.scss',
})
export class EnfantsParent {
  private readonly api = inject(ApiService);
  private readonly sync = inject(SyncService);
  private readonly route = inject(ActivatedRoute);
  private readonly confirmation = inject(ConfirmationService);
  protected readonly selection = inject(EnfantActifService);

  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly enfants = signal<Enfant[]>([]);
  protected readonly ajout = signal(false);
  /** Enfant dont le suivi complet est ouvert en modal (spec B1). */
  protected readonly suiviOuvert = signal<string | null>(null);
  /** Menu d'options (carte / suivi) ouvert au-dessus de la liste. */
  protected readonly optionsOuvert = signal<string | null>(null);
  /** Carte élève (QR) affichée en plein écran. */
  protected readonly carteOuvert = signal<Enfant | null>(null);

  @ViewChild(AjouterEnfant) private formAjout?: AjouterEnfant;

  constructor() {
    // Liens « Ajouter » déjà positionnés sur /parent/enfants/ajouter.
    if (this.route.snapshot.data['ouvrirAjout']) this.ajout.set(true);
    void this.charger();
  }

  /* ---------------------------------------------------------------- */
  /*  Overlay « Ajouter un enfant »                                     */
  /* ---------------------------------------------------------------- */

  protected ouvrirAjout(): void {
    this.ajout.set(true);
  }

  /** Pastille ronde de présence du jour (vert / rouge / gris). */
  protected pastille(e: Enfant): { classe: string; titre: string } {
    return pastillePresence(e.statut_presence ?? e.presence_aujourdhui, e.jour_non_scolaire);
  }

  protected nomEnfant(id: string): string {
    return this.enfantsAffiches().find((e) => e.id === id)?.full_name ?? '';
  }

  /** Ouvre le suivi complet depuis le menu d'options de la carte. */
  protected ouvrirSuivi(id: string): void {
    this.optionsOuvert.set(null);
    this.suiviOuvert.set(id);
  }

  /** Ouvre la carte élève (QR) en plein écran depuis le menu d'options. */
  protected ouvrirCarte(id: string): void {
    const enfant = this.enfantsAffiches().find((e) => e.id === id);
    this.optionsOuvert.set(null);
    if (enfant) this.carteOuvert.set(enfant);
  }

  /**
   * Cartes à afficher : l'enfant choisi dans la barre supérieure n'affiche
   * que lui ; « Tous » regroupe tous les enfants du compte.
   */
  protected enfantsAffiches(): Enfant[] {
    const liste = this.enfants();
    const actif = this.selection.enfantActif();
    if (!actif) return liste;
    const filtre = liste.filter((e) => e.id === actif.id);
    return filtre.length ? filtre : liste;
  }

  protected fermerAjout(): void {
    void this.fermerAjoutAsync();
  }

  protected onEnfantAjoute(): void {
    this.ajout.set(false);
    void this.charger();
    void this.selection.charger(true);
  }

  /** En-cours du formulaire embarqué (pied de l'overlay). */
  protected enCoursAjout(): boolean {
    return this.formAjout?.enCours() ?? false;
  }

  /** Déclenche l'enregistrement du formulaire embarqué (pied de l'overlay). */
  protected ajouterEnfant(): void {
    void this.formAjout?.ajouter();
  }

  private async fermerAjoutAsync(): Promise<void> {
    if (this.formAjout?.modifie()) {
      const choix = await this.confirmation.demander({
        message: "L'enfant n'a pas encore été ajouté à votre compte.",
        texteEnregistrer: 'Ajouter cet enfant',
      });
      if (choix === 'reprendre') return;
      if (choix === 'enregistrer') {
        await this.formAjout.ajouter();
        // En cas d'échec de validation le formulaire reste ouvert.
        if (this.ajout()) return;
        return;
      }
    }
    this.ajout.set(false);
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      // La sélection (Tous / un enfant) a besoin de la liste pour se valider.
      await this.selection.charger();
      await this.sync.lireDabord<{ enfants: Enfant[] }>(
        'parent.enfants',
        () => this.api.lire<{ enfants: Enfant[] }>('parent/enfants'),
        (r) => this.enfants.set(r.enfants ?? []),
        { entite: 'eleves', extraire: (r) => r.enfants ?? [] },
      );
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne || (err as Error)?.message === 'HORS_LIGNE' ? 'Hors ligne : enfants indisponibles.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }
}
