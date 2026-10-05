import { Routes } from '@angular/router';

/** Routes de l'espace parent (chargées en différé). */
export const PARENT_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./parent-layout').then((m) => m.EspaceParentLayout),
    children: [
      {
        path: '',
        loadComponent: () => import('./tableau-de-bord').then((m) => m.PageTableauBordParent),
      },
      {
        path: 'enfants',
        loadComponent: () => import('./enfants').then((m) => m.EnfantsParent),
      },
      {
        path: 'enfants/ajouter',
        loadComponent: () => import('./enfants-ajouter').then((m) => m.AjouterEnfant),
      },
      {
        path: 'enfants/:id',
        loadComponent: () => import('./enfants-detail').then((m) => m.DetailEnfant),
      },
      {
        path: 'communiques',
        loadComponent: () => import('./communiques').then((m) => m.CommuniquesParent),
      },
      {
        path: 'calendrier',
        loadComponent: () => import('./calendrier').then((m) => m.CalendrierParent),
      },
      {
        path: 'documents',
        loadComponent: () => import('./documents').then((m) => m.DocumentsParent),
      },
      {
        path: 'notifications',
        loadComponent: () => import('./notifications').then((m) => m.NotificationsParent),
      },
      {
        path: 'ajouter-ecole',
        loadComponent: () => import('./ajouter-ecole').then((m) => m.AjouterEcole),
      },
      {
        path: 'profil',
        loadComponent: () => import('./profil').then((m) => m.ProfilParent),
      },
      {
        path: 'demandes',
        loadComponent: () => import('./demandes').then((m) => m.DemandesParent),
      },
      {
        path: 'plus',
        loadComponent: () => import('./plus').then((m) => m.PlusParent),
      },
    ],
  },
];
