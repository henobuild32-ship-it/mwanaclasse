import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom, throwError } from 'rxjs';
import { ErreurApi } from './models';

/** Erreur applicative normalisée (HTTP ou réseau). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ErreurApi['details'],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Vrai quand la requête n'a jamais atteint le serveur (offline…). */
  get horsLigne(): boolean {
    return this.status === 0;
  }
}

export type Params = Record<string, string | number | boolean | null | undefined>;

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly cache = new Map<string, { expires: number; value: unknown }>();
  private readonly cacheTtl = 30_000;

  /** Base de l'API : même origine en production, proxy en développement. */
  readonly base = '/api';

  get<T>(path: string, params?: Params): Observable<T> {
    return this.http.get<T>(this.url(path), { params: this.toParams(params) });
  }

  post<T>(path: string, body?: unknown, params?: Params): Observable<T> {
    return this.http.post<T>(this.url(path), body ?? {}, {
      params: this.toParams(params),
    });
  }

  patch<T>(path: string, body?: unknown): Observable<T> {
    return this.http.patch<T>(this.url(path), body ?? {});
  }

  delete<T>(path: string): Observable<T> {
    return this.http.delete<T>(this.url(path));
  }

  private url(path: string): string {
    return path.startsWith('/api') ? path : `${this.base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /* ---------------------------------------------------------------- */
  /*  Variantes « promesse » (utilisées par les pages)                 */
  /* ---------------------------------------------------------------- */

  async lire<T>(path: string, params?: Params): Promise<T> {
    const key = `${path}?${JSON.stringify(params ?? {})}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value as T;
    const value = await firstValueFrom(this.get<T>(path, params));
    this.cache.set(key, { value, expires: Date.now() + this.cacheTtl });
    return value;
  }

  async envoyer<T>(path: string, body?: unknown, params?: Params): Promise<T> {
    const value = await firstValueFrom(this.post<T>(path, body, params));
    this.cache.clear();
    return value;
  }

  async modifier<T>(path: string, body?: unknown): Promise<T> {
    const value = await firstValueFrom(this.patch<T>(path, body));
    this.cache.clear();
    return value;
  }

  async supprimer<T>(path: string): Promise<T> {
    const value = await firstValueFrom(this.delete<T>(path));
    this.cache.clear();
    return value;
  }

  private toParams(params?: Params): HttpParams | undefined {
    if (!params) return undefined;
    let p = new HttpParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined || v === '') continue;
      p = p.set(k, String(v));
    }
    return p;
  }
}

/** Traduit une HttpErrorResponse de l'API en ApiError exploitable. */
export function toApiError(err: unknown): ApiError {
  const anyErr = err as {
    status?: number;
    error?: ErreurApi & { message?: string };
    message?: string;
  };
  const status = anyErr?.status ?? 0;

  if (status === 0) {
    return new ApiError(0, 'HORS_LIGNE', 'Connexion impossible. Vérifiez votre réseau.');
  }

  const body = anyErr?.error;
  return new ApiError(
    status,
    body?.erreur ?? 'ERREUR',
    body?.message ?? anyErr?.message ?? 'Une erreur est survenue.',
    body?.details,
  );
}

/** Lance une ApiError normalisée (utilisé dans les catchError des pages). */
export function echec(err: unknown): Observable<never> {
  return throwError(() => toApiError(err));
}
