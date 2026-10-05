import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionService } from '../../core/session.service';

interface Destination {
  chemin: string;
  icone: string;
  titre: string;
  sous: string;
}

/** Menu « Plus » de l'espace parent (spec §6). */
@Component({
  selector: 'app-plus-parent',
  imports: [RouterLink],
  templateUrl: './plus.html',
  styleUrl: './pages.scss',
})
export class PlusParent {
  protected readonly session = inject(SessionService);

  protected readonly destinations: Destination[] = [
    { chemin: '/parent/communiques', icone: '📢', titre: 'Communiqués', sous: 'Messages de l’école' },
    { chemin: '/parent/calendrier', icone: '📅', titre: 'Calendrier', sous: 'Événements à venir' },
    { chemin: '/parent/documents', icone: '📄', titre: 'Documents', sous: 'Fichiers de l’école' },
    { chemin: '/parent/notifications', icone: '🔔', titre: 'Notifications', sous: 'Centre de notifications' },
    { chemin: '/parent/ajouter-ecole', icone: '🏫', titre: 'Rejoindre une école', sous: 'Avec le code de l’établissement' },
    { chemin: '/parent/profil', icone: '👤', titre: 'Mon profil', sous: 'Informations et mot de passe' },
  ];
}
