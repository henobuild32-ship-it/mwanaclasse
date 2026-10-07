import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService, toApiError } from '../../core/api.service';
import { ExportService } from '../../core/export.service';
import { Classe, PresencesEleve, RecapPresence } from '../../core/models';
import { ConnectiviteService } from '../../core/connectivite.service';
import { SessionService } from '../../core/session.service';
import { SyncService } from '../../core/sync.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide } from '../../shared/ui';

type Statut = 'present' | 'absent' | 'retard' | 'depart_anticipe';
type FiltreStatut = Statut | 'non_enregistre';

interface EntreeBrouillon {
  status?: Statut;
  arrivalTime?: string;
  reason?: string;
  adminNote?: string;
  justified?: boolean;
}

interface InstantanePresence {
  id: string;
  classeId: string;
  date: string;
  eleves: PresencesEleve[];
  recap: RecapPresence;
  enregistreLe?: number;
}

interface EleveCachePresence {
  id: string;
  public_code: string;
  full_name: string;
  gender?: string | null;
  status: string;
  class_id: string;
  section_id?: string | null;
  classe: string;
  section?: string | null;
}

interface PresenceCacheSynchro extends PresencesEleve {
  attendance_date: string;
}

interface DetailsFormulaire {
  reason: string;
  note: string;
  justified: boolean;
  arrivalTime: string;
}

const STATUTS: { valeur: Statut; libelle: string; variante: 'succes' | 'danger' | 'attention' | 'info' }[] = [
  { valeur: 'present', libelle: 'Présent', variante: 'succes' },
  { valeur: 'retard', libelle: 'Retard', variante: 'attention' },
  { valeur: 'absent', libelle: 'Absent', variante: 'danger' },
  { valeur: 'depart_anticipe', libelle: 'Départ', variante: 'info' },
];

const RAISONS_ABSENCE = [
  { valeur: 'maladie', libelle: 'Maladie' },
  { valeur: 'famille', libelle: 'Motif familial' },
  { valeur: 'transport', libelle: 'Transport' },
  { valeur: 'autre', libelle: 'Autre' },
];

const NOTE_META = 'MC-PRESENCE-V1:';

interface ReponsePresences {
  eleves: PresencesEleve[];
  recap: RecapPresence;
}

/** Feuille de présence (spec §18 — mode hors ligne) + export PDF/DOCX. */
@Component({
  selector: 'app-presences-ecole',
  imports: [FormsModule, RouterLink, Chargement, EtatVide],
  templateUrl: './presences.html',
  styleUrl: './presences.scss',
})
export class PresencesEcole {
  private readonly api = inject(ApiService);
  private readonly export = inject(ExportService);
  private readonly sync = inject(SyncService);
  private readonly connectivite = inject(ConnectiviteService);
  private readonly toasts = inject(ToastService);
  protected readonly session = inject(SessionService);
  protected readonly statuts = STATUTS;
  protected readonly raisonsAbsence = RAISONS_ABSENCE;

  protected readonly date = signal(new Date().toISOString().slice(0, 10));
  protected readonly classeId = signal('');
  protected readonly classes = signal<Classe[]>([]);
  protected readonly eleves = signal<PresencesEleve[]>([]);
  protected readonly recap = signal<RecapPresence | null>(null);
  protected readonly chargement = signal(true);
  protected readonly chargementFond = signal(false);
  protected readonly erreur = signal('');
  protected readonly sauvegardeEnCours = signal(false);
  protected readonly exportEnCours = signal(false);
  protected readonly brouillon = signal<Record<string, EntreeBrouillon>>({});
  protected readonly selection = signal<Record<string, boolean>>({});
  protected readonly filtre = signal<FiltreStatut | null>(null);
  protected readonly detailsEleveId = signal<string | null>(null);
  protected readonly detailsFormulaire = signal<DetailsFormulaire>(this.formulaireVide());
  protected readonly etatFeuille = signal<'local' | 'synchronise' | 'attente' | null>(null);
  protected readonly instantaneEnregistre = signal(0);
  protected readonly aChargeUneFois = signal(false);
  private readonly base = signal<Record<string, EntreeBrouillon>>({});
  private derniereSyncTraitee = 0;

  protected readonly compteurs = computed(() => {
    const brouillon = this.brouillon();
    const eleves = this.eleves();
    return {
      presents: eleves.filter((e) => brouillon[e.student_id]?.status === 'present').length,
      absents: eleves.filter((e) => brouillon[e.student_id]?.status === 'absent').length,
      retards: eleves.filter((e) => brouillon[e.student_id]?.status === 'retard').length,
      nonEnregistres: eleves.filter((e) => !brouillon[e.student_id]?.status).length,
    };
  });

  protected readonly elevesFiltres = computed(() => {
    const filtre = this.filtre();
    if (!filtre) return this.eleves();
    return this.eleves().filter((e) => {
      const statut = this.brouillon()[e.student_id]?.status;
      return filtre === 'non_enregistre' ? !statut : statut === filtre;
    });
  });

  protected readonly nombreModifications = computed(() =>
    this.eleves().filter((e) => {
      const id = e.student_id;
      return JSON.stringify(this.brouillon()[id] ?? {}) !== JSON.stringify(this.base()[id] ?? {});
    }).length,
  );

  protected readonly modifie = computed(() => this.nombreModifications() > 0);
  protected readonly selectionnes = computed(() => Object.values(this.selection()).filter(Boolean).length);
  protected readonly etatVisible = computed(() => {
    if (this.sync.operationsEnErreur() > 0) return 'erreur';
    if (this.etatFeuille() === 'local' && this.operationsEnFile > 0) return 'attente';
    const derniereSynchro = this.sync.derniereSynchro()?.getTime() ?? 0;
    if (
      this.etatFeuille() === 'local' && this.enLigne && this.operationsEnFile === 0 &&
      derniereSynchro >= this.instantaneEnregistre()
    ) return 'synchronise';
    return this.etatFeuille();
  });

  constructor() {
    this.derniereSyncTraitee = this.sync.derniereSynchro()?.getTime() ?? 0;
    effect(() => {
      const horodatage = this.sync.derniereSynchro()?.getTime() ?? 0;
      if (horodatage <= this.derniereSyncTraitee) return;
      this.derniereSyncTraitee = horodatage;
      if (this.aChargeUneFois() && this.enLigne && !this.modifie() && !this.sauvegardeEnCours()) {
        void this.chargerFeuille();
      }
    });
    void this.chargerClasses();
  }

  protected get enLigne(): boolean {
    return this.connectivite.enLigne();
  }

  protected get operationsEnFile(): number {
    return this.sync.operationsEnFile();
  }

  protected get operationsEnErreur(): number {
    return this.sync.operationsEnErreur();
  }

  protected get eleveDetails(): PresencesEleve | undefined {
    const id = this.detailsEleveId();
    return id ? this.eleves().find((e) => e.student_id === id) : undefined;
  }

  protected get horsLigne(): boolean {
    return !this.connectivite.enLigne();
  }

  protected get synchronisationEnCours(): boolean {
    return this.sync.statutSync() === 'en_cours';
  }

  protected async chargerClasses(): Promise<void> {
    try {
      let classes: Classe[];
      if (this.connectivite.enLigne()) {
        const r = await this.api.lire<{ classes: Classe[] }>('ecole/classes');
        classes = r.classes ?? [];
        await this.sync.mettreEnCache('classes', classes);
      } else {
        classes = await this.sync.depuisLeCache<Classe>('classes');
      }
      this.classes.set(classes);
      if (!this.classeId() && classes.length) this.classeId.set(classes[0].id);
    } catch (err) {
      const e = toApiError(err);
      if (!e.horsLigne) this.erreur.set(e.message);
      else this.classes.set(await this.sync.depuisLeCache<Classe>('classes'));
    }
    await this.chargerFeuille();
  }

  protected async chargerFeuille(): Promise<void> {
    if (!this.classeId()) {
      this.eleves.set([]);
      this.recap.set(null);
      this.brouillon.set({});
      this.base.set({});
      this.chargement.set(false);
      this.chargementFond.set(false);
      return;
    }
    const cle = this.cleInstantane();
    let cache = (await this.sync.depuisLeCache<InstantanePresence>('presences'))
      .find((ligne) => ligne.id === cle);
    if (!cache && !this.connectivite.enLigne()) {
      cache = await this.construireInstantaneLocal();
      if (cache) await this.sync.mettreEnCache('presences', [cache]);
    }
    if (cache && !this.modifie()) {
      this.installerFeuille(cache.eleves, cache.recap);
      this.instantaneEnregistre.set(cache.enregistreLe ?? 0);
    } else if (!cache) {
      this.eleves.set([]);
      this.recap.set(null);
      this.brouillon.set({});
      this.base.set({});
    }
    this.chargement.set(!cache && !this.aChargeUneFois());
    this.chargementFond.set(this.connectivite.enLigne());
    this.erreur.set('');
    if (!this.connectivite.enLigne()) {
      this.etatFeuille.set(cache ? 'local' : null);
      if (!cache) this.erreur.set('Hors ligne : aucune feuille enregistrée sur cet appareil pour cette classe et cette date.');
      this.chargement.set(false);
      this.chargementFond.set(false);
      this.aChargeUneFois.set(true);
      return;
    }
    try {
      if (cache) this.chargementFond.set(true);
      const r = await this.api.lire<ReponsePresences>('ecole/presences', {
        date: this.date(),
        classeId: this.classeId(),
      });
      const liste = r.eleves ?? [];
      this.installerFeuille(liste, r.recap);
      await this.enregistrerInstantane(liste, r.recap);
      this.etatFeuille.set('synchronise');
    } catch (err) {
      const e = toApiError(err);
      if (e.horsLigne && cache) {
        this.etatFeuille.set('local');
      } else {
        this.erreur.set(e.horsLigne ? 'Hors ligne : aucune feuille enregistrée sur cet appareil pour cette classe et cette date.' : e.message);
        if (!cache) this.eleves.set([]);
      }
    } finally {
      this.chargement.set(false);
      this.chargementFond.set(false);
      this.aChargeUneFois.set(true);
    }
  }

  protected changerDate(valeur: string): void {
    if (this.modifie()) {
      this.toasts.info('Enregistrez la feuille avant de changer de date.');
      return;
    }
    this.date.set(valeur);
    void this.chargerFeuille();
  }

  protected changerClasse(valeur: string): void {
    if (this.modifie()) {
      this.toasts.info('Enregistrez la feuille avant de changer de classe.');
      return;
    }
    this.classeId.set(valeur);
    void this.chargerFeuille();
  }

  protected statutDe(eleve: PresencesEleve): Statut | undefined {
    return this.brouillon()[eleve.student_id]?.status;
  }

  protected choisir(eleve: PresencesEleve, statut: Statut): void {
    this.choisirStatut(eleve.student_id, statut);
  }

  protected toutPresent(): void {
    this.brouillon.update((b) => {
      const suivant = { ...b };
      for (const e of this.eleves()) suivant[e.student_id] = { ...suivant[e.student_id], status: 'present' };
      return suivant;
    });
    this.selection.set({});
  }

  protected basculerFiltre(statut: FiltreStatut): void {
    this.filtre.update((actuel) => (actuel === statut ? null : statut));
  }

  protected selectionner(eleveId: string, coche: boolean): void {
    this.selection.update((actuelle) => ({ ...actuelle, [eleveId]: coche }));
  }

  protected selectionnerTous(coche: boolean): void {
    this.selection.set(Object.fromEntries(this.elevesFiltres().map((e) => [e.student_id, coche])));
  }

  protected appliquerSelection(statut: Statut): void {
    const ids = Object.entries(this.selection()).filter(([, coche]) => coche).map(([id]) => id);
    this.brouillon.update((b) => {
      const suivant = { ...b };
      for (const id of ids) {
        suivant[id] = {
          ...suivant[id],
          status: statut,
          ...(statut === 'retard' && !suivant[id]?.arrivalTime ? { arrivalTime: this.heureActuelle() } : {}),
        };
      }
      return suivant;
    });
    this.selection.set({});
  }

  protected estSelectionne(id: string): boolean {
    return !!this.selection()[id];
  }

  protected aDetails(eleve: PresencesEleve): boolean {
    const entree = this.brouillon()[eleve.student_id];
    return !!(entree?.reason || entree?.adminNote || entree?.arrivalTime);
  }

  protected ouvrirDetails(eleve: PresencesEleve): void {
    const entree = this.brouillon()[eleve.student_id] ?? {};
    const details = this.lireMetaNote(entree.adminNote ?? eleve.admin_note ?? '');
    this.detailsFormulaire.set({
      reason: entree.reason ?? eleve.reason ?? '',
      note: details.note,
      justified: details.justified,
      arrivalTime: entree.arrivalTime ?? eleve.arrival_time?.slice(0, 5) ?? this.heureActuelle(),
    });
    this.detailsEleveId.set(eleve.student_id);
  }

  protected fermerDetails(): void {
    this.detailsEleveId.set(null);
  }

  protected majDetails<K extends keyof DetailsFormulaire>(champ: K, valeur: DetailsFormulaire[K]): void {
    this.detailsFormulaire.update((formulaire) => ({ ...formulaire, [champ]: valeur }));
  }

  protected enregistrerDetails(): void {
    const id = this.detailsEleveId();
    if (!id) return;
    const details = this.detailsFormulaire();
    const adminNote = `${NOTE_META}${JSON.stringify({ justified: details.justified, note: details.note.slice(0, 900) })}`;
    this.brouillon.update((b) => ({
      ...b,
      [id]: {
        ...b[id],
        reason: details.reason,
        adminNote,
        ...(b[id]?.status === 'retard' ? { arrivalTime: details.arrivalTime } : {}),
        justified: details.justified,
      },
    }));
    this.fermerDetails();
  }

  protected raisonLibelle(raison: string | undefined): string {
    return RAISONS_ABSENCE.find((item) => item.valeur === raison)?.libelle ?? raison ?? '';
  }

  protected actualiser(): void {
    if (this.modifie()) {
      this.toasts.info('Enregistrez les modifications avant d’actualiser.');
      return;
    }
    if (!this.connectivite.enLigne()) {
      this.toasts.info('Hors ligne : la feuille locale est affichée.');
      return;
    }
    void this.chargerFeuille();
  }

  protected async enregistrer(): Promise<void> {
    const eleves = this.eleves();
    if (!eleves.length || this.sauvegardeEnCours() || !this.modifie()) return;

    const brouillon = this.brouillon();
    const base = this.base();
    const entries = eleves
      .filter((e) => JSON.stringify(brouillon[e.student_id] ?? {}) !== JSON.stringify(base[e.student_id] ?? {}))
      .filter((e) => !!brouillon[e.student_id]?.status)
      .map((e) => {
        const entree = brouillon[e.student_id];
        return {
          studentId: e.student_id,
          status: entree.status!,
          arrivalTime: entree.status === 'retard' ? (entree.arrivalTime || this.heureActuelle()) : undefined,
          reason: entree.reason || undefined,
          adminNote: entree.adminNote ? this.serialiserNote(entree.adminNote) : undefined,
        };
      });

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
        const resultat = await this.api.envoyer<{
          refusees?: { studentId: string; raison: string }[];
        }>('ecole/presences', feuille);
        if (resultat.refusees?.length) {
          this.toasts.erreur(`${resultat.refusees.length} présence(s) refusée(s). La feuille va être actualisée.`);
          await this.chargerFeuille();
          return;
        }
        const liste = this.elevesAvecBrouillon();
        const recap = this.calculerRecap(liste);
        this.installerFeuille(liste, recap);
        await this.enregistrerInstantane(liste, recap);
        this.etatFeuille.set('synchronise');
        this.toasts.succes('Feuille enregistrée et synchronisée.');
      } else {
        await this.sync.soumettre({
          entityType: 'attendance.bulk',
          opType: 'upsert',
          payload: feuille as unknown as Record<string, unknown>,
          deviceId: this.session.profil()?.id ?? null,
        });
        const liste = this.elevesAvecBrouillon();
        const recap = this.calculerRecap(liste);
        this.installerFeuille(liste, recap);
        await this.enregistrerInstantane(liste, recap);
        this.etatFeuille.set('local');
        this.toasts.info('Feuille enregistrée sur l’appareil. Elle sera synchronisée au retour du réseau.');
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
        const liste = this.elevesAvecBrouillon();
        const recap = this.calculerRecap(liste);
        this.installerFeuille(liste, recap);
        await this.enregistrerInstantane(liste, recap);
        this.etatFeuille.set('local');
        this.toasts.info('Feuille enregistrée sur l’appareil. Elle sera synchronisée au retour du réseau.');
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
      const donnees = this.donneesExport();
      await this.export.genererPDF(donnees);
      this.toasts.succes('PDF généré avec succès.');
    } catch (err) {
      this.toasts.erreur(`Échec de la génération du PDF. ${toApiError(err).message}`);
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
      const donnees = this.donneesExport();
      await this.export.genererDOCX(donnees);
      this.toasts.succes('DOCX généré avec succès.');
    } catch (err) {
      this.toasts.erreur(`Échec de la génération du DOCX. ${toApiError(err).message}`);
    } finally {
      this.exportEnCours.set(false);
    }
  }

  private async construireInstantaneLocal(): Promise<InstantanePresence | undefined> {
    const [elevesEnCache, presencesEnCache] = await Promise.all([
      this.sync.depuisLeCache<EleveCachePresence>('eleves'),
      this.sync.depuisLeCache<PresenceCacheSynchro>('presences'),
    ]);
    const presentes = elevesEnCache.filter(
      (eleve) => eleve.class_id === this.classeId() && eleve.status === 'actif',
    );
    if (!presentes.length) return undefined;

    const presencesDuJour = presencesEnCache.filter(
      (presence) => presence.attendance_date === this.date() && presence.class_id === this.classeId(),
    );
    const eleves = presentes.map((eleve) => {
      const presence = presencesDuJour.find((ligne) => ligne.student_id === eleve.id);
      return {
        student_id: eleve.id,
        public_code: eleve.public_code,
        full_name: eleve.full_name,
        gender: eleve.gender,
        class_id: eleve.class_id,
        classe: eleve.classe,
        section_id: eleve.section_id,
        section: eleve.section,
        status: presence?.status ?? 'non_enregistre',
        arrival_time: presence?.arrival_time ?? null,
        departure_time: presence?.departure_time ?? null,
        reason: presence?.reason ?? null,
        admin_note: presence?.admin_note ?? null,
      } satisfies PresencesEleve;
    });

    return {
      id: this.cleInstantane(),
      classeId: this.classeId(),
      date: this.date(),
      eleves,
      recap: this.calculerRecap(eleves),
    };
  }

  private choisirStatut(id: string, status: Statut): void {
    this.brouillon.update((b) => ({
      ...b,
      [id]: {
        ...b[id],
        status,
        ...(status === 'retard' && !b[id]?.arrivalTime ? { arrivalTime: this.heureActuelle() } : {}),
      },
    }));
  }

  private installerFeuille(eleves: PresencesEleve[], recap: RecapPresence): void {
    this.eleves.set(eleves);
    this.recap.set(recap);
    const brouillon: Record<string, EntreeBrouillon> = {};
    for (const eleve of eleves) {
      const status = eleve.status !== 'non_enregistre' ? eleve.status as Statut : undefined;
      const adminNote = eleve.admin_note ?? '';
      const meta = this.lireMetaNote(adminNote);
      brouillon[eleve.student_id] = {
        ...(status ? { status } : {}),
        arrivalTime: eleve.arrival_time?.slice(0, 5) ?? undefined,
        reason: eleve.reason ?? undefined,
        adminNote: adminNote || undefined,
        justified: meta.justified,
      };
    }
    this.brouillon.set(brouillon);
    this.base.set(structuredClone(brouillon));
    this.selection.set({});
  }

  private elevesAvecBrouillon(): PresencesEleve[] {
    const brouillon = this.brouillon();
    return this.eleves().map((eleve) => {
      const entree = brouillon[eleve.student_id] ?? {};
      return {
        ...eleve,
        status: entree.status ?? 'non_enregistre',
        arrival_time: entree.arrivalTime ?? null,
        reason: entree.reason ?? null,
        admin_note: entree.adminNote ? this.serialiserNote(entree.adminNote) : null,
      };
    });
  }

  private calculerRecap(eleves: PresencesEleve[]): RecapPresence {
    return {
      date: this.date(),
      total: eleves.length,
      presents: eleves.filter((e) => e.status === 'present').length,
      absents: eleves.filter((e) => e.status === 'absent').length,
      retards: eleves.filter((e) => e.status === 'retard').length,
      departs: eleves.filter((e) => e.status === 'depart_anticipe').length,
      nonEnregistres: eleves.filter((e) => e.status === 'non_enregistre').length,
    };
  }

  private async enregistrerInstantane(eleves: PresencesEleve[], recap: RecapPresence): Promise<void> {
    const enregistreLe = Date.now();
    await this.sync.mettreEnCache('presences', [{
      id: this.cleInstantane(),
      classeId: this.classeId(),
      date: this.date(),
      eleves,
      recap,
      enregistreLe,
    } satisfies InstantanePresence]);
    this.instantaneEnregistre.set(enregistreLe);
  }

  private cleInstantane(): string {
    return `feuille:${this.classeId()}:${this.date()}`;
  }

  private donneesExport(): Parameters<ExportService['genererPDF']>[0] {
    const eleves = this.elevesAvecBrouillon();
    const recap = this.calculerRecap(eleves);
    return {
      date: this.date(),
      classe: this.classes().find((classe) => classe.id === this.classeId())?.name ?? eleves[0]?.classe ?? 'Classe',
      section: eleves.map((eleve) => eleve.section).find(Boolean) ?? undefined,
      ecole: this.session.ecole()?.nom || 'École',
      eleves: eleves.map((eleve) => ({
        id: eleve.student_id,
        publicCode: eleve.public_code,
        nom: eleve.full_name,
        genre: eleve.gender ?? '',
        statut: eleve.status,
        heureArrivee: eleve.arrival_time ?? undefined,
        heureDepart: eleve.departure_time ?? undefined,
        motif: [eleve.reason, this.lireMetaNote(eleve.admin_note ?? '').note].filter(Boolean).join(' — ') || undefined,
      })),
      stats: {
        total: recap.total,
        presents: recap.presents,
        absents: recap.absents,
        retards: recap.retards,
        departs: recap.departs,
      },
    };
  }

  private formulaireVide(): DetailsFormulaire {
    return { reason: '', note: '', justified: false, arrivalTime: this.heureActuelle() };
  }

  private heureActuelle(): string {
    return new Date().toTimeString().slice(0, 5);
  }

  private lireMetaNote(adminNote: string): { justified: boolean; note: string } {
    if (!adminNote.startsWith(NOTE_META)) return { justified: false, note: adminNote };
    try {
      const valeur = JSON.parse(adminNote.slice(NOTE_META.length)) as { justified?: boolean; note?: string };
      return { justified: !!valeur.justified, note: valeur.note ?? '' };
    } catch {
      return { justified: false, note: adminNote };
    }
  }

  private serialiserNote(adminNote: string): string {
    if (!adminNote.startsWith(NOTE_META)) return adminNote;
    return `${NOTE_META}${JSON.stringify(this.lireMetaNote(adminNote))}`;
  }
}