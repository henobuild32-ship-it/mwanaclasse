import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, firstValueFrom, from, map } from 'rxjs';
import { ApiService, ApiError } from './api.service';
import { Interface, ProfilConnexion, ReponseConnexion } from './models';

const CLE_SESSION = 'mwana.session';

interface SessionStockee {
  jeton: string;
  expire: number;
  profil: ProfilConnexion;
  interface: Interface;
}

/**
 * Gère le cycle de vie de la session : connexion, stockage local du jeton
 * d'accès (le jeton de rafraîchissement reste un cookie HttpOnly géré par
 * l'API), reprise de session au démarrage et déconnexion.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly profil = signal<ProfilConnexion | null>(null);
  readonly charge = signal(true);

  readonly connecte = computed(() => this.profil() !== null);
  readonly interface = signal<Interface | null>(null);
  readonly estEcole = computed(() => this.interface() === 'ecole');
  readonly estParent = computed(() => this.interface() === 'parent');
  readonly nomAffiche = computed(() => {
    const p = this.profil();
    if (!p) return '';
    return p.fullName ?? p.full_name ?? p.email ?? '';
  });
  readonly ecole = computed(() => {
    const p = this.profil();
    if (!p) return null;
    return {
      id: p.schoolId ?? p.school_id ?? null,
      nom: p.schoolName ?? p.official_name ?? '',
      code: p.schoolCode ?? p.public_code ?? null,
      couleur: p.primaryColor ?? p.primary_color ?? null,
    };
  });
  readonly permissions = computed(() => this.profil()?.permissions ?? []);
  readonly doitChangerMotDePasse = computed(
    () => this.profil()?.mustChangePassword === true,
  );

  private jetonActuel: string | null = null;

  constructor() {
    const brut = localStorage.getItem(CLE_SESSION);
    if (brut) {
      try {
        const s = JSON.parse(brut) as SessionStockee;
        this.jetonActuel = s.jeton;
        this.profil.set(s.profil);
        this.interface.set(s.interface);
      } catch {
        localStorage.removeItem(CLE_SESSION);
      }
    }
    this.charge.set(false);
  }

  jeton(): string | null {
    return this.jetonActuel;
  }

  /** Recharge le profil depuis l'API (appel au démarrage de la PWA). */
  async restaurer(): Promise<void> {
    if (!this.jetonActuel) return;
    try {
      const reponse = await firstValueFrom(
        this.api.get<{ profil: ProfilConnexion }>('auth/moi'),
      );
      const profil = reponse.profil;
      const iface: Interface =
        profil.interface ?? (profil.school_id || profil.schoolId ? 'ecole' : 'parent');
      this.profil.set({ ...profil, kind: iface });
      this.interface.set(iface);
      this.enregistrerLocal();
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 401 || e.status === 403) this.vider();
    }
  }

  async connecterEcole(body: {
    email: string;
    password: string;
    schoolCode?: string;
    totpCode?: string;
  }): Promise<ReponseConnexion> {
    const reponse = await firstValueFrom(
      this.api.post<ReponseConnexion>('auth/ecole/connexion', body),
    );
    this.ouvrirSession(reponse, 'ecole');
    return reponse;
  }

  async connecterParent(body: {
    emailOrPhone: string;
    password: string;
    totpCode?: string;
  }): Promise<ReponseConnexion> {
    const reponse = await firstValueFrom(
      this.api.post<ReponseConnexion>('auth/parent/connexion', body),
    );
    this.ouvrirSession(reponse, 'parent');
    return reponse;
  }

  /** Rafraîchit le jeton d'accès via le cookie HttpOnly. */
  rafraichir(): Observable<string> {
    return from(
      this.api.post<{ jetonAcces?: string; accessToken?: string; expireDans?: number }>(
        'auth/renouveler',
      ),
    ).pipe(
      map((r) => {
        const jeton = r.jetonAcces ?? r.accessToken;
        if (!jeton) throw new ApiError(401, 'SESSION_EXPIREE', 'Session expirée.');
        this.jetonActuel = jeton;
        this.enregistrerLocal(jeton);
        return jeton;
      }),
    );
  }

  async deconnexion(): Promise<void> {
    try {
      await firstValueFrom(this.api.post('auth/deconnexion'));
    } catch {
      /* la session peut déjà être expirée côté serveur */
    }
    this.vider();
    this.router.navigate(['/']);
  }

  async deconnexionPartout(): Promise<void> {
    try {
      await firstValueFrom(this.api.post('auth/deconnexion-partout'));
    } catch {
      /* idem */
    }
    this.vider();
    this.router.navigate(['/']);
  }

  /** Utilisé par l'intercepteur quand le rafraîchissement a échoué. */
  forcerDeconnexion(): void {
    this.vider();
  }

  private ouvrirSession(reponse: ReponseConnexion, iface: Interface): void {
    this.jetonActuel = reponse.jetonAcces;
    const profil: ProfilConnexion = { ...reponse.profil, kind: iface };
    this.profil.set(profil);
    this.interface.set(iface);
    this.enregistrerLocal();
  }

  private enregistrerLocal(jeton?: string): void {
    const s: SessionStockee = {
      jeton: jeton ?? this.jetonActuel ?? '',
      expire: Date.now() + 3600_000,
      profil: (this.profil() ?? {}) as ProfilConnexion,
      interface: this.interface() ?? 'ecole',
    };
    if (s.jeton) localStorage.setItem(CLE_SESSION, JSON.stringify(s));
  }

  private vider(): void {
    this.jetonActuel = null;
    this.profil.set(null);
    this.interface.set(null);
    localStorage.removeItem(CLE_SESSION);
  }
}
