import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { SessionService } from '../../core/session.service';

interface Destination {
  chemin: string;
  icone: string;
  titre: string;
  sous: string;
  /** Nombre d'éléments non lus (badge à droite), 0 = aucun badge. */
  nonLus?: () => number;
}

interface Section {
  titre: string;
  destinations: Destination[];
}

/** Menu « Plus » de l'espace école : sections + badges non lus (spec §5). */
@Component({
  selector: 'app-plus-ecole',
  imports: [RouterLink],
  templateUrl: './plus.html',
  styleUrl: './pages.scss',
})
export class PlusEcole {
  protected readonly session = inject(SessionService);
  private readonly api = inject(ApiService);

  protected readonly notificationsNonLues = signal(0);
  protected readonly demandesNonTraitees = signal(0);
  protected readonly liaisonsEnAttente = signal(0);

  protected readonly sections = computed<Section[]>(() => {
    const avecSections = this.session.sectionsVisibles();

    return [
      {
        titre: 'Scolarité',
        destinations: [
          {
            chemin: '/ecole/classes',
            icone: '🏫',
            titre: avecSections ? 'Classes & sections' : 'Classes',
            sous: avecSections ? 'Structure pédagogique' : 'Niveaux et classes',
          },
          { chemin: '/ecole/cartes', icone: '🪪', titre: 'Carte des élèves', sous: 'QR code, impression et PDF' },
        ],
      },
      {
        titre: 'Familles',
        destinations: [
          { chemin: '/ecole/parents', icone: '👨‍👩‍👧', titre: 'Parents', sous: 'Comptes et enfants rattachés' },
          {
            chemin: '/ecole/liaisons',
            icone: '🔗',
            titre: 'Demandes de liaison',
            sous: 'Valider ou refuser les liens',
            nonLus: () => this.liaisonsEnAttente(),
          },
          {
            chemin: '/ecole/demandes',
            icone: '📨',
            titre: 'Demandes des parents',
            sous: 'Répondre aux réclamations',
            nonLus: () => this.demandesNonTraitees(),
          },
        ],
      },
      {
        titre: 'Communication',
        destinations: [
          { chemin: '/ecole/communiques', icone: '📢', titre: 'Communiqués', sous: 'Rédiger et publier' },
          { chemin: '/ecole/documents', icone: '📄', titre: 'Documents', sous: 'Fichiers mis à disposition' },
          { chemin: '/ecole/calendrier', icone: '📅', titre: 'Calendrier', sous: 'Événements à venir' },
          {
            chemin: '/ecole/notifications',
            icone: '🔔',
            titre: 'Notifications',
            sous: 'Centre de notifications',
            nonLus: () => this.notificationsNonLues(),
          },
        ],
      },
      {
        titre: 'Administration',
        destinations: [
          { chemin: '/ecole/parametres', icone: '⚙️', titre: 'Paramètres', sous: 'École, personnel, sécurité' },
        ],
      },
    ];
  });

  constructor() {
    void this.chargerCompteurs();
  }

  /** Compteurs de non-lus affichés en badge (hors ligne : silencieux). */
  private async chargerCompteurs(): Promise<void> {
    try {
      const r = await this.api.lire<{ nonLues: number }>('ecole/notifications');
      this.notificationsNonLues.set(r?.nonLues ?? 0);
    } catch {
      /* hors ligne : pas de badge plutôt qu'une erreur */
    }
    try {
      const r = await this.api.lire<{ demandes: { status: string }[] }>('ecole/demandes');
      const enAttente = (r?.demandes ?? []).filter(
        (d) => d.status === 'en_attente' || d.status === 'en_cours',
      ).length;
      this.demandesNonTraitees.set(enAttente);
    } catch {
      /* best effort */
    }
    try {
      const r = await this.api.lire<{ liaisons: { status: string }[] }>('ecole/liaisons');
      const enAttente = (r?.liaisons ?? []).filter((l) => l.status === 'en_attente').length;
      this.liaisonsEnAttente.set(enAttente);
    } catch {
      /* best effort */
    }
  }
}
