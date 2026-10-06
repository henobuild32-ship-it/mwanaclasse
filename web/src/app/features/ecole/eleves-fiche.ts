import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { dateFr, dateHeureFr } from '../../core/format';
import { Eleve, ParentEcole } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';

interface ResumeMensuel {
  presents?: number;
  absents?: number;
  retards?: number;
  tauxPresence?: number;
}

interface DetailEleve {
  eleve: Eleve & {
    notesMedicales?: string | null;
    telephoneTuteur?: string | null;
    adresse?: string | null;
    annee_scolaire?: string;
    enrolled_on?: string;
  };
  parents: (ParentEcole & { status: string; relationship?: string })[];
  historique: { resumeMensuel: ResumeMensuel; derniers: unknown[] };
}

/** Fiche détaillée d'un élève (spec §5). */
@Component({
  selector: 'app-fiche-eleve',
  imports: [RouterLink, Chargement, EtatVide, Etiquette],
  templateUrl: './eleves-fiche.html',
  styleUrl: './pages.scss',
})
export class FicheEleve {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly etiquetteStatut = etiquetteStatut;
  protected readonly dateFr = dateFr;
  protected readonly dateHeureFr = dateHeureFr;

  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly donnees = signal<DetailEleve | null>(null);

  private id = '';

  constructor() {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    void this.charger();
  }

  protected eleve(): DetailEleve['eleve'] | null {
    return this.donnees()?.eleve ?? null;
  }

  protected resume(): ResumeMensuel {
    return this.donnees()?.historique?.resumeMensuel ?? {};
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      this.donnees.set(await this.api.lire<DetailEleve>(`ecole/eleves/${this.id}`));
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  protected async changerEtat(archiver: boolean): Promise<void> {
    try {
      await this.api.envoyer(
        archiver ? `ecole/eleves/${this.id}/archiver` : `ecole/eleves/${this.id}/reactiver`,
        {},
      );
      this.toasts.succes(archiver ? 'Élève archivé.' : 'Élève réactivé.');
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    }
  }

  protected retour(): void {
    void this.router.navigate(['/ecole/eleves']);
  }
}
