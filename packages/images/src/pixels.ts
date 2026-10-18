// SPDX-License-Identifier: MIT
/** packages/images/src/pixels.ts — pixels comme Pillow, sans module natif : PNG (pngjs), JPEG (jpeg-js), WebP (libwebp en WebAssembly), orientation EXIF, rééchantillonnage de Pillow ; lancé aussi en thread de travail. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { crc32, deflateSync, inflateSync } from "node:zlib";

import { decode as decoderJpegBrut, encode as encoderJpegBrut } from "jpeg-js";
import pngjs from "pngjs";

/** Image décodée : mode de Pillow, pixels en RVBA 8 bits, métadonnées lues comme `Image.open`. */
type Ouverte = {
  format: "PNG" | "JPEG" | "WEBP";
  mode: string;
  largeur: number;
  hauteur: number;
  rvba: Uint8Array;
  exif: Uint8Array | null;
  xmp: string | null;
  icc: Uint8Array | null;
};
/** Trame de 1 (L), 3 (RGB) ou 4 (RGBA) canaux de 8 bits. */
type Trame = { largeur: number; hauteur: number; canaux: number; donnees: Uint8Array };
type Filtre = { f: (x: number) => number; support: number };
/** Exports des modules WebAssembly de libwebp (deploy/codecs/webp) : mémoire, allocation, interface d'Elpis, version. */
type CodecWebp = {
  memory: { buffer: ArrayBuffer };
  _initialize(): void;
  malloc(n: number): number;
  free(p: number): void;
  elpis_webp_decode(donnees: number, taille: number, largeur: number, hauteur: number): number;
  elpis_webp_encode(
    rvba: number,
    l: number,
    h: number,
    qualite: number,
    methode: number,
    taille: number,
  ): number;
  elpis_webp_free(p: number): void;
  WebPGetDecoderVersion(): number;
  WebPGetEncoderVersion(): number;
};
type ApiWasm = {
  compile(octets: Uint8Array): Promise<object>;
  instantiate(module: object, imports: object): Promise<{ exports: unknown }>;
};

const wasm = (globalThis as unknown as { WebAssembly: ApiWasm }).WebAssembly;
/** libwebp 1.3.2 et après : décodage sans perte corrigé (CVE-2023-4863). */
export const LIBWEBP_MIN = 0x010302;
const IMPORTS_WEBP = {
  env: { emscripten_notify_memory_growth: (): void => undefined },
  wasi_snapshot_preview1: { fd_close: (): number => 8, fd_write: (): number => 8, fd_seek: (): number => 8 },
};

const PRECISION = 22;
const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(x * Math.PI) / (x * Math.PI));
const BOITE: Filtre = { f: (x) => (x > -0.5 && x <= 0.5 ? 1 : 0), support: 0.5 };
const BICUBIQUE: Filtre = {
  f: (v) => {
    const x = Math.abs(v);
    if (x < 1) return (1.5 * x - 2.5) * x * x + 1;
    return x < 2 ? (((x - 5) * x + 8) * x - 4) * -0.5 : 0;
  },
  support: 2,
};
const LANCZOS: Filtre = { f: (x) => (-3 <= x && x < 3 ? sinc(x) * sinc(x / 3) : 0), support: 3 };

const commence = (o: Uint8Array, debut: number, texte: string): boolean =>
  [...texte].every((c, i) => o[debut + i] === c.charCodeAt(0));

/** `precompute_coeffs` + `normalize_coeffs_8bpc` de Pillow : bornes du support et poids en virgule fixe (22 bits). */
function coefficients(entree: number, debut: number, fin: number, sortie: number, filtre: Filtre) {
  const d = Math.fround(debut);
  const echelle = Math.fround(Math.fround(fin) - d) / sortie;
  const etalement = echelle < 1 ? 1 : echelle;
  const support = filtre.support * etalement;
  const ksize = Math.ceil(support) * 2 + 1;
  const [kk, bornes, poids] = [
    new Int32Array(sortie * ksize),
    new Int32Array(sortie * 2),
    new Float64Array(ksize),
  ];
  const ss = 1 / etalement;
  for (let xx = 0; xx < sortie; xx++) {
    const centre = d + (xx + 0.5) * echelle;
    const xmin = Math.max(0, Math.trunc(centre - support + 0.5));
    const xmax = Math.min(entree, Math.trunc(centre + support + 0.5)) - xmin;
    let total = 0;
    for (let x = 0; x < xmax; x++) total += poids[x] = filtre.f((x + xmin - centre + 0.5) * ss);
    for (let x = 0; x < xmax; x++) {
      const k = total !== 0 ? (poids[x] ?? 0) / total : (poids[x] ?? 0);
      kk[xx * ksize + x] = Math.trunc(k < 0 ? -0.5 + k * 2 ** PRECISION : 0.5 + k * 2 ** PRECISION);
    }
    [bornes[xx * 2], bornes[xx * 2 + 1]] = [xmin, xmax];
  }
  return { ksize, kk, bornes };
}

const borner8 = (somme: number): number => Math.min(255, Math.max(0, somme >> PRECISION));

/** `ImagingResample` (8 bits) de Pillow : passe horizontale sur les seules lignes utiles, puis verticale. */
function reechantillonner(
  t: Trame,
  largeur: number,
  hauteur: number,
  filtre: Filtre,
  boite: readonly [number, number, number, number] = [0, 0, t.largeur, t.hauteur],
): Trame {
  const c = t.canaux;
  const b = boite.map(Math.fround);
  const [b0, b1, b2, b3] = [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0];
  const h = coefficients(t.largeur, b0, b2, largeur, filtre);
  const v = coefficients(t.hauteur, b1, b3, hauteur, filtre);
  let source = t;
  if (largeur !== t.largeur || b0 !== 0 || b2 !== largeur) {
    const premiere = v.bornes[0] ?? 0;
    const lignes = (v.bornes[hauteur * 2 - 2] ?? 0) + (v.bornes[hauteur * 2 - 1] ?? 0) - premiere;
    for (let i = 0; i < hauteur; i++) v.bornes[i * 2] = (v.bornes[i * 2] ?? 0) - premiere;
    const sortie = new Uint8Array(largeur * lignes * c);
    for (let y = 0; y < lignes; y++) {
      const ligne = (y + premiere) * t.largeur * c;
      for (let xx = 0; xx < largeur; xx++) {
        const [xmin, xmax, k0] = [h.bornes[xx * 2] ?? 0, h.bornes[xx * 2 + 1] ?? 0, xx * h.ksize];
        for (let ch = 0; ch < c; ch++) {
          let somme = 1 << (PRECISION - 1);
          for (let x = 0; x < xmax; x++)
            somme += (t.donnees[ligne + (x + xmin) * c + ch] ?? 0) * (h.kk[k0 + x] ?? 0);
          sortie[(y * largeur + xx) * c + ch] = borner8(somme);
        }
      }
    }
    source = { largeur, hauteur: lignes, canaux: c, donnees: sortie };
  }
  if (hauteur === t.hauteur && b1 === 0 && b3 === hauteur) return source;
  const pas = source.largeur * c;
  const sortie = new Uint8Array(pas * hauteur);
  for (let yy = 0; yy < hauteur; yy++) {
    const [ymin, ymax, k0] = [v.bornes[yy * 2] ?? 0, v.bornes[yy * 2 + 1] ?? 0, yy * v.ksize];
    for (let x = 0; x < pas; x++) {
      let somme = 1 << (PRECISION - 1);
      for (let y = 0; y < ymax; y++)
        somme += (source.donnees[(y + ymin) * pas + x] ?? 0) * (v.kk[k0 + y] ?? 0);
      sortie[yy * pas + x] = borner8(somme);
    }
  }
  return { largeur: source.largeur, hauteur, canaux: c, donnees: sortie };
}

/** `Image.resize` : copie si rien ne change ; RGBA prémultiplié (RGBa) le temps du calcul, comme Pillow. */
function redimensionner(
  t: Trame,
  largeur: number,
  hauteur: number,
  filtre: Filtre,
  boite?: readonly [number, number, number, number],
): Trame {
  const b = boite ?? [0, 0, t.largeur, t.hauteur];
  if (
    largeur === t.largeur &&
    hauteur === t.hauteur &&
    b[0] === 0 &&
    b[1] === 0 &&
    b[2] === largeur &&
    b[3] === hauteur
  )
    return { ...t, donnees: new Uint8Array(t.donnees) };
  if (t.canaux !== 4) return reechantillonner(t, largeur, hauteur, filtre, b);
  const p = new Uint8Array(t.donnees);
  for (let i = 0; i < p.length; i += 4)
    for (let c = 0; c < 3; c++) {
      const m = (p[i + c] ?? 0) * (p[i + 3] ?? 0) + 128;
      p[i + c] = ((m >> 8) + m) >> 8;
    }
  const r = reechantillonner({ ...t, donnees: p }, largeur, hauteur, filtre, b);
  for (let i = 0; i < r.donnees.length; i += 4) {
    const a = r.donnees[i + 3] ?? 0;
    if (a === 0 || a === 255) continue;
    for (let c = 0; c < 3; c++)
      r.donnees[i + c] = Math.min(255, Math.trunc((255 * (r.donnees[i + c] ?? 0)) / a));
  }
  return r;
}

/** Source de chaque pixel par orientation EXIF : `sx = ax + bx·x + cx·y`, `sy = ay + by·x + cy·y` (w−1, h−1 notés −1). */
const TRANSPOSITIONS: Readonly<Record<number, readonly number[]>> = {
  2: [-1, -1, 0, 0, 0, 1],
  3: [-1, -1, 0, -1, 0, -1],
  4: [0, 1, 0, -1, 0, -1],
  5: [0, 0, 1, 0, 1, 0],
  6: [0, 0, 1, -1, -1, 0],
  7: [-1, 0, -1, -1, -1, 0],
  8: [-1, 0, -1, 0, 1, 0],
};

/** `Image.transpose` des orientations EXIF 2 à 8 (`exif_transpose`). */
function transposer(t: Trame, orientation: number): Trame {
  const [w, h, c] = [t.largeur, t.hauteur, t.canaux];
  const [ax, bx, cx, ay, by, cy] = (TRANSPOSITIONS[orientation] ?? [0, 1, 0, 0, 0, 1]).map((k, i) =>
    i % 3 === 0 && k === -1 ? (i === 0 ? w - 1 : h - 1) : k,
  ) as [number, number, number, number, number, number];
  const [lo, ho] = orientation >= 5 ? [h, w] : [w, h];
  const sortie = new Uint8Array(t.donnees.length);
  for (let y = 0; y < ho; y++)
    for (let x = 0; x < lo; x++) {
      const [de, vers] = [((ay + by * x + cy * y) * w + ax + bx * x + cx * y) * c, (y * lo + x) * c];
      for (let k = 0; k < c; k++) sortie[vers + k] = t.donnees[de + k] ?? 0;
    }
  return { largeur: lo, hauteur: ho, canaux: c, donnees: sortie };
}

/** Tag 0x0112 de l'IFD0 (TIFF « II » ou « MM », préfixe `Exif\0\0` toléré) ; `null` si absent ou illisible. */
function orientationExif(exif: Uint8Array | null): number | null {
  if (exif === null) return null;
  const d = commence(exif, 0, "Exif\0\0") ? exif.subarray(6) : exif;
  try {
    const petit = commence(d, 0, "II");
    if (!petit && !commence(d, 0, "MM")) return null;
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const ifd = v.getUint32(4, petit);
    for (let k = 0, n = v.getUint16(ifd, petit); k < n; k++) {
      const e = ifd + 2 + 12 * k;
      if (v.getUint16(e, petit) !== 0x0112) continue;
      const type = v.getUint16(e + 2, petit);
      if (v.getUint32(e + 4, petit) !== 1) return null;
      return type === 3
        ? v.getUint16(e + 8, petit)
        : type === 4
          ? v.getUint32(e + 8, petit)
          : type === 1
            ? (d[e + 8] ?? null)
            : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** `getexif()` puis repli XMP (`tiff:Orientation`), comme `ImageOps.exif_transpose`. */
function orientation(o: Ouverte): number {
  const exif = orientationExif(o.exif);
  if (exif !== null) return exif;
  const m = o.xmp === null ? null : /tiff:Orientation(="|>)([0-9])/.exec(o.xmp);
  return m ? Number(m[2]) : 1;
}

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

/** Blocs d'un PNG : eXIf, iCCP, XMP (`XML:com.adobe.xmp`) et `Raw profile type exif`, avant ou après IDAT. */
function metadonneesPng(o: Uint8Array): Pick<Ouverte, "exif" | "xmp" | "icc"> {
  const m: Pick<Ouverte, "exif" | "xmp" | "icc"> = { exif: null, xmp: null, icc: null };
  const v = new DataView(o.buffer, o.byteOffset, o.byteLength);
  const textes: Record<string, string> = {};
  for (let i = 8; i + 8 <= o.length;) {
    const n = v.getUint32(i);
    const type = String.fromCharCode(...o.subarray(i + 4, i + 8));
    const d = o.subarray(i + 8, Math.min(o.length, i + 8 + n));
    i += 12 + n;
    const nul = d.indexOf(0);
    try {
      if (type === "eXIf") m.exif = d;
      else if (type === "iCCP" && nul >= 0 && d[nul + 1] === 0) m.icc = inflateSync(d.subarray(nul + 2));
      else if (type === "tEXt" && nul >= 0) textes[latin1(d.subarray(0, nul))] = latin1(d.subarray(nul + 1));
      else if (type === "zTXt" && nul >= 0)
        textes[latin1(d.subarray(0, nul))] = latin1(inflateSync(d.subarray(nul + 2)));
      else if (type === "iTXt" && nul >= 0) {
        const [cle, compresse] = [latin1(d.subarray(0, nul)), d[nul + 1] === 1];
        const langue = d.indexOf(0, nul + 3);
        const corps = d.subarray(d.indexOf(0, langue + 1) + 1);
        textes[cle] = Buffer.from(compresse ? inflateSync(corps) : corps).toString("utf-8");
      } else if (type === "IEND") break;
    } catch {
      continue;
    }
  }
  m.xmp = textes["XML:com.adobe.xmp"] ?? null;
  const brut = textes["Raw profile type exif"];
  if (m.exif === null && brut !== undefined) m.exif = Buffer.from(brut.split("\n").slice(3).join(""), "hex");
  return m;
}

const latin1 = (o: Uint8Array): string => Buffer.from(o).toString("latin1");

function ouvrirPng(o: Uint8Array): Ouverte {
  const [profondeur, type] = [o[24] ?? 0, o[25] ?? 0];
  const mode = MODES_PNG[`${profondeur},${type}`];
  if (mode === undefined) throw new Error(`unknown PNG mode (${profondeur}, ${type})`);
  const png = pngjs.PNG.sync.read(Buffer.from(o.buffer, o.byteOffset, o.byteLength), {
    skipRescale: profondeur === 16,
  });
  let rvba: Uint8Array;
  if (profondeur === 16) {
    const d = png.data as Uint16Array;
    rvba = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i++) {
      const x = d[i] ?? 0;
      rvba[i] = mode === "I;16" ? (i % 4 === 3 ? 255 : Math.min(x, 255)) : x >>> 8;
    }
  } else rvba = png.data as Uint8Array;
  return { format: "PNG", mode, largeur: png.width, hauteur: png.height, rvba, ...metadonneesPng(o) };
}

/** Segments d'un JPEG jusqu'à SOS : composantes (SOF), Exif (le premier), XMP (le dernier), ICC réassemblé. */
function segmentsJpeg(o: Uint8Array): Pick<Ouverte, "exif" | "xmp" | "icc"> & { composantes: number } {
  const m = {
    exif: null as Uint8Array | null,
    xmp: null as string | null,
    icc: null as Uint8Array | null,
    composantes: 3,
  };
  const morceaux: Uint8Array[] = [];
  for (let i = 2; i + 4 <= o.length;) {
    const marqueur = o[i + 1] ?? 0;
    if (o[i] !== 0xff) break;
    if (marqueur === 0xff || marqueur === 0x01 || (marqueur >= 0xd0 && marqueur <= 0xd8)) {
      i += marqueur === 0xff ? 1 : 2;
      continue;
    }
    if (marqueur === 0xda || marqueur === 0xd9) break;
    const n = ((o[i + 2] ?? 0) << 8) | (o[i + 3] ?? 0);
    const s = o.subarray(i + 4, i + 2 + n);
    if (marqueur === 0xe1 && commence(s, 0, "Exif\0\0")) m.exif ??= s;
    else if (marqueur === 0xe1 && commence(s, 0, "http://ns.adobe.com/xap/1.0/\0"))
      m.xmp = latin1(s.subarray(29));
    else if (marqueur === 0xe2 && commence(s, 0, "ICC_PROFILE\0")) morceaux.push(s);
    else if (marqueur >= 0xc0 && marqueur <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marqueur))
      m.composantes = s[5] ?? 3;
    i += 2 + n;
  }
  morceaux.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (morceaux.length && morceaux[0]?.[13] === morceaux.length)
    m.icc = Buffer.concat(morceaux.map((s) => s.subarray(14)));
  return m;
}

const MAX_MEGAPIXELS = (2 * 89_478_485) / 1e6;

function ouvrirJpeg(o: Uint8Array): Ouverte {
  const { composantes, ...meta } = segmentsJpeg(o);
  const r = decoderJpegBrut(o, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: MAX_MEGAPIXELS,
    maxMemoryUsageInMB: 1024,
  });
  const mode = composantes === 1 ? "L" : composantes === 4 ? "CMYK" : "RGB";
  return { format: "JPEG", mode, largeur: r.width, hauteur: r.height, rvba: r.data, ...meta };
}

/** Morceaux RIFF d'un WebP : alpha (VP8X, ou bit du VP8L), EXIF, XMP, ICCP. */
function morceauxWebp(o: Uint8Array): Pick<Ouverte, "exif" | "xmp" | "icc"> & { alpha: boolean } {
  const m = {
    exif: null as Uint8Array | null,
    xmp: null as string | null,
    icc: null as Uint8Array | null,
    alpha: false,
  };
  const v = new DataView(o.buffer, o.byteOffset, o.byteLength);
  for (let i = 12; i + 8 <= o.length;) {
    const type = String.fromCharCode(...o.subarray(i, i + 4));
    const n = v.getUint32(i + 4, true);
    const d = o.subarray(i + 8, Math.min(o.length, i + 8 + n));
    if (type === "VP8X") m.alpha = ((d[0] ?? 0) & 0x10) !== 0;
    else if (type === "VP8L" && d.length >= 5) m.alpha = ((d[4] ?? 0) & 0x10) !== 0;
    else if (type === "ALPH") m.alpha = true;
    else if (type === "EXIF") m.exif = d;
    else if (type === "XMP ") m.xmp = latin1(d);
    else if (type === "ICCP") m.icc = d;
    i += 8 + n + (n % 2);
  }
  return m;
}

let webp: Promise<{ dec: object; enc: object; version: number }> | null = null;

/** Modules compilés de libwebp à côté de ce module : `webp/` du bundle (dist) ou des sources ; refusés sous 1.3.2. */
function chargerWebp(): Promise<{ dec: object; enc: object; version: number }> {
  webp ??= (async () => {
    const dossier = fileURLToPath(new URL("./webp", import.meta.url));
    const compiler = (fichier: string): Promise<object> => wasm.compile(readFileSync(join(dossier, fichier)));
    const [dec, enc] = await Promise.all([compiler("dec/webp_dec.wasm"), compiler("enc/webp_enc.wasm")]);
    const version = (await instanceWebp(dec)).WebPGetDecoderVersion();
    if (version < LIBWEBP_MIN || (await instanceWebp(enc)).WebPGetEncoderVersion() < LIBWEBP_MIN)
      throw new Error("libwebp antérieure à 1.3.2 (CVE-2023-4863) : codecs refusés");
    return { dec, enc, version };
  })();
  return webp;
}

/** Instance neuve à chaque appel : mémoire rendue ensuite, rien de réutilisé après un arrêt de libwebp en cours de route. */
async function instanceWebp(module: object): Promise<CodecWebp> {
  const codec = (await wasm.instantiate(module, IMPORTS_WEBP)).exports as CodecWebp;
  codec._initialize();
  return codec;
}

/** Version de libwebp compilée dans le décodeur (`0x010600` pour 1.6.0). */
export async function versionLibwebp(): Promise<number> {
  return (await chargerWebp()).version;
}

/** Octets copiés dans la mémoire du module, libérés après `f` quoi qu'il arrive ; adresses non signées (mémoire de 4 Gio). */
function avecTampon<T>(codec: CodecWebp, octets: Uint8Array, f: (p: number) => T): T {
  const p = codec.malloc(Math.max(1, octets.length)) >>> 0;
  if (p === 0) throw new Error("mémoire de libwebp épuisée");
  try {
    new Uint8Array(codec.memory.buffer, p, octets.length).set(octets);
    return f(p);
  } finally {
    codec.free(p);
  }
}

/** `WebPAnimDecoder` (première image, RGBA), comme Pillow ; flux refusé → erreur. */
async function decoderWebp(o: Uint8Array): Promise<{ largeur: number; hauteur: number; rvba: Uint8Array }> {
  const dec = await instanceWebp((await chargerWebp()).dec);
  return avecTampon(dec, new Uint8Array(8), (tailles) =>
    avecTampon(dec, o, (entree) => {
      const sortie = dec.elpis_webp_decode(entree, o.length, tailles, tailles + 4) >>> 0;
      if (sortie === 0) throw new Error("cannot decode WebP image");
      try {
        const v = new DataView(dec.memory.buffer);
        const [largeur, hauteur] = [v.getInt32(tailles, true), v.getInt32(tailles + 4, true)];
        return {
          largeur,
          hauteur,
          rvba: new Uint8Array(dec.memory.buffer, sortie, largeur * hauteur * 4).slice(),
        };
      } finally {
        dec.free(sortie);
      }
    }),
  );
}

/** WebP avec perte (préréglage par défaut, `alpha_quality` 100), comme `Image.save(…, "WEBP")`. */
async function encoderWebp(t: Trame, qualite: number, methode: number): Promise<Uint8Array> {
  const enc = await instanceWebp((await chargerWebp()).enc);
  return avecTampon(enc, new Uint8Array(4), (taille) =>
    avecTampon(enc, versRvba(t), (entree) => {
      const sortie = enc.elpis_webp_encode(entree, t.largeur, t.hauteur, qualite, methode, taille) >>> 0;
      if (sortie === 0) throw new Error("cannot encode WebP image");
      try {
        const n = new DataView(enc.memory.buffer).getUint32(taille, true);
        return new Uint8Array(enc.memory.buffer, sortie, n).slice();
      } finally {
        enc.elpis_webp_free(sortie);
      }
    }),
  );
}

async function ouvrirWebp(o: Uint8Array): Promise<Ouverte> {
  const { alpha, ...meta } = morceauxWebp(o);
  const r = await decoderWebp(o);
  return {
    format: "WEBP",
    mode: alpha ? "RGBA" : "RGB",
    largeur: r.largeur,
    hauteur: r.hauteur,
    rvba: r.rvba,
    ...meta,
  };
}

/** `Image.open(…, formats=["PNG", "JPEG", "WEBP"])` : format reconnu à la signature. */
async function ouvrir(o: Uint8Array): Promise<Ouverte> {
  if (commence(o, 0, "\x89PNG\r\n\x1a\n")) return ouvrirPng(o);
  if (o[0] === 0xff && o[1] === 0xd8 && o[2] === 0xff) return ouvrirJpeg(o);
  if (commence(o, 0, "RIFF") && commence(o, 8, "WEBP")) return ouvrirWebp(o);
  throw new Error("cannot identify image file");
}

/** `convert("L" | "RGB" | "RGBA")` depuis les pixels RVBA décodés. */
function convertir(o: Ouverte, canaux: 1 | 3 | 4): Trame {
  const n = o.largeur * o.hauteur;
  const donnees = new Uint8Array(n * canaux);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < canaux; c++) donnees[i * canaux + c] = o.rvba[i * 4 + c] ?? 0;
  return { largeur: o.largeur, hauteur: o.hauteur, canaux, donnees };
}

/** Bloc PNG (longueur, type, données, CRC). */
function bloc(type: string, donnees: Uint8Array): Buffer {
  const corps = Buffer.concat([Buffer.from(type, "latin1"), donnees]);
  const [longueur, controle] = [Buffer.alloc(4), Buffer.alloc(4)];
  longueur.writeUInt32BE(donnees.length);
  controle.writeUInt32BE(crc32(corps));
  return Buffer.concat([longueur, corps, controle]);
}

/** PNG 8 bits (L, RGB ou RGBA), filtres adaptatifs ; profil ICC repris en iCCP comme Pillow (« ICC Profile »). */
function encoderPng(t: Trame, niveau: number, icc: Uint8Array | null = null): Uint8Array {
  const type = { 1: 0, 3: 2, 4: 6 }[t.canaux as 1 | 3 | 4];
  const png = pngjs.PNG.sync.write(
    {
      width: t.largeur,
      height: t.hauteur,
      data: Buffer.from(t.donnees.buffer, t.donnees.byteOffset, t.donnees.byteLength),
    },
    {
      colorType: type,
      inputColorType: type,
      inputHasAlpha: t.canaux === 4,
      bitDepth: 8,
      deflateLevel: niveau,
    },
  );
  if (!icc?.length) return png;
  const iccp = bloc("iCCP", Buffer.concat([Buffer.from("ICC Profile\0\0", "latin1"), deflateSync(icc)]));
  return Buffer.concat([png.subarray(0, 33), iccp, png.subarray(33)]);
}

function versRvba(t: Trame): Uint8Array {
  const n = t.largeur * t.hauteur;
  const d = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) d[i * 4 + c] = t.donnees[i * t.canaux + (t.canaux === 1 ? 0 : c)] ?? 0;
    d[i * 4 + 3] = t.canaux === 4 ? (t.donnees[i * 4 + 3] ?? 255) : 255;
  }
  return d;
}

/** Taille de `Image.thumbnail((côté, côté))` : rapport gardé, chaque côté arrondi au plus juste (≥ 1), jamais agrandie. */
export function tailleVignette(w: number, h: number, cote: number): [number, number] {
  let [x, y] = [cote, cote];
  if (x >= w && y >= h) return [w, h];
  const aspect = w / h;
  const arrondi = (n: number, cle: (k: number) => number): number => {
    const [bas, haut] = [Math.floor(n), Math.ceil(n)];
    return Math.max(cle(haut) < cle(bas) ? haut : bas, 1);
  };
  if (x / y >= aspect) x = arrondi(y * aspect, (k) => Math.abs(aspect - k / y));
  else y = arrondi(x / aspect, (k) => (k === 0 ? 0 : Math.abs(aspect - x / k)));
  return [x, y];
}

/** `prepare_source` : `exif_transpose`, `convert("RGB")`, `ImageOps.fit` (lanczos, recadrage centré), PNG. */
export async function preparerSource(
  data: Uint8Array,
  largeur: number,
  hauteur: number,
): Promise<Uint8Array> {
  const o = await ouvrir(data);
  let t = convertir(o, 3);
  const sens = orientation(o);
  if (sens >= 2 && sens <= 8) t = transposer(t, sens);
  const [rv, rs] = [t.largeur / t.hauteur, largeur / hauteur];
  const [lc, hc] =
    rv === rs ? [t.largeur, t.hauteur] : rv >= rs ? [rs * t.hauteur, t.hauteur] : [t.largeur, t.largeur / rs];
  const [gauche, haut] = [(t.largeur - lc) * 0.5, (t.hauteur - hc) * 0.5];
  const r = redimensionner(t, largeur, hauteur, LANCZOS, [gauche, haut, gauche + lc, haut + hc]);
  return encoderPng(r, 6, o.icc);
}

/** `_thumbnail` : réduction JPEG de `draft`, `thumbnail` (bicubique, RGBA gardé), WebP qualité 80, méthode 4. */
export async function vignetter(data: Uint8Array, cote: number): Promise<Uint8Array> {
  const o = await ouvrir(data);
  let t = convertir(o, ["RGBA", "LA", "P"].includes(o.mode) ? 4 : 3);
  let [w, h] = [t.largeur, t.hauteur];
  if (o.format === "JPEG") {
    const echelle = Math.min(Math.trunc(w / cote), Math.trunc(h / cote));
    const s = [8, 4, 2, 1].find((x) => echelle >= x) ?? 1;
    [w, h] = [Math.ceil(w / s), Math.ceil(h / s)];
  }
  const [lv, hv] = tailleVignette(w, h, cote);
  if (lv !== t.largeur || hv !== t.hauteur)
    t = redimensionner(t, lv, hv, lv === w && hv === h ? BOITE : BICUBIQUE);
  return encoderWebp(t, 80, 4);
}

/** Mode gardé s'il est RGB ou L, sinon `convert("RGB")`, comme les réductions de capture. */
function rvbOuGris(o: Ouverte): Trame {
  return convertir(o, o.mode === "L" ? 1 : 3);
}

/** `_maybe_downscale` : lanczos à `largeurMax` (hauteur `int(h × ratio)`, au moins 1), PNG optimisé, profil ICC gardé. */
export async function reduireEnPng(data: Uint8Array, largeurMax: number): Promise<Uint8Array> {
  const o = await ouvrir(data);
  const t = rvbOuGris(o);
  const hauteur = Math.max(1, Math.trunc(t.hauteur * (largeurMax / t.largeur)));
  return encoderPng(redimensionner(t, largeurMax, hauteur, LANCZOS), 9, o.icc);
}

/** `_downscale_screenshot` : lanczos si plus large que `largeurMax`, JPEG de qualité donnée (RGB). */
export async function reduireEnJpeg(
  data: Uint8Array,
  largeurMax: number,
  qualite: number,
): Promise<Uint8Array> {
  let t = rvbOuGris(await ouvrir(data));
  if (t.largeur > largeurMax) {
    const hauteur = Math.trunc(t.hauteur * (largeurMax / t.largeur));
    if (hauteur <= 0) throw new Error("height and width must be > 0");
    t = redimensionner(t, largeurMax, hauteur, LANCZOS);
  }
  return encoderJpegBrut({ width: t.largeur, height: t.hauteur, data: versRvba(t) }, qualite).data;
}

/** `_frame_sig` du bureau : `convert("L")` (luma L24 de Pillow), `resize((9, 8))` bicubique, dHash 64 bits en 16 chiffres hexadécimaux. */
export async function signatureCapture(data: Uint8Array): Promise<Uint8Array> {
  const o = await ouvrir(data);
  const gris = new Uint8Array(o.largeur * o.hauteur);
  for (let i = 0; i < gris.length; i++)
    gris[i] =
      ((o.rvba[i * 4] ?? 0) * 19595 +
        (o.rvba[i * 4 + 1] ?? 0) * 38470 +
        (o.rvba[i * 4 + 2] ?? 0) * 7471 +
        0x8000) >>>
      16;
  const px = redimensionner(
    { largeur: o.largeur, hauteur: o.hauteur, canaux: 1, donnees: gris },
    9,
    8,
    BICUBIQUE,
  ).donnees;
  let bits = 0n;
  for (let ligne = 0; ligne < 8; ligne++)
    for (let col = 0; col < 8; col++)
      bits = (bits << 1n) | ((px[ligne * 9 + col] ?? 0) > (px[ligne * 9 + col + 1] ?? 0) ? 1n : 0n);
  return Buffer.from(bits.toString(16).padStart(16, "0"), "latin1");
}

/** `_crop_for_region` du bureau : bornes entières marge comprise, rognées à l'image ; l'image telle quelle si la zone fait moins de 4 px. */
export async function recadrerCapture(
  data: Uint8Array,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<Uint8Array> {
  const o = await ouvrir(data);
  const [a, b, c, d] = [Math.max(0, x1), Math.max(0, y1), Math.min(o.largeur, x2), Math.min(o.hauteur, y2)];
  if (c - a < 4 || d - b < 4) return data;
  const canaux = o.mode.includes("A") ? 4 : 3;
  const [l, h] = [c - a, d - b];
  const donnees = new Uint8Array(l * h * canaux);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < l; x++)
      for (let k = 0; k < canaux; k++)
        donnees[(y * l + x) * canaux + k] = o.rvba[((y + b) * o.largeur + x + a) * 4 + k] ?? 0;
  return encoderPng({ largeur: l, hauteur: h, canaux, donnees }, 6);
}

export const OPERATIONS = {
  preparerSource,
  vignetter,
  reduireEnPng,
  reduireEnJpeg,
  signatureCapture,
  recadrerCapture,
};
export type Operation = keyof typeof OPERATIONS;
export type RequetePixels = { id: number; op: Operation; args: unknown[] };
export type ReponsePixels =
  | { id: number; resultat: Uint8Array }
  | { id: number; erreur: { nom: string; message: string } }
  | { pret: true };

/** Thread de travail : requêtes traitées dans l'ordre d'arrivée, octets rendus par transfert. */
function servir(): void {
  const port = parentPort;
  if (port === null) return;
  port.on("message", (r: RequetePixels) => {
    const f = OPERATIONS[r.op] as (...a: unknown[]) => Promise<Uint8Array>;
    f(...r.args).then(
      (octets) => {
        const resultat = new Uint8Array(octets);
        port.postMessage({ id: r.id, resultat } satisfies ReponsePixels, [resultat.buffer]);
      },
      (e: unknown) => {
        const erreur =
          e instanceof Error ? { nom: e.name, message: e.message } : { nom: "Error", message: String(e) };
        port.postMessage({ id: r.id, erreur } satisfies ReponsePixels);
      },
    );
  });
  port.postMessage({ pret: true } satisfies ReponsePixels);
}

if ((workerData as { elpis?: unknown } | null)?.elpis === "pixels") servir();
