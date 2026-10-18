// SPDX-License-Identifier: MIT
/** packages/images/src/dimensions.ts — largeur et hauteur lues dans l'en-tête PNG, JPEG ou WEBP, avec les refus de `Image.open` (Pillow 12). */

export type FormatImage = "PNG" | "JPEG" | "WEBP";
export type Dimensions = readonly [number, number];

/** `Image.MAX_IMAGE_PIXELS` : au-delà du double, Pillow refuse d'ouvrir (bombe de décompression). */
export const MAX_IMAGE_PIXELS = 89_478_485;
const FORMATS: readonly FormatImage[] = ["PNG", "JPEG", "WEBP"];

const u16be = (d: Uint8Array, i: number): number => ((d[i] ?? 0) << 8) | (d[i + 1] ?? 0);
const u32be = (d: Uint8Array, i: number): number =>
  ((d[i] ?? 0) * 0x1000000 + (((d[i + 1] ?? 0) << 16) | ((d[i + 2] ?? 0) << 8) | (d[i + 3] ?? 0))) >>> 0;
const u32le = (d: Uint8Array, i: number): number =>
  ((d[i + 3] ?? 0) * 0x1000000 + (((d[i + 2] ?? 0) << 16) | ((d[i + 1] ?? 0) << 8) | (d[i] ?? 0))) >>> 0;
const commence = (d: Uint8Array, prefixe: readonly number[], depuis = 0): boolean =>
  d.length >= depuis + prefixe.length && prefixe.every((o, i) => d[depuis + i] === o);
const ascii = (d: Uint8Array, debut: number, fin: number): string =>
  String.fromCharCode(...d.subarray(debut, fin));

let tableCrc: Uint32Array | null = null;

function crc32(d: Uint8Array, debut: number, fin: number): number {
  if (tableCrc === null) {
    tableCrc = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tableCrc[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = debut; i < fin; i++) c = (tableCrc[(c ^ (d[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Modes de `_MODES` (profondeur, type de couleur) de PngImagePlugin. */
const MODES_PNG: Readonly<Record<string, string>> = {
  "1,0": "1",
  "2,0": "L",
  "4,0": "L",
  "8,0": "L",
  "16,0": "I;16",
  "8,2": "RGB",
  "16,2": "RGB",
  "1,3": "P",
  "2,3": "P",
  "4,3": "P",
  "8,3": "P",
  "8,4": "LA",
  "16,4": "RGBA",
  "8,6": "RGBA",
  "16,6": "RGBA",
};
const CID = /^[A-Za-z0-9_]{4}/;

/** `PngImageFile._open` : morceaux lus et vérifiés (CRC) jusqu'au premier IDAT. */
function png(d: Uint8Array): Dimensions | null {
  if (!commence(d, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  let i = 8;
  let taille: Dimensions | null = null;
  let mode: string | null = null;
  const apng = { sequence: null as number | null };
  for (;;) {
    if (i + 8 > d.length) return null;
    const longueur = u32be(d, i);
    const cid = ascii(d, i + 4, i + 8);
    if (!CID.test(cid)) return null;
    const debut = i + 8;
    if (cid === "IDAT" || cid === "IEND") break;
    if (cid === "fdAT") return null;
    const fin = debut + longueur;
    if (fin > d.length) return null;
    if (cid === "IHDR") {
      if (longueur < 13) return null;
      taille = [u32be(d, debut), u32be(d, debut + 4)];
      mode = MODES_PNG[`${d[debut + 8]},${d[debut + 9]}`] ?? null;
      if (d[debut + 11]) return null;
    } else if (!morceauLisible(cid, d.subarray(debut, fin), mode, taille, apng)) return null;
    if (fin + 4 > d.length || crc32(d, i + 4, fin) !== u32be(d, fin)) return null;
    i = fin + 4;
  }
  return mode !== null && taille !== null ? taille : null;
}

/** Morceaux auxiliaires dont Pillow lit des champs (taille fixe, méthode de compression, séquence APNG) : sinon il lève. */
function morceauLisible(
  cid: string,
  s: Uint8Array,
  mode: string | null,
  taille: Dimensions | null,
  apng: { sequence: number | null },
): boolean {
  const n = s.length;
  switch (cid) {
    case "gAMA":
      return n >= 4;
    case "sRGB":
      return n >= 1;
    case "pHYs":
      return n >= 9;
    case "cHRM":
      return n % 4 === 0;
    case "acTL":
      return n >= 8;
    case "tRNS":
      if (mode === "1" || mode === "L" || mode === "I;16") return n >= 2;
      return mode === "RGB" ? n >= 6 : true;
    case "iCCP": {
      const nul = s.indexOf(0);
      return nul + 1 < n && s[nul + 1] === 0;
    }
    case "zTXt": {
      const nul = s.indexOf(0);
      return nul < 0 || nul + 1 >= n || s[nul + 1] === 0;
    }
    case "fcTL": {
      if (n < 26) return false;
      const seq = u32be(s, 0);
      if ((apng.sequence === null && seq !== 0) || (apng.sequence !== null && apng.sequence !== seq - 1))
        return false;
      apng.sequence = seq;
      if (taille === null) return false;
      return u32be(s, 12) + u32be(s, 4) <= taille[0] && u32be(s, 16) + u32be(s, 8) <= taille[1];
    }
    default:
      return true;
  }
}

const SOF = new Set([
  0xffc0, 0xffc1, 0xffc2, 0xffc3, 0xffc5, 0xffc6, 0xffc7, 0xffc9, 0xffca, 0xffcb, 0xffcd, 0xffce, 0xffcf,
  0xffde,
]);
/** `ICC_PROFILE\0` : les segments ICC sont triés au SOF, le premier doit porter son rang (octet 13). */
const ICC = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00];
const SANS_GESTION = new Set([
  0xffc8, 0xffd0, 0xffd1, 0xffd2, 0xffd3, 0xffd4, 0xffd5, 0xffd6, 0xffd7, 0xffd8, 0xffd9,
]);

/** `JpegImageFile._open` : marqueurs parcourus jusqu'au SOS ; le SOF donne la taille (8 bits, 1, 3 ou 4 composantes). */
function jpeg(d: Uint8Array): Dimensions | null {
  if (!commence(d, [0xff, 0xd8, 0xff])) return null;
  let i = 3;
  let octet = 0xff;
  let taille: Dimensions | null = null;
  let mode = "";
  const icc: Buffer[] = [];
  const segment = (): Uint8Array | null => {
    if (i + 2 > d.length) return null;
    const n = u16be(d, i) - 2;
    i += 2;
    if (n <= 0) return d.subarray(i, i);
    if (i + n > d.length) return null;
    const s = d.subarray(i, i + n);
    i += n;
    return s;
  };
  for (;;) {
    if (octet !== 0xff) {
      if (i >= d.length) return null;
      octet = d[i++] ?? 0;
      continue;
    }
    if (i >= d.length) return null;
    const marqueur = 0xff00 | (d[i++] ?? 0);
    if (marqueur === 0xff00) {
      if (i >= d.length) return null;
      octet = d[i++] ?? 0;
      continue;
    }
    if (marqueur === 0xffff) {
      octet = 0xff;
      continue;
    }
    if (marqueur < 0xffc0 || marqueur > 0xfffe) return null;
    if (!SANS_GESTION.has(marqueur) && !(marqueur >= 0xfff0 && marqueur <= 0xfffd)) {
      const s = segment();
      if (s === null) return null;
      if (SOF.has(marqueur)) {
        if (s.length < 6) return null;
        taille = [u16be(s, 3), u16be(s, 1)];
        if (s[0] !== 8) return null;
        mode = { 1: "L", 3: "RGB", 4: "CMYK" }[s[5] ?? 0] ?? "";
        if (!mode) return null;
        if (icc.length > 0 && icc.reduce((a, b) => (Buffer.compare(a, b) <= 0 ? a : b)).length < 14)
          return null;
        icc.length = 0;
        for (let k = 6; k < s.length; k += 3) if (k + 2 >= s.length) return null;
      } else if (marqueur === 0xffe2 && commence(s, ICC)) icc.push(Buffer.from(s));
      else if (marqueur === 0xffdb && !tablesQuantification(s)) return null;
      else if (marqueur === 0xffe0 && commence(s, [0x4a, 0x46, 0x49, 0x46]) && s.length < 7) return null;
      else if (marqueur === 0xffee && commence(s, [0x41, 0x64, 0x6f, 0x62, 0x65]) && s.length < 7)
        return null;
    }
    if (marqueur === 0xffda) break;
    if (i >= d.length) return null;
    octet = d[i++] ?? 0;
  }
  return mode && taille !== null ? taille : null;
}

/** Gestionnaire DQT : chaque table annonce sa précision et doit tenir dans le segment. */
function tablesQuantification(s: Uint8Array): boolean {
  let k = 0;
  while (k < s.length) {
    const longueur = 1 + ((s[k] ?? 0) >> 4 === 0 ? 1 : 2) * 64;
    if (s.length - k < longueur) return false;
    k += longueur;
  }
  return true;
}

/** `WebPAnimDecoder` : conteneur RIFF entier, puis taille de la toile (VP8X) ou du flux VP8 / VP8L. */
function webp(d: Uint8Array): Dimensions | null {
  if (!commence(d, [0x52, 0x49, 0x46, 0x46]) || ascii(d, 8, 12) !== "WEBP") return null;
  const premier = ascii(d, 12, 16);
  if (premier !== "VP8 " && premier !== "VP8X" && premier !== "VP8L") return null;
  const fichier = u32le(d, 4) + 8;
  if (fichier > d.length || fichier < 20 || fichier % 2) return null;
  const morceaux: { cid: string; debut: number; longueur: number }[] = [];
  for (let i = 12; i < fichier;) {
    if (i + 8 > fichier) return null;
    const longueur = u32le(d, i + 4);
    const debut = i + 8;
    if (debut + longueur > fichier) return null;
    morceaux.push({ cid: ascii(d, i, i + 4), debut, longueur });
    i = debut + longueur + (longueur % 2);
  }
  const image = morceaux.find((m) => m.cid === "VP8 " || m.cid === "VP8L" || m.cid === "ANMF");
  if (premier === "VP8X") {
    const x = morceaux[0];
    if (x === undefined || x.longueur < 10 || image === undefined) return null;
    const w = 1 + ((d[x.debut + 4] ?? 0) | ((d[x.debut + 5] ?? 0) << 8) | ((d[x.debut + 6] ?? 0) << 16));
    const h = 1 + ((d[x.debut + 7] ?? 0) | ((d[x.debut + 8] ?? 0) << 8) | ((d[x.debut + 9] ?? 0) << 16));
    return [w, h];
  }
  if (image === undefined) return null;
  return fluxWebp(d, image.cid, image.debut, image.longueur);
}

function fluxWebp(d: Uint8Array, cid: string, debut: number, longueur: number): Dimensions | null {
  if (cid === "VP8 ") {
    if (longueur < 10 || (d[debut] ?? 0) & 1 || !commence(d, [0x9d, 0x01, 0x2a], debut + 3)) return null;
    const w = ((d[debut + 6] ?? 0) | ((d[debut + 7] ?? 0) << 8)) & 0x3fff;
    const h = ((d[debut + 8] ?? 0) | ((d[debut + 9] ?? 0) << 8)) & 0x3fff;
    return w > 0 && h > 0 ? [w, h] : null;
  }
  if (cid === "VP8L") {
    if (longueur < 5 || d[debut] !== 0x2f) return null;
    const bits = u32le(d, debut + 1);
    if (bits >>> 29 !== 0) return null;
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  return null;
}

/** Taille d'une image dans l'un des `formats` ; `null` là où `Image.open` lèverait (en-tête refusé, taille nulle, bombe). */
export function dimensionsImage(d: Uint8Array, formats: readonly FormatImage[] = FORMATS): Dimensions | null {
  const lecteurs: Readonly<Record<FormatImage, (x: Uint8Array) => Dimensions | null>> = {
    PNG: png,
    JPEG: jpeg,
    WEBP: webp,
  };
  for (const f of formats) {
    const t = lecteurs[f](d);
    if (t === null) continue;
    const [w, h] = t;
    if (w <= 0 || h <= 0 || Math.max(1, w) * Math.max(1, h) > 2 * MAX_IMAGE_PIXELS) return null;
    return t;
  }
  return null;
}
