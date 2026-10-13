import { Injectable } from '@angular/core';

/** Payload JSON toléré pour les QR déjà imprimés par l'API. */
interface PayloadQr {
  l?: string;
  code?: string;
  c?: string;
}

/** Préfixe canonique d'un code élève, sans tiret : `MC-ELV`. */
const PREFIXE_ELEVE = 'MCELV';
/** Corps minimal attendu après le préfixe (contrainte SQL : 4 à 12 caractères). */
const CORPS_MINIMAL = 4;
/** Un code élève tel qu'il apparaît dans un texte scanné. */
const REGEX_CODE_DANS_TEXTE = /MC[-\s]?ELV[-\s]?[A-Z0-9]{4,}/;

/**
 * Génération de QR codes et lecture des codes scannés, **entièrement locale**
 * (la bibliothèque `qrcode` est embarquée dans l'application, aucun appel
 * réseau : les cartes se lisent aussi hors ligne).
 */
@Injectable({ providedIn: 'root' })
export class QrService {
  /**
   * Data-URL PNG d'un QR code.
   *
   * `margin` porte la marge de silence (4 modules minimum : c'est elle qui
   * garantit que les lecteurs distinguent le motif du décor de la carte).
   */
  async generer(
    texte: string,
    options: { largeur?: number; marge?: number } = {},
  ): Promise<string> {
    const QRCode = (await import('qrcode')).default;
    return QRCode.toDataURL(texte, {
      errorCorrectionLevel: 'M',
      margin: options.marge ?? 4,
      width: options.largeur ?? 512,
      color: { dark: '#000000ff', light: '#ffffffff' },
    });
  }

  /**
   * Code élève contenu dans une chaîne scannée : JSON de l'API, texte brut
   * (`MC-ELV-XXXXXX`) ou code seul saisi sans préfixe.
   */
  extraireCode(brut: string): string {
    const texte = (brut ?? '').trim();
    if (!texte) return '';
    if (texte.startsWith('{')) {
      try {
        const objet = JSON.parse(texte) as PayloadQr;
        const dedans = objet.l ?? objet.code ?? objet.c;
        if (dedans) return this.normaliser(dedans);
      } catch {
        /* payload non JSON : on retombe sur la recherche dans le texte */
      }
    }
    const trouve = texte.match(REGEX_CODE_DANS_TEXTE);
    return this.normaliser(trouve ? trouve[0] : texte);
  }

  /**
   * Ramène un code au format stocké `MC-ELV-XXXXXXXXXX`, exactement comme le
   * fait l'API : insensible à la casse, aux espaces, aux tirets et aux traits
   * de soulignement. Miroir local de `normalizeStudentCode`.
   */
  normaliser(raw: string): string {
    const compact = (raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (compact.startsWith(PREFIXE_ELEVE)) {
      const corps = compact.slice(PREFIXE_ELEVE.length);
      if (corps.length >= CORPS_MINIMAL) return `MC-ELV-${corps}`;
      return compact;
    }
    if (compact.startsWith('MCPAR') || compact.startsWith('MCECOLE')) return compact;
    return compact ? `MC-ELV-${compact}` : compact;
  }
}
