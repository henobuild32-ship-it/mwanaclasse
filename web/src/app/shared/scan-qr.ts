import { Component, ElementRef, OnDestroy, OnInit, ViewChild, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import jsQR from 'jsqr';

/** Détecteur QR natif (`BarcodeDetector`), quand le navigateur l'expose. */
interface DetecteurNatif {
  detect(source: HTMLVideoElement | HTMLCanvasElement): Promise<{ rawValue: string }[]>;
}
type ConstructeurDetecteur = new (options: { formats: string[] }) => DetecteurNatif;

/**
 * Scanner de QR code plein écran (caméra arrière).
 *
 * - fonctionne **hors ligne** : le décodage est local (`BarcodeDetector` du
 *   navigateur, sinon `jsQR` embarqué) ;
 * - propose la lampe, une fermeture claire et le repli « Saisir le code »
 *   quand la caméra est refusée ou indisponible ;
 * - reste ouvert pour les scans successifs : l'appelant réceptionne chaque
 *   code via `(code)` et affiche son propre retour (nom, coche, erreur).
 */
@Component({
  selector: 'app-scan-qr',
  imports: [FormsModule],
  template: `
    <div class="scan" role="dialog" aria-modal="true" [attr.aria-label]="titre()">
      <header class="scan__entete">
        <strong class="scan__titre">{{ titre() }}</strong>
        <button type="button" class="scan__fermer" (click)="fermeture.emit()" aria-label="Fermer le scanner">×</button>
      </header>

      @if (etat() === 'actif') {
        <div class="scan__zone">
          <video #video class="scan__video" autoplay muted playsinline></video>
          <div class="scan__cadre" aria-hidden="true">
            <span></span><span></span><span></span><span></span>
          </div>
          @if (retour(); as r) {
            <div class="scan__retour" [class.scan__retour--ko]="!r.ok" role="status" aria-live="polite">
              <span class="scan__retour-marque" aria-hidden="true">{{ r.ok ? '✓' : '!' }}</span>
              {{ r.texte }}
            </div>
          }
        </div>
        <p class="scan__consigne">{{ consigne() }}</p>
        <div class="scan__actions">
          <button type="button" class="btn btn--secondaire" (click)="basculerLampe()">
            {{ lampe() ? 'Éteindre la lampe' : 'Allumer la lampe' }}
          </button>
          <button type="button" class="btn btn--contour" (click)="passerEnSaisie()">Saisir le code à la place</button>
        </div>
        @if (message()) {
          <p class="scan__message" role="status">{{ message() }}</p>
        }
      } @else if (etat() === 'saisie') {
        <div class="scan__saisie">
          <label class="champ" for="scan-code">
            <span>Code de l'élève</span>
            <input
              id="scan-code"
              name="codeSaisi"
              type="text"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              placeholder="MC-ELV-XXXXXX"
              [(ngModel)]="valeurSaisie"
              (keyup.enter)="validerSaisie()"
            />
          </label>
          <button class="btn btn--primaire" type="button" (click)="validerSaisie()">Valider le code</button>
          @if (message()) {
            <p class="scan__message" role="alert">{{ message() }}</p>
          }
          <button class="btn btn--discret" type="button" (click)="revenirScan()">Retour au scanner</button>
        </div>
      } @else {
        <div class="scan__attente">
          <span class="scan__attente-icone" aria-hidden="true">📷</span>
          @if (etat() === 'refuse') {
            <p class="scan__message" role="alert">{{ message() }}</p>
            <p class="scan__consigne">Vous pouvez saisir le code imprimé sur la carte à la main.</p>
            <button class="btn btn--primaire" type="button" (click)="passerEnSaisie()">Saisir le code à la place</button>
          } @else {
            <p class="scan__consigne">Ouverture de la caméra…</p>
          }
        </div>
      }
    </div>
  `,
})
export class ScanQr implements OnInit, OnDestroy {
  readonly titre = input('Scanner la carte');
  readonly consigne = input('Placez le QR code de l’élève dans le cadre.');
  /** Retour affiché par-dessus le cadre : succès ou motif de refus. */
  readonly retour = input<{ texte: string; ok: boolean } | null>(null);
  /** Chaque QR lu (ou code saisi manuellement) est émis ici, en clair. */
  readonly code = output<string>();
  readonly fermeture = output<void>();

  @ViewChild('video') private videoRef?: ElementRef<HTMLVideoElement>;

  protected readonly etat = signal<'demarrage' | 'actif' | 'refuse' | 'saisie'>('demarrage');
  protected readonly message = signal('');
  protected readonly lampe = signal(false);
  protected valeurSaisie = '';

  private flux: MediaStream | null = null;
  private toile: HTMLCanvasElement | null = null;
  private contexte: CanvasRenderingContext2D | null = null;
  private detecteur: DetecteurNatif | null = null;
  private boucle = 0;
  private enAnalyse = false;
  private derniereAnalyse = 0;
  private codeVu = '';
  private codeVuLe = 0;

  ngOnInit(): void {
    document.body.style.overflow = 'hidden';
    void this.demarrer();
  }

  ngOnDestroy(): void {
    document.body.style.overflow = '';
    this.arreter();
  }

  /* ---------------------------------------------------------------- */
  /*  Caméra                                                           */
  /* ---------------------------------------------------------------- */

  private async demarrer(): Promise<void> {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      this.refuser('Caméra indisponible sur cet appareil ou connexion non sécurisée.');
      return;
    }
    try {
      this.flux = await media.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch {
      this.refuser('Accès à la caméra refusé ou impossible.');
      return;
    }
    this.etat.set('actif');
    // La piste est injectée après le rendu du branchement `etat() === 'actif'`.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const video = this.videoRef?.nativeElement;
    if (!video) {
      this.refuser('Caméra indisponible.');
      return;
    }
    video.srcObject = this.flux;
    try {
      await video.play();
    } catch {
      /* autoplay refusé : la boucle attendra une piste prête */
    }
    const constructeur = (globalThis as unknown as { BarcodeDetector?: ConstructeurDetecteur })
      .BarcodeDetector;
    if (constructeur) {
      try {
        this.detecteur = new constructeur({ formats: ['qr_code'] });
      } catch {
        this.detecteur = null;
      }
    }
    this.toile = document.createElement('canvas');
    this.contexte = this.toile.getContext('2d', { willReadFrequently: true });
    this.boucle = requestAnimationFrame(() => void this.analyser());
  }

  private refuser(texte: string): void {
    this.message.set(texte);
    this.etat.set('refuse');
    this.arreter();
  }

  private arreter(): void {
    if (this.boucle) cancelAnimationFrame(this.boucle);
    this.boucle = 0;
    this.flux?.getTracks().forEach((piste) => piste.stop());
    this.flux = null;
    this.detecteur = null;
    this.contexte = null;
    this.toile = null;
  }

  /* ---------------------------------------------------------------- */
  /*  Détection                                                        */
  /* ---------------------------------------------------------------- */

  private async analyser(): Promise<void> {
    if (!this.flux) return;
    const maintenant = Date.now();
    if (!this.enAnalyse && maintenant - this.derniereAnalyse > 120) {
      this.enAnalyse = true;
      this.derniereAnalyse = maintenant;
      try {
        const brut = await this.lire();
        if (brut) this.traiter(brut);
      } catch {
        /* image illisible : on repart à la frame suivante */
      }
      this.enAnalyse = false;
    }
    if (this.flux) this.boucle = requestAnimationFrame(() => void this.analyser());
  }

  private async lire(): Promise<string | null> {
    const video = this.videoRef?.nativeElement;
    if (!video || video.readyState < 2 || !video.videoWidth) return null;

    if (this.detecteur) {
      const resultats = await this.detecteur.detect(video);
      return resultats[0]?.rawValue ?? null;
    }

    const toile = this.toile;
    const contexte = this.contexte;
    if (!toile || !contexte) return null;
    const largeur = video.videoWidth;
    const hauteur = video.videoHeight;
    if (toile.width !== largeur || toile.height !== hauteur) {
      toile.width = largeur;
      toile.height = hauteur;
    }
    contexte.drawImage(video, 0, 0, largeur, hauteur);
    const image = contexte.getImageData(0, 0, largeur, hauteur);
    const resultat = jsQR(image.data, largeur, hauteur, { inversionAttempts: 'dontInvert' });
    return resultat?.data ?? null;
  }

  private traiter(brut: string): void {
    const maintenant = Date.now();
    // Même carte relue dans la seconde : on n'émet qu'une seule fois.
    if (brut === this.codeVu && maintenant - this.codeVuLe < 2500) return;
    this.codeVu = brut;
    this.codeVuLe = maintenant;
    this.code.emit(brut);
  }

  /* ---------------------------------------------------------------- */
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

  protected async basculerLampe(): Promise<void> {
    const piste = this.flux?.getVideoTracks()[0];
    if (!piste) return;
    const capacites = piste.getCapabilities?.() as { torch?: boolean } | undefined;
    if (!capacites?.torch) {
      this.message.set('Lampe indisponible sur cet appareil.');
      return;
    }
    const suivant = !this.lampe();
    try {
      // `torch` n'est pas typé dans les libDOM : contrainte caméra native.
      const contraintes = { advanced: [{ torch: suivant }] } as unknown as MediaTrackConstraints;
      await piste.applyConstraints(contraintes);
      this.lampe.set(suivant);
    } catch {
      this.message.set('Impossible d’allumer la lampe.');
    }
  }

  protected passerEnSaisie(): void {
    this.arreter();
    this.valeurSaisie = '';
    this.message.set('');
    this.etat.set('saisie');
  }

  protected revenirScan(): void {
    this.valeurSaisie = '';
    this.message.set('');
    if (this.flux) {
      this.etat.set('actif');
      return;
    }
    this.etat.set('demarrage');
    void this.demarrer();
  }

  protected validerSaisie(): void {
    const code = this.valeurSaisie.trim();
    if (code.length < 4) {
      this.message.set('Saisissez le code imprimé sur la carte.');
      return;
    }
    this.code.emit(code);
    this.valeurSaisie = '';
    this.message.set('');
  }
}
