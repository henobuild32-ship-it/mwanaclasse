import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { ApiService, toApiError } from '../../core/api.service';
import { CommuniqueMinistere } from '../../core/models';
import { Chargement, EtatVide, Etiquette } from '../../shared/ui';

/**
 * Communiqués officiels reçus du Ministère de l'EPST :
 * seuls les communiqués destinés à cette école s'affichent
 * (ceux pour toutes les écoles + ceux pour elle seule). Lecture seule.
 */
@Component({
  selector: 'app-communiques-recus',
  imports: [SlicePipe, Chargement, EtatVide, Etiquette],
  templateUrl: './communiques-recus.html',
  styleUrl: './pages.scss',
})
export class CommuniquesRecusMinistere {
  private readonly api = inject(ApiService);

  protected readonly communiques = signal<CommuniqueMinistere[]>([]);
  protected readonly nonLus = signal(0);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');

  /** Détail ouvert d'un communiqué. */
  protected readonly ouvertId = signal<string | null>(null);

  constructor() {
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.api.lire<{
        communiques: CommuniqueMinistere[];
        nonLusCount: number;
      }>('ecole/communiques-recus');
      // Le plus récent en haut (l'API trie déjà DESC, on l'assure côté affichage).
      this.communiques.set(
        [...(r.communiques ?? [])].sort((a, b) => b.sent_at.localeCompare(a.sent_at)),
      );
      this.nonLus.set(r.nonLusCount ?? 0);
    } catch (err) {
      this.erreur.set(toApiError(err).message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected basculer(id: string): void {
    const ouvert = this.ouvertId() === id;
    this.ouvertId.set(ouvert ? null : id);
    if (!ouvert) {
      const c = this.communiques().find((x) => x.id === id);
      if (c && !c.lu) {
        void this.marquerLu(id);
      }
    }
  }

  private async marquerLu(id: string): Promise<void> {
    try {
      await this.api.post(`ecole/communiques-recus/${id}/lire`);
      const liste = this.communiques().map((c) =>
        c.id === id ? { ...c, lu: true, read_at: new Date().toISOString() } : c,
      );
      this.communiques.set(liste);
      this.nonLus.set(Math.max(0, this.nonLus() - 1));
    } catch {
      /* hors ligne : reverrouillé à la reconnexion */
    }
  }
}
