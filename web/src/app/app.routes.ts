import { Routes } from '@angular/router';
import { gardeInterface, gardeInvite } from './core/guards';

/**
 * Routage de l'application MwanaClasse.
 *  /                page d'accueil (choix Parent / École)
 *  /connexion/*     connexions + inscription
 *  /ecole/**        espace école (protégé)
 *  /parent/**       espace parent (protégé)
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/accueil/accueil').then((m) => m.Accueil),
  },
  {
    path: 'conditions-utilisation',
    loadComponent: () => import('./features/public/informations').then((m) => m.InformationsPubliques),
    data: { page: 'conditions' },
  },
  {
    path: 'politique-confidentialite',
    loadComponent: () => import('./features/public/informations').then((m) => m.InformationsPubliques),
    data: { page: 'confidentialite' },
  },
  {
    path: 'aide',
    loadComponent: () => import('./features/public/informations').then((m) => m.InformationsPubliques),
    data: { page: 'aide' },
  },
  {
    path: 'a-propos',
    loadComponent: () => import('./features/public/informations').then((m) => m.InformationsPubliques),
    data: { page: 'apropos' },
  },
  {
    path: 'connexion/ecole',
    canMatch: [gardeInvite],
    loadComponent: () =>
      import('./features/auth/connexion-ecole').then((m) => m.ConnexionEcole),
  },
  {
    path: 'connexion/parent',
    canMatch: [gardeInvite],
    loadComponent: () =>
      import('./features/auth/connexion-parent').then((m) => m.ConnexionParent),
  },
  {
    path: 'inscription/ecole',
    canMatch: [gardeInvite],
    loadComponent: () =>
      import('./features/auth/inscription-ecole').then((m) => m.InscriptionEcole),
  },
  {
    path: 'inscription/parent',
    canMatch: [gardeInvite],
    loadComponent: () =>
      import('./features/auth/inscription-parent').then((m) => m.InscriptionParent),
  },
  {
    path: 'mot-de-passe-oublie',
    loadComponent: () =>
      import('./features/auth/mot-de-passe-oublie').then((m) => m.MotDePasseOublie),
  },
  {
    path: 'ecole',
    canMatch: [gardeInterface('ecole')],
    loadChildren: () =>
      import('./features/ecole/ecole.routes').then((m) => m.ECOLE_ROUTES),
  },
  {
    path: 'parent',
    canMatch: [gardeInterface('parent')],
    loadChildren: () =>
      import('./features/parent/parent.routes').then((m) => m.PARENT_ROUTES),
  },
  { path: '**', redirectTo: '' },
];
