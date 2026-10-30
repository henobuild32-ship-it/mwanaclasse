import { Routes } from '@angular/router';

/** Routes de l'espace Ministère de l'EPST (protégées par gardeInterface('ministere')). */
export const MINISTERE_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./ministere-layout').then((m) => m.EspaceMinistereLayout),
    children: [
      {
        path: '',
        loadComponent: () => import('./ecoles').then((m) => m.EcolesMinistere),
      },
      {
        path: 'ecoles',
        loadComponent: () => import('./ecoles').then((m) => m.EcolesMinistere),
      },
      {
        path: 'communiques',
        loadComponent: () => import('./communiques').then((m) => m.CommuniquesMinistere),
      },
      {
        path: 'parametres',
        loadComponent: () => import('./parametres').then((m) => m.ParametresMinistere),
      },
    ],
  },
];
