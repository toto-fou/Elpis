// SPDX-License-Identifier: MIT
/** packages/bureau/src/session.ts — bureau (computer-use) : propriété des trames, observations et ids stables, résolution d'éléments, cible active par compte. */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

import {
  ErreurPython,
  estDict,
  exigerDict,
  floatPy,
  FlottantPy,
  intPy,
  iterPy,
  lire,
  lowerPy,
  maxPy,
  ouPy as ou,
  poserCle,
  pyJsonDumps,
  pyJsonLoads,
  reprPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import { journal } from "@elpis/http";

import { portAncres } from "./ports";

const log = journal("desktop");

/** Jeton de trame : pas de traversée de chemin possible. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** `os.path.join(a, b)` (sans normalisation, contrairement à `path.join`). */
export function joindre(a: string, b: string): string {
  if (b.startsWith("/") || a === "") return b;
  return a.endsWith("/") ? a + b : `${a}/${b}`;
}

/** `os.path.dirname`. */
export function dossierParent(p: string): string {
  const i = p.lastIndexOf("/") + 1;
  const tete = p.slice(0, i);
  return tete && tete !== "/".repeat(tete.length) ? tete.replace(/\/+$/, "") : tete;
}

/** Dossier partagé des trames annotées (`DESKTOP_SCREENS_DIR`). */
export function desktopScreensDir(): string {
  return process.env["DESKTOP_SCREENS_DIR"] ?? "/tmp/desktop_screens";
}

export function desktopFramePath(token: string): string {
  return joindre(desktopScreensDir(), `frame_${token}.png`);
}

function cheminProprietaire(token: string): string {
  return joindre(desktopScreensDir(), `frame_${token}.owner`);
}

/** Fichier compagnon de propriété à côté du PNG (best-effort), lu par le service qui sert la trame. */
export async function writeFrameOwner(token: string, owner: string): Promise<void> {
  if (!token || !owner) return;
  try {
    await writeFile(cheminProprietaire(token), owner, "utf-8");
  } catch (e) {
    log.warn(`frame owner sidecar failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function ensureScreensDir(): Promise<void> {
  await mkdir(desktopScreensDir(), { recursive: true }).catch(() => undefined);
}

let dernierElagage = 0;
const ELAGAGE_MIN_S = 30.0;

/** Trames (et compagnons) plus vieilles que `ttlSec` supprimées ; un balayage au plus toutes les 30 s sauf `force`. */
export async function pruneFrames(
  ttlSec = 900,
  force = false,
  maintenant = Date.now() / 1000,
): Promise<void> {
  if (!force && maintenant - dernierElagage < ELAGAGE_MIN_S) return;
  dernierElagage = maintenant;
  const dossier = desktopScreensDir();
  let noms: string[];
  try {
    noms = await readdir(dossier);
  } catch {
    return;
  }
  for (const nom of noms) {
    if (!nom.startsWith("frame_")) continue;
    const chemin = joindre(dossier, nom);
    try {
      if (maintenant - (await stat(chemin)).mtimeMs / 1000 > ttlSec) await unlink(chemin);
    } catch {
      continue;
    }
  }
}

const proprietaires = new Map<string, string>();
const PROPRIETAIRES_MAX = 500;

/** Retire les entrées les plus anciennes au-delà de `max` (ordre d'insertion, comme un dict Python). */
function borner<K, V>(m: Map<K, V>, max: number, retrait?: (k: K) => void): void {
  if (m.size <= max) return;
  for (const k of [...m.keys()].slice(0, m.size - max)) {
    m.delete(k);
    retrait?.(k);
  }
}

/** Propriétaire d'une trame : en mémoire et dans le fichier compagnon, à attendre avant d'annoncer la trame. */
export async function registerDesktopFrameOwner(token: string, username: string): Promise<void> {
  if (!token || !username) return;
  proprietaires.set(token, username);
  borner(proprietaires, PROPRIETAIRES_MAX);
  await writeFrameOwner(token, username);
}

/** Mémoire, sinon fichier compagnon (trame écrite par un autre processus) ; `null` si inconnu. */
export async function getDesktopFrameOwner(token: string): Promise<string | null> {
  if (!token) return null;
  const connu = proprietaires.get(token);
  if (connu !== undefined) return connu;
  if (!TOKEN_RE.test(token)) return null;
  let owner: string;
  try {
    owner = stripPy(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await readFile(cheminProprietaire(token)),
      ),
    );
  } catch {
    return null;
  }
  if (!owner) return null;
  proprietaires.set(token, owner);
  return owner;
}

type Observation = { elements: unknown[]; ts: number };
const observations = new Map<string, Observation>();
const dimensions = new Map<string, readonly [number, number]>();
const sequences = new Map<string, number>();
const OBSERVATIONS_MAX = 200;
const MARGE = 2;

export function obsKey(username: unknown, target: unknown): string {
  return `${veritePy(username) ? strPy(username) : "?"}::${veritePy(target) ? strPy(target) : "?"}`;
}

function erreurConversion(e: unknown): boolean {
  return e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError");
}

/** Dimensions de la dernière capture d'une cible (bornent les coordonnées d'action). */
export function setScreenDims(username: string, target: string, w: unknown, h: unknown): void {
  let lw: number;
  let lh: number;
  try {
    lw = intPy(w);
    lh = intPy(h);
  } catch (e) {
    if (erreurConversion(e)) return;
    throw e;
  }
  if (lw > 0 && lh > 0) dimensions.set(obsKey(username, target), [lw, lh]);
}

export function getScreenDims(username: string, target: string): readonly [number, number] | null {
  return dimensions.get(obsKey(username, target)) ?? null;
}

function nomType(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (v instanceof FlottantPy) return "float";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "bigint") return "int";
  return typeof v === "string" ? "str" : Array.isArray(v) ? "list" : "dict";
}

export type SequencePy = { n: number; at(i: number): unknown };

/** `len(x)` et `x[i]` : liste ou texte (points de code) ; un dict lève KeyError à l'indexation, le reste TypeError. */
export function sequencePy(v: unknown): SequencePy {
  if (Array.isArray(v)) return { n: v.length, at: (i) => v[i] };
  if (typeof v === "string") {
    const points = Array.from(v);
    return { n: points.length, at: (i) => points[i] };
  }
  if (estDict(v))
    return {
      n: Object.keys(v).length,
      at: (i) => {
        const e = new Error(String(i));
        e.name = "KeyError";
        throw e;
      },
    };
  throw new ErreurPython("TypeError", `object of type '${nomType(v)}' has no len()`);
}

/** Point d'action borné à l'écran (bord à 2 px près), `null` s'il est franchement dehors ou illisible. */
export function validatePoint(
  point: unknown,
  dims: readonly [number, number] | null,
): [number, number] | null {
  if (!veritePy(point)) return null;
  const seq = sequencePy(point);
  if (seq.n < 2) return null;
  const [p0, p1] = [seq.at(0), seq.at(1)];
  let x: number;
  let y: number;
  try {
    x = intPy(p0);
    y = intPy(p1);
  } catch (e) {
    if (erreurConversion(e)) return null;
    throw e;
  }
  if (dims === null) {
    if (x < -MARGE || y < -MARGE) return null;
    return [Math.max(0, x), Math.max(0, y)];
  }
  const [w, h] = dims;
  if (x < -MARGE || y < -MARGE || x > w + MARGE || y > h + MARGE) return null;
  return [Math.min(Math.max(0, x), w - 1), Math.min(Math.max(0, y), h - 1)];
}

/** `list(x or [])`. */
function liste(v: unknown): unknown[] {
  if (!veritePy(v)) return [];
  const it = iterPy(v);
  if (it === null) throw new ErreurPython("TypeError", `'${nomType(v)}' object is not iterable`);
  return [...it];
}

export function registerDesktopObservation(username: string, target: string, elements: unknown): void {
  observations.set(obsKey(username, target), { elements: liste(elements), ts: Date.now() / 1000 });
  borner(observations, OBSERVATIONS_MAX, (k) => {
    dimensions.delete(k);
    sequences.delete(k);
  });
}

export function getDesktopObservation(username: string, target: string): unknown[] {
  const rec = observations.get(obsKey(username, target));
  return rec ? [...rec.elements] : [];
}

/** `d.get(cle)` d'un élément (AttributeError si ce n'est pas un dict). */
function champ(e: unknown, cle: string): unknown {
  return lire(exigerDict(e), cle) ?? null;
}

/** `str(e.get(cle) or "")`. */
function texteChamp(e: unknown, cle: string): string {
  const v = champ(e, cle);
  return veritePy(v) ? strPy(v) : "";
}

/** Clé d'ensemble Python (`True == 1 == 1.0`). */
function cleEnsemble(v: unknown): string {
  if (typeof v === "string") return `s${v}`;
  if (typeof v === "boolean") return `n${v ? 1 : 0}`;
  if (v instanceof FlottantPy) return `n${v.valeur}`;
  if (typeof v === "number" || typeof v === "bigint") return `n${String(v)}`;
  return `o${reprPy(v)}`;
}

/** Ids `el_N` réutilisés d'une observation à l'autre (même `runtime_id`, sinon même `auto_id`), compteur monotone par cible. */
export function assignStableIds(username: string, target: string, elements: unknown[]): unknown[] {
  const cle = obsKey(username, target);
  const precedente = observations.get(cle)?.elements ?? [];
  let seq = sequences.get(cle) ?? 0;
  const parRid = new Map<string, unknown>();
  const parAid = new Map<string, unknown>();
  for (const pe of precedente) {
    const pid = champ(pe, "id");
    if (!veritePy(pid)) continue;
    const rid = texteChamp(pe, "runtime_id");
    const aid = texteChamp(pe, "auto_id");
    if (rid && !parRid.has(rid)) parRid.set(rid, pid);
    if (aid && !parAid.has(aid)) parAid.set(aid, pid);
  }
  const utilises = new Set<string>();
  const enAttente: Dict[] = [];
  for (const e of elements) {
    const d = exigerDict(e);
    const rid = texteChamp(d, "runtime_id");
    const aid = texteChamp(d, "auto_id");
    let reprise: unknown = null;
    const parR = parRid.get(rid) ?? null;
    const parA = parAid.get(aid) ?? null;
    if (rid && veritePy(parR) && !utilises.has(cleEnsemble(parR))) reprise = parR;
    else if (aid && veritePy(parA) && !utilises.has(cleEnsemble(parA))) reprise = parA;
    if (veritePy(reprise)) {
      poserCle(d, "id", reprise);
      utilises.add(cleEnsemble(reprise));
    } else enAttente.push(d);
  }
  for (const d of enAttente) {
    let candidat: string;
    do {
      seq += 1;
      candidat = `el_${seq}`;
    } while (utilises.has(cleEnsemble(candidat)));
    poserCle(d, "id", candidat);
    utilises.add(cleEnsemble(candidat));
  }
  sequences.set(cle, seq);
  return elements;
}

/** Centre d'un élément (`center`, sinon milieu de `box`), en flottants ; lève comme `float()`. */
export function elementCenter(e: unknown): [number, number] | null {
  const c = sequencePy(ou(champ(e, "center"), []));
  if (c.n >= 2) return [floatPy(c.at(0)), floatPy(c.at(1))];
  const b = sequencePy(ou(champ(e, "box"), []));
  if (b.n >= 4) return [(floatPy(b.at(0)) + floatPy(b.at(2))) / 2, (floatPy(b.at(1)) + floatPy(b.at(3))) / 2];
  return null;
}

export type Proche = readonly [number, number] | null | undefined;

/** Départage : même rôle, libellé égal ou préfixe, proximité de `near`, actionnable ; à égalité le premier gagne. */
export function pickBest(
  candidats: readonly unknown[],
  o: { near?: Proche; role?: unknown; query?: unknown } = {},
): unknown {
  if (candidats.length === 0) return null;
  if (candidats.length === 1) return candidats[0];
  const rl = lowerPy(stripPy(veritePy(o.role) ? strPy(o.role) : ""));
  const q = lowerPy(stripPy(veritePy(o.query) ? strPy(o.query) : ""));
  const score = (e: unknown): number => {
    let s = 0;
    if (rl && lowerPy(stripPy(texteChamp(e, "role"))) === rl) s += 100;
    if (q) {
      const lbl = lowerPy(stripPy(strPy(ou(ou(champ(e, "label"), champ(e, "name")), ""))));
      if (lbl === q) s += 50;
      else if (lbl.startsWith(q)) s += 20;
    }
    if (o.near !== null && o.near !== undefined) {
      const c = elementCenter(e);
      if (c !== null) s += maxPy(0, 40 - Math.sqrt((c[0] - o.near[0]) ** 2 + (c[1] - o.near[1]) ** 2) / 50);
    }
    const etats = liste(champ(e, "states")).map((x) => lowerPy(strPy(x)));
    if (etats.includes("offscreen")) s -= 30;
    if (etats.includes("enabled")) s += 5;
    return s;
  };
  let meilleur = candidats[0];
  let max = score(meilleur);
  for (const c of candidats.slice(1)) {
    const s = score(c);
    if (s > max) {
      meilleur = c;
      max = s;
    }
  }
  return meilleur;
}

const memoAncres = new Map<string, string>();

/** Ancre épinglée (auto_id) pour la requête, ou `null` ; une panne de la mémoire d'ancres ne casse rien. */
async function lookupPinnedAnchor(username: string, target: string, q: string): Promise<unknown> {
  const port = portAncres();
  if (port === null) return null;
  try {
    const rec = await port.lookupActionAnchor(obsKey(username, target), q);
    return veritePy(rec) ? (lire(rec, "auto_id") ?? null) : null;
  } catch {
    return null;
  }
}

/** Mémorise l'auto_id stable d'un élément résolu par requête ; écritures identiques dédoublonnées. */
async function learnAnchor(username: string, target: string, q: string, el: unknown): Promise<void> {
  if (!veritePy(el)) return;
  const aid = stripPy(texteChamp(el, "auto_id"));
  if (!aid) return;
  const scope = obsKey(username, target);
  const cle = `${scope}|${q}`;
  if (memoAncres.get(cle) === aid) return;
  const port = portAncres();
  if (port === null) return;
  try {
    await port.recordActionAnchor(scope, q, aid, {
      role: texteChamp(el, "role"),
      center: champ(el, "center"),
    });
    memoAncres.set(cle, aid);
    if (memoAncres.size > 1000) memoAncres.clear();
  } catch {
    return;
  }
}

export type CriteresResolution = {
  element_id?: unknown;
  query?: unknown;
  auto_id?: unknown;
  near?: Proche;
  role?: unknown;
  runtime_id?: unknown;
};

/** `str.strip()` d'une requête : AttributeError hors texte, comme Python. */
function requeteNormalisee(query: unknown): string {
  if (typeof query !== "string")
    throw new ErreurPython("AttributeError", `'${nomType(query)}' object has no attribute 'strip'`);
  return lowerPy(stripPy(query));
}

/** Élément de la dernière observation et la méthode qui l'a trouvé (`runtime_id`, `auto_id`, `element_id`, `cache_pin`, `exact_label`, `substring`, `""`). */
export async function resolveElementImpl(
  username: string,
  target: string,
  o: CriteresResolution = {},
): Promise<[unknown, string]> {
  const els = getDesktopObservation(username, target);
  if (veritePy(o.runtime_id))
    for (const e of els) if (texteChamp(e, "runtime_id") === strPy(o.runtime_id)) return [e, "runtime_id"];
  if (veritePy(o.auto_id))
    for (const e of els) if (texteChamp(e, "auto_id") === strPy(o.auto_id)) return [e, "auto_id"];
  if (veritePy(o.element_id))
    for (const e of els) if (strPy(champ(e, "id")) === strPy(o.element_id)) return [e, "element_id"];
  if (veritePy(o.query)) {
    const q = requeteNormalisee(o.query);
    if (q) {
      if ((o.near === null || o.near === undefined) && !veritePy(o.role)) {
        const epingle = await lookupPinnedAnchor(username, target, q);
        if (veritePy(epingle))
          for (const e of els) {
            if (texteChamp(e, "auto_id") !== epingle) continue;
            if (lowerPy(strPy(ou(ou(champ(e, "label"), champ(e, "name")), ""))).includes(q))
              return [e, "cache_pin"];
            break;
          }
      }
      const exacts = els.filter(
        (e) =>
          lowerPy(stripPy(texteChamp(e, "label"))) === q || lowerPy(stripPy(texteChamp(e, "name"))) === q,
      );
      if (exacts.length > 0) {
        const choisi = pickBest(exacts, { near: o.near, role: o.role, query: q });
        await learnAnchor(username, target, q, choisi);
        return [choisi, "exact_label"];
      }
      const partiels = els.filter(
        (e) => lowerPy(texteChamp(e, "label")).includes(q) || lowerPy(texteChamp(e, "name")).includes(q),
      );
      if (partiels.length > 0) {
        const choisi = pickBest(partiels, { near: o.near, role: o.role, query: q });
        await learnAnchor(username, target, q, choisi);
        return [choisi, "substring"];
      }
    }
  }
  return [null, ""];
}

export async function resolveElement(
  username: string,
  target: string,
  o: CriteresResolution = {},
): Promise<unknown> {
  return (await resolveElementImpl(username, target, o))[0];
}

/** Requête qui désigne exactement plusieurs éléments distincts sans ancre pour trancher : les candidats, sinon `null`. */
export async function ambiguousQueryCandidates(
  username: string,
  target: string,
  query: unknown,
): Promise<unknown[] | null> {
  const q = lowerPy(stripPy(veritePy(query) ? strPy(query) : ""));
  if (!q) return null;
  const exacts = getDesktopObservation(username, target).filter(
    (e) => lowerPy(stripPy(texteChamp(e, "label"))) === q || lowerPy(stripPy(texteChamp(e, "name"))) === q,
  );
  const vus = new Set<string>();
  const distincts: unknown[] = [];
  for (const e of exacts) {
    const k = texteChamp(e, "auto_id") || texteChamp(e, "runtime_id") || texteChamp(e, "id");
    if (vus.has(k)) continue;
    vus.add(k);
    distincts.push(e);
  }
  if (distincts.length < 2) return null;
  const epingle = await lookupPinnedAnchor(username, target, q);
  if (veritePy(epingle) && distincts.some((e) => texteChamp(e, "auto_id") === epingle)) return null;
  return distincts;
}

/** `DESKTOP_ACTIVE_PATH`, sinon `desktop_active.json` à côté de la base. */
function cheminActif(): string {
  const p = process.env["DESKTOP_ACTIVE_PATH"];
  if (p) return p;
  return joindre(dossierParent(String(config.DB_PATH)), "desktop_active.json");
}

/** `json.load(f) or {}` d'un fichier UTF-8 ; lève si absent ou illisible. */
async function lireActif(chemin: string): Promise<unknown> {
  const texte = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(chemin));
  return ou(pyJsonLoads(texte), {});
}

/** Cible active d'un compte (sélecteur de l'interface), `""` si aucune ou fichier illisible. */
export async function getActiveTarget(username: string): Promise<string> {
  if (!username) return "";
  try {
    const v = lire(exigerDict(await lireActif(cheminActif())), username) ?? "";
    return veritePy(v) ? strPy(v) : "";
  } catch {
    return "";
  }
}

let fileActive: Promise<void> = Promise.resolve();

/** Pose (ou retire, cible vide) la cible active ; écritures sérialisées, publication atomique. */
export function setActiveTarget(username: string, target: string): Promise<void> {
  const tour = fileActive.then(() => ecrireActif(username, target));
  fileActive = tour.catch(() => undefined);
  return tour;
}

async function ecrireActif(username: string, target: string): Promise<void> {
  if (!username) return;
  const chemin = cheminActif();
  let data: unknown;
  try {
    data = await lireActif(chemin);
  } catch {
    data = {};
  }
  if (!estDict(data)) {
    if (target || Array.isArray(data))
      throw new ErreurPython("TypeError", `'${nomType(data)}' object does not support item assignment`);
    throw new ErreurPython("AttributeError", `'${nomType(data)}' object has no attribute 'pop'`);
  }
  if (target) poserCle(data, username, target);
  else delete data[username];
  try {
    await mkdir(dossierParent(chemin) || ".", { recursive: true });
    const tmp = chemin + ".tmp";
    await writeFile(tmp, pyJsonDumps(data, { ensureAscii: false, separators: [", ", ": "] }), "utf-8");
    await rename(tmp, chemin);
  } catch (e) {
    log.warn(`écriture cible active échouée: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Résultat d'un outil `desktop_*` portant un `frame_token` → données de l'évènement `annotation_frame`, sinon `null`. */
export function extractDesktopFrame(
  nom: unknown,
  args: unknown,
  resultat: unknown,
  maintenant = Date.now() / 1000,
): Dict | null {
  if (typeof nom !== "string" || !nom.startsWith("desktop_")) return null;
  if (typeof resultat !== "string" || !resultat) return null;
  let data: unknown;
  try {
    data = pyJsonLoads(resultat);
  } catch {
    return null;
  }
  if (!estDict(data)) return null;
  const token = lire(data, "frame_token");
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const cibleResultat = lire(data, "target");
  const cibleArgs = estDict(args) ? lire(args, "target") : undefined;
  const target =
    typeof cibleResultat === "string" ? cibleResultat : typeof cibleArgs === "string" ? cibleArgs : "";
  const ts = Math.trunc(maintenant * 1000);
  const boxes = lire(data, "elements");
  return {
    url: `/api/desktop/frame/${token}?t=${ts}`,
    step: token,
    session_id: target,
    img_w: intPy(ou(lire(data, "img_w") ?? null, 0)),
    img_h: intPy(ou(lire(data, "img_h") ?? null, 0)),
    boxes: Array.isArray(boxes) ? boxes : [],
    token,
    sig: ou(lire(data, "sig") ?? null, ""),
  };
}
