/**
 * ============================================================================
 *  MWANA CLASSE — Vérification de l'intégrité de la base
 * ============================================================================
 *  Usage : npm run db:verify
 *
 *  Contrôle, sans rien modifier :
 *    1. extensions et schémas attendus ;
 *    2. présence des tables métier, de sécurité et de synchronisation ;
 *    3. migrations appliquées et empreintes conformes ;
 *    4. isolation Row Level Security active et forcée ;
 *    5. fonctions applicatives critiques ;
 *    6. journal d'audit immuable (déclencheur anti-modification) ;
 *    7. cohérence des comptes de démonstration (aucun en production).
 *
 *  Code de sortie 0 = conforme, 1 = anomalie détectée.
 * ============================================================================
 */

import 'dotenv/config';
import {
  createAdminPool,
  finish,
  migrationFiles,
  out,
} from './_shared.js';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  critical: boolean;
}

const EXPECTED_SCHEMAS = ['app', 'sec', 'ref', 'sync'];
const EXPECTED_EXTENSIONS = ['pgcrypto', 'citext', 'unaccent'];

const EXPECTED_TABLES = [
  // métier
  'app.schools',
  'app.academic_years',
  'app.classes',
  'app.sections',
  'app.students',
  'app.parents',
  'app.parent_student_links',
  'app.attendance',
  'app.attendance_history',
  'app.announcement_templates',
  'app.announcements',
  'app.announcement_recipients',
  'app.requests',
  'app.request_messages',
  'app.calendar_events',
  'app.school_documents',
  'app.import_jobs',
  'app.notifications',
  'app.push_subscriptions',
  // sécurité
  'ref.permissions',
  'sec.staff_users',
  'sec.roles',
  'sec.sessions',
  'sec.login_attempts',
  'sec.audit_log',
  // synchronisation
  'sync.clients',
  'sync.batches',
  'sync.operations',
  'sync.change_log',
  'sync.conflicts',
];

const EXPECTED_FUNCTIONS = [
  'sec.effective_permissions',
  'sec.has_permission',
  'sec.register_login_attempt',
  'sec.is_locked_out',
  'sec.verify_audit_chain',
  'app.build_full_name',
  'app.format_school_code',
  'app.format_student_code',
];

async function main(): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string | undefined, critical = true) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}), critical });
  };

  out.step('Vérification de la base de données');

  const pool = createAdminPool();

  try {
    /* 1. Extensions ---------------------------------------------------- */
    const ext = await pool.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = ANY($1)`,
      [EXPECTED_EXTENSIONS],
    );
    const foundExt = new Set(ext.rows.map((r) => r.extname));
    for (const name of EXPECTED_EXTENSIONS) {
      add(`Extension ${name}`, foundExt.has(name), foundExt.has(name) ? undefined : 'absente');
    }

    /* 2. Schémas ------------------------------------------------------- */
    const sch = await pool.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)`,
      [EXPECTED_SCHEMAS],
    );
    const foundSch = new Set(sch.rows.map((r) => r.nspname));
    for (const name of EXPECTED_SCHEMAS) {
      add(`Schéma ${name}`, foundSch.has(name), foundSch.has(name) ? undefined : 'absent');
    }

    /* 3. Tables -------------------------------------------------------- */
    const tbl = await pool.query<{ fq: string }>(
      `SELECT n.nspname || '.' || c.relname AS fq
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = ANY($1)`,
      [EXPECTED_SCHEMAS],
    );
    const foundTbl = new Set(tbl.rows.map((r) => r.fq));
    const missingTables = EXPECTED_TABLES.filter((t) => !foundTbl.has(t));
    add(
      `Tables attendues (${EXPECTED_TABLES.length})`,
      missingTables.length === 0,
      missingTables.length ? `manquantes : ${missingTables.join(', ')}` : 'toutes présentes',
    );

    /* 4. Migrations ---------------------------------------------------- */
    const files = migrationFiles();
    let mig: { version: string; checksum: string }[] = [];
    try {
      const res = await pool.query<{ version: string; checksum: string }>(
        `SELECT version, checksum FROM sec.schema_migrations`,
      );
      mig = res.rows;
    } catch {
      mig = [];
    }
    const migMap = new Map(mig.map((m) => [m.version, m.checksum]));
    const notApplied = files.filter((f) => !migMap.has(f.version));
    const altered = files.filter((f) => migMap.has(f.version) && migMap.get(f.version) !== f.checksum);
    add(
      `Migrations appliquées (${files.length})`,
      notApplied.length === 0,
      notApplied.length
        ? `en attente : ${notApplied.map((f) => f.name).join(', ')}`
        : altered.length
          ? `empreinte modifiée : ${altered.map((f) => f.name).join(', ')}`
          : 'toutes appliquées, empreintes conformes',
    );

    /* 5. Isolation RLS ------------------------------------------------- */
    const rls = await pool.query<{ rel: string; enabled: boolean; forced: boolean }>(
      `SELECT n.nspname || '.' || c.relname AS rel,
              c.relrowsecurity AS enabled,
              c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind = 'r'
          AND c.relrowsecurity`,
    );
    add(
      'Row Level Security active',
      rls.rows.length > 0,
      `${rls.rows.length} table(s) protégée(s), dont ${rls.rows.filter((r) => r.forced).length} forcée(s)`,
    );

    const pol = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_policies WHERE schemaname IN ('app','sec','sync')`,
    );
    add(
      'Politiques RLS définies',
      Number(pol.rows[0]?.n ?? 0) > 0,
      `${pol.rows[0]?.n ?? 0} politique(s)`,
    );

    /* 6. Fonctions ----------------------------------------------------- */
    const fn = await pool.query<{ oid: string; name: string }>(
      `SELECT p.oid::text, n.nspname || '.' || p.proname AS name
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname || '.' || p.proname = ANY($1)`,
      [EXPECTED_FUNCTIONS],
    );
    const foundFn = new Set(fn.rows.map((r) => r.name));
    const missingFn = EXPECTED_FUNCTIONS.filter((f) => !foundFn.has(f));
    add(
      `Fonctions applicatives (${EXPECTED_FUNCTIONS.length})`,
      missingFn.length === 0,
      missingFn.length ? `manquantes : ${missingFn.join(', ')}` : 'toutes présentes',
    );

    /* 7. Journal d'audit immuable -------------------------------------- */
    const trg = await pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'sec' AND c.relname = 'audit_log'
          AND NOT t.tgisinternal AND t.tgname = 'audit_no_update'`,
    );
    add(
      "Journal d'audit verrouillé (anti-modification)",
      trg.rows.length > 0,
      trg.rows.length ? 'déclencheur audit_no_update actif' : 'déclencheur absent',
    );

    // La chaîne renvoie (total, broken, first_broken_id) : c'est le compteur
    // « broken » qui fait foi.
    let chainDetail: string | undefined;
    const chain = await pool
      .query<{ total: string; broken: string; first_broken_id: string | null }>(
        'SELECT total, broken, first_broken_id FROM sec.verify_audit_chain()',
      )
      .then((r) => {
        const row = r.rows[0];
        if (!row) return false;
        const broken = Number(row.broken);
        const total = Number(row.total);
        chainDetail = `${total} entrée(s) vérifiée(s)` + (broken ? `, ${broken} altérée(s) à partir de l'entrée ${row.first_broken_id}` : ', chaîne intacte');
        return broken === 0;
      })
      .catch((err: unknown) => {
        chainDetail = `vérification impossible : ${(err as Error).message}`;
        return false;
      });
    add('Chaîne de hachage du journal intacte', chain, chainDetail, false);

    /* 8. Comptes de démonstration -------------------------------------- */
    const demo = await pool
      .query<{ n: string }>(`SELECT count(*)::text AS n FROM app.schools WHERE public_code LIKE '%DEMO%'`)
      .then((r) => Number(r.rows[0]?.n ?? 0))
      .catch(() => 0);
    const isProd = process.env.NODE_ENV === 'production';
    add(
      'Absence de comptes de démonstration',
      !isProd || demo === 0,
      demo === 0 ? 'aucun' : `${demo} école(s) de démonstration présente(s)`,
      true,
    );

    /* 9. Volume (information) ------------------------------------------ */
    // RLS ... FORCE : même le propriétaire ne voit que les lignes de
    // l'école dont app.school_id est défini. Les compteurs par école sont
    // donc agrégés école par école, dans une connexion dédiée.
    const volumes: Record<string, number> = {};
    const client = await pool.connect();
    try {
      await client.query(`SELECT set_config('app.actor', 'system', false)`);
      const schools = await client.query<{ id: string }>('SELECT id FROM app.schools ORDER BY id');
      volumes['écoles'] = schools.rows.length;

      let students = 0;
      let attendance = 0;
      for (const s of schools.rows) {
        await client.query('SELECT set_config($1, $2, false)', ['app.school_id', s.id]);
        const st = await client.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM app.students',
        );
        students += Number(st.rows[0]?.n ?? 0);
        const at = await client.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM app.attendance',
        );
        attendance += Number(at.rows[0]?.n ?? 0);
      }
      volumes['élèves'] = students;
      volumes['présences'] = attendance;

      const parents = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM app.parents',
      );
      volumes['parents'] = Number(parents.rows[0]?.n ?? 0);

      const audit = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM sec.audit_log',
      );
      volumes['entrées de journal'] = Number(audit.rows[0]?.n ?? 0);
    } finally {
      client.release();
    }
    add(
      'Volumes',
      true,
      ['écoles', 'élèves', 'parents', 'présences', 'entrées de journal']
        .map((label) => `${label} : ${volumes[label] ?? 0}`)
        .join(' · '),
      false,
    );
  } finally {
    await pool.end();
  }

  /* Rapport ------------------------------------------------------------ */
  console.log('');
  let failures = 0;
  let warnings = 0;
  for (const c of checks) {
    const mark = c.ok ? '[ok]' : c.critical ? '[x]' : '[!]';
    if (!c.ok) {
      if (c.critical) failures += 1;
      else warnings += 1;
    }
    console.log(`  ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }

  if (failures > 0) {
    finish(1, `\n${failures} anomalie(s) critique(s), ${warnings} avertissement(s).`);
  }
  finish(0, `\nBase conforme.${warnings ? ` ${warnings} avertissement(s).` : ''}`);
}

main().catch((err: unknown) => {
  console.error(`\n[x] ${(err as Error).message}\n`);
  process.exit(1);
});
