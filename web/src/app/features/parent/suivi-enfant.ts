import { SlicePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, input, output, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';
import { CalendrierPresence } from './calendrier-presence';

interface FicheEnfant {
  eleve: {
    id: string;
    full_name: string;
    public_code: string;
    classe?: string | null;
    section?: string | null;
    ecole?: string | null;
    phone_contact?: string | null;
    email_ecole?: string | null;
    relationship?: string | null;
    lien_statut?: string | null;
    presence_aujourdhui?: string | null;
  };
  jourAujourdhui?: { ferme?: boolean; libelle?: string | null };
  clarification?: string;
}

interface HistoriqueJour {
  attendance_date: string;
  status: string;
  arrival_time?: string | null;
  departure_time?: string | null;
  reason?: string | null;
}

/**
 * Modal « Suivi complet » (spec B1) : bottom sheet sur mobile, centré sur
 * tablette, ouvert PAR-DESSUS l'accueil sans navigation ni rechargement.
 * Fermeture : X, clic sur le fond, glissement vers le bas, retour téléphone.
 */
@Component({
  selector: 'app-suivi-enfant',
  imports: [SlicePipe, Chargement, EtatVide, Etiquette, CalendrierPresence],
  templateUrl: './suivi-enfant.html',
  styleUrl: './pages.scss',
})
export class SuiviEnfant implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly etiquetteStatut = etiquetteStatut;

  readonly enfantId = input.required<string>();
  readonly fermeture = output<void>();

  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly fiche = signal<FicheEnfant | null>(null);
  protected readonly historique = signal<HistoriqueJour[]>([]);

  /** Suivi du glissement tactile (fermeture par balayage vers le bas). */
  private toucheY: number | null = null;
  private deplacement = 0;
  private fermeEnCours = false;
  /** Position de scroll de la page avant l'ouverture (verrou iOS). */
  private scrollYDepart = 0;

  protected readonly glissement = signal(0);

  ngOnInit(): void {
    // Verrou du scroll d'arrière-plan : position:fixed indispensable sur
    // iOS Safari (overflow:hidden seul ne bloque pas → la page défilait
    // derrière le modal et celui-ci semblait « cale » vers la fin).
    this.scrollYDepart = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${this.scrollYDepart}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    // Bouton retour du téléphone : ferme le modal au lieu de quitter la page.
    history.pushState({ mwanaFeuille: true }, '');
    window.addEventListener('popstate', this.onPopstate);
    void this.charger();
  }

  ngOnDestroy(): void {
    // Restaure le scroll d'arrière-plan à sa position d'origine.
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    window.scrollTo(0, this.scrollYDepart);
    window.removeEventListener('popstate', this.onPopstate);
    // Si le modal est détruit sans passer par popstate (navigation), on
    // retire proprement l'entrée d'historique ajoutée à l'ouverture.
    if (!this.fermeEnCours && history.state?.mwanaFeuille) {
      history.replaceState(null, '');
    }
  }

  private readonly onPopstate = (): void => {
    this.sortirSansHistorique();
  };

  /** Fermeture par l'interface (X, fond, glissement) : on revient en arrière. */
  protected fermer(): void {
    if (this.fermeEnCours) return;
    if (history.state?.mwanaFeuille) {
      // popstate fera le reste — pas de double émission.
      history.back();
    } else {
      this.sortirSansHistorique();
    }
  }

  private sortirSansHistorique(): void {
    if (this.fermeEnCours) return;
    this.fermeEnCours = true;
    this.fermeture.emit();
  }

  /* ---------------------------------------------------------------- */
  /*  Glissement vers le bas pour fermer                              */
  /* ---------------------------------------------------------------- */

  /**
   * Le swipe-to-close n'est actif que si le contenu scrollé est en haut.
   * Sans cette garde, dès que le doigt descend (défilement du contenu vers
   * le haut), la feuille entière se translatait avec le geste : le modal
   * « calait » au milieu du défilement.
   */
  private contenuEnHaut(event: TouchEvent): boolean {
    const cible = event.target as HTMLElement | null;
    const corps = cible?.closest('.feuille__corps') as HTMLElement | null;
    if (!corps) return true;
    return corps.scrollTop <= 0;
  }

  protected toucheDebut(event: TouchEvent): void {
    if (!this.contenuEnHaut(event)) {
      this.toucheY = null;
      return;
    }
    this.toucheY = event.touches[0]?.clientY ?? null;
    this.deplacement = 0;
  }

  protected toucheMove(event: TouchEvent): void {
    if (this.toucheY === null) return;
    // Le contenu a défilé depuis le début du geste : on abandonne le swipe
    // pour laisser le défilement natif faire son travail.
    if (!this.contenuEnHaut(event)) {
      this.toucheY = null;
      this.deplacement = 0;
      this.glissement.set(0);
      return;
    }
    const y = event.touches[0]?.clientY ?? null;
    if (y === null) return;
    // Balayage strictement descendant, depuis le haut de la feuille.
    this.deplacement = Math.max(0, y - this.toucheY);
    this.glissement.set(this.deplacement);
  }

  protected toucheFin(): void {
    if (this.deplacement > 90) this.fermer();
    this.toucheY = null;
    this.deplacement = 0;
    this.glissement.set(0);
  }

  /* ---------------------------------------------------------------- */
  /*  Données                                                          */
  /* ---------------------------------------------------------------- */

  private async charger(): Promise<void> {
    const id = this.enfantId();
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const fiche = await this.api.lire<FicheEnfant>(`parent/enfants/${id}`);
      this.fiche.set(fiche);
      try {
        const h = await this.api.lire<{ jours: HistoriqueJour[] }>(
          `parent/enfants/${id}/historique`,
        );
        this.historique.set((h.jours ?? []).slice(0, 10));
      } catch {
        this.historique.set([]);
      }
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : suivi indisponible.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected statutAujourdhui(): { texte: string; variante: 'neutre' | 'succes' | 'danger' | 'attention' | 'info' } {
    const jour = this.fiche()?.jourAujourdhui;
    if (jour?.ferme) {
      const libelle = jour.libelle ?? '';
      if (libelle.startsWith('Jour férié')) return { texte: libelle, variante: 'danger' };
      if (libelle.startsWith('École fermée')) return { texte: libelle, variante: 'attention' };
      return { texte: libelle || 'Jour non scolaire', variante: 'neutre' };
    }
    return etiquetteStatut(this.fiche()?.eleve?.presence_aujourdhui ?? 'non_enregistre');
  }

  protected ouvrirDemandes(): void {
    this.fermer();
    void this.router.navigate(['/parent/demandes']);
  }

  protected async demanderClarification(): Promise<void> {
    const id = this.enfantId();
    try {
      await this.api.envoyer('parent/demandes', {
        studentId: id,
        kind: 'question_presence',
        subject: 'Demande de clarification',
        message: "Bonjour, je souhaite obtenir des précisions sur la présence de mon enfant.",
      });
      this.toasts.succes("Demande envoyée à l'école.");
      this.ouvrirDemandes();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    }
  }
}
