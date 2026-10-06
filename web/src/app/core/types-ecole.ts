export interface TypeEcole {
  valeur: string;
  libelle: string;
}

/** Choix proposés à la création et dans les paramètres de l'établissement. */
export const TYPES_ECOLE: TypeEcole[] = [
  { valeur: 'primaire', libelle: 'Primaire' },
  { valeur: 'maternelle', libelle: 'Maternelle' },
  { valeur: 'secondaire', libelle: 'Secondaire (collège)' },
  { valeur: 'humanites', libelle: 'Humanités (collège + lycée)' },
  { valeur: 'technique', libelle: 'Technique' },
  { valeur: 'professionnel', libelle: 'Professionnel' },
  { valeur: 'mixte', libelle: 'Mixte' },
  { valeur: 'autre', libelle: 'Autre' },
];

/** Cycles du collège : c'est là que la précision mixte / non mixte est demandée. */
export const TYPES_COLLEGE = ['secondaire', 'humanites'];

/** Cycles sans structure par sections : la classe suffit (maternelle, primaire). */
export const TYPES_SANS_SECTION = ['maternelle', 'primaire'];

/** Vrai si la sélection contient au moins un cycle de collège. */
export function inclutCollege(types: readonly string[]): boolean {
  return types.some((t) => TYPES_COLLEGE.includes(t));
}

/**
 * Vrai si l'établissement a besoin de sections.
 * Une école qui ne propose que de la maternelle/du primaire fonctionne en
 * classes seules : les sections sont masquées dans toute l'interface.
 * Une sélection vide (donnée ancienne) garde les sections visibles.
 */
export function proposeSections(types: readonly string[]): boolean {
  if (types.length === 0) return true;
  return types.some((t) => !TYPES_SANS_SECTION.includes(t));
}
