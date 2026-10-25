// SPDX-License-Identifier: MIT
/** apps/core/src/apparence/skins.ts — registre des skins intégrés et importés : validation, état d'instance, feuille rendue, images servies (shared_infra/appearance/skins.py). */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";

import {
  BLANC_PY,
  clesOrdonnees,
  comparePointsDeCode,
  copieDict,
  copieProfondePy,
  decoderUtf8,
  dictPy,
  encoderUtf8Py,
  ErreurDecodage,
  estAlnumPy,
  estDict,
  estErreurValeur,
  getOu,
  getPy,
  iterExige,
  lireTextePy,
  longueurPy,
  lowerPy,
  ouPy,
  poserCle,
  prefixePy,
  pyJsonLoads,
  reprPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, liveConfigValue, pyJoin, realpathPy } from "@elpis/config";

import { journal } from "../journal";
import { estErreurOs } from "../skills/chemins";

const log = journal("skins");

/** Refus lisible, rendu tel quel à l'administrateur. */
export class SkinError extends Error {
  override name = "SkinError";
}

export class SkinExistsError extends SkinError {
  override name = "SkinExistsError";
}

export class SkinNotFoundError extends SkinError {
  override name = "SkinNotFoundError";
}

export const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
export const TOKEN_RE = /^--[a-z0-9-]{1,48}$/;
/** `re.I | re.A` : casse ASCII seulement (Phase 0, 676e766). */
export const ASSET_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(?:[Pp][Nn][Gg]|[Jj][Pp][Ee]?[Gg]|[Ww][Ee][Bb][Pp]|[Gg][Ii][Ff])$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,20}$/;
const LICENSE_RE = /^[A-Za-z0-9.+ ()-]{1,40}$/;

export const MAX_TOKEN_VALUE = 200;
export const MAX_TOKENS_PER_MODE = 300;
export const MAX_CSS_BYTES = 256 * 1024;
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_ASSETS = 50;
export const MAX_JSON_BYTES = 256 * 1024;
export const MAX_EXTRA_BYTES = 64 * 1024;
export const MAX_ZIP_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_UNCOMPRESSED =
  MAX_ASSETS * MAX_ASSET_BYTES + MAX_CSS_BYTES + MAX_JSON_BYTES + 4 * MAX_EXTRA_BYTES;
export const MAX_ZIP_FILES = MAX_ASSETS + 8;
export const EXTRA_FILES: readonly string[] = ["README.md", "LICENSE", "LICENSE.txt", "LICENSE.md"];

/** `.elpis-skin-self` désigne le skin lui-même dans sa feuille (réécrit au rendu). */
export const SELF_ID = "self";
export const SELF_CLASS = `.elpis-skin-${SELF_ID}`;
/** Classe des habillages personnels : un skin importé ne peut pas la prendre. */
export const ID_PERSO = "perso";

const AT_RULES_OK: ReadonlySet<string> = new Set([
  "media",
  "supports",
  "keyframes",
  "-webkit-keyframes",
  "layer",
  "container",
]);
const AT_RULES_ADMIS = [...AT_RULES_OK]
  .sort(comparePointsDeCode)
  .map((a) => `@${a}`)
  .join(", ");

const RADIUS_DERIVES: readonly (readonly [string, string])[] = [
  ["--radius-sm", "calc(var(--radius) - 4px)"],
  ["--radius-md", "calc(var(--radius) - 2px)"],
  ["--radius-lg", "var(--radius)"],
  ["--radius-xl", "calc(var(--radius) + 4px)"],
];

const IMAGE_EXT_TYPE: Readonly<Record<string, string>> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  webp: "webp",
  gif: "gif",
};
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const BUILTIN_REPLI: readonly Dict[] = [
  {
    id: "elpis",
    label: "Elpis",
    desc: "",
    sw: ["#f3efe8", "#fcfbf9", "#b88a3d"],
    builtin: true,
    enabled_by_default: true,
  },
  {
    id: "",
    label: "Ardoise",
    desc: "",
    sw: ["#0f172a", "#f8fafc", "#2563eb"],
    builtin: true,
    enabled_by_default: true,
  },
];
const MASCOTTES_REPLI: readonly Dict[] = [
  { id: "boite_or", label: "Coffre" },
  { id: "flamme", label: "Flamme" },
  { id: "flamme_bleue", label: "Flamme bleue", apercu: false },
  { id: "fantome", label: "Fantôme" },
  { id: "elpis", label: "Elpis" },
];

export function manifesteIntegres(): string {
  return pyJoin(config.PROJECT_ROOT, "frontend/css/skins/skins.json");
}

export function dossierCssIntegres(): string {
  return pyJoin(config.PROJECT_ROOT, "frontend/css/skins");
}

export function registreMascottes(): string {
  return pyJoin(config.PROJECT_ROOT, "frontend/assets/mascotte/mascottes.json");
}

/** Dossier des skins importés, relu à chaque appel. */
export function skinsDir(): string {
  return config.SKINS_DIR;
}

const IGNORES = new Set(["ENOENT", "ENOTDIR", "EBADF", "ELOOP"]);

/** `Path.stat()` des tests `is_file`/`is_dir`/`exists` : `null` si absent, les autres erreurs d'OS lèvent. */
function statPy(chemin: string): Stats | null {
  try {
    return statSync(chemin);
  } catch (e) {
    if (IGNORES.has(String((e as { code?: unknown }).code))) return null;
    throw e;
  }
}

export function estFichierPy(chemin: string): boolean {
  return statPy(chemin)?.isFile() ?? false;
}

export function estDossierPy(chemin: string): boolean {
  return statPy(chemin)?.isDirectory() ?? false;
}

export function existePy(chemin: string): boolean {
  return statPy(chemin) !== null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : strPy(e);
}

const cacheJson = new Map<string, [string, unknown]>();
const cachePlugins = new Map<string, [string, Dict]>();

/** Aide de test : caches remis à zéro, comme `_PLUGIN_CACHE.clear()`. */
export function viderCachesSkins(): void {
  cacheJson.clear();
  cachePlugins.clear();
}

/** JSON relu seulement si le fichier a changé (mtime en ns, taille) ; rendu en copie. */
function lireJsonEnCache(chemin: string): unknown {
  const st = statSync(chemin, { bigint: true });
  const cle = `${st.mtimeNs}:${st.size}`;
  const vu = cacheJson.get(chemin);
  if (vu && vu[0] === cle) return copieProfondePy(vu[1]);
  const donnees = pyJsonLoads(lireTextePy(chemin));
  cacheJson.set(chemin, [cle, donnees]);
  return copieProfondePy(donnees);
}

function estControle(c: string): boolean {
  const p = c.codePointAt(0) ?? 0;
  return p < 32 || p === 127;
}

/** `_clean_text` : texte retaillé, borné en points de code, sans caractère de contrôle. */
function texteNettoye(v: unknown, ou: string, maxlen: number, requis = false): string {
  const brut = v ?? "";
  if (typeof brut !== "string") throw new SkinError(`${ou} : texte attendu.`);
  const t = stripPy(brut);
  if (requis && !t) throw new SkinError(`${ou} : obligatoire.`);
  if (longueurPy(t) > maxlen) throw new SkinError(`${ou} : ${maxlen} caractères au plus.`);
  if (Array.from(t).some(estControle)) throw new SkinError(`${ou} : caractère de contrôle interdit.`);
  return t;
}

/** `_detect_image` : type d'image d'après les premiers octets. */
export function detectImage(tete: Uint8Array): string | null {
  const t = Buffer.from(tete.buffer, tete.byteOffset, tete.byteLength);
  const debut = (octets: string): boolean =>
    t.subarray(0, octets.length / 2).equals(Buffer.from(octets, "hex"));
  if (debut("ffd8ff")) return "jpeg";
  if (debut("89504e470d0a1a0a")) return "png";
  if (debut("474946383761") || debut("474946383961")) return "gif";
  if (
    t.length >= 12 &&
    t.subarray(0, 4).toString("latin1") === "RIFF" &&
    t.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "webp";
  return null;
}

/** `png` / `jpeg` / `webp` / `gif` d'après l'extension d'un nom déjà validé par `ASSET_RE`. */
export function assetType(nom: string): string {
  const extension = lowerPy(nom.split(".").at(-1) ?? "");
  const type = Object.hasOwn(IMAGE_EXT_TYPE, extension) ? IMAGE_EXT_TYPE[extension] : undefined;
  if (type === undefined) throw new Error(`extension d'image inconnue : ${nom}`);
  return type;
}

const CARACTERES_INTERDITS = new Set([";", "{", "}", "<", ">", "\\"]);
const MOTS_INTERDITS = [
  "url(",
  "@",
  "expression",
  "/*",
  "*/",
  "image-set",
  "image(",
  "src(",
  "javascript:",
  "element(",
  "cross-fade",
];

/** Valeur d'un jeton CSS : rien qui sorte de la déclaration ni ne charge de ressource. */
export function checkTokenValue(value: unknown, ou: string): string {
  if (typeof value !== "string") throw new SkinError(`${ou} : valeur texte attendue.`);
  const v = stripPy(value);
  if (!v) throw new SkinError(`${ou} : valeur vide.`);
  if (longueurPy(v) > MAX_TOKEN_VALUE) throw new SkinError(`${ou} : ${MAX_TOKEN_VALUE} caractères au plus.`);
  if (Array.from(v).some((c) => CARACTERES_INTERDITS.has(c) || estControle(c)))
    throw new SkinError(`${ou} : caractère interdit (; { } < > \\).`);
  const bas = lowerPy(v);
  for (const mot of MOTS_INTERDITS)
    if (bas.includes(mot)) throw new SkinError(`${ou} : « ${mot} » interdit dans une valeur.`);
  return v;
}

function jetonsVerifies(brut: unknown, ou: string): Dict {
  if (brut === null || brut === undefined) return {};
  if (!estDict(brut)) throw new SkinError(`${ou} : objet {"--jeton": "valeur"} attendu.`);
  const cles = clesOrdonnees(brut);
  if (cles.length > MAX_TOKENS_PER_MODE)
    throw new SkinError(`${ou} : ${MAX_TOKENS_PER_MODE} jetons au plus.`);
  const out: Dict = {};
  for (const k of cles) {
    if (!TOKEN_RE.test(k))
      throw new SkinError(
        `${ou} : nom de jeton invalide ${reprPy(prefixePy(k, 60))} (--minuscules-chiffres-tirets).`,
      );
    poserCle(out, k, checkTokenValue(brut[k], `${ou} ${k}`));
  }
  return out;
}

// Échappement CSS : seulement vers une ponctuation (`\72` = « r » écrirait `url(` sans l'écrire).
const ECHAPPEMENT = new RegExp(`\\\\(?:([0-9a-fA-F]{1,6})${BLANC_PY}?|(.)|$)`, "gsu");
const COMMENTAIRE = /\/\*.*?\*\//gsu;
const URL_CSS = new RegExp(`url\\(${BLANC_PY}*(['"]?)(.*?)\\1${BLANC_PY}*\\)`, "gisu");
// `re.I` Unicode de Python : i ↔ U+0130 U+0131, s ↔ U+017F, k ↔ U+212A, comme dans `_DATA_IMG_RE`.
const DATA_IMG =
  /^[dD][aA][tT][aA]:[iI\u0130\u0131][mM][aA][gG][eE]\/(?:[pP][nN][gG]|[jJ][pP][eE][gG]|[wW][eE][bB][pP]|[gG][iI\u0130\u0131][fF])(?:;[bB][aA][sS\u017f][eE]64)?,[A-Za-z0-9+/=%._\-\u0130\u0131\u017f\u212a]*$/u;
const REF_ASSET = /^(?:\.\/)?assets\/([^/\\?#]+)$/u;
const AT_RULE = /@(-?[a-zA-Z][a-zA-Z-]*)/g;
const BEHAVIOR = new RegExp(`behavior${BLANC_PY}*:`, "u");
const INTERDITS_CSS: readonly (readonly [string, string])[] = [
  ["</", "« </ » interdit"],
  ["@import", "@import interdit"],
  ["expression(", "expression() interdit"],
  ["-moz-binding", "-moz-binding interdit"],
  ["javascript:", "javascript: interdit"],
  ["vbscript:", "vbscript: interdit"],
  ["image-set(", "image-set() interdit"],
  ["image(", "image() interdit"],
  ["src(", "src() interdit"],
  ["element(", "element() interdit"],
  ["cross-fade(", "cross-fade() interdit"],
];

/** Feuille d'un skin validée et rendue telle quelle ; `assetNames` : images disponibles (`null` : non vérifié). */
export function validateCss(texte: unknown, assetNames: ReadonlySet<string> | null = null): string {
  if (texte === null || texte === undefined) return "";
  if (typeof texte !== "string") throw new SkinError("skin.css : texte attendu.");
  if (encoderUtf8Py(texte).length > MAX_CSS_BYTES)
    throw new SkinError(`skin.css : ${Math.floor(MAX_CSS_BYTES / 1024)} Ko au plus.`);
  if (texte.includes("\0")) throw new SkinError("skin.css : octet nul interdit.");
  for (const m of texte.matchAll(ECHAPPEMENT)) {
    let c = m[2] ?? "";
    if (m[1]) {
      const point = parseInt(m[1], 16);
      c = point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    if (!c || estAlnumPy(c) || c === "\r" || c === "\n" || c === "\0")
      throw new SkinError("skin.css : échappement « \\ » autorisé seulement pour une ponctuation.");
  }
  const sansCommentaires = texte.replace(COMMENTAIRE, " ");
  if (sansCommentaires.includes("/*")) throw new SkinError("skin.css : commentaire non refermé.");
  for (const source of [lowerPy(texte), lowerPy(sansCommentaires)]) {
    for (const [mot, motif] of INTERDITS_CSS)
      if (source.includes(mot)) throw new SkinError(`skin.css : ${motif}.`);
    if (BEHAVIOR.test(source)) throw new SkinError("skin.css : behavior interdit.");
  }
  for (const m of sansCommentaires.matchAll(AT_RULE)) {
    const regle = m[1] ?? "";
    if (!AT_RULES_OK.has(regle.toLowerCase()))
      throw new SkinError(`skin.css : @${regle} interdit (admis : ${AT_RULES_ADMIS}).`);
  }
  const urls = [...texte.matchAll(URL_CSS)];
  if (urls.length !== lowerPy(texte).split("url(").length - 1)
    throw new SkinError("skin.css : url() mal formée.");
  for (const m of urls) {
    const arg = stripPy(m[2] ?? "");
    if (DATA_IMG.test(arg)) continue;
    const a = REF_ASSET.exec(arg);
    const nom = a?.[1];
    if (nom !== undefined && ASSET_RE.test(nom)) {
      if (assetNames !== null && !assetNames.has(nom))
        throw new SkinError(`skin.css : image absente du paquet : assets/${nom}.`);
      continue;
    }
    throw new SkinError(
      `skin.css : url() refusée (${reprPy(prefixePy(arg, 60))}) — seules assets/<image> ` +
        "et data:image/(png|jpeg|webp|gif) sont admises.",
    );
  }
  return texte;
}

/** `url(assets/…)` vers l'URL servie, `.elpis-skin-self` vers la classe du skin. */
export function reecrireCss(texte: string, skinId: string): string {
  const sortie = texte.replace(URL_CSS, (tout: string, _q: string, arg: string) => {
    const a = REF_ASSET.exec(stripPy(arg));
    return a ? `url("/api/skins/${skinId}/assets/${a[1]}")` : tout;
  });
  return sortie.replaceAll(SELF_CLASS, () => `.elpis-skin-${skinId}`);
}

function idsIntegres(): Set<string> {
  return new Set(builtinSkins().map((s) => s["id"] as string));
}

export const MAX_LABEL_SKIN = 40;
export const MAX_DESC_SKIN = 200;

/** Manifeste normalisé (champs connus seulement, dans l'ordre de Python) ou `SkinError`. */
export function validateManifest(data: unknown, options: { hasCss?: boolean } = {}): Dict {
  const hasCss = options.hasCss ?? false;
  if (!estDict(data)) throw new SkinError("skin.json : objet JSON attendu.");
  const sid = getPy(data, "id");
  if (typeof sid !== "string" || !ID_RE.test(sid))
    throw new SkinError(
      "Identifiant invalide : 2 à 32 caractères, minuscule en tête, puis minuscules, chiffres, - ou _.",
    );
  if (sid === SELF_ID) throw new SkinError("Identifiant réservé : self.");
  if (sid === ID_PERSO) throw new SkinError("Identifiant réservé : perso.");
  if (idsIntegres().has(sid)) throw new SkinError(`Identifiant déjà pris par un skin intégré : ${sid}.`);
  const out: Dict = { id: sid };
  out["label"] = texteNettoye(getPy(data, "label"), "Nom", MAX_LABEL_SKIN, true);
  const desc = Object.hasOwn(data, "description") ? data["description"] : getPy(data, "desc");
  out["description"] = texteNettoye(desc, "Description", MAX_DESC_SKIN);
  const version = texteNettoye(getPy(data, "version"), "Version", 20);
  if (version && !VERSION_RE.test(version))
    throw new SkinError("Version : chiffres, lettres, . + - seulement.");
  out["version"] = version || "1.0.0";
  out["author"] = texteNettoye(getPy(data, "author"), "Auteur", 80);
  const licence = texteNettoye(getPy(data, "license"), "Licence", 40);
  if (licence && !LICENSE_RE.test(licence))
    throw new SkinError("Licence : identifiant SPDX attendu (ex. MIT, CC-BY-4.0).");
  out["license"] = licence;
  out["darkBase"] = veritePy(getPy(data, "darkBase"));
  const sw = Object.hasOwn(data, "swatch") ? data["swatch"] : getPy(data, "sw");
  if (!Array.isArray(sw) || sw.length !== 3)
    throw new SkinError("Pastilles : trois couleurs attendues [rail, fond, accent].");
  const pastilles = sw.map((c: unknown, i) => checkTokenValue(c, `Pastille ${i + 1}`));
  out["swatch"] = pastilles;
  if (pastilles.some((c) => longueurPy(c) > 60)) throw new SkinError("Pastilles : 60 caractères au plus.");
  const jetons = ouPy(getPy(data, "tokens"), {});
  if (!estDict(jetons)) throw new SkinError("tokens : objet {light, dark} attendu.");
  if (clesOrdonnees(jetons).some((k) => k !== "light" && k !== "dark"))
    throw new SkinError("tokens : seules les clés light et dark sont admises.");
  out["tokens"] = {
    light: jetonsVerifies(getPy(jetons, "light"), "Jetons clairs"),
    dark: jetonsVerifies(getPy(jetons, "dark"), "Jetons sombres"),
  };
  const css = getPy(data, "css");
  if (!(css === null || css === "" || css === "skin.css"))
    throw new SkinError("css : seule la valeur « skin.css » est admise.");
  if (css === "skin.css" && !hasCss) throw new SkinError("skin.json annonce skin.css, absent du paquet.");
  if (hasCss) out["css"] = "skin.css";
  const marque = getPy(data, "brand");
  if (!(marque === null || marque === "" || (estDict(marque) && clesOrdonnees(marque).length === 0))) {
    if (!estDict(marque)) throw new SkinError("brand : objet {name} attendu.");
    const nom = texteNettoye(getPy(marque, "name"), "Nom de marque", 40);
    if (nom) out["brand"] = { name: nom };
  }
  return out;
}

/** Skins intégrés dans l'ordre du manifeste ; repli Elpis + Ardoise si le registre est illisible. */
export function builtinSkins(): Dict[] {
  try {
    const doc = lireJsonEnCache(manifesteIntegres());
    const out: Dict[] = [];
    for (const s of iterExige(ouPy(getPy(doc, "skins"), []))) {
      if (!estDict(s) || typeof getOu(s, "id", null) !== "string") continue;
      const e = copieDict(s);
      poserCle(e, "builtin", true);
      poserCle(e, "enabled_by_default", veritePy(getOu(s, "enabled_by_default", true)));
      out.push(e);
    }
    if (out.some((e) => e["id"] === "")) return out;
  } catch (e) {
    log.warn({ err: e }, `[skins] ${manifesteIntegres()} illisible : repli Elpis + Ardoise`);
  }
  return BUILTIN_REPLI.map((e) => copieProfondePy(e));
}

/** Registre des mascottes, repli sur les cinq d'origine. */
export function mascotsCatalogue(): Dict[] {
  try {
    const doc = lireJsonEnCache(registreMascottes());
    const out: Dict[] = [];
    for (const m of iterExige(ouPy(getPy(doc, "mascottes"), []))) {
      const id = getOu(m, "id", null);
      if (!estDict(m) || typeof id !== "string" || !id) continue;
      const e: Dict = { id, label: strPy(ouPy(getOu(m, "label", null), id)) };
      if (getOu(m, "apercu", null) === false) e["apercu"] = false;
      out.push(e);
    }
    if (out.length > 0) return out;
  } catch (e) {
    log.warn({ err: e }, `[skins] ${registreMascottes()} illisible : repli sur les mascottes d'origine`);
  }
  return MASCOTTES_REPLI.map((m) => copieProfondePy(m));
}

export function mascotIds(): string[] {
  return mascotsCatalogue().map((m) => m["id"] as string);
}

/** État du dossier (mtime en ns et taille de skin.json, puis de skin.css ou `None`), au `repr` de Python. */
function clePlugin(d: string): string {
  const js = statSync(pyJoin(d, "skin.json"), { bigint: true });
  let css = "None";
  try {
    const c = statSync(pyJoin(d, "skin.css"), { bigint: true });
    css = `(${c.mtimeNs}, ${c.size})`;
  } catch (e) {
    if (!estErreurOs(e)) throw e;
  }
  return `(${js.mtimeNs}, ${js.size}, ${css})`;
}

function nomDe(chemin: string): string {
  return chemin.split("/").at(-1) ?? "";
}

/** Plugin validé depuis son dossier, ou `null` (journalisé) ; relu seulement si ses fichiers ont changé. */
function chargerPlugin(d: string): Dict | null {
  let cle: string;
  try {
    cle = clePlugin(d);
  } catch (e) {
    if (estErreurOs(e)) return null;
    throw e;
  }
  const vu = cachePlugins.get(d);
  if (vu && vu[0] === cle) return copieProfondePy(vu[1]);
  let man: Dict;
  try {
    const brut = readFileSync(pyJoin(d, "skin.json"));
    if (brut.length > MAX_JSON_BYTES) throw new SkinError("skin.json trop volumineux.");
    man = validateManifest(pyJsonLoads(decoderUtf8(brut)), { hasCss: estFichierPy(pyJoin(d, "skin.css")) });
    if (man["id"] !== nomDe(d))
      throw new SkinError(`l'identifiant ${reprPy(man["id"])} ne correspond pas au dossier.`);
  } catch (e) {
    if (!(e instanceof SkinError || estErreurValeur(e) || estErreurOs(e))) throw e;
    log.warn(`[skins] skin ignoré ${d} : ${message(e)}`);
    return null;
  }
  const entree: Dict = {
    id: man["id"],
    label: man["label"],
    desc: man["description"],
    darkBase: man["darkBase"],
    sw: man["swatch"],
    builtin: false,
    enabled_by_default: false,
    version: man["version"],
    author: man["author"],
    license: man["license"],
    tokens: man["tokens"],
    has_css: Object.hasOwn(man, "css"),
    rev: createHash("sha1").update(cle).digest("hex").slice(0, 10),
  };
  if (Object.hasOwn(man, "brand")) entree["brand"] = man["brand"];
  cachePlugins.set(d, [cle, entree]);
  return copieProfondePy(entree);
}

/** Retire un dossier du cache des plugins (suppression). */
export function oublierPlugin(d: string): void {
  cachePlugins.delete(d);
}

/** Skins importés valides, triés par nom (`label.lower()`). */
export function pluginSkins(): Dict[] {
  const racine = skinsDir();
  if (!estDossierPy(racine)) return [];
  const reserves = idsIntegres();
  reserves.add(SELF_ID);
  reserves.add(ID_PERSO);
  let dossiers: string[];
  try {
    dossiers = readdirSync(racine)
      .sort(comparePointsDeCode)
      .map((nom) => pyJoin(racine, nom))
      .filter(estDossierPy);
  } catch (e) {
    if (estErreurOs(e)) return [];
    throw e;
  }
  const out: Dict[] = [];
  for (const d of dossiers) {
    const nom = nomDe(d);
    if (!ID_RE.test(nom) || reserves.has(nom)) continue;
    const e = chargerPlugin(d);
    if (e) out.push(e);
  }
  return out.sort((a, b) =>
    comparePointsDeCode(lowerPy(a["label"] as string), lowerPy(b["label"] as string)),
  );
}

/** `_all_skins` : intégrés puis importés, par identifiant. */
export function toutesLesSkins(): Map<string, Dict> {
  const out = new Map<string, Dict>();
  for (const e of builtinSkins()) out.set(e["id"] as string, e);
  for (const e of pluginSkins()) if (!out.has(e["id"] as string)) out.set(e["id"] as string, e);
  return out;
}

/** `config.json` › `skins`, relu à chaque appel : activations et défaut demandé. */
function etat(): [Map<string, boolean>, string | null] {
  let brut = ouPy(liveConfigValue("skins", {}), {});
  if (!estDict(brut)) brut = {};
  const actives = getOu(brut, "enabled", null);
  const en = estDict(actives) ? actives : {};
  const d = getOu(brut, "default", null);
  return [new Map(clesOrdonnees(en).map((k) => [k, veritePy(en[k])])), typeof d === "string" ? d : null];
}

export function defautDe(connus: ReadonlyMap<string, Dict>, d: string | null): string {
  if (d !== null && connus.has(d)) return d;
  return connus.has("elpis") ? "elpis" : "";
}

/** Skin par défaut de l'instance : `skins.default` s'il existe, sinon « elpis ». */
export function defaultSkin(): string {
  return defautDe(toutesLesSkins(), etat()[1]);
}

function activeDans(
  connus: ReadonlyMap<string, Dict>,
  en: ReadonlyMap<string, boolean>,
  defaut: string,
  sid: string,
): boolean {
  if (sid === "" || sid === defaut) return connus.has(sid);
  const e = connus.get(sid);
  if (e === undefined) return false;
  const choix = en.get(sid);
  if (choix !== undefined) return choix;
  return veritePy(getOu(e, "builtin", null)) ? veritePy(getOu(e, "enabled_by_default", null)) : false;
}

export function isEnabled(skinId: unknown): boolean {
  const connus = toutesLesSkins();
  const [en, d] = etat();
  return activeDans(connus, en, defautDe(connus, d), strPy(skinId));
}

/** Skin effectif d'un compte : sa valeur si elle est activée, sinon le défaut. */
export function resolveUserSkin(valeur: unknown): string {
  if (valeur === null || valeur === undefined) return defaultSkin();
  const v = strPy(valeur);
  return isEnabled(v) ? v : defaultSkin();
}

function publique(e: Dict): Dict {
  const id = e["id"] as string;
  const out: Dict = {
    id,
    label: ouPy(getOu(e, "label", null), id),
    desc: ouPy(getOu(e, "desc", null), ""),
    darkBase: veritePy(getOu(e, "darkBase", null)),
    sw: [...iterExige(ouPy(getOu(e, "sw", null), []))],
    builtin: veritePy(getOu(e, "builtin", null)),
  };
  if (veritePy(getOu(e, "brand", null))) out["brand"] = dictPy(e["brand"]);
  if (veritePy(getOu(e, "mascot", null))) out["mascot"] = e["mascot"];
  if (!veritePy(getOu(e, "builtin", null)))
    out["css_url"] = `/api/skins/${id}/skin.css?v=${strPy(getOu(e, "rev", ""))}`;
  return out;
}

/** Skins au format de l'interface ; `includeDisabled` (console) ajoute les désactivés et leur état. */
export function listSkins(includeDisabled = false): Dict[] {
  const connus = toutesLesSkins();
  const [en, d] = etat();
  const defaut = defautDe(connus, d);
  const out: Dict[] = [];
  for (const [sid, e] of connus) {
    const actif = activeDans(connus, en, defaut, sid);
    if (!actif && !includeDisabled) continue;
    const p = publique(e);
    if (includeDisabled) {
      p["enabled"] = actif;
      p["source"] = veritePy(getOu(e, "builtin", null)) ? "builtin" : "plugin";
      p["is_default"] = sid === defaut;
      p["locked"] = sid === "" || sid === defaut;
      p["enabled_by_default"] = veritePy(getOu(e, "enabled_by_default", null));
      p["version"] = getOu(e, "version", "");
      p["author"] = getOu(e, "author", "");
      p["license"] = getOu(e, "license", "");
    }
    out.push(p);
  }
  return out;
}

/** Images d'un dossier de plugin (noms conformes à `ASSET_RE`), triées. */
export function assetNames(d: string): string[] {
  const a = pyJoin(d, "assets");
  if (!estDossierPy(a)) return [];
  try {
    return readdirSync(a)
      .filter((nom) => estFichierPy(pyJoin(a, nom)) && ASSET_RE.test(nom))
      .sort(comparePointsDeCode);
  } catch (e) {
    if (estErreurOs(e)) return [];
    throw e;
  }
}

/** Définition complète d'un skin importé (formulaire « Modifier » de la console). */
export function skinDetail(skinId: string): Dict {
  const e = toutesLesSkins().get(skinId);
  if (e === undefined || veritePy(getOu(e, "builtin", null)))
    throw new SkinNotFoundError("Skin importé inconnu.");
  const d = pyJoin(skinsDir(), skinId);
  let css = "";
  if (veritePy(getOu(e, "has_css", null))) {
    try {
      css = lireTextePy(pyJoin(d, "skin.css"));
    } catch (x) {
      if (!estErreurOs(x)) throw x;
    }
  }
  return {
    id: e["id"],
    label: e["label"],
    description: e["desc"],
    version: e["version"],
    author: e["author"],
    license: e["license"],
    darkBase: e["darkBase"],
    swatch: e["sw"],
    tokens: e["tokens"],
    brand: ouPy(getOu(e, "brand", null), {}),
    css,
    assets: assetNames(d),
  };
}

/** `_token_block` : déclarations d'un mode, échelle des rayons ajoutée si `--radius` est posé seul. */
export function blocJetons(selecteur: string, jetons: Dict): string {
  const lignes = clesOrdonnees(jetons).map((k) => `    ${k}: ${strPy(jetons[k])};`);
  if (Object.hasOwn(jetons, "--radius"))
    for (const [k, v] of RADIUS_DERIVES) if (!Object.hasOwn(jetons, k)) lignes.push(`    ${k}: ${v};`);
  return `${selecteur} {\n${lignes.join("\n")}\n}\n`;
}

/** Feuille d'un skin : jetons clair/sombre, échelle des rayons puis skin.css revalidée ; fichier pour un intégré ; `null` si inconnu. */
export function renderCss(skinId: string): string | null {
  const e = toutesLesSkins().get(skinId);
  if (e === undefined) return null;
  if (veritePy(getOu(e, "builtin", null))) {
    if (!skinId) return "";
    try {
      return lireTextePy(pyJoin(dossierCssIntegres(), `${skinId}.css`));
    } catch (x) {
      if (estErreurOs(x)) return "";
      throw x;
    }
  }
  const parties = [`/* Skin « ${skinId} » — feuille générée par Elpis. */\n`];
  const jetons = ouPy(getOu(e, "tokens", null), {});
  const clair = getOu(jetons, "light", null);
  const sombre = getOu(jetons, "dark", null);
  if (estDict(clair) && veritePy(clair)) parties.push(blocJetons(`body.elpis-skin-${skinId}`, clair));
  if (estDict(sombre) && veritePy(sombre))
    parties.push(blocJetons(`body.elpis-skin-${skinId}.elpis-app-dark`, sombre));
  if (veritePy(getOu(e, "has_css", null))) {
    const d = pyJoin(skinsDir(), skinId);
    try {
      const texte = lireTextePy(pyJoin(d, "skin.css"));
      validateCss(texte, new Set(assetNames(d)));
      parties.push(reecrireCss(texte, skinId));
    } catch (x) {
      if (!(x instanceof SkinError || x instanceof ErreurDecodage || estErreurOs(x))) throw x;
      log.warn(`[skins] skin.css de ${skinId} ignorée : ${message(x)}`);
    }
  }
  return parties.join("\n");
}

/** Chemin réel d'une image d'un plugin, ou `null` (nom invalide, hors du dossier `assets`, absente). */
export function assetPath(skinId: unknown, nom: unknown): string | null {
  if (typeof skinId !== "string" || !ID_RE.test(skinId)) return null;
  if (typeof nom !== "string" || !ASSET_RE.test(nom)) return null;
  const base = pyJoin(pyJoin(skinsDir(), skinId), "assets");
  try {
    const racine = realpathPy(base);
    const p = realpathPy(pyJoin(base, nom));
    if (p !== racine && !p.startsWith(racine.endsWith("/") ? racine : `${racine}/`)) return null;
    return estFichierPy(p) ? p : null;
  } catch (e) {
    if (estErreurOs(e) || estErreurValeur(e)) return null;
    throw e;
  }
}
