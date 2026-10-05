import { Routes } from '@angular/router';

/** Routes de l'espace école (chargées en différé). */
export const ECOLE_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./ecole-layout').then((m) => m.EspaceEcoleLayout),
    children: [
      {
        path: '',
        loadComponent: () => import('./tableau-de-bord').then((m) => m.PageTableauBordEcole),
      },
      {
        path: 'presences',
        loadComponent: () => import('./presences').then((m) => m.PresencesEcole),
      },
      {
        path: 'eleves',
        loadComponent: () => import('./eleves').then((m) => m.ElevesEcole),
      },
      {
        path: 'eleves/nouveau',
        loadComponent: () => import('./eleves-nouveau').then((m) => m.NouvelEleve),
      },
      {
        path: 'eleves/:id',
        loadComponent: () => import('./eleves-fiche').then((m) => m.FicheEleve),
      },
      {
        path: 'classes',
        loadComponent: () => import('./classes').then((m) => m.ClassesEcole),
      },
      {
        path: 'parents',
        loadComponent: () => import('./parents').then((m) => m.ParentsEcole),
      },
      {
        path: 'liaisons',
        loadComponent: () => import('./liaisons').then((m) => m.LiaisonsEcole),
      },
      {
        path: 'communiques',
        loadComponent: () => import('./communiques').then((m) => m.CommuniquesEcole),
      },
      {
        path: 'demandes',
        loadComponent: () => import('./demandes').then((m) => m.DemandesEcole),
      },
      {
        path: 'documents',
        loadComponent: () => import('./documents').then((m) => m.DocumentsEcole),
      },
      {
        path: 'calendrier',
        loadComponent: () => import('./calendrier').then((m) => m.CalendrierEcole),
      },
      {
        path: 'notifications',
        loadComponent: () => import('./notifications').then((m) => m.NotificationsEcole),
      },
      {
        path: 'parametres',
        loadComponent: () => import('./parametres').then((m) => m.ParametresEcole),
      },
      {
        path: 'plus',
        loadComponent: () => import('./plus').then((m) => m.PlusEcole),
      },
    ],
  },
];
