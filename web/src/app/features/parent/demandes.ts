import { SlicePipe } from '@angular/common';
import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { ConfirmationService } from '../../core/confirmation.service';
import { Demande, Enfant } from '../../core/models';
import { ConnectiviteService } from '../../core/connectivite.service';
import { EnfantActifService } from '../../core/enfant-actif.service';
import { SyncService } from '../../core/sync.service';
import { ToastService } from '../../core/toast.service';
import { Chargement, EtatVide, Etiquette, etiquetteStatut, OverlayFormulaire } from '../../shared/ui';

const KINDS = [
  { valeur: 'reclamation', libelle: 'Réclamation' },
  { valeur: 'demande_information', libelle: "Demande d'information" },
  { valeur: 'demande_derogation', libelle: 'Demande de dérogation' },
  { valeur: 'correction_information', libelle: 'Correction de information' },
  { valeur: 'question_presence', libelle: 'Question sur une présence' },
  { valeur: 'justification_absence', libelle: "Justification d'absence" },
  { valeur: 'autre', libelle: 'Autre' },
];

/** Demandes / réclamations du parent (spec §6). */
@Component({
  selector: 'app-demandes-parent',
  imports: [FormsModule, SlicePipe, Chargement, EtatVide, Etiquette, OverlayFormulaire],
  templateUrl: './demandes.html',
  styleUrl: './pages.scss',
})
export class DemandesParent {
  private readonly api = inject(ApiService);
  private readonly sync = inject(SyncService);
  private readonly connectivite = inject(ConnectiviteService);
  private readonly toasts = inject(ToastService);
  protected readonly confirmation = inject(ConfirmationService);
  protected readonly selection = inject(EnfantActifService);
  protected readonly etiquetteStatut = etiquetteStatut;
  protected readonly kinds = KINDS;

  protected readonly chargement = signal(true);
  protected readonly erreur = signal('');
  protected readonly demandes = signal<Demande[]>([]);
  protected readonly enfants = signal<Enfant[]>([]);
  protected readonly formulaireOuvert = signal(false);
  protected readonly enCours = signal(false);
  /** Demande dépliée (fil d'échanges + champ de réponse). */
  protected readonly idOuverte = signal('');
  protected readonly enCoursReponse = signal(false);

  kind = 'reclamation';
  sujet = '';
  message = '';
  studentId = '';
  absenceDate = '';
  absenceReason = '';
  reponse = '';

  /** Saisie relevée à l'ouverture, pour détecter une fermeture avec modifications. */
  private depart = '';

  private premier = true;

  constructor() {
    // Changer d'enfant change d'école : on recharge les demandes.
    effect(
      () => {
        this.selection.ecoleId();
        if (this.premier) {
          this.premier = false;
          return;
        }
        void this.charger();
      },
      { allowSignalWrites: true },
    );
    void this.charger();
    void this.chargerEnfants();
  }

  protected get enLigne(): boolean {
    return this.connectivite.enLigne();
  }

  protected echanges(d: Demande): { auteur: string; nom: string; message: string; date: string }[] {
    const e = (d as unknown as { echanges?: unknown }).echanges;
    return (Array.isArray(e) ? e : (d.messages ?? [])) as never;
  }

  protected basculer(id: string): void {
    this.idOuverte.set(this.idOuverte() === id ? '' : id);
    this.reponse = '';
  }

  protected cloturee(d: Demande): boolean {
    return d.status === 'cloture';
  }

  /** Ajoute un message au fil d'une demande existante (POST parent/demandes/:id/messages). */
  protected async envoyerReponse(id: string): Promise<void> {
    if (this.enCoursReponse()) return;
    if (this.reponse.trim().length < 1) {
      this.toasts.erreur('Votre message est vide.');
      return;
    }
    this.enCoursReponse.set(true);
    try {
      await this.api.envoyer(`parent/demandes/${id}/messages`, { message: this.reponse.trim() });
      this.reponse = '';
      this.toasts.succes('Message envoyé à l’administration.');
      await this.charger();
    } catch (err) {
      this.toasts.erreur(toApiError(err).message);
    } finally {
      this.enCoursReponse.set(false);
    }
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set('');
    try {
      await this.selection.charger();
      const r = await this.sync.lire(
        'demandes',
        () => this.api.lire<{ demandes: Demande[] }>('parent/demandes', this.selection.params),
        (rep) => rep.demandes ?? [],
      );
      this.demandes.set((r.demandes ?? []) as unknown as Demande[]);
    } catch (err) {
      const e = toApiError(err);
      this.erreur.set(e.horsLigne ? 'Hors ligne : demandes indisponibles.' : e.message);
    } finally {
      this.chargement.set(false);
    }
  }

  private async chargerEnfants(): Promise<void> {
    try {
      const r = await this.api.lire<{ enfants: Enfant[] }>('parent/enfants');
      this.enfants.set(r.enfants ?? []);
    } catch {
      /* filtre facultatif */
    }
  }

  protected ouvrirFormulaire(): void {
    if (this.formulaireOuvert()) {
      void this.fermerFormulaire();
      return;
    }
    this.depart = this.etat();
    this.formulaireOuvert.set(true);
  }

  protected fermerFormulaire(): void {
    void this.fermerFormulaireAsync();
  }

  private async fermerFormulaireAsync(): Promise<void> {
    if (this.formulaireOuvert() && this.etat() !== this.depart) {
      const choix = await this.confirmation.demander({
        message: "Votre demande n'a pas encore été envoyée.",
      });
      if (choix === 'reprendre') return;
      if (choix === 'enregistrer') {
        await this.envoyer();
        return;
      }
    }
    this.formulaireOuvert.set(false);
  }

  private etat(): string {
    return JSON.stringify([
      this.kind,
      this.studentId,
      this.sujet,
      this.message,
      this.absenceDate,
      this.absenceReason,
    ]);
  }

  protected async envoyer(): Promise<void> {
    if (this.enCours()) return;
    if (this.sujet.trim().length < 2 || this.message.trim().length < 2) {
      this.toasts.erreur('Le sujet et le message sont obligatoires.');
      return;
    }
    this.enCours.set(true);
    const corps = {
      studentId: this.studentId || null,
      kind: this.kind,
      subject: this.sujet.trim(),
      message: this.message.trim(),
      absenceDate: this.absenceDate || null,
      absenceReason: this.absenceReason.trim() || null,
      clientUuid: crypto.randomUUID(),
    };
    try {
      if (this.enLigne) {
        await this.api.envoyer('parent/demandes', corps);
        this.toasts.succes('Demande envoyée à l administration.');
      } else {
        await this.sync.soumettre({
          entityType: 'request',
          opType: 'create',
          payload: corps as unknown as Record<string, unknown>,
        });
        this.toasts.info('Hors ligne : demande enregistrée, elle partira automatiquement.');
      }
      this.sujet = '';
      this.message = '';
      this.absenceDate = '';
      this.absenceReason = '';
      this.formulaireOuvert.set(false);
      this.depart = this.etat();
      await this.charger();
    } catch (err) {
      const e = toApiError(err);
      this.toasts.erreur(e.message);
    } finally {
      this.enCours.set(false);
    }
  }
}
