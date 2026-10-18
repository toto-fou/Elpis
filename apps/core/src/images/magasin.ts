// SPDX-License-Identifier: MIT
/** apps/core/src/images/magasin.ts — magasin des images générées : fichiers par compte + `generated_images`, rétention, galerie, suppressions, entretien (shared_infra/image/store.py). */
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import {
  arrondiPy,
  comparePointsDeCode,
  ErreurLecturePy,
  estChiffresPy,
  estDict,
  FlottantPy,
  getPy,
  intPy,
  maxPy,
  minPy,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, pyJoin, pyParent, realpathPy } from "@elpis/config";
import { noLimit } from "@elpis/db";
import type { Base, Executeur, Ligne } from "@elpis/db";
import { vignette } from "@elpis/images";

import { journal } from "../journal";
import { rmtree } from "../skills/chemins";
import type { ImageResult } from "./base";
import { getImageConfig } from "./config";

export { THUMB_SIDE } from "@elpis/images";

const log = journal("image");

const EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const ID_RE = /^[0-9a-f]{32}$/;
/** Image d'une conversation inconnue de la base : ramassée au-delà de ce délai (la question d'un chat neuf peut suivre l'image). */
export const ORPHAN_GRACE_S = 2 * 3600.0;
/** Images d'une session éphémère (sans conversation en base) : gardées un jour. */
export const EPHEMERAL_TTL_S = 24 * 3600.0;
const MISSING_GRACE_S = 24 * 3600.0;
const MODEL_MAX = 191;
const DELETE_CHUNK = 500;
const FILE_GRACE_S = 3600.0;
const COLONNES =
  "id, user_id, chat_id, prompt, params_json, model, mime, width, height, " +
  "bytes, rel_path, thumb_rel_path, steps, megapixels, duration_s, created_at";

/** Référence portée par un message (`ref_for`) : jamais d'URL arbitraire. */
export type RefImage = {
  id: string;
  url: string;
  thumb_url: string;
  width: number;
  height: number;
  mime: string;
  seed?: number | bigint | boolean;
};

/** Ligne de `generated_images` (`dict(row)`), avec `path` et `thumb_path` absolus pour `getImage`. */
export type LigneImage = Ligne & { id: string; rel_path: string; thumb_rel_path: unknown; mime: string };
export type ImageTrouvee = LigneImage & { path: string; thumb_path: string | null };

export function validId(imageId: unknown): imageId is string {
  return typeof imageId === "string" && ID_RE.test(imageId);
}

export function urlFor(imageId: string, options: { thumb?: boolean } = {}): string {
  return `/api/images/${imageId}` + (options.thumb ? "?thumb=1" : "");
}

/** `root()` : `<dossier de la base>/generated_images`, relu à chaque appel (jamais figé à l'import). */
export function root(): string {
  return pyJoin(pyParent(config.DB_PATH), "generated_images");
}

/** `_abs` : chemin absolu d'un chemin relatif s'il reste sous la racine, liens résolus. */
export function absolu(rel: string): string | null {
  if (!rel) return null;
  const racine = realpathPy(root());
  let chemin: string;
  try {
    chemin = realpathPy(pyJoin(racine, rel));
  } catch {
    return null;
  }
  const prefixe = racine.endsWith("/") ? racine : `${racine}/`;
  return chemin === racine || chemin.startsWith(prefixe) ? chemin : null;
}

/** `_unlink` : hors magasin ou impossible, journalisé ; un fichier déjà absent ne compte pas. */
export function effacer(rels: Iterable<unknown>): void {
  for (const rel of rels) {
    if (typeof rel !== "string" || !rel) continue;
    const chemin = absolu(rel);
    if (chemin === null) {
      log.warn(`chemin hors magasin ignoré : ${rel}`);
      continue;
    }
    try {
      unlinkSync(chemin);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        log.warn(`effacement de ${chemin} impossible : ${(e as Error).message}`);
    }
  }
}

function ecrire(chemin: string, data: Uint8Array): void {
  const tmp = chemin + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, chemin);
}

/** `json.loads(texte or "{}")` ; ValueError → `{}`, la récursion remonte. */
function paramsDe(texte: unknown): unknown {
  try {
    return pyJsonLoads(strPy(veritePy(texte) ? texte : "{}"));
  } catch (e) {
    if (e instanceof SyntaxError || (e instanceof ErreurLecturePy && e.nature !== "RecursionError"))
      return {};
    throw e;
  }
}

const estEntierPy = (v: unknown): v is number | bigint | boolean =>
  (typeof v === "number" && Number.isInteger(v)) || typeof v === "bigint" || typeof v === "boolean";

export function refFor(row: Dict): RefImage {
  const params = estDict(row["params"]) ? row["params"] : paramsDe(row["params_json"]);
  const id = strPy(row["id"]);
  const ref: RefImage = {
    id,
    url: urlFor(id),
    thumb_url: urlFor(id, { thumb: true }),
    width: intPy(row["width"]),
    height: intPy(row["height"]),
    mime: strPy(row["mime"]),
  };
  const graine = getPy(params, "seed");
  if (estEntierPy(graine)) ref.seed = graine;
  return ref;
}

/** `_delete_ids` : dédoublonnées et triées (ordre de verrous stable), un `DELETE … IN` par tranche. */
export async function supprimerIds(tx: Executeur, ids: Iterable<unknown>): Promise<void> {
  const uniques = [...new Set([...ids].filter((i) => veritePy(i)).map((i) => strPy(i)))].sort(
    comparePointsDeCode,
  );
  for (let k = 0; k < uniques.length; k += DELETE_CHUNK) {
    const tranche = uniques.slice(k, k + DELETE_CHUNK);
    await tx.run(`DELETE FROM generated_images WHERE id IN (${tranche.map(() => "?").join(",")})`, tranche);
  }
}

export type LotImages = {
  model: string;
  params: Dict;
  results: readonly ImageResult[];
  keep: number;
  steps?: number;
  durationS?: number | null;
};

type LigneVieille = Ligne & { id: string; rel_path: unknown; thumb_rel_path: unknown };

/** Écrit les images d'un lot, les inscrit, applique la rétention du compte (jamais moins que le lot) ; rend les références du message. */
export async function saveImages(
  base: Base,
  userId: number,
  chatId: string | null,
  prompt: string,
  lot: LotImages,
): Promise<RefImage[]> {
  const uid = Math.trunc(userId);
  mkdirSync(pyJoin(root(), String(uid)), { recursive: true });
  const maintenant = Date.now() / 1000;
  const lotMp = arrondiPy(
    lot.results.reduce((s, r) => s + Math.trunc(r.width) * Math.trunc(r.height), 0) / 1e6,
    4,
  );
  const lignes: (string | number | null)[][] = [];
  const refs: RefImage[] = [];
  const ecrits: string[] = [];
  let vieilles: LigneVieille[];
  try {
    for (const [i, res] of lot.results.entries()) {
      const imageId = randomUUID().replaceAll("-", "");
      const rel = `${uid}/${imageId}.${EXT[res.mime] ?? "png"}`;
      ecrire(pyJoin(root(), rel), res.data);
      ecrits.push(rel);
      let relVignette = "";
      const v = await vignette(res.data);
      if (v) {
        relVignette = `${uid}/${imageId}.thumb.webp`;
        ecrire(pyJoin(root(), relVignette), v);
        ecrits.push(relVignette);
      }
      const p: Dict = { ...lot.params };
      if (res.seed !== null) p["seed"] = res.seed;
      if (res.revisedPrompt) p["revised_prompt"] = res.revisedPrompt;
      refs.push(refFor({ id: imageId, width: res.width, height: res.height, mime: res.mime, params: p }));
      lignes.push([
        imageId,
        uid,
        chatId,
        prompt || "",
        pyJsonDumps(p, { ensureAscii: false }),
        prefixePy(lot.model || "", MODEL_MAX),
        res.mime,
        Math.trunc(res.width),
        Math.trunc(res.height),
        res.data.length,
        rel,
        relVignette,
        Math.trunc(lot.steps || 0),
        lotMp,
        i === 0 ? (lot.durationS ?? null) : null,
        maintenant + i * 1e-6,
      ]);
    }
    vieilles = await base.transaction(async (tx) => {
      for (const l of lignes)
        await tx.run(
          `INSERT INTO generated_images (${COLONNES}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          l,
        );
      const garder = Math.max(1, Math.trunc(lot.keep), lignes.length);
      const anciennes = await tx.all<LigneVieille>(
        "SELECT id, rel_path, thumb_rel_path FROM generated_images WHERE user_id=? " +
          `ORDER BY created_at DESC LIMIT ${noLimit(tx.dialecte)} OFFSET ?`,
        [uid, garder],
      );
      const orphelines = await tx.all<LigneVieille>(
        "SELECT id, rel_path, thumb_rel_path FROM generated_images g " +
          "WHERE user_id=? AND chat_id IS NOT NULL AND created_at < ? AND NOT EXISTS " +
          "(SELECT 1 FROM chats c WHERE c.id=g.chat_id AND c.user_id=g.user_id)",
        [uid, maintenant - ORPHAN_GRACE_S],
      );
      const duLot = new Set(lignes.map((l) => l[0]));
      const parId = new Map<string, LigneVieille>();
      for (const r of [...anciennes, ...orphelines]) if (!duLot.has(r.id)) parId.set(r.id, r);
      const retenues = [...parId.values()];
      if (retenues.length > 0)
        await supprimerIds(
          tx,
          retenues.map((r) => r.id),
        );
      return retenues;
    });
  } catch (e) {
    effacer(ecrits);
    throw e;
  }
  effacer(vieilles.flatMap((r) => [r.rel_path, r.thumb_rel_path]));
  return refs;
}

async function ligne(base: Executeur, userId: number, imageId: unknown): Promise<LigneImage | null> {
  if (!validId(imageId)) return null;
  return (
    (await base.get<LigneImage>(`SELECT ${COLONNES} FROM generated_images WHERE id=? AND user_id=?`, [
      imageId,
      Math.trunc(userId),
    ])) ?? null
  );
}

function estFichier(chemin: string): boolean {
  try {
    return statSync(chemin).isFile();
  } catch {
    return false;
  }
}

function estDossier(chemin: string): boolean {
  try {
    return statSync(chemin).isDirectory();
  } catch {
    return false;
  }
}

/** La ligne si elle appartient au compte ET si son fichier existe, avec `path` et `thumb_path` absolus (`null` sans vignette). */
export async function getImage(
  base: Executeur,
  userId: number,
  imageId: unknown,
): Promise<ImageTrouvee | null> {
  const row = await ligne(base, userId, imageId);
  if (!row) return null;
  const p = absolu(row.rel_path);
  if (p === null || !estFichier(p)) return null;
  const t = absolu(veritePy(row.thumb_rel_path) ? strPy(row.thumb_rel_path) : "");
  return { ...row, path: p, thumb_path: t !== null && estFichier(t) ? t : null };
}

/** Octets d'une image du compte (édition à partir d'une image générée). */
export async function readBytes(base: Executeur, userId: number, imageId: unknown): Promise<Buffer | null> {
  const row = await getImage(base, userId, imageId);
  return row ? readFileSync(row.path) : null;
}

export async function deleteImage(base: Executeur, userId: number, imageId: unknown): Promise<boolean> {
  const row = await ligne(base, userId, imageId);
  if (!row) return false;
  const r = await base.run("DELETE FROM generated_images WHERE id=? AND user_id=?", [
    row.id,
    Math.trunc(userId),
  ]);
  effacer([row.rel_path, row.thumb_rel_path]);
  return r.changes > 0;
}

/** `delete_for_chats` : lignes et fichiers (vignettes comprises) des conversations supprimées ; rend le nombre d'images. */
export async function deleteForChats(base: Base, uid: number, chatIds: Iterable<unknown>): Promise<number> {
  const ids = [...chatIds].filter((c) => veritePy(c)).map((c) => strPy(c));
  if (ids.length === 0) return 0;
  const [rels, n] = await base.transaction(async (tx) => {
    const chemins: unknown[] = [];
    let total = 0;
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
      const tranche = ids.slice(i, i + DELETE_CHUNK);
      const marques = tranche.map(() => "?").join(",");
      const lignes = await tx.all<{ rel_path: unknown; thumb_rel_path: unknown }>(
        `SELECT rel_path, thumb_rel_path FROM generated_images WHERE user_id=? AND chat_id IN (${marques})`,
        [uid, ...tranche],
      );
      for (const l of lignes) chemins.push(l.rel_path, l.thumb_rel_path);
      await tx.run(`DELETE FROM generated_images WHERE user_id=? AND chat_id IN (${marques})`, [
        uid,
        ...tranche,
      ]);
      total += lignes.length;
    }
    return [chemins, total] as const;
  });
  effacer(rels);
  return n;
}

/** Dossier d'un compte supprimé (les lignes partent avec le compte). */
export async function deleteUserDir(userId: number): Promise<void> {
  const p = absolu(String(Math.trunc(userId)));
  if (p !== null && estDossier(p)) await rmtree(p, true);
}

export type OptionsGalerie = { before?: number | null; limit?: number; chatId?: string | null };
export type Galerie = [items: Dict[], suivant: FlottantPy | null, total: number];

/** Galerie : images (plus récentes d'abord), curseur suivant (`created_at` de la dernière rendue) et total du compte. */
export async function listImages(base: Executeur, userId: number, o: OptionsGalerie = {}): Promise<Galerie> {
  const limite = maxPy(1, minPy(Math.trunc(o.limit ?? 50), 100));
  const ou = ["user_id=?"];
  const params: (string | number)[] = [Math.trunc(userId)];
  if (o.chatId) {
    ou.push("chat_id=?");
    params.push(String(o.chatId));
  }
  if (o.before !== undefined && o.before !== null) {
    ou.push("created_at < ?");
    params.push(Number(o.before));
  }
  let lignes = await base.all<LigneImage>(
    `SELECT ${COLONNES} FROM generated_images WHERE ${ou.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    [...params, limite + 1],
  );
  const total = await countForUser(base, userId);
  const encore = lignes.length > limite;
  lignes = lignes.slice(0, limite);
  const items = lignes.map((r): Dict => {
    const ref: Dict = refFor(r);
    const p = paramsDe(r["params_json"]);
    ref["chat_id"] = veritePy(r["chat_id"]) ? r["chat_id"] : null;
    ref["prompt"] = veritePy(r["prompt"]) ? r["prompt"] : "";
    ref["model"] = veritePy(r["model"]) ? r["model"] : "";
    ref["created_at"] = new FlottantPy(Number(r["created_at"]));
    const revise = getPy(p, "revised_prompt");
    if (veritePy(revise)) ref["revised_prompt"] = revise;
    return ref;
  });
  const derniere = lignes[lignes.length - 1];
  return [items, encore && derniere ? new FlottantPy(Number(derniere["created_at"])) : null, total];
}

export async function countForUser(base: Executeur, userId: number): Promise<number> {
  const r = await base.valeurs<[unknown]>("SELECT COUNT(*) FROM generated_images WHERE user_id=?", [
    Math.trunc(userId),
  ]);
  return intPy(veritePy(r[0]?.[0]) ? r[0]?.[0] : 0);
}

/** `[(secondes de calcul, mégapixels du lot)]` des derniers lots du même modèle à ce nombre d'étapes, tous comptes confondus. */
export async function recentTimings(
  base: Executeur,
  model: string,
  steps: number,
  limit = 20,
): Promise<[number, number][]> {
  const lignes = await base.all<{ duration_s: unknown; megapixels: unknown }>(
    "SELECT duration_s, megapixels FROM generated_images " +
      "WHERE model=? AND steps=? AND duration_s IS NOT NULL AND megapixels > 0 " +
      "ORDER BY created_at DESC LIMIT ?",
    [model || "", Math.trunc(steps || 0), Math.trunc(limit)],
  );
  return lignes
    .filter((r) => veritePy(r.duration_s) && Number(r.duration_s) > 0)
    .map((r) => [Number(r.duration_s), Number(r.megapixels)]);
}

async function auDelaDeLaRetention(tx: Executeur, keep: number): Promise<LigneVieille[]> {
  const out: LigneVieille[] = [];
  const comptes = await tx.valeurs<[unknown]>(
    "SELECT user_id FROM generated_images GROUP BY user_id HAVING COUNT(*) > ?",
    [keep],
  );
  for (const [uid] of comptes)
    out.push(
      ...(await tx.all<LigneVieille>(
        "SELECT id, rel_path, thumb_rel_path FROM generated_images WHERE user_id=? " +
          `ORDER BY created_at DESC LIMIT ${noLimit(tx.dialecte)} OFFSET ?`,
        [intPy(uid), keep],
      )),
    );
  return out;
}

/** Entretien : conversations disparues, sessions éphémères au-delà d'un jour, lignes sans fichier, rétention de chaque compte, fichiers sans ligne, dossiers de comptes supprimés ; rend le nombre d'éléments retirés. */
export async function sweepOrphans(
  base: Base,
  options: { now?: number | null; keep?: number | null } = {},
): Promise<number> {
  const maintenant = options.now ?? Date.now() / 1000;
  const keep = options.keep ?? getImageConfig().keep_per_user;
  let n = 0;
  const [vieilles, connus, comptes] = await base.transaction(async (tx) => {
    const old = await tx.all<LigneVieille>(
      "SELECT id, rel_path, thumb_rel_path FROM generated_images g " +
        "WHERE chat_id IS NOT NULL AND created_at < ? AND NOT EXISTS " +
        "(SELECT 1 FROM chats c WHERE c.id=g.chat_id AND c.user_id=g.user_id)",
      [maintenant - ORPHAN_GRACE_S],
    );
    old.push(
      ...(await tx.all<LigneVieille>(
        "SELECT id, rel_path, thumb_rel_path FROM generated_images WHERE chat_id IS NULL AND created_at < ?",
        [maintenant - EPHEMERAL_TTL_S],
      )),
    );
    for (const r of await tx.all<LigneVieille>(
      "SELECT id, rel_path, thumb_rel_path FROM generated_images WHERE created_at < ?",
      [maintenant - MISSING_GRACE_S],
    )) {
      const p = absolu(strPy(r.rel_path));
      if (!(p !== null && estFichier(p))) old.push(r);
    }
    old.push(...(await auDelaDeLaRetention(tx, maxPy(1, intPy(keep)))));
    if (old.length > 0)
      await supprimerIds(
        tx,
        old.map((r) => r.id),
      );
    const known = new Set<string>();
    for (const r of await tx.all<{ rel_path: unknown; thumb_rel_path: unknown }>(
      "SELECT rel_path, thumb_rel_path FROM generated_images",
    ))
      for (const x of [r.rel_path, r.thumb_rel_path]) if (veritePy(x)) known.add(strPy(x));
    const users = new Set((await tx.valeurs<[unknown]>("SELECT id FROM users")).map(([id]) => intPy(id)));
    return [old, known, users] as const;
  });
  const uniques = new Map<string, LigneVieille>();
  for (const r of vieilles) uniques.set(r.id, r);
  effacer([...uniques.values()].flatMap((r) => [r.rel_path, r.thumb_rel_path]));
  n += uniques.size;
  const racine = root();
  if (!estDossier(racine)) return n;
  for (const nom of readdirSync(racine)) {
    const d = pyJoin(racine, nom);
    if (!estDossier(d) || !estChiffresPy(nom)) continue;
    let uid: number;
    try {
      uid = intPy(nom);
    } catch {
      continue;
    }
    if (!comptes.has(uid)) {
      await rmtree(d, true);
      n += 1;
      continue;
    }
    let contenu: string[];
    try {
      contenu = readdirSync(d);
    } catch {
      continue;
    }
    for (const f of contenu) {
      const rel = `${nom}/${f}`;
      const chemin = pyJoin(d, f);
      try {
        if (!connus.has(rel)) {
          const s = statSync(chemin);
          if (s.isFile() && maintenant - s.mtimeMs / 1000 > FILE_GRACE_S) {
            unlinkSync(chemin);
            n += 1;
          }
        }
      } catch {
        continue;
      }
    }
  }
  return n;
}
