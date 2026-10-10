/**
 * ============================================================================
 *  MWANA CLASSE — Jours fériés officiels de la République Démocratique du Congo
 * ============================================================================
 *  Dates fixes (jour/mois) + fêtes mobiles calculées à partir de Pâques
 *  (algorithme grégorien anonyme). L'administrateur peut ensuite modifier ou
 *  supprimer librement chaque entrée dans le calendrier de son école.
 * ============================================================================
 */

import type { QueryableClient } from '../http/middleware.js';

export interface FerieRdc {
  titre: string;
  /** Date au format AAAA-MM-JJ. */
  date: string;
}

/** Dates fixes : [jour du mois, mois, libellé]. */
const FIXES: ReadonlyArray<readonly [number, number, string]> = [
  [1, 1, 'Jour de l’An'],
  [4, 1, 'Journée des Martyrs de l’Indépendance'],
  [16, 1, 'Journée des Héros Nationaux — Laurent-Désiré Kabila'],
  [17, 1, 'Journée des Héros Nationaux — Patrice-Émery Lumumba'],
  [1, 5, 'Fête du Travail'],
  [17, 5, 'Jour de la Libération'],
  [30, 6, 'Fête de l’Indépendance'],
  [1, 8, 'Fête des Parents'],
  [25, 12, 'Noël'],
];

/** Dimanche de Pâques pour une année grégorienne (algorithme de Meeus/Jones/Butcher). */
function paques(annee: number): Date {
  const a = annee % 19;
  const b = Math.floor(annee / 100);
  const c = annee % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mois = Math.floor((h + l - 7 * m + 114) / 31);
  const jour = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(annee, mois - 1, jour));
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function decaler(base: Date, jours: number): string {
  const d = new Date(base.getTime() + jours * 86_400_000);
  return iso(d);
}

/** Liste complète des jours fériés RDC d'une année, triée par date. */
export function feriesRdcPourAnnee(annee: number): FerieRdc[] {
  const p = paques(annee);
  const fixes: FerieRdc[] = FIXES.map(([jour, mois, titre]) => ({
    titre,
    date: `${annee}-${String(mois).padStart(2, '0')}-${String(jour).padStart(2, '0')}`,
  }));
  const mobiles: FerieRdc[] = [
    { titre: 'Lundi de Pâques', date: decaler(p, 1) },
    { titre: 'Ascension', date: decaler(p, 39) },
    { titre: 'Lundi de Pentecôte', date: decaler(p, 50) },
  ];
  return [...fixes, ...mobiles].sort((x, y) => x.date.localeCompare(y.date));
}

/**
 * Insère les jours fériés RDC d'une année dans le calendrier d'une école.
 * Les dates déjà couvertes par un férié existant sont ignorées (l'admin peut
 * avoir ajusté la liste). Retourne le nombre d'entrées créées.
 */
export async function insererFeriesRdc(
  client: QueryableClient,
  input: {
    schoolId: string;
    annee: number;
    anneeScolaireId?: string | null;
    auteur?: string | null;
  },
): Promise<{ crees: number; ignores: number }> {
  const { schoolId, annee, anneeScolaireId, auteur } = input;
  const feries = feriesRdcPourAnnee(annee);
  if (feries.length === 0) return { crees: 0, ignores: 0 };

  // Une seule requête : on insère ceux qui n'ont pas déjà un férié ce jour-là.
  const { rowCount } = await client.query(
    `INSERT INTO app.calendar_events
       (school_id, academic_year_id, kind, title, starts_on, ends_on, all_day,
        audience_kind, is_published, school_closed, created_by_name)
     SELECT $1, $2::uuid, 'ferie', f.titre, f.date::date, NULL, true,
            'toute_ecole', true, true, $4
       FROM unnest($3::text[], $5::text[]) AS f(titre, date)
      WHERE NOT EXISTS (
              SELECT 1 FROM app.calendar_events e
               WHERE e.school_id = $1
                 AND e.kind = 'ferie'
                 AND f.date::date BETWEEN e.starts_on AND coalesce(e.ends_on, e.starts_on))`,
    [
      schoolId,
      anneeScolaireId ?? null,
      feries.map((f) => f.titre),
      auteur ?? 'Pré-remplissage RDC',
      feries.map((f) => f.date),
    ],
  );

  const crees = rowCount ?? 0;
  return { crees, ignores: feries.length - crees };
}
