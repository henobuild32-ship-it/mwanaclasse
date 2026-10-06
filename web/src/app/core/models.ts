/**
 * Modèles partagés de l'application MwanaClasse (École + Parent).
 * Les champs marqués « optionnels » correspondent à des réponses API
 * dont la présence varie selon les routes ou les versions.
 */

export type Interface = 'ecole' | 'parent';

export interface ReponseConnexion {
  message: string;
  jetonAcces: string;
  expireDans: number;
  profil: ProfilConnexion;
}

export interface ProfilConnexion {
  kind?: Interface;
  interface?: Interface;
  id: string;
  fullName?: string;
  full_name?: string;
  email?: string;
  phone?: string;
  schoolId?: string | null;
  school_id?: string | null;
  schoolName?: string;
  official_name?: string;
  /** Types d'enseignement proposés par l'établissement (sélection multiple). */
  types?: string[] | null;
  public_code?: string;
  primaryColor?: string;
  primary_color?: string;
  jobTitle?: string;
  isOwner?: boolean;
  is_owner?: boolean;
  permissions?: string[];
  mustChangePassword?: boolean;
  twoFactorEnabled?: boolean;
  totp_enabled?: boolean;
  childrenCount?: number;
  enfants_actifs?: number;
}

export interface ErreurApi {
  erreur?: string;
  message?: string;
  details?: { champ: string; message: string }[];
}

/* ------------------------------------------------------------------ */
/*  École                                                              */
/* ------------------------------------------------------------------ */

export interface Eleve {
  id: string;
  public_code: string;
  last_name: string;
  middle_name?: string | null;
  first_name: string;
  full_name: string;
  gender?: 'M' | 'F' | null;
  date_of_birth?: string | null;
  place_of_birth?: string | null;
  status: string;
  version?: number;
  photo_url?: string | null;
  internal_number?: string | null;
  class_id?: string;
  classe?: string;
  section_id?: string | null;
  section?: string | null;
  created_at?: string;
  archived_at?: string | null;
  presence_aujourdhui?: string | null;
  parents_connectes?: number;
}

export interface Classe {
  id: string;
  name: string;
  level?: string | null;
  level_order?: number;
  max_capacity: number;
  effectif?: number;
  places_disponibles?: number;
  etat_capacite?: string;
  taux_occupation?: number;
  is_active: boolean;
  room?: string | null;
  notes?: string | null;
  sections?: Section[];
  sections_detail?: Section[];
  annee_scolaire?: string;
}

export interface Section {
  id: string;
  class_id?: string;
  name: string;
  short_code?: string | null;
  max_capacity?: number | null;
  effectif?: number;
  is_active?: boolean;
}

export interface PresencesEleve {
  student_id: string;
  public_code: string;
  full_name: string;
  gender?: string | null;
  photo_url?: string | null;
  class_id: string;
  classe: string;
  section_id?: string | null;
  section?: string | null;
  status: string;
  arrival_time?: string | null;
  departure_time?: string | null;
}

export interface RecapPresence {
  date: string;
  total: number;
  presents: number;
  absents: number;
  retards: number;
  departs: number;
  nonEnregistres: number;
}

export interface TableauBordEcole {
  eleves: {
    total: number;
    presentsAujourdhui: number;
    absentsAujourdhui: number;
    retardsAujourdhui: number;
    departsAnticipesAujourdhui: number;
    presencesNonEnregistrees: number;
  };
  classes: {
    total: number;
    sections: number;
    occupation: number;
    classesProchesCapacite: number;
  };
  presences: {
    presents: number;
    absents: number;
    retards: number;
    nonEnregistres: number;
    classesSansPresence: number;
    tendance30Jours: { date: string; taux: number }[] | unknown;
  };
  communiques: {
    publies: number;
    brouillons: number;
    programmes: number;
    derniers: unknown[];
  };
  demandes: { enAttente: number; enCours: number };
  parents: { liaisonsAValider: number };
  activite: { dernieresPresences: unknown[]; derniersEleves: unknown[] };
}

export interface ParentEcole {
  id: string;
  full_name: string;
  email?: string | null;
  phone?: string | null;
  relationship?: string | null;
  is_active: boolean;
  last_seen_at?: string | null;
  enfants_actifs?: number;
  en_attente?: number;
  enfants?: unknown[];
}

export interface Liaison {
  id: string;
  status: string;
  relationship?: string | null;
  requested_at?: string | null;
  requested_ip?: string | null;
  requested_device?: string | null;
  requested_method?: string | null;
  decided_at?: string | null;
  decision_note?: string | null;
  parent_id?: string;
  parent?: string;
  email?: string | null;
  phone?: string | null;
  student_id?: string;
  eleve?: string;
  public_code?: string | null;
  classe?: string | null;
  section?: string | null;
}

export interface Demande {
  id: string;
  reference?: string;
  kind?: string;
  subject?: string | null;
  message?: string | null;
  status: string;
  priority?: string | null;
  absence_date?: string | null;
  absence_reason?: string | null;
  justification_decision?: string | null;
  assigned_to_name?: string | null;
  handled_at?: string | null;
  created_at?: string;
  parent?: string | null;
  eleve?: string | null;
  messages?: MessageDemande[];
}

export interface MessageDemande {
  id?: string;
  author_type?: string;
  author_name?: string;
  body: string;
  created_at?: string;
}

export interface Communique {
  id: string;
  reference?: string | null;
  kind?: string;
  title: string;
  subject?: string | null;
  summary?: string | null;
  body_html?: string | null;
  body_text?: string | null;
  status: string;
  is_urgent?: boolean;
  audience_kind?: string;
  published_at?: string | null;
  publish_at?: string | null;
  created_at?: string;
  attachment_url?: string | null;
}

export interface DocumentEcole {
  id: string;
  category?: string | null;
  title: string;
  description?: string | null;
  file_url?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  visibility?: string | null;
  downloads?: number;
  is_active?: boolean;
}

export interface EvenementCalendrier {
  id: string;
  kind?: string;
  title: string;
  description?: string | null;
  starts_on: string;
  ends_on?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  all_day?: boolean;
  location?: string | null;
  audience_kind?: string;
  is_published?: boolean;
}

export interface Notification {
  id: string;
  kind?: string;
  title: string;
  body?: string | null;
  severity?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  action_url?: string | null;
  read_at?: string | null;
  created_at?: string;
}

export interface Alerte {
  type: string;
  gravite: string;
  titre: string;
  detail?: string | null;
  action?: string | null;
}

export interface ParametresEcole {
  ecole: {
    id: string;
    public_code: string;
    slug?: string;
    official_name: string;
    short_name?: string | null;
    type?: string | null;
    logo_url?: string | null;
    primary_color?: string | null;
    secondary_color?: string | null;
    address_line?: string | null;
    commune?: string | null;
    city?: string | null;
    phones?: string[] | string | null;
    email?: string | null;
    website?: string | null;
    description?: string | null;
    opening_hours?: string | null;
    current_year_label?: string | null;
    parent_link_mode?: string;
    signature_name?: string | null;
    signature_title?: string | null;
    settings?: Record<string, unknown>;
  };
  anneesScolaires?: { id: string; label: string; is_current: boolean }[];
  personnel?: {
    id: string;
    email: string;
    full_name: string;
    job_title?: string | null;
    is_active?: boolean;
    is_owner?: boolean;
    totp_enabled?: boolean;
    roles?: string[];
  }[];
  statistiques?: { eleves: number; classes: number; presences: number; communiques: number };
}

/* ------------------------------------------------------------------ */
/*  Parent                                                             */
/* ------------------------------------------------------------------ */

export interface Enfant {
  id: string;
  full_name: string;
  public_code?: string | null;
  gender?: string | null;
  date_of_birth?: string | null;
  photo_url?: string | null;
  classe?: string | null;
  class_id?: string;
  section?: string | null;
  section_id?: string;
  ecole?: string | null;
  primary_color?: string | null;
  lien_statut?: string;
  lien_id?: string;
  relationship?: string | null;
  is_primary?: boolean;
  presence?: string;
  presence_aujourdhui?: string;
  arrival_time?: string | null;
  recorded_at?: string | null;
}

export interface TableauBordParent {
  enfants: Enfant[];
  communiques?: unknown[];
  calendrier?: EvenementCalendrier[];
  demandes?: Demande[];
  notifications?: Notification[];
  precision?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Synchronisation hors ligne                                         */
/* ------------------------------------------------------------------ */

export type TypeEntiteSync =
  | 'attendance'
  | 'attendance.bulk'
  | 'request'
  | 'request.message'
  | 'announcement.draft'
  | 'student.draft'
  | 'notification.read';

export type TypeOperation = 'create' | 'update' | 'delete' | 'upsert' | 'action';

export interface OperationSync {
  opUuid: string;
  entityType: TypeEntiteSync;
  opType: TypeOperation;
  entityId?: string | null;
  payload: Record<string, unknown>;
  baseVersion?: number | null;
  clientTime?: string | null;
  deviceId?: string | null;
}

export interface EtatSync {
  terminaux?: unknown[];
  operationsEnAttente?: number;
  conflitsNonResolus?: number;
  conseil?: string;
}
