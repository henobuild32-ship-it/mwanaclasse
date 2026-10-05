# MwanaClasse — Guide des interfaces utilisateur

## Vue d'ensemble

MwanaClasse propose **deux interfaces distinctes** selon le profil :
- **Espace École** : pour le personnel de direction, secrétariat, enseignants
- **Espace Parent** : pour les parents/tuteurs d'élèves

Les deux interfaces partagent le même design system (mobile-first, PWA, offline-first) mais ont des parcours et permissions différents.

---

## 0. PAGES PUBLIQUES (VITRINE)

Les pages vitrine ont leur **propre layout** (pas de barre de l'application) : la barre
du haut de l'app réapparaît automatiquement après connexion.

| Page | Route | Contenu |
|------|-------|---------|
| Accueil | `/` | Hero dégradé (bleu → teal), badge PWA/hors-ligne, 2 cartes d'entrée « Je suis une École » / « Je suis Parent » (chacune avec un lien d'inscription), visuel « Présences du jour », 3 atouts, pied de page |
| Connexion école | `/connexion/ecole` | Layout split : panneau marque à gauche (avantages) / formulaire à droite |
| Connexion parent | `/connexion/parent` | Idem, avec lien **Créer un compte parent** |
| Inscription école | `/inscription/ecole` | Idem, formulaire en 2 étapes |
| **Inscription parent** | `/inscription/parent` | Idem, **code école obligatoire** (normalisé et vérifié côté API : 404 `ECOLE_INTROUVABLE` si inconnu) |
| Mot de passe oublié | `/mot-de-passe-oublie` | Idem, envoi des instructions de réinitialisation |

Responsive : hero empilé (< 1080 px), 2 colonnes (≥ 1080 px) ; cartes d'entrée en 2
colonnes ≥ 640 px.

---

## 1. ESPACE ÉCOLE

### Accès
- URL : `/connexion/ecole`
- Identifiants : email professionnel + mot de passe + code école (optionnel)
- Comptes démo : `directeur@ecole-demo.cd` / `secretaire@ecole-demo.cd` / `presence@ecole-demo.cd`
- Mot de passe : `MotDePasseDemo2026!`
- Code école démo : `MC-ECOLE-DEMO01`

### Navigation (barre du bas / rail latéral ≥1024px)
| Icône | Libellé | Route | Description |
|-------|---------|-------|-------------|
| 🏠 | Accueil | `/ecole` | Tableau de bord synthétique |
| 🗓️ | Présences | `/ecole/presences` | Feuille d'appel journalière + exports |
| 👥 | Élèves | `/ecole/eleves` | Liste, fiches, inscription |
| ⋯ | Plus | `/ecole/plus` | Menu complet (voir ci-dessous) |

### Menu « Plus » (`/ecole/plus`)
| Lien | Route | Description |
|------|-------|-------------|
| 🏫 Classes & sections | `/ecole/classes` | Gestion classes, sections, effectifs, jauges |
| 👨‍👩‍👧 Parents | `/ecole/parents` | Comptes parents, enfants rattachés, recherche |
| 🔗 Demandes de liaison | `/ecole/liaisons` | Validation/refus liens parent↔élève |
| 📢 Communiqués | `/ecole/communiques` | Création, publication, programmation, lecture |
| 📨 Demandes des parents | `/ecole/demandes` | Traitement réclamations, justificatifs, réponses |
| 📄 Documents | `/ecole/documents` | Dépôt/consultation fichiers (PDF, images, etc.) |
| 📅 Calendrier | `/ecole/calendrier` | Événements scolaires, création, publication |
| 🔔 Notifications | `/ecole/notifications` | Centre alertes admin, marquer comme lues |
| ⚙️ Paramètres | `/ecole/parametres` | Identité école, années, personnel, couleurs |

### Pages détaillées — Espace École

#### 1. Tableau de bord (`/ecole`)
- **KPI** : total élèves, présents/absents/retards aujourd'hui, classes, présences totales, communiqués, demandes en attente, parents connectés
- **Activité récente** : dernières présences, communiqués, demandes
- **Accès rapide** : boutons vers Présences, Élèves, Communiqués, Demandes

#### 2. Présences (`/ecole/presences`)
- **Filtres** : date (par défaut aujourd'hui), classe (select)
- **Feuille d'appel** : liste élèves avec boutons statut (Présent/Retard/Absent/Départ)
- **Actions** : « Tout présent », « Enregistrer la feuille »
- **Mode hors-ligne** : modifications mises en file, synchronisation auto au retour réseau
- **Exports** : 📄 **PDF** (mise en page professionnelle, stats, en-tête école) · 📝 **DOCX** (tableau Word editable)
- **Récapitulatif** : présents, absents, retards, départs anticipés, non enregistrés
- **Historique** : accès via fiche élève

#### 3. Élèves (`/ecole/eleves`)
- **Liste paginée** : 60 élèves, filtres (statut, classe, section, recherche)
- **Colonnes** : code, nom, classe/section, statut, présence aujourd'hui, parents connectés
- **Fiche élève** (`/ecole/eleves/:id`) :
  - Identité complète (nom, code, date/lieu naissance, genre, classe, section, année)
  - Contacts & santé (téléphone tuteur, adresse, notes médicales — audit loggé)
  - Récap 30 jours (présents/absents/retards, taux)
  - Parents connectés (statut lien, email, téléphone)
  - Actions : Archivier/Réactiver, Voir présences
- **Inscription** (`/ecole/eleves/nouveau`) : formulaire complet (nom, post-nom, prénom, genre, naissance, classe, section, n° interne, téléphone tuteur, adresse, notes médicales)

#### 4. Classes & sections (`/ecole/classes`)
- **Vue classes** : nom, niveau, salle, effectif/capacité, jauge occupation, état (complet/proche/normale), sections
- **Création classe** : nom, niveau, capacité, salle, notes
- **Création section** : classe parente, nom, code court, capacité
- **Sections** : liste avec effectifs par classe parente

#### 5. Parents (`/ecole/parents`)
- **Liste** : nom, email/téléphone, enfants actifs, demandes en attente, dernière connexion
- **Recherche** temps réel par nom/email/téléphone
- **Lien** vers demandes de liaison

#### 6. Demandes de liaison (`/ecole/liaisons`)
- **Filtres** : en attente / actif / refusé / tous
- **Cartes** : parent ↔ élève, classe/section, relation, date/méthode demande
- **Actions** : Approuver (avec note optionnelle) / Refuser
- **Historique** : date décision, note

#### 7. Communiqués (`/ecole/communiques`)
- **Filtres** : tous / brouillon / programmé / publié
- **Création** : titre, objet, résumé, corps (HTML), type (communiqué, note parents, rappel, annonce, invitation, urgent, changement horaire, réunion, calendrier, administratif), urgence, audience (toute école / niveau / classe / section / élève / custom), programmation (immédiate / différée / brouillon)
- **Liste** : titre, type, audience, statut, date publication, lu/non lu, destinataires
- **Actions** : Publier (depuis brouillon/programmé), voir détails

#### 8. Demandes des parents (`/ecole/demandes`)
- **Filtres** : tous / en attente / en cours / répondu / clôturé
- **Détail** : parent, élève, classe, type, objet, message, date absence, motif, priorité
- **Réponse** : message, nouveau statut (en attente / en cours / répondu / clôturé), décision justification (acceptée / refusée / à vérifier)
- **Historique échanges** : messages parent/école horodatés

#### 9. Documents (`/ecole/documents`)
- **Liste** : titre, catégorie, fichier, taille, visibilité, téléchargements, date, déposé par
- **Action** : Ouvrir (nouvel onglet)

#### 10. Calendrier (`/ecole/calendrier`)
- **Création événement** : titre, description, type (rentrée, cours, congé, vacances, examen, réunion, événement, journée spéciale, férié, autre), dates début/fin, heures, toute la journée, lieu, audience (toute école / niveau / classe / section), classes ciblées
- **Affichage** : liste à venir avec vignette date, type, école, portée

#### 11. Notifications (`/ecole/notifications`)
- **Liste** : icône selon sévérité (🚨 critique, ⚠️ alerte, 🔔 info), titre, corps, type, entité liée, date
- **Actions** : Tout marquer comme lu, navigation via lien d'action

#### 12. Paramètres (`/ecole/parametres`)
- **Identité** : nom officiel/court, type, logo, couleurs primaire/secondaire, adresse, commune, ville, province, téléphone, email, site web, description, horaires, mode liaison (auto/validation), signature (nom/titre), couleur primaire
- **Années scolaires** : liste avec statut (courante/à venir/archivée)
- **Personnel** : liste comptes, rôles, statut, 2FA, dernière connexion
- **Stats** : élèves, classes, présences, communiqués

---

## 2. ESPACE PARENT

### Accès
- URL : `/connexion/parent`
- **Inscription** : `/inscription/parent` — nom complet, **code école (obligatoire, vérifié par l'API)**,
  e-mail et/ou téléphone, lien avec l'enfant, mot de passe. Accessible depuis la carte
  « Je suis Parent » de l'accueil (`Créer un compte parent`) et depuis la page de connexion.
- Identifiants : email ou téléphone + mot de passe
- Comptes démo : `parent1@example.cd` … `parent28@example.cd`
- Mot de passe : `MotDePasseDemo2026!`

### Navigation (barre du bas / rail latéral ≥1024px)
| Icône | Libellé | Route | Description |
|-------|---------|-------|-------------|
| 🏠 | Accueil | `/parent` | Tableau de bord parental |
| 👧 | Enfants | `/parent/enfants` | Liste enfants rattachés |
| 📨 | Demandes | `/parent/demandes` | Mes demandes à l'école |
| ⋯ | Plus | `/parent/plus` | Menu complet (voir ci-dessous) |

### Menu « Plus » (`/parent/plus`)
| Lien | Route | Description |
|------|-------|-------------|
| 📢 Communiqués | `/parent/communiques` | Messages reçus de l'école |
| 📅 Calendrier | `/parent/calendrier` | Événements des écoles des enfants |
| 📄 Documents | `/parent/documents` | Fichiers mis à disposition |
| 🔔 Notifications | `/parent/notifications` | Centre notifications parent |
| 🏫 Rejoindre une école | `/parent/ajouter-ecole` | Ajout école via code public |
| 👤 Mon profil | `/parent/profil` | Infos, appareils, suppression compte |

### Pages détaillées — Espace Parent

#### 1. Tableau de bord (`/parent`)
- **Bienvenue** : nom parent, indicateur « à jour » / alertes
- **Enfants** : cartes (photo initiale, nom, classe, école, présence aujourd'hui, statut lien) — max 3 affichées + lien « Tout voir »
- **Communiqués non lus** : compteur + 3 derniers (titre, école, date, bouton « Lire »)
- **Actions rapides** : + Ajouter un enfant, Mes demandes, Communiqués, Calendrier

#### 2. Enfants (`/parent/enfants`)
- **Cartes enfants** : photo initiale, nom, classe, école, présence aujourd'hui (badge coloré), statut lien
- **Actions** : Voir le suivi complet → fiche détail, + Ajouter un enfant

#### 3. Fiche enfant (`/parent/enfants/:id`)
- **En-tête** : nom, classe/section, école, année, badge présence du jour
- **Présence aujourd'hui** : statut, arrivée, départ, mode, note précision
- **30 derniers jours** : 4 stats (présents, absents, retards, départs)
- **Contacts école** : téléphone, email, code enfant, relation, statut lien
- **Historique récent** : 10 dernières journées (date, statut, heures, motif)
- **Actions** : Voir les demandes, Demander une clarification

#### 4. Ajouter un enfant (`/parent/enfants/ajouter`)
- **Formulaire** : code école (ex: `MC-ECOLE-DEMO01`), code enfant (ex: `MC-ELV-XXXXXX`), relation (père, mère, tuteur, oncle, tante, grand-parent, frère, sœur, parent, autre)
- **Vérification** : double code (école + enfant) anti-énumération

#### 5. Demandes (`/parent/demandes`)
- **Liste** : référence, type (réclamation, demande info, dérogation, correction, question présence, justification absence, autre), objet, statut, priorité, date
- **Détail** : échanges parent↔école (messages horodatés, auteur)
- **Nouvelle demande** : enfant concerné (optionnel), type, objet, message, date absence + motif (si justificatif)
- **Statuts** : en attente → en cours → répondu → clôturé

#### 6. Communiqués (`/parent/communiques`)
- **Liste** : badge « nouveau » / « URGENT », titre, objet, école, élève concerné, classe, date publication
- **Lecture** : expansion inline avec corps HTML + pièce jointe PDF
- **Actions** : Tout marquer comme lu, lire/réduire individuel

#### 7. Calendrier (`/parent/calendrier`)
- **Cette semaine** : vignettes date + événements
- **À venir** : liste groupée (date, titre, type, heures, lieu, école, portée, enfants concernés)

#### 8. Documents (`/parent/documents`)
- **Liste** : titre, catégorie, nom fichier, taille, école, date, bouton « Ouvrir »

#### 9. Notifications (`/parent/notifications`)
- **Liste** : icône sévérité, titre, corps, type, date, badge « nouveau », navigation via lien d'action
- **Action** : Tout marquer comme lu

#### 10. Rejoindre une école (`/parent/ajouter-ecole`)
- **Formulaire** : code public école (format `MC-ECOLE-XXXXX`)
- **Validation** : anti-énumération (quota IP)

#### 11. Mon profil (`/parent/profil`)
- **Informations** : nom complet, email, téléphone (modifiables)
- **Appareils connectés** : liste (libellé, IP, user-agent, dernier usage, 2FA), bouton « Déconnecter » par appareil
- **Zone sensible** : suppression compte (mot de passe + taper « SUPPRIMER »)

---

## 3. FONCTIONNALITÉS TRANSVERSES

### Design System (tokens CSS)
- **Couleurs** : primaire (#1d4ed8), accent (#0d9488), danger (#b91c1c), succès (#047857), alerte (#b45309)
- **Espacements** : grille 4px, rayon 16px/10px, ombre standard
- **Typographie** : Segoe UI / system-ui, tailles responsives
- **Composants** : btn (primaire/secondaire/contour/danger/discret/ligne/petit/large), carte, badge, pastille, input/select/textarea, avatar, jauge, kpi, alerte, toast, modal, dropdown, skeleton, onglets, table responsive

### PWA / Offline-First
- **Service Worker** : cache statique (app shell, assets, manifest, icônes), stratégies network-first / stale-while-revalidate
- **IndexedDB** : stores `donnees` (cache entités), `operations` (file d'attente écritures), `meta` (curseurs, clientId)
- **Sync** : push (envoi lot opérations) / pull (différentiel depuis curseur) / état (en_cours/succes/erreur/idle)
- **Indicateurs UI** : pastille « En ligne / Hors ligne », compteur opérations en file, spinner sync

### Sécurité & Audit
- **Mots de passe** : Argon2id (par défaut) / bcrypt / PBKDF2, pepper serveur, vérification force (zxcvbn-like)
- **Sessions** : JWT access (1h) + refresh token HttpOnly cookie (rotation, détection vol, révocation)
- **2FA** : TOTP (RFC 6238) optionnel, codes secours
- **RLS PostgreSQL** : isolation par école (`app.school_id`), par parent (`app.parent_id`), acteur `system` pour inscriptions
- **Audit trail** : chaîne hachée (SHA-256), entrées signées, immuables (trigger DB)

### API (Fastify, TypeScript)
- **Auth** : `/auth/ecole/connexion`, `/auth/parent/connexion`, `/auth/renouveler`, `/auth/deconnexion`, `/auth/mot-de-passe-oublie`, `/auth/ecole/inscription`, `/auth/parent/inscription`
- **École** : `/ecole/*` (tableau-bord, classes, eleves, presences, communiques, demandes, documents, calendrier, notifications, parametres, liaisons, code/QR)
- **Parent** : `/parent/*` (tableau-bord, enfants, demandes, communiques, calendrier, documents, notifications, ecoles, profil, appareils)
- **Sync** : `/sync/client`, `/sync/push`, `/sync/pull`, `/sync/etat`
- **Formats** : JSON, codes d'erreur (`ERREUR`, `DONNEES_INVALIDES`, `SESSION_EXPIREE`, `ACCES_REFUSE`, etc.), pagination (`limit`, `offset`, `total`)

---

## 4. COMPTES DE DÉMONSTRATION

| Rôle | Email | Mot de passe | Code école |
|------|-------|--------------|------------|
| Directeur | `directeur@ecole-demo.cd` | `MotDePasseDemo2026!` | `MC-ECOLE-DEMO01` |
| Secrétaire | `secretaire@ecole-demo.cd` | `MotDePasseDemo2026!` | `MC-ECOLE-DEMO01` |
| Responsable présences | `presence@ecole-demo.cd` | `MotDePasseDemo2026!` | `MC-ECOLE-DEMO01` |
| Parent 1 | `parent1@example.cd` | `MotDePasseDemo2026!` | — |
| … | `parentN@example.cd` | `MotDePasseDemo2026!` | — |

---

## 5. DÉMARRAGE RAPIDE

```bash
# API
cd api
npm run db:migrate && npm run db:seed && npm run build && npm run start
# → http://localhost:4000

# Frontend
cd web
npm run build && npm run start
# → http://localhost:4200 (proxy vers :4000)
```

**Test E2E headless** (Playwright/Chromium) :
```bash
cd web
node ../temp/verif.js   # teste 27 routes école+parent, login, exports
```

---

## 6. ARCHITECTURE DES DOSSIERS (web/src/app)

```
features/
  accueil/           # Page d'accueil publique
  auth/              # Connexion, inscription, mot de passe oublié (école + parent)
  ecole/             # Espace école complet
    ecole-layout.*   # Coquille (barre haute, nav, toasts)
    presences.*      # Feuille d'appel + export PDF/DOCX
    eleves.*         # Liste + fiche + inscription
    eleves-fiche.*   # Détail élève
    eleves-nouveau.* # Inscription élève
    classes.*        # Classes & sections
    parents.*        # Liste parents
    liaisons.*       # Demandes de liaison
    communiques.*    # CRUD communiqués
    demandes.*       # Traitement demandes parents
    documents.*      # Liste documents
    calendrier.*     # CRUD événements
    notifications.*  # Centre notifications
    parametres.*     # Identité, années, personnel
    plus.*           # Menu "Plus"
    ecole.routes.ts  # Routes lazy-loaded
  parent/            # Espace parent complet
    parent-layout.*  # Coquille
    tableau-de-bord.*
    enfants.*        # Liste + fiche + ajout
    enfants-detail.*
    enfants-ajouter.*
    demandes.*       # Liste + détail + nouvelle
    communiques.*    # Liste + lecture
    calendrier.*
    documents.*
    notifications.*
    ajouter-ecole.*
    profil.*
    plus.*
    parent.routes.ts
core/                # Services partagés (API, session, sync, connectivité, toast, guards, models)
shared/ui.ts         # Composants UI réutilisables (Toast, TitrePage, CarteStat, EtatVide, Chargement, Etiquette)
```

---

*Document généré pour MwanaClasse v1.0 — Spécification complète interfaces École & Parent*