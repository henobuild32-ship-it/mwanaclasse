/**
 * Génère les icônes PWA de MwanaClasse (PNG) sans dépendance externe.
 * Usage : node scripts/generer-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const sortie = join(racine, 'public', 'icons');

/* ------------------------------------------------------------------ */
/*  Encodage PNG minimal (8 bits RVB, sans alpha)                      */
/* ------------------------------------------------------------------ */

const TABLE_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const octet of buf) c = TABLE_CRC[(c ^ octet) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, donnees) {
  const corps = Buffer.concat([Buffer.from(type, 'ascii'), donnees]);
  const longueur = Buffer.alloc(4);
  longueur.writeUInt32BE(donnees.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corps));
  return Buffer.concat([longueur, corps, crc]);
}

function png(largeur, hauteur, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0);
  ihdr.writeUInt32BE(hauteur, 4);
  ihdr[8] = 8; // bits par composante
  ihdr[9] = 2; // type : RVB
  const brut = Buffer.alloc((largeur * 3 + 1) * hauteur);
  for (let y = 0; y < hauteur; y++) {
    brut[y * (largeur * 3 + 1)] = 0; // filtre « aucun »
    pixels.copy
      ? pixels.copy(brut, y * (largeur * 3 + 1) + 1, y * largeur * 3, (y + 1) * largeur * 3)
      : brut.set(
          pixels.subarray(y * largeur * 3, (y + 1) * largeur * 3),
          y * (largeur * 3 + 1) + 1,
        );
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(brut, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/*  Tracé : dégradé bleu → teal + lettre « M » blanche                 */
/* ------------------------------------------------------------------ */

const LETTRE_M = [
  'X...X',
  'XX.XX',
  'X.X.X',
  'X...X',
  'X...X',
  'X...X',
  'X...X',
];

function melange(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function generer(taille, { arrondi = 0.22, lettre = true, marge = 0.16 } = {}) {
  const pixels = Buffer.alloc(taille * taille * 3);
  const bleu = [29, 78, 216]; // #1d4ed8
  const teal = [13, 148, 136]; // #0d9488
  const fond = [246, 248, 251]; // #f6f8fb
  const rayon = Math.round(taille * arrondi);

  const echelle = Math.max(1, Math.floor((taille * (1 - 2 * marge)) / LETTRE_M.length));
  const largeurLettre = echelle * 5;
  const hauteurLettre = echelle * LETTRE_M.length;
  const x0 = Math.floor((taille - largeurLettre) / 2);
  const y0 = Math.floor((taille - hauteurLettre) / 2);

  for (let y = 0; y < taille; y++) {
    for (let x = 0; x < taille; x++) {
      // Masque à coins arrondis (le fond reste pour les PNG « any »)
      const dx = Math.max(0, rayon - Math.min(x, taille - 1 - x));
      const dy = Math.max(0, rayon - Math.min(y, taille - 1 - y));
      const dansCoins = dx > 0 && dy > 0 && dx * dx + dy * dy > rayon * rayon;
      let couleur = dansCoins ? fond : melange(bleu, teal, (x + y) / (2 * taille));

      if (lettre && !dansCoins) {
        const lx = Math.floor((x - x0) / echelle);
        const ly = Math.floor((y - y0) / echelle);
        if (lx >= 0 && lx < 5 && ly >= 0 && ly < LETTRE_M.length && LETTRE_M[ly][lx] === 'X') {
          couleur = [255, 255, 255];
        }
      }

      const i = (y * taille + x) * 3;
      pixels[i] = couleur[0];
      pixels[i + 1] = couleur[1];
      pixels[i + 2] = couleur[2];
    }
  }
  return png(taille, taille, pixels);
}

mkdirSync(sortie, { recursive: true });
const fichiers = [
  ['icon-192.png', generer(192)],
  ['icon-512.png', generer(512)],
  ['maskable-512.png', generer(512, { arrondi: 0, lettre: true, marge: 0.28 })],
  ['apple-touch-icon.png', generer(180, { arrondi: 0 })],
  ['favicon-32.png', generer(32, { arrondi: 0.18 })],
];

for (const [nom, contenu] of fichiers) {
  writeFileSync(join(sortie, nom), contenu);
  console.log('  ✓', nom);
}
console.log('Icônes générées dans public/icons');
