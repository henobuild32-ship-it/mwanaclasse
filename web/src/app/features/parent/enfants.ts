import { Component, ViewChild, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { ConfirmationService } from '../../core/confirmation.service';
import { EnfantActifService } from '../../core/enfant-actif.service';
import { Enfant } from '../../core/models';
import { SyncService } from '../../core/sync.service';
import { EtatVide, Etiquette, etiquetteStatut, OverlayFormulaire, Squelette } from '../../shared/ui';
import { AjouterEnfant } from './enfants-ajouter';
import { SuiviEnfant } from './suivi-enfant';

/** Liste des enfants rattachés au compte parent (spec §6). */
@Component({
  selector: 'app-enfants-parent',
  imports: [EtatVide, Etiquette, OverlayFormulaire, AjouterEnfant, SuiviEnfant, Squelette],
  templateUrl: './enfants.html',
  styleUrl: './pages.scss',
})
export class EnfantsParent {
  private readonly api = inject(ApiService);
  private readonly sync = inject(SyncService);
  private readonly route = inject(ActivatedRoute);
  private readonly confirmation = inject(ConfirmationService);
  protected readonly selection = inject(EnfantActifService);
  protected readonly etiquetteStatut = etiquetteStatut;

  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly enfants = signal<Enfant[]>([]);
  protected readonly ajout = signal(false);
  /** Enfant dont le suivi complet est ouvert en modal (spec B1). */
  protected readonly suiviOuvert = signal<string | null>(null);

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
