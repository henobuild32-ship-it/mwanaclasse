import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConnectiviteService } from '../../core/connectivite.service';

/**
 * Page d'accueil (spec §2) : choix d'entrée « Parent » / « École », atouts,
 * parcours en trois étapes puis liens institutionnels.
 */
@Component({
  selector: 'app-accueil',
  imports: [RouterLink],
  templateUrl: './accueil.html',
  styleUrl: './accueil.scss',
})
export class Accueil {
  protected readonly connectivite = inject(ConnectiviteService);

  /** Année affichée dans le pied de page. */
  protected readonly annee = new Date().getFullYear();
}
