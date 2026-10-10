/**
 * ============================================================================
 *  MWANA CLASSE — Calendrier scolaire partagé
 * ============================================================================
 *  Règles communes à toutes les interfaces :
 *    - l'école choisit un régime d'activité (« lundi_vendredi » ou
 *      « lundi_samedi ») ; les autres jours sont NON SCOLAIRES ;
 *    - une entrée de calendrier avec « school_closed » ferme l'école sur
 *      toute sa période (jour férié, vacances, fermeture exceptionnelle…).
 *
 *  Un jour FERMÉ = jour non scolaire OU couvert par une fermeture du
 *  calendrier : aucun appel possible, aucune absence comptée, statistiques
 *  exclues — sauf ouverture exceptionnelle explicite (fanion « forcer »).
 * ============================================================================
 */

import type { QueryableClient } from '../http/middleware.js';

export type RegimeActivite = 'lundi_vendredi' | 'lundi_samedi';

/** Une entrée de calendrier couvrant une date donnée. */
export interface EntreeJour {
  titre: string;
  kind: string;
  schoolClosed: boolean;
}

/** État complet d'une date pour une école. */
export interface EtatJour {
  date: string;
  regime: RegimeActivite;
  /** Jour inclus dans le régime hebdomadaire (ex. samedi en régime étendu). */
  scolaire: boolean;
  /** Jour non scolaire OU école fermée par le calendrier. */
  ferme: boolean;
  /** Toutes les entrées publiées couvrant la date (fériés compris). */
  evenements: EntreeJour[];
}

export const REGIMES: RegimeActivite[] = ['lundi_vendredi', 'lundi_samedi'];

export function estRegime(valeur: unknown): valeur is RegimeActivite {
  return valeur === 'lundi_vendredi' || valeur === 'lundi_samedi';
}

/** Dernier jour d'activité du régime : 5 = vendredi, 6 = samedi. */
export function dernierJourRegime(regime: RegimeActivite): number {
  return regime === 'lundi_samedi' ? 6 : 5;
}

/**
 * Un jour est scolaire s'il tombe du lundi au dernier jour du régime.
 * ISO : lundi = 1 … dimanche = 7. Le dimanche n'est jamais scolaire.
 */
export function estJourDuRegime(date: string, regime: RegimeActivite): boolean {
  const jour = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  return jour >= 1 && jour <= dernierJourRegime(regime);
}

/** Construit l'état d'un jour à partir du régime et des entrées couvrantes. */
export function construireEtatJour(
  date: string,
  regime: RegimeActivite,
  entrees: EntreeJour[],
): EtatJour {
  const scolaire = estJourDuRegime(date, regime);
  const fermeture = entrees.some((e) => e.schoolClosed);
  return {
    date,
    regime,
    scolaire,
    ferme: !scolaire || fermeture,
    evenements: entrees,
  };
}

/** Libellé court du motif de fermeture, pour les messages d'erreur. */
export function libelleFermeture(etat: EtatJour): string {
  const fermee = etat.evenements.find((e) => e.schoolClosed);
  if (fermee) {
    return etat.evenements.some((e) => e.kind === 'ferie' && e.schoolClosed)
      ? `Jour férié : ${fermee.titre}`
      : `École fermée : ${fermee.titre}`;
  }
  if (!etat.scolaire) {
    return etat.regime === 'lundi_samedi'
      ? 'Jour non scolaire (dimanche)'
      : 'Jour non scolaire (samedi ou dimanche)';
  }
  return 'École fermée';
}

/* ==========================================================================
 *  Lectures base de données
 * ========================================================================== */

interface LigneEvenement {
  title: string;
  kind: string;
  school_closed: boolean;
}

/** Regime d'activité de l'école (valeur par défaut : lundi → vendredi). */
export async function lireRegime(client: QueryableClient, schoolId: string): Promise<RegimeActivite> {
  const { rows } = await client.query<{ activity_days: string }>(
    `SELECT activity_days FROM app.schools WHERE id = $1`,
    [schoolId],
  );
  const valeur = rows[0]?.activity_days;
  return estRegime(valeur) ? valeur : 'lundi_vendredi';
}

/** Entrées de calendrier publiées couvrant exactement une date. */
async function evenementsDuJour(
  client: QueryableClient,
  schoolId: string,
  date: string,
): Promise<EntreeJour[]> {
  const { rows } = await client.query<LigneEvenement>(
    `SELECT title, kind, school_closed
       FROM app.calendar_events
      WHERE school_id = $1 AND is_published
        AND $2::date BETWEEN starts_on AND coalesce(ends_on, starts_on)
      ORDER BY starts_on`,
    [schoolId, date],
  );
  return rows.map((r) => ({ titre: r.title, kind: r.kind, schoolClosed: r.school_closed }));
}

/** État complet d'une date (régime + entrées de calendrier). */
export async function lireEtatJour(
  client: QueryableClient,
  schoolId: string,
  date: string,
): Promise<EtatJour> {
  const regime = await lireRegime(client, schoolId);
  const evenements = await evenementsDuJour(client, schoolId, date);
  return construireEtatJour(date, regime, evenements);
}

/** État de chaque jour d'une période (bornes incluses, 400 jours maximum). */
export async function lireEtatsJours(
  client: QueryableClient,
  schoolId: string,
  du: string,
  au: string,
): Promise<{ regime: RegimeActivite; jours: EtatJour[] }> {
  const regime = await lireRegime(client, schoolId);
  const { rows } = await client.query<LigneEvenement & { starts_on: string; ends_on: string | null }>(
    `SELECT title, kind, school_closed, starts_on, ends_on
       FROM app.calendar_events
      WHERE school_id = $1 AND is_published
        AND starts_on <= $3::date
        AND coalesce(ends_on, starts_on) >= $2::date
      ORDER BY starts_on`,
    [schoolId, du, au],
  );

  const entrees = rows.map((r) => ({
    titre: r.title,
    kind: r.kind,
    schoolClosed: r.school_closed,
    du: r.starts_on,
    au: r.ends_on ?? r.starts_on,
  }));

  const jours: EtatJour[] = [];
  const curseur = new Date(`${du}T12:00:00Z`);
  const fin = new Date(`${au}T12:00:00Z`);
  while (curseur <= fin && jours.length < 400) {
    const iso = curseur.toISOString().slice(0, 10);
    jours.push(
      construireEtatJour(
        iso,
        regime,
        entrees.filter((e) => iso >= e.du && iso <= e.au),
      ),
    );
    curseur.setUTCDate(curseur.getUTCDate() + 1);
  }
  return { regime, jours };
}

/* ==========================================================================
 *  Filtrage statistique
 * ========================================================================== */

/**
 * Fragment SQL à ajouter aux requêtes sur « app.attendance a » pour exclure
 * les jours non scolaires et les jours d'école fermée.
 * Paramètres : le $n suivant est l'identifiant de l'école (passer
 * explicitement le schoolId en dernier paramètre de la requête).
 */
export function filtreJoursScolairesSql(paramEcole: string): string {
  return `
    AND EXISTS (
      SELECT 1 FROM app.schools s
       WHERE s.id = ${paramEcole}
         AND extract(isodow FROM a.attendance_date)
             BETWEEN 1 AND (CASE WHEN s.activity_days = 'lundi_samedi' THEN 6 ELSE 5 END))
    AND NOT EXISTS (
      SELECT 1 FROM app.calendar_events e
       WHERE e.school_id = ${paramEcole} AND e.school_closed
         AND a.attendance_date BETWEEN e.starts_on AND coalesce(e.ends_on, e.starts_on))`;
}
