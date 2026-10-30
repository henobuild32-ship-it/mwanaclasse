import { SlicePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { EcoleKinshasa } from '../../core/models';
import { Chargement, EtatVide, Etiquette } from '../../shared/ui';

/**
 * Liste des écoles inscrites à Kinshasa, réservée au Ministère de l'EPST :
 * recherche, filtre par commune, filtre statut, fiche détaillée au clic.
 */
@Component({
  selector: 'app-ecoles-ministere',
  imports: [FormsModule, Chargement, EtatVide, Etiquette],
  templateUrl: './ecoles.html',
  styleUrl: '../ecole/pages.scss',
})
export class EcolesMinistere {
  private readonly api = inject(ApiService);

  protected readonly ecoles = signal<EcoleKinshasa[]>([]);
  protected readonly communes = signal<string[]>([]);
  protected readonly total = signal(0);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');

  /** Champs des filtres (liés par ngModel, appliqués au clic Rechercher). */
  rechercheSaisie = '';
  communeSelectionnee = 'toutes';
  statutSelectionne = 'tous';

  protected readonly recherche = signal('');
  protected readonly commune = signal('toutes');
  protected readonly statut = signal('tous');

  /** Fiche ouverte (détail de l'école). */
  protected readonly fiche = signal<Record<string, unknown> | null>(null);
  protected readonly chargementFiche = signal(false);

  constructor() {
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.api.lire<{
        ecoles: EcoleKinshasa[];
        total: number;
        communes: string[];
      }>('ministere/ecoles', {
        recherche: this.recherche() || null,
        commune: this.commune() === 'toutes' ? null : this.commune(),
        statut: this.statut() === 'tous' ? null : this.statut(),
      });
      this.ecoles.set(r.ecoles ?? []);
      this.total.set(r.total ?? 0);
      this.communes.set(r.communes ?? []);
    } catch (err) {
      this.erreur.set(toApiError(err).message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected async ouvrirFiche(id: string): Promise<void> {
    this.chargementFiche.set(true);
    try {
      const r = await this.api.lire<{ ecole: Record<string, unknown> }>(
        `ministere/ecoles/${id}`,
      );
      this.fiche.set(r.ecole ?? null);
    } catch (err) {
      this.fiche.set(null);
    } finally {
      this.chargementFiche.set(false);
    }
  }

  protected fermerFiche(): void {
    this.fiche.set(null);
  }

  protected reinitialiser(): void {
    this.rechercheSaisie = '';
    this.communeSelectionnee = 'toutes';
    this.statutSelectionne = 'tous';
    this.recherche.set('');
    this.commune.set('toutes');
    this.statut.set('tous');
    void this.charger();
  }

  protected texteType(e: EcoleKinshasa): string {
    const types = Array.isArray(e.types) && e.types.length > 0 ? e.types : [];
    if (types.length > 0) {
      return types
        .map((t) => t.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()))
        .join(', ');
    }
    return (e.type ?? '').replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()) || 'Établissement';
  }
}
