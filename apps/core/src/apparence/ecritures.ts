// SPDX-License-Identifier: MIT
/** apps/core/src/apparence/ecritures.ts — écritures des skins : état dans config.json sous verrou, dossiers mis en place par renommage, import et export zip, formulaire, suppression (shared_infra/appearance/skins.py). */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

import {
  ArchiveZip,
  clesOrdonnees,
  dateHeureLocale,
  decoderUtf8,
  dictPy,
  ecrireZip,
  encoderUtf8Py,
  ErreurPython,
  ErreurZip,
  estDict,
  estErreurValeur,
  getOu,
  getPy,
  iterExige,
  lireTextePy,
  nomTypePy,
  ouPy,
  poserCle,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  reprPy,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Dict, EntreeZipEcrite, MembreZip } from "@elpis/commun";
import { mettreAJourConfigJson, pyJoin, writeTextAtomic } from "@elpis/config";

import { journal } from "../journal";
import { estErreurOs, rmtree } from "../skills/chemins";
import {
  ASSET_RE,
  assetNames,
  assetType,
  defautDe,
  defaultSkin,
  detectImage,
  dossierCssIntegres,
  estDossierPy,
  estFichierPy,
  existePy,
  EXTRA_FILES,
  listSkins,
  MAX_ASSET_BYTES,
  MAX_ASSETS,
  MAX_CSS_BYTES,
  MAX_EXTRA_BYTES,
  MAX_JSON_BYTES,
  MAX_ZIP_BYTES,
  MAX_ZIP_FILES,
  MAX_ZIP_UNCOMPRESSED,
  oublierPlugin,
  SELF_CLASS,
  SkinError,
  SkinExistsError,
  SkinNotFoundError,
  skinsDir,
  toutesLesSkins,
  validateCss,
  validateManifest,
} from "./skins";

const log = journal("skins");

/** config.json mis à jour sous verrou ; JSON illisible : `SkinError`. */
function majConfig(mutateur: (cfg: Dict) => void): Promise<void> {
  return mettreAJourConfigJson(mutateur, (message) => new SkinError(message));
}

function sectionSkins(cfg: Dict): Dict {
  const lue = getOu(cfg, "skins", null);
  const sk: Dict = estDict(lue) ? lue : {};
  if (sk !== lue) poserCle(cfg, "skins", sk);
  if (!estDict(getOu(sk, "enabled", null))) poserCle(sk, "enabled", {});
  return sk;
}

/** Applique `enabled` (fusion) et/ou `default` ; le défaut est activé d'office, désactiver Ardoise ou le défaut est refusé. */
export async function setState(enabled: unknown = null, defaut: unknown = null): Promise<void> {
  const connus = toutesLesSkins();
  const choix = enabled ?? null;
  const demande = defaut ?? null;
  if (choix !== null && !estDict(choix)) throw new SkinError("enabled : objet {id: booléen} attendu.");
  if (demande !== null && (typeof demande !== "string" || !connus.has(demande)))
    throw new SkinError("Skin par défaut inconnu.");
  const ids = choix === null ? [] : clesOrdonnees(choix);
  for (const sid of ids) if (!connus.has(sid)) throw new SkinError(`Skin inconnu : ${sid}.`);
  await majConfig((cfg) => {
    const sk = sectionSkins(cfg);
    const actuel = getOu(sk, "default", null);
    const effectif = demande ?? defautDe(connus, typeof actuel === "string" ? actuel : null);
    const en = sk["enabled"] as Dict;
    for (const sid of ids) {
      if (sid === "") continue;
      const v = veritePy((choix as Dict)[sid]);
      if (!v && sid === effectif) throw new SkinError("Le skin par défaut ne peut pas être désactivé.");
      poserCle(en, sid, v);
    }
    if (demande !== null) {
      poserCle(sk, "default", demande);
      if (demande) poserCle(en, demande as string, true);
    }
  });
}

async function oublierEtat(skinId: string): Promise<void> {
  await majConfig((cfg) => {
    delete (sectionSkins(cfg)["enabled"] as Dict)[skinId];
  });
}

async function marquerDesactive(skinId: string): Promise<void> {
  await majConfig((cfg) => {
    poserCle(sectionSkins(cfg)["enabled"] as Dict, skinId, false);
  });
}

function manifesteJson(norm: Dict): string {
  return `${pyJsonDumps(norm, { ensureAscii: false, indent: 2 })}\n`;
}

const suffixe = (): string => randomBytes(4).toString("hex");

/** Dossier complet écrit à part puis mis en place par renommage ; vrai si un skin existait (écrasé). */
export async function ecrireNouveauDossier(
  norm: Dict,
  css: string | null,
  images: ReadonlyMap<string, Buffer>,
  annexes: ReadonlyMap<string, Buffer>,
  ecraser: boolean,
  racine: string = skinsDir(),
): Promise<boolean> {
  mkdirSync(racine, { recursive: true });
  const id = norm["id"] as string;
  const dest = pyJoin(racine, id);
  const existait = existePy(dest);
  if (existait && !ecraser) throw new SkinExistsError(`Un skin « ${id} » existe déjà.`);
  let tmp: string | null = pyJoin(racine, `.tmp-${id}-${suffixe()}`);
  try {
    mkdirSync(tmp);
    writeFileSync(pyJoin(tmp, "skin.json"), encoderUtf8Py(manifesteJson(norm)));
    if (css) writeFileSync(pyJoin(tmp, "skin.css"), encoderUtf8Py(css));
    if (images.size > 0) {
      mkdirSync(pyJoin(tmp, "assets"));
      for (const [nom, octets] of images) writeFileSync(pyJoin(pyJoin(tmp, "assets"), nom), octets);
    }
    for (const [nom, octets] of annexes) writeFileSync(pyJoin(tmp, nom), octets);
    if (existait) {
      const ancien = pyJoin(racine, `.old-${id}-${suffixe()}`);
      renameSync(dest, ancien);
      renameSync(tmp, dest);
      await rmtree(ancien, true);
    } else {
      renameSync(tmp, dest);
    }
    tmp = null;
  } finally {
    if (tmp !== null) await rmtree(tmp, true);
  }
  return existait;
}

function vueAdmin(skinId: string): Dict {
  for (const s of listSkins(true)) if (s["id"] === skinId) return s;
  throw new SkinNotFoundError("Skin inconnu.");
}

/** Membres retenus de l'archive, par chemin normalisé ; refus des chemins dangereux, liens et archives chiffrées. */
function membresRetenus(zf: ArchiveZip): Map<string, MembreZip> {
  const infos = zf.membres.filter((i) => !i.nom.endsWith("/"));
  if (infos.length === 0) throw new SkinError("Archive vide.");
  if (infos.length > MAX_ZIP_FILES)
    throw new SkinError(`Trop de fichiers (${infos.length} > ${MAX_ZIP_FILES}).`);
  if (infos.reduce((s, i) => s + Math.max(0, i.taille), 0) > MAX_ZIP_UNCOMPRESSED)
    throw new SkinError("Contenu décompressé trop volumineux.");
  const membres = new Map<string, MembreZip>();
  for (const i of infos) {
    const arc = i.nom.replaceAll("\\", "/");
    if (arc.includes("\0") || arc.startsWith("/") || /^[A-Za-z]:/.test(arc))
      throw new SkinError(`Chemin d'archive dangereux : ${reprPy(prefixePy(arc, 80))}.`);
    const parties = arc.split("/").filter((p) => p !== "" && p !== ".");
    if (parties.length === 0) continue;
    if (parties.includes(".."))
      throw new SkinError(`Chemin d'archive dangereux (zip-slip) : ${prefixePy(arc, 80)}.`);
    if (parties[0] === "__MACOSX" || parties.some((p) => p.startsWith("."))) continue;
    if (((i.attributsExternes >>> 16) & 0o170000) === 0o120000)
      throw new SkinError(`Lien symbolique refusé : ${prefixePy(arc, 80)}.`);
    if (i.drapeaux & 0x1) throw new SkinError("Archive chiffrée refusée.");
    membres.set(parties.join("/"), i);
  }
  return membres;
}

/** Installe un skin depuis un zip (skin.json à la racine ou dans un dossier unique) ; un nouveau skin arrive désactivé. */
export async function importZip(octets: Uint8Array, overwrite = false): Promise<Dict> {
  if (octets.length === 0) throw new SkinError("Fichier vide.");
  if (octets.length > MAX_ZIP_BYTES)
    throw new SkinError(`Archive trop volumineuse (${Math.floor(MAX_ZIP_BYTES / 1048576)} Mo au plus).`);
  let zf: ArchiveZip;
  try {
    zf = new ArchiveZip(octets);
  } catch (e) {
    if (e instanceof ErreurZip && e.type === "BadZipFile")
      throw new SkinError("Ce fichier n'est pas une archive .zip.");
    throw e;
  }
  const membres = membresRetenus(zf);
  let prefixe: string;
  if (membres.has("skin.json")) prefixe = "";
  else {
    const racines = new Set([...membres.keys()].map((k) => k.split("/")[0] ?? ""));
    const [seule] = racines;
    if (racines.size === 1 && seule !== undefined && membres.has(`${seule}/skin.json`)) prefixe = `${seule}/`;
    else throw new SkinError("skin.json introuvable (à la racine ou dans un dossier unique).");
  }
  let manifesteBrut: Buffer | null = null;
  let cssBrut: Buffer | null = null;
  const images = new Map<string, Buffer>();
  const annexes = new Map<string, Buffer>();
  for (const [k, info] of membres) {
    if (!k.startsWith(prefixe)) throw new SkinError(`Fichier hors du dossier du skin : ${prefixePy(k, 80)}.`);
    const rel = k.slice(prefixe.length);
    const parties = rel.split("/");
    let plafond: number;
    if (rel === "skin.json") plafond = MAX_JSON_BYTES;
    else if (rel === "skin.css") plafond = MAX_CSS_BYTES;
    else if (EXTRA_FILES.includes(rel)) plafond = MAX_EXTRA_BYTES;
    else if (parties.length === 2 && parties[0] === "assets") {
      if (!ASSET_RE.test(parties[1] ?? ""))
        throw new SkinError(`Image refusée : ${prefixePy(rel, 80)} (png, jpg, webp ou gif ; pas de SVG).`);
      plafond = MAX_ASSET_BYTES;
    } else {
      throw new SkinError(
        `Fichier non autorisé : ${prefixePy(rel, 80)} (admis : skin.json, ` +
          "skin.css, assets/*.png|jpg|webp|gif, README, LICENSE).",
      );
    }
    const trop = `${rel} : trop volumineux (${Math.floor(plafond / 1024)} Ko au plus).`;
    if (info.taille > plafond) throw new SkinError(trop);
    const blob = zf.lire(info);
    if (blob.length > plafond) throw new SkinError(trop);
    if (rel === "skin.json") manifesteBrut = blob;
    else if (rel === "skin.css") cssBrut = blob;
    else if (EXTRA_FILES.includes(rel)) annexes.set(rel, blob);
    else images.set(parties[1] ?? "", blob);
  }
  if (images.size > MAX_ASSETS) throw new SkinError(`Trop d'images (${images.size} > ${MAX_ASSETS}).`);
  for (const [nom, blob] of images)
    if (detectImage(blob.subarray(0, 16)) !== assetType(nom))
      throw new SkinError(`assets/${nom} : contenu non conforme à l'extension.`);
  let manifeste: unknown;
  try {
    manifeste = pyJsonLoads(decoderUtf8(manifesteBrut ?? Buffer.alloc(0)));
  } catch (e) {
    if (estErreurValeur(e)) throw new SkinError("skin.json : JSON invalide.");
    throw e;
  }
  let cssTexte: string | null = null;
  if (cssBrut !== null) {
    try {
      cssTexte = decoderUtf8(cssBrut);
    } catch (e) {
      if (estErreurValeur(e)) throw new SkinError("skin.css : UTF-8 attendu.");
      throw e;
    }
    if (estDict(manifeste) && !veritePy(getPy(manifeste, "css"))) poserCle(manifeste, "css", "skin.css");
    validateCss(cssTexte, new Set(images.keys()));
  }
  const norm = validateManifest(manifeste, { hasCss: cssTexte !== null });
  const id = norm["id"] as string;
  const existait = await ecrireNouveauDossier(norm, cssTexte, images, annexes, overwrite);
  if (!existait) await marquerDesactive(id);
  log.info(`[skins] skin ${id} importé (${images.size} image(s))`);
  return vueAdmin(id);
}

/** Création (`update` absent) ou mise à jour d'un skin importé depuis la console ; les images existantes sont gardées. */
export async function saveFromEditor(payload: unknown): Promise<Dict> {
  if (!estDict(payload)) throw new SkinError("Objet JSON attendu.");
  const miseAJour = veritePy(getPy(payload, "update"));
  const cssTexte = ouPy(getPy(payload, "css"), "");
  if (typeof cssTexte !== "string") throw new SkinError("CSS avancé : texte attendu.");
  const hasCss = stripPy(cssTexte) !== "";
  const manifeste: Dict = {};
  for (const k of [
    "id",
    "label",
    "description",
    "version",
    "author",
    "license",
    "darkBase",
    "swatch",
    "tokens",
    "brand",
  ])
    manifeste[k] = getPy(payload, k);
  if (hasCss) manifeste["css"] = "skin.css";
  const norm = validateManifest(manifeste, { hasCss });
  const id = norm["id"] as string;
  const dest = pyJoin(skinsDir(), id);
  if (miseAJour && !estDossierPy(dest)) throw new SkinNotFoundError("Skin à modifier introuvable.");
  if (!miseAJour) {
    if (existePy(dest)) throw new SkinExistsError(`Un skin « ${id} » existe déjà.`);
    if (hasCss) validateCss(cssTexte, new Set());
    await ecrireNouveauDossier(norm, hasCss ? cssTexte : null, new Map(), new Map(), false);
    await marquerDesactive(id);
  } else {
    if (hasCss) validateCss(cssTexte, new Set(assetNames(dest)));
    writeTextAtomic(pyJoin(dest, "skin.json"), manifesteJson(norm));
    if (hasCss) writeTextAtomic(pyJoin(dest, "skin.css"), cssTexte);
    else {
      try {
        unlinkSync(pyJoin(dest, "skin.css"));
      } catch (e) {
        if ((e as { code?: unknown }).code !== "ENOENT") throw e;
      }
    }
  }
  return vueAdmin(id);
}

/** Supprime un skin importé (jamais un intégré, jamais le skin par défaut). */
export async function deleteSkin(skinId: string): Promise<void> {
  const e = toutesLesSkins().get(skinId);
  if (e === undefined) throw new SkinNotFoundError("Skin inconnu.");
  if (veritePy(getOu(e, "builtin", null)))
    throw new SkinError("Un skin intégré ne se supprime pas : désactivez-le.");
  if (skinId === defaultSkin())
    throw new SkinError("C'est le skin par défaut : choisissez-en un autre d'abord.");
  const racine = skinsDir();
  const dest = pyJoin(racine, skinId);
  const ancien = pyJoin(racine, `.old-${skinId}-${suffixe()}`);
  renameSync(dest, ancien);
  await rmtree(ancien, true);
  oublierPlugin(dest);
  await oublierEtat(skinId);
  log.info(`[skins] skin ${skinId} supprimé`);
}

function entreeEcrite(nom: string, texte: string): EntreeZipEcrite {
  return {
    nom,
    donnees: encoderUtf8Py(texte),
    dateHeure: dateHeureLocale(Date.now()),
    attributsExternes: (0o600 << 16) >>> 0,
  };
}

/** Fichier ordinaire (lien symbolique exclu) mis dans l'archive avec sa date et ses droits. */
function entreeFichier(chemin: string, nom: string): EntreeZipEcrite {
  const st = statSync(chemin);
  return {
    nom,
    donnees: readFileSync(chemin),
    dateHeure: dateHeureLocale(st.mtimeMs),
    attributsExternes: ((st.mode & 0xffff) << 16) >>> 0,
  };
}

/** `Path.is_symlink()` : faux si absent, les autres erreurs d'OS lèvent. */
function estLien(chemin: string): boolean {
  try {
    return lstatSync(chemin).isSymbolicLink();
  } catch (e) {
    if (["ENOENT", "ENOTDIR", "EBADF", "ELOOP"].includes(String((e as { code?: unknown }).code)))
      return false;
    throw e;
  }
}

/** `texte[:n]` : une valeur qui n'est pas du texte lève comme en Python. */
function tranche(v: unknown, n: number): string {
  if (typeof v !== "string")
    throw new ErreurPython("TypeError", `'${nomTypePy(v)}' object is not subscriptable`);
  return prefixePy(v, n);
}

/** (nom de fichier, octets) du zip d'un skin au format d'import ; un intégré s'exporte comme modèle `<id>-perso`. */
export function exportZip(skinId: string): [string, Buffer] {
  const e = toutesLesSkins().get(skinId);
  if (e === undefined) throw new SkinNotFoundError("Skin inconnu.");
  if (veritePy(getOu(e, "builtin", null))) {
    const nouveau = `${skinId || "ardoise"}-perso`;
    let css = "";
    if (skinId) {
      try {
        css = lireTextePy(pyJoin(dossierCssIntegres(), `${skinId}.css`));
      } catch (x) {
        if (!estErreurOs(x)) throw x;
      }
      css = css.replaceAll(`.elpis-skin-${skinId}`, () => SELF_CLASS);
    }
    const man: Dict = {
      id: nouveau,
      label: `${tranche(ouPy(getOu(e, "label", null), nouveau), 32)} perso`,
      description: tranche(ouPy(getOu(e, "desc", null), ""), 200),
      version: "1.0.0",
      author: "",
      license: "MIT",
      darkBase: veritePy(getOu(e, "darkBase", null)),
      swatch: [...iterExige(ouPy(getOu(e, "sw", null), ["#0f172a", "#f8fafc", "#2563eb"]))],
      tokens: { light: {}, dark: {} },
    };
    if (css) man["css"] = "skin.css";
    if (veritePy(getOu(e, "brand", null))) man["brand"] = dictPy(e["brand"]);
    const entrees = [entreeEcrite(`${nouveau}/skin.json`, manifesteJson(man))];
    if (css) entrees.push(entreeEcrite(`${nouveau}/skin.css`, css));
    return [`skin-${nouveau}.zip`, ecrireZip(entrees)];
  }
  const d = pyJoin(skinsDir(), skinId);
  const entrees: EntreeZipEcrite[] = [];
  for (const nom of ["skin.json", "skin.css", ...EXTRA_FILES]) {
    const p = pyJoin(d, nom);
    if (estFichierPy(p) && !estLien(p)) entrees.push(entreeFichier(p, `${skinId}/${nom}`));
  }
  for (const nom of assetNames(d)) {
    const p = pyJoin(pyJoin(d, "assets"), nom);
    if (!estLien(p)) entrees.push(entreeFichier(p, `${skinId}/assets/${nom}`));
  }
  return [`skin-${skinId}.zip`, ecrireZip(entrees)];
}
