import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { EnfantActifService } from '../../core/enfant-actif.service';
import { SessionService } from '../../core/session.service';
import { SyncService } from '../../core/sync.service';

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

/** Menu « Plus » de l'espace parent (spec §6) : sections + badges non lus. */
@Component({
  selector: 'app-plus-parent',
  imports: [RouterLink],
  templateUrl: './plus.html',
  styleUrl: './pages.scss',
})
export class PlusParent {
  protected readonly session = inject(SessionService);
  private readonly api = inject(ApiService);
  private readonly sync = inject(SyncService);
  private readonly selection = inject(EnfantActifService);

  protected readonly communiquesNonLus = signal(0);
  protected readonly notificationsNonLues = signal(0);

  protected readonly sections: Section[] = [
    {
      titre: 'École',
      destinations: [
        {
          chemin: '/parent/communiques',
          icone: '📢',
          titre: 'Communiqués',
          sous: 'Messages de l’école',
          nonLus: () => this.communiquesNonLus(),
        },
        { chemin: '/parent/calendrier', icone: '📅', titre: 'Calendrier', sous: 'Événements à venir' },
        { chemin: '/parent/documents', icone: '📄', titre: 'Documents', sous: 'Fichiers de l’école' },
      ],
    },
    {
      titre: 'Alertes',
      destinations: [
        {
          chemin: '/parent/notifications',
          icone: '🔔',
          titre: 'Notifications',
          sous: 'Centre de notifications',
          nonLus: () => this.notificationsNonLues(),
        },
      ],
    },
    {
      titre: 'Mes enfants',
      destinations: [
        { chemin: '/parent/enfants/ajouter', icone: '➕', titre: 'Ajouter un enfant', sous: 'Avec le code unique de l’élève' },
      ],
    },
    {
      titre: 'Compte',
      destinations: [
        { chemin: '/parent/profil', icone: '👤', titre: 'Mon profil', sous: 'Informations et mot de passe' },
      ],
    },
  ];

  constructor() {
    void this.chargerCompteurs();
  }

  /** Compteurs de non-lus affichés en badge (hors ligne : cache local). */
  private async chargerCompteurs(): Promise<void> {
    try {
      await this.selection.charger();
      const ecoleId = this.selection.ecoleId();
      await this.sync.lireDabord<{ nonLus: number }>(
        `parent.communiques:${ecoleId ?? 'toutes'}`,
        () => this.api.lire<{ nonLus: number }>('parent/communiques', this.selection.params),
        (r) => this.communiquesNonLus.set(r?.nonLus ?? 0),
      );
    } catch {
      /* compteur facultatif : le menu reste utilisable hors ligne */
    }
    try {
      const r = await this.api.lire<{ nonLues: number }>('parent/notifications', this.selection.params);
      this.notificationsNonLues.set(r?.nonLues ?? 0);
    } catch {
      /* hors ligne : pas de badge plutôt qu'une erreur */
    }
  }
}
