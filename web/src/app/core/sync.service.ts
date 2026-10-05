import { Injectable, inject, signal, computed } from '@angular/core';
import { ApiService } from './api.service';
import { ConnectiviteService } from './connectivite.service';
import { SessionService } from './session.service';

export type TypeEntiteLocale =
  | 'eleves'
  | 'classes'
  | 'presences'
  | 'communiques'
  | 'demandes'
  | 'documents'
  | 'calendrier'
  | 'notifications';

export interface OperationFile {
  opUuid: string;
  entityType: string;
  opType: 'create' | 'update' | 'delete' | 'upsert' | 'action';
  entityId?: string | null;
  payload: Record<string, unknown>;
  baseVersion?: number | null;
  clientTime: string;
  deviceId?: string | null;
  audience: 'ecole' | 'parent';
}

export interface MetadonneesSync {
  clientId: string;
  terminalEnregistre: boolean;
  curseurPull: string | null;
  derniereSynchro: number | null;
}

const DB_NAME = 'mwana-classe';
const DB_VERSION = 1;
const STORE_DONNEES = 'donnees';
const STORE_OPERATIONS = 'operations';
const STORE_META = 'meta';

const ENTITES_PULL = [
  'attendance',
  'student',
  'class',
  'section',
  'announcement',
  'request',
  'notification',
  'calendar',
] as const;

/**
 * File d'attente hors ligne (IndexedDB) + synchronisation avec l'API
 * (`/api/sync/client`, `/api/sync/push`, `/api/sync/pull`).
 *
 * - les **écritures** faites hors ligne sont mises en file puis poussées
 *   dès que la connexion revient ;
 * - les **lectures** profitent du dernier cache local tiré par `pull`.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionService);
  private readonly connectivite = inject(ConnectiviteService);

  readonly operationsEnFile = signal(0);
  readonly enCours = signal(false);
  readonly derniereSynchro = signal<Date | null>(null);
  readonly message = signal<string | null>(null);

  /** Statut de synchronisation pour l'UI : 'idle' | 'en_cours' | 'erreur' | 'succes' */
  readonly statutSync = computed(() => {
    if (this.enCours()) return 'en_cours';
    if (this.message() && this.message()!.startsWith('Erreur')) return 'erreur';
    if (this.derniereSynchro() && this.operationsEnFile() === 0) return 'succes';
    return 'idle';
  });

  private db: IDBDatabase | null = null;
  private ouverture: Promise<IDBDatabase> | null = null;
  private minuterie: ReturnType<typeof setInterval> | null = null;
  private meta: MetadonneesSync = {
    clientId: '',
    terminalEnregistre: false,
    curseurPull: null,
    derniereSynchro: null,
  };

  /* ---------------------------------------------------------------- */
  /*  Base locale                                                      */
  /* ---------------------------------------------------------------- */

  private ouvrir(): Promise<IDBDatabase> {
    if (this.ouverture) return this.ouverture;
    this.ouverture = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_DONNEES)) {
          db.createObjectStore(STORE_DONNEES, { keyPath: ['entite', 'id'] });
        }
        if (!db.objectStoreNames.contains(STORE_OPERATIONS)) {
          db.createObjectStore(STORE_OPERATIONS, { keyPath: 'opUuid' });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'cle' });
        }
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
    return this.ouverture;
  }

  private async lireMeta(): Promise<void> {
    const db = await this.ouvrir();
    const brut = await this.promettre<MetadonneesSync | undefined>(
      db.transaction(STORE_META, 'readonly').objectStore(STORE_META).get('sync'),
    );
    if (brut) this.meta = { ...this.meta, ...brut };
    if (!this.meta.clientId) {
      this.meta.clientId = crypto.randomUUID();
      await this.ecrireMeta();
    }
  }

  private async ecrireMeta(): Promise<void> {
    const db = await this.ouvrir();
    await this.promettre(
      db
        .transaction(STORE_META, 'readwrite')
        .objectStore(STORE_META)
        .put({ cle: 'sync', ...this.meta }),
    );
  }

/** Attend la fin (succès ou abort) d'une transaction IndexedDB. */
  private finTransaction(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  private promettre<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Cycle de vie                                                     */
  /* ---------------------------------------------------------------- */

  async demarrer(): Promise<void> {
    if (!this.session.connecte()) return;
    await this.lireMeta();
    await this.compter();
    if (this.connectivite.enLigne()) {
      await this.enregistrerTerminal();
      await this.synchroniser();
    }
    if (!this.minuterie) {
      this.minuterie = setInterval(() => {
        if (this.connectivite.enLigne() && this.session.connecte()) {
          void this.synchroniser();
        }
      }, 60_000);
    }
  }

  arreter(): void {
    if (this.minuterie) {
      clearInterval(this.minuterie);
      this.minuterie = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Écritures hors ligne                                             */
  /* ---------------------------------------------------------------- */

  /** Ajoute une opération à la file (puis tente un envoi immédiat). */
  async soumettre(
    op: Omit<OperationFile, 'clientTime' | 'audience' | 'opUuid'> & { opUuid?: string },
  ): Promise<void> {
    const db = await this.ouvrir();
    const audience = this.session.interface() === 'parent' ? 'parent' : 'ecole';
    const operation: OperationFile = {
      ...op,
      opUuid: op.opUuid ?? crypto.randomUUID(),
      clientTime: new Date().toISOString(),
      audience,
    };
    await this.promettre(
      db.transaction(STORE_OPERATIONS, 'readwrite').objectStore(STORE_OPERATIONS).put(operation),
    );
    await this.compter();
    if (this.connectivite.enLigne()) await this.pousser();
  }

  /** Envoie la file au serveur par lots (500 opérations max par appel). */
  async pousser(): Promise<boolean> {
    if (!this.session.connecte() || !this.connectivite.enLigne()) return false;
    const db = await this.ouvrir();
    const operations = await this.promettre<OperationFile[]>(
      db.transaction(STORE_OPERATIONS, 'readonly').objectStore(STORE_OPERATIONS).getAll(),
    );
    if (!operations.length) return true;

    const lot = operations.slice(0, 500);
    try {
      await this.api.envoyer('sync/push', {
        clientId: this.meta.clientId,
        batchId: crypto.randomUUID(),
        audience: this.session.interface() === 'parent' ? 'parent' : 'ecole',
        platform: navigator.platform,
        appVersion: '1.0.0',
        clientCreatedAt: new Date().toISOString(),
        operations: lot.map((o) => ({
          opUuid: o.opUuid,
          entityType: o.entityType,
          opType: o.opType,
          entityId: o.entityId ?? null,
          payload: o.payload,
          baseVersion: o.baseVersion ?? null,
          clientTime: o.clientTime,
          deviceId: o.deviceId ?? null,
        })),
      });
      const tx = db.transaction(STORE_OPERATIONS, 'readwrite');
      for (const o of lot) tx.objectStore(STORE_OPERATIONS).delete(o.opUuid);
      await this.finTransaction(tx);
      await this.compter();
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Lectures : cache local                                           */
  /* ---------------------------------------------------------------- */

  /** Enregistre un jeu de données dans le cache local. */
  async mettreEnCache(entite: TypeEntiteLocale, lignes: unknown[]): Promise<void> {
    const db = await this.ouvrir();
    const tx = db.transaction(STORE_DONNEES, 'readwrite');
    const store = tx.objectStore(STORE_DONNEES);
    for (const ligne of lignes) {
      const r = ligne as { id?: string };
      if (!r?.id) continue;
      store.put({ entite, id: r.id, donnees: ligne, maj: Date.now() });
    }
    await this.finTransaction(tx);
  }

  /** Relit le cache local d'une entité (mode hors ligne). */
  async depuisLeCache<T>(entite: TypeEntiteLocale): Promise<T[]> {
    const db = await this.ouvrir();
    const lignes = await this.promettre<{ entite: string; donnees: T }[]>(
      db.transaction(STORE_DONNEES, 'readonly').objectStore(STORE_DONNEES).getAll(),
    );
    return lignes.filter((l) => l.entite === entite).map((l) => l.donnees);
  }

  /**
   * Lecture « online d'abord, cache en secours » : la promesse API est
   * exécutée si le réseau est là, sinon on retombe sur IndexedDB.
   */
  async lire<T>(entite: TypeEntiteLocale, appel: () => Promise<T>, extraire?: (r: T) => unknown[]): Promise<T> {
    if (this.connectivite.enLigne()) {
      try {
        const resultat = await appel();
        if (extraire) await this.mettreEnCache(entite, extraire(resultat));
        this.message.set(null);
        return resultat;
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status && status !== 0) throw err;
        const secours = await this.depuisLeCache<unknown>(entite);
        if (secours.length) {
          this.message.set('Hors ligne : données locales du dernier synchronisation.');
          return { [entite]: secours } as unknown as T;
        }
        throw err;
      }
    }
    const secours = await this.depuisLeCache<unknown>(entite);
    this.message.set('Hors ligne : affichage du dernier cache local.');
    return { [entite]: secours } as unknown as T;
  }

  /* ---------------------------------------------------------------- */
  /*  Pull serveur                                                     */
  /* ---------------------------------------------------------------- */

  private async enregistrerTerminal(): Promise<void> {
    if (this.meta.terminalEnregistre) return;
    try {
      await this.api.envoyer('sync/client', {
        clientId: this.meta.clientId,
        audience: this.session.interface() === 'parent' ? 'parent' : 'ecole',
        label: `Terminal ${new Date().toLocaleDateString('fr-FR')}`,
        platform: 'pwa',
        appVersion: '1.0.0',
      });
      this.meta.terminalEnregistre = true;
      await this.ecrireMeta();
    } catch {
      /* sans réseau : on réessaiera plus tard */
    }
  }

  /** Tire les changements serveur puis les range en cache local. */
  async tirer(): Promise<void> {
    if (!this.connectivite.enLigne() || !this.session.connecte()) return;
    const reponse = await this.api.envoyer<{
      changements?: { entite: string; donnees?: unknown[]; lignes?: unknown[] }[];
      curseur?: string;
      cursor?: string;
      derniereMaj?: string;
    }>('sync/pull', {
      clientId: this.meta.clientId,
      audience: this.session.interface() === 'parent' ? 'parent' : 'ecole',
      since: this.meta.curseurPull,
      entities: [...ENTITES_PULL],
      limit: 1000,
    });
    for (const lot of reponse.changements ?? []) {
      const lignes = lot.donnees ?? lot.lignes ?? [];
      const mapping: Record<string, TypeEntiteLocale> = {
        attendance: 'presences',
        student: 'eleves',
        class: 'classes',
        section: 'classes',
        announcement: 'communiques',
        request: 'demandes',
        notification: 'notifications',
        calendar: 'calendrier',
      };
      const entite = mapping[lot.entite];
      if (entite && lignes.length) await this.mettreEnCache(entite, lignes);
    }
    if (reponse.curseur ?? reponse.derniereMaj) {
      this.meta.curseurPull = (reponse.curseur ?? reponse.derniereMaj)!;
      await this.ecrireMeta();
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Synchronisation globale                                          */
  /* ---------------------------------------------------------------- */

  async synchroniser(): Promise<void> {
    if (this.enCours() || !this.connectivite.enLigne() || !this.session.connecte()) return;
    this.enCours.set(true);
    try {
      await this.enregistrerTerminal();
      const pousse = await this.pousser();
      await this.tirer();
      this.meta.derniereSynchro = Date.now();
      await this.ecrireMeta();
      this.derniereSynchro.set(new Date());
      this.message.set(pousse ? null : 'Envoi partiel : nouvelle tentative en cours.');
    } catch (err) {
      const status = (err as { status?: number })?.status;
      this.message.set(
        status === 0 || !status
          ? 'Hors ligne : synchronisation reportée.'
          : 'Synchronisation en échec, nouvelle tentative automatique.',
      );
    } finally {
      this.enCours.set(false);
      await this.compter();
    }
  }

  private async compter(): Promise<void> {
    const db = await this.ouvrir();
    const n = await this.promettre<number>(
      db.transaction(STORE_OPERATIONS, 'readonly').objectStore(STORE_OPERATIONS).count(),
    );
    this.operationsEnFile.set(n);
  }
}
