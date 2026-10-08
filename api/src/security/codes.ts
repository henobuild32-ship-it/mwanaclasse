/**
 * ============================================================================
 *  MWANA CLASSE — Normalisation des codes d'identification
 * ============================================================================
 *  Un code est SAISI sous n'importe quelle forme (avec ou sans préfixe, en
 *  minuscules, avec tirets/espaces) mais stocké au format canonique
 *  `MC-ELV-XXXXXXXXXX` (voir `app.format_student_code` et la contrainte
 *  `app.students_public_code_format`).
 *
 *  La comparaison est stricte en base : c'est donc la normalisation qui doit
 *  être exacte, quel que soit le point d'entrée (inscription parent,
 *  rattachement d'un enfant, administration).
 * ============================================================================
 */

/** Préfixe canonique d'un code élève, sans tiret : `MC-ELV`. */
const PREFIXE_ELEVE = 'MCELV';

/** Corps minimal attendu après le préfixe (contrainte SQL : 4 à 12 caractères). */
const CORPS_MINIMAL = 4;

/**
 * Ramène un code élève saisi au format stocké `MC-ELV-XXXXXXXXXX`.
 *
 * Cas couverts :
 *   - `MC-ELV-JBXAFM`, `mc-elv-jbxafm`, `MCELVJBXAFM` → `MC-ELV-JBXAFM`
 *   - `JBXAFM`, ` jbx afm `                          → `MC-ELV-JBXAFM`
 *   - `MCPAR-XXXXXX`, `MC-ECOLE-XXXXXX` (autre type) → tel quel (inconnu)
 *
 * Une saisie dont il ne reste rien après suppression des séparateurs est
 * retournée telle quelle : elle ne pourra correspondre à aucun code stocké.
 */
export function normalizeStudentCode(raw: string): string {
  const compact = (raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (compact.startsWith(PREFIXE_ELEVE)) {
    const corps = compact.slice(PREFIXE_ELEVE.length);
    // Corps assez long : c'est un code élève avec son préfixe.
    if (corps.length >= CORPS_MINIMAL) return `MC-ELV-${corps}`;
    // « MCELV » seul ou corps trop court : on ne peut pas trancher, on
    // conserve la saisie pour que la recherche échoue proprement.
    return compact;
  }

  // Autre type de code (parent, école) : on ne le transforme pas en code
  // élève, il ne doit pas correspondre par accident.
  if (compact.startsWith('MCPAR') || compact.startsWith('MCECOLE')) return compact;

  // Corps seul : on lui remet le préfixe attendu par la base.
  return compact ? `MC-ELV-${compact}` : compact;
}
