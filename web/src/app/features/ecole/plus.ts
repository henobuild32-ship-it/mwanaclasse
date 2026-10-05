import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionService } from '../../core/session.service';

interface Destination {
  chemin: string;
  icone: string;
  titre: string;
  sous: string;
}

/** Menu « Plus » de l'espace école : accès à toutes les fonctions (spec §5). */
@Component({
  selector: 'app-plus-ecole',
  imports: [RouterLink],
  templateUrl: './plus.html',
  styleUrl: './pages.scss',
})
export class PlusEcole {
  protected readonly session = inject(SessionService);

  protected readonly destinations: Destination[] = [
    { chemin: '/ecole/classes', icone: '🏫', titre: 'Classes & sections', sous: 'Structure pédagogique' },
    { chemin: '/ecole/parents', icone: '👨‍👩‍👧', titre: 'Parents', sous: 'Comptes et enfants rattachés' },
    { chemin: '/ecole/liaisons', icone: '🔗', titre: 'Demandes de liaison', sous: 'Valider ou refuser les liens' },
    { chemin: '/ecole/communiques', icone: '📢', titre: 'Communiqués', sous: 'Rédiger et publier' },
    { chemin: '/ecole/demandes', icone: '📨', titre: 'Demandes des parents', sous: 'Répondre aux réclamations' },
    { chemin: '/ecole/documents', icone: '📄', titre: 'Documents', sous: 'Fichiers mis à disposition' },
    { chemin: '/ecole/calendrier', icone: '📅', titre: 'Calendrier', sous: 'Événements à venir' },
    { chemin: '/ecole/notifications', icone: '🔔', titre: 'Notifications', sous: 'Centre de notifications' },
    { chemin: '/ecole/parametres', icone: '⚙️', titre: 'Paramètres', sous: 'École, personnel, sécurité' },
  ];
}
