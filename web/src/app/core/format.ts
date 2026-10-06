/**
 * Formatage des dates affichées à l'écran.
 *
 * Les colonnes de type `date` reviennent de l'API en ISO complet
 * (« 2010-05-06T00:00:00.000Z ») : on affiche uniquement la date, sans
 * conversion de fuseau, pour ne jamais voir glisser d'un jour.
 *
 * Les colonnes de type `timestamp` (enregistrement, publication) gardent
 * leur heure, convertie dans le fuseau du navigateur.
 */

const ISO_AVEC_HEURE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})/;

function enFr(date: Date, avecHeure: boolean): string {
  return date.toLocaleString('fr-FR', avecHeure
    ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Date seule : « 06/05/2010 ». */
export function dateFr(valeur?: string | null): string {
  if (!valeur) return '-';
  const brut = String(valeur).trim();
  const m = ISO_DATE.exec(brut);
  if (m) {
    const [annee, mois, jour] = m[1].split('-');
    return `${jour}/${mois}/${annee}`;
  }
  const d = new Date(brut);
  return isNaN(d.getTime()) ? brut : enFr(d, false);
}

/** Date + heure : « 06/10/2026 15:42 ». Une valeur sans heure reste une date. */
export function dateHeureFr(valeur?: string | null): string {
  if (!valeur) return '-';
  const brut = String(valeur).trim();
  const m = ISO_AVEC_HEURE.exec(brut);
  if (m) {
    // Minuit (ou absence d'heure) = une simple date, pas un instant.
    if (m[2] === '00:00') return dateFr(brut);
    const d = new Date(brut);
    if (!isNaN(d.getTime())) return enFr(d, true);
    const [annee, mois, jour] = m[1].split('-');
    return `${jour}/${mois}/${annee} ${m[2]}`;
  }
  const d = new Date(brut);
  return isNaN(d.getTime()) ? brut : enFr(d, true);
}
