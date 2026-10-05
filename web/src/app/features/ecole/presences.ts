import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { ExportService } from '../../core/export.service';
import { Classe, PresencesEleve, RecapPresence } from '../../core/models';
import { ConnectiviteService } from '../../core/connectivite.service';
import { SessionService } from '../../core/session.service';
import { SyncService } from '../../core/sync.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut } from '../../shared/ui';

type Statut = 'present' | 'absent' | 'retard' | 'depart_anticipe';

const STATUTS: { valeur: Statut; libelle: string; variante: 'succes' | 'danger' | 'attention' | 'info' }[] = [
  { valeur: 'present', libelle: 'Présent', variante: 'succes' },
  { valeur: 'retard', libelle: 'Retard', variante: 'attention' },
  { valeur: 'absent', libelle: 'Absent', variante: 'danger' },
  { valeur: 'depart_anticipe', libelle: 'Départ', variante: 'info' },
];

interface ReponsePresences {
  eleves: PresencesEleve[];
  recap: RecapPresence;
}

/** Feuille de présence (spec §18 — mode hors ligne) + export PDF/DOCX. */
@Component({
  selector: 'app-presences-ecole',
  imports: [FormsModule, Chargement, EtatVide],
  templateUrl: './presences.html',
  styleUrl: './pages.scss',
})
export class PresencesEcole {
  private readonly api = inject(ApiService);
  private readonly export = inject(ExportService);
  private readonly sync = inject(SyncService);
  private readonly connectivite = inject(ConnectiviteService);
  private readonly toasts = inject(ToastService);
  protected readonly session = inject(SessionService);
  protected readonly etiquetteStatut = etiquetteStatut;
  protected readonly statuts = STATUTS;

  protected readonly date = signal(new Date().toISOString().slice(0, 10));
  protected readonly classeId = signal('');
  protected readonly classes = signal<Classe[]>([]);
  protected readonly eleves = signal<PresencesEleve[]>([]);
  protected readonly recap = signal<RecapPresence | null>(null);
  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly sauvegardeEnCours = signal(false);
  protected readonly exportEnCours = signal(false);
  /** Modifications locales non encore enregistrées. */
  protected readonly brouillon = signal<Record<string, Statut>>({});
  protected readonly modifie = signal(false);

  constructor() {
    void this.chargerClasses();
  }

  protected get enLigne(): boolean {
    return this.connectivite.enLigne();
  }

  protected get operationsEnFile(): number {
    return this.sync.operationsEnFile();
  }

  protected async chargerClasses(): Promise<void> {
    try {
      const r = await this.api.lire<{ classes: Classe[] }>('ecole/classes');
      const classes = r.classes ?? [];
      this.classes.set(classes);
      if (!this.classeId() && classes.length) this.classeId.set(classes[0].id);
    } catch (err) {
      const e = toApiError(err);
      if (!e.horsLigne) this.erreur.set(e.message);
    }
    await this.chargerFeuille();
  }

  protected async chargerFeuille(): Promise<void> {
    if (!this.classeId()) {
      this.eleves.set([]);
      this.chargement.set(false);
      return;
    }
    this.chargement.set(true);
    this.erreur.set('');
    try {
      const r = await this.sync.lire(
        'presences',
        () =>
          this.api.lire<ReponsePresences>('ecole/presences', {
            date: this.date(),
            classeId: this.classeId(),
          }),
        (rep) => rep.eleves ?? [],
      );
      const liste = (r.eleves ?? []) as unknown as PresencesEleve[];
      this.eleves.set(liste);
      this.recap.set(r.recap ?? null);
      // Le brouillon local repart de l'état serveur.
      const brut: Record<string, Statut> = {};
      for (const e of liste) {
        if (e.status && e.status !== 'non_enregistre') {
          brut[e.student_id] = e.status as Statut;
        }
      }
      this.brouillon.set(brut);
      this.modifie.set(false);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne et aucune feuille en cache.' : e.message);
      this.eleves.set([]);
    } finally {
      this.chargement.set(false);
    }
  }

  protected statutDe(eleve: PresencesEleve): Statut | undefined {
    return this.brouillon()[eleve.student_id];
  }

  protected choisir(eleve: PresencesEleve, statut: Statut): void {
    this.brouillon.update((b) => ({ ...b, [eleve.student_id]: statut }));
    this.modifie.set(true);
  }

  protected toutPresent(): void {
    const b: Record<string, Statut> = {};
    for (const e of this.eleves()) b[e.student_id] = 'present';
    this.brouillon.set(b);
    this.modifie.set(true);
  }

  protected async enregistrer(): Promise<void> {
    const eleves = this.eleves();
    if (!eleves.length || this.sauvegardeEnCours()) return;

    const brouillon = this.brouillon();
    const entries = eleves
      .filter((e) => brouillon[e.student_id])
      .map((e) => ({ studentId: e.student_id, status: brouillon[e.student_id] }));

    if (!entries.length) {
      this.toasts.info('Aucune présence à enregistrer.');
      return;
    }

    const feuille = {
      classId: this.classeId(),
      date: this.date(),
      method: this.enLigne ? 'manuel_classe' : 'sync_offline',
      entries,
      deviceId: this.session.profil()?.id ?? undefined,
    };

    this.sauvegardeEnCours.set(true);
    try {
      if (this.enLigne) {
        await this.api.envoyer('ecole/presences', feuille);
        this.toasts.succes('Présences enregistrées.');
        await this.chargerFeuille();
      } else {
        await this.sync.soumettre({
          entityType: 'attendance.bulk',
          opType: 'upsert',
          payload: feuille as unknown as Record<string, unknown>,
          deviceId: this.session.profil()?.id ?? null,
        });
        this.toasts.info('Hors ligne : feuille mise en file, envoi au retour du réseau.');
        this.modifie.set(false);
      }
    } catch (err) {
      const e = toApiError(err);
      if (e.horsLigne) {
        await this.sync.soumettre({
          entityType: 'attendance.bulk',
          opType: 'upsert',
          payload: feuille as unknown as Record<string, unknown>,
          deviceId: this.session.profil()?.id ?? null,
        });
        this.toasts.info('Connexion perdue : feuille conservée hors ligne.');
        this.modifie.set(false);
      } else {
        this.toasts.erreur(e.message);
      }
    } finally {
      this.sauvegardeEnCours.set(false);
    }
  }

  /** Prépare les données et exporte en PDF */
  protected async exporterPDF(): Promise<void> {
    if (!this.classeId() || !this.eleves().length) {
      this.toasts.info('Aucune donnée à exporter.');
      return;
    }
    this.exportEnCours.set(true);
    try {
      const donnees = await this.export.preparerExport(this.date(), this.classeId());
      await this.export.genererPDF(donnees);
      this.toasts.succes('PDF généré avec succès.');
    } catch (err) {
      this.toasts.erreur('Échec de la génération du PDF.');
    } finally {
      this.exportEnCours.set(false);
    }
  }

  /** Prépare les données et exporte en DOCX */
  protected async exporterDOCX(): Promise<void> {
    if (!this.classeId() || !this.eleves().length) {
      this.toasts.info('Aucune donnée à exporter.');
      return;
    }
    this.exportEnCours.set(true);
    try {
      const donnees = await this.export.preparerExport(this.date(), this.classeId());
      await this.export.genererDOCX(donnees);
      this.toasts.succes('DOCX généré avec succès.');
    } catch (err) {
      this.toasts.erreur('Échec de la génération du DOCX.');
    } finally {
      this.exportEnCours.set(false);
    }
  }
}