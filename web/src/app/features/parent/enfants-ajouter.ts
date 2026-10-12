import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, toApiError } from '../../core/api.service';
import { ConnectiviteService } from '../../core/connectivite.service';
import { SyncService } from '../../core/sync.service';
import { ToastService } from '../../core/toast.service';

interface ReponseAjout {
  message?: string;
  created?: boolean;
  eleve?: {
    id: string;
    nomComplet?: string;
    classe?: string | null;
    section?: string | null;
    ecole?: string;
  };
  liaison?: { statut?: string; validationRequise?: boolean };
}

/**
 * Formulaire « Ajouter un enfant » par son code unique (spec §6).
 *
 * Un seul champ : le code élève. La relation de parenté n'est plus demandée
 * (le serveur l'enregistre comme « parent »). Hors ligne la demande part dans
 * la file d'attente de synchronisation (`student.link`) et sera exécutée au
 * retour du réseau.
 *
 * Rendu à l'intérieur d'un `<app-overlay>` ouvert depuis la liste des enfants :
 * il ne possède ni en-tête de page, ni boutons d'action.
 */
@Component({
  selector: 'app-ajouter-enfant',
  imports: [FormsModule],
  templateUrl: './enfants-ajouter.html',
  styleUrl: './pages.scss',
})
export class AjouterEnfant {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly sync = inject(SyncService);
  private readonly connectivite = inject(ConnectiviteService);

  /** Enfant rattaché : la liste parente referme l'overlay et recharge. */
  readonly enregistre = output<void>();

  readonly enCours = signal(false);
  protected readonly erreur = signal('');

  codeEnfant = '';

  /** Saisie relevée à l'ouverture, pour détecter une fermeture avec modifications. */
  private depart = '';

  constructor() {
    this.depart = this.etat();
  }

  /** Vrai si le parent a commencé à remplir le formulaire. */
  modifie(): boolean {
    return this.etat() !== this.depart;
  }

  private etat(): string {
    return JSON.stringify([this.codeEnfant]);
  }

  /** Validation + enregistrement (appelée par le pied de l'overlay). */
  async ajouter(): Promise<void> {
    this.erreur.set('');
    const code = this.codeEnfant.trim();
    if (code.length < 6) {
      this.erreur.set('Le code enfant doit contenir au moins 6 caractères.');
      return;
    }
    if (this.enCours()) return;
    this.enCours.set(true);
    try {
      if (!this.connectivite.enLigne()) {
        await this.mettreEnFile(code);
        return;
      }
      const r = await this.api.envoyer<ReponseAjout>('parent/enfants', { codeEnfant: code });
      this.confirmer(r);
      this.enregistre.emit();
    } catch (err) {
      const e = toApiError(err);
      if (e.horsLigne) {
        // Le réseau est tombé pendant la tentative : la demande est conservée.
        await this.mettreEnFile(code);
        return;
      }
      this.erreur.set(e.message);
    } finally {
      this.enCours.set(false);
    }
  }

  /** File d'attente hors ligne : exécutée par `SyncService` au retour du réseau. */
  private async mettreEnFile(code: string): Promise<void> {
    await this.sync.soumettre({
      entityType: 'student.link',
      opType: 'create',
      payload: { codeEnfant: code },
    });
    this.toasts.info('Hors ligne : demande enregistrée, elle partira automatiquement.');
    this.enregistre.emit();
  }

  /** Confirmation claire : nom de l'enfant, classe, école et statut du lien. */
  private confirmer(r?: ReponseAjout): void {
    const e = r?.eleve;
    const qui = e?.nomComplet ? `${e.nomComplet}${e.classe ? ` (${e.classe})` : ''}` : '';
    if (r && r.created === false) {
      this.toasts.succes('Cet enfant est déjà dans votre compte.');
      return;
    }
    if (!qui) {
      this.toasts.succes(r?.message ?? 'Enfant ajouté à votre compte.');
      return;
    }
    if (r?.liaison?.validationRequise) {
      this.toasts.succes(`Demande envoyée à ${e?.ecole ?? 'votre école'} pour ${qui}. Vous serez prévenu dès la validation.`);
      return;
    }
    this.toasts.succes(`${qui} a été connecté à votre compte.`);
  }
}
