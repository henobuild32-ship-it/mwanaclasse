import { inject } from '@angular/core';
import { CanMatchFn, Route, Router, UrlTree } from '@angular/router';
import { SessionService } from './session.service';

function chemin(segments: { path: string }[]): string {
  return `/${segments.map((s) => s.path).join('/')}`;
}

/** Empêche l'accès aux espaces sans session valide (redirige vers l'accueil). */
export const gardeConnexion: CanMatchFn = (
  _route: Route,
  segments: { path: string }[],
): boolean | UrlTree => {
  const session = inject(SessionService);
  const router = inject(Router);
  if (session.connecte()) return true;
  return router.createUrlTree(['/'], { queryParams: { retour: chemin(segments) } });
};

/** Vérifie aussi que la session correspond bien à l'interface demandée. */
export const gardeInterface = (iface: 'ecole' | 'parent'): CanMatchFn => {
  return (_route: Route, segments: { path: string }[]): boolean | UrlTree => {
    const session = inject(SessionService);
    const router = inject(Router);
    if (!session.connecte()) {
      return router.createUrlTree(['/'], { queryParams: { retour: chemin(segments) } });
    }
    if (session.interface() !== iface) {
      return router.createUrlTree([
        session.interface() === 'parent' ? '/parent' : '/ecole',
      ]);
    }
    return true;
  };
};

/** Renvoie les utilisateurs déjà connectés vers leur espace. */
export const gardeInvite: CanMatchFn = () => {
  const session = inject(SessionService);
  const router = inject(Router);
  if (!session.connecte()) return true;
  return router.createUrlTree([session.interface() === 'parent' ? '/parent' : '/ecole']);
};
