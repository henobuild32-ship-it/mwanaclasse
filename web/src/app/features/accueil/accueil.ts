import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConnectiviteService } from '../../core/connectivite.service';

/**
 * Page d'accueil (spec §2) : choix d'entrée « Parent » / « École » puis
 * les liens institutionnels.
 */
@Component({
  selector: 'app-accueil',
  imports: [RouterLink],
  templateUrl: './accueil.html',
  styleUrl: './accueil.scss',
})
export class Accueil {
  protected readonly connectivite = inject(ConnectiviteService);
}
