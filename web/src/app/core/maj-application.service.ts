import { Injectable, inject, signal } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';

/**
 * Mise à jour de l'application (spec C1) :
 * quand le service worker a téléchargé une nouvelle version, on propose
 * discrètement à l'utilisateur de l'appliquer (rechargement propre).
 */
@Injectable({ providedIn: 'root' })
export class MajApplicationService {
  private readonly swUpdate = inject(SwUpdate);

  /** true quand une nouvelle version est prête à être activée. */
  readonly disponible = signal(false);
  /** true pendant l'activation (désactive le bouton). */
  readonly enCours = signal(false);

  constructor() {
    if (!this.swUpdate.isEnabled) return;
    this.swUpdate.versionUpdates
      .pipe(
        filter(
          (e): e is VersionReadyEvent =>
            e.type === 'VERSION_READY',
        ),
      )
      .subscribe(() => this.disponible.set(true));
  }

  /** Active la nouvelle version puis recharge la page. */
  async appliquer(): Promise<void> {
    if (this.enCours()) return;
    this.enCours.set(true);
    try {
      await this.swUpdate.activateUpdate();
      document.location.reload();
    } catch {
      this.enCours.set(false);
    }
  }
}
