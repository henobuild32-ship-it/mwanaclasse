import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

type PageInformation = 'conditions' | 'confidentialite' | 'aide' | 'apropos';

@Component({
  selector: 'app-informations-publiques',
  imports: [RouterLink],
  templateUrl: './informations.html',
  styleUrl: './informations.scss',
})
export class InformationsPubliques {
  protected readonly page = inject(ActivatedRoute).snapshot.data['page'] as PageInformation;
  protected readonly liens = [
    { page: 'conditions' as const, chemin: '/conditions-utilisation', libelle: 'Conditions d’utilisation' },
    { page: 'confidentialite' as const, chemin: '/politique-confidentialite', libelle: 'Confidentialité' },
    { page: 'aide' as const, chemin: '/aide', libelle: 'Aide' },
    { page: 'apropos' as const, chemin: '/a-propos', libelle: 'À propos' },
  ];
  protected readonly annee = new Date().getFullYear();
}
