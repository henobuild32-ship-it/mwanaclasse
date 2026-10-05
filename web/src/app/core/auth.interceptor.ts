import {
  HttpErrorResponse,
  HttpInterceptorFn,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';
import { SessionService } from './session.service';

const ENTETE_REESSAI = 'X-Mwana-Reessaye';

/**
 * Ajoute le jeton d'accès à chaque requête API et, sur un 401, tente un
 * rafraîchissement (cookie HttpOnly) puis rejoue la requête une seule fois.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const session = inject(SessionService);
  const jeton = session.jeton();

  const avecJeton = jeton && !req.headers.has('Authorization')
    ? req.clone({ setHeaders: { Authorization: `Bearer ${jeton}` } })
    : req;

  if (avecJeton.url.includes('/api/auth/') && avecJeton.url.includes('renouveler')) {
    return next(avecJeton);
  }

  return next(avecJeton).pipe(
    catchError((err) => {
      const horsReessai =
        err instanceof HttpErrorResponse && err.headers.has(ENTETE_REESSAI);
      const aJeton = !!jeton;

      if (err instanceof HttpErrorResponse && err.status === 401 && aJeton && !horsReessai) {
        return session.rafraichir().pipe(
          switchMap((nouveau) => {
            const rejoue = req.clone({
              setHeaders: { Authorization: `Bearer ${nouveau}` },
              headers: req.headers.set(ENTETE_REESSAI, '1'),
            });
            return next(rejoue);
          }),
          catchError((e2) => {
            session.forcerDeconnexion();
            return throwError(() => e2);
          }),
        );
      }

      if (err instanceof HttpErrorResponse && err.status === 401 && !aJeton) {
        session.forcerDeconnexion();
      }

      return throwError(() => err);
    }),
  );
};
