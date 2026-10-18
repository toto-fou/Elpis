// SPDX-License-Identifier: MIT
/** apps/toolhost/src/reponse-agent.ts — fichiers du bac servis par l'agent du conteneur (routes_files.py `_reponse_agent`, `_fichier_agent`) : plage, ETag, 304/206/416, blocs ; partagé par pv, serve et download (B2-03b). */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { estErreurAgent } from "@elpis/bac";
import {
  arrondiEntierPy,
  BLANC_PY,
  getPy,
  HttpError,
  intPy,
  lowerPy,
  reprFlottant,
  stripPy,
  strPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { AgentError, agentHttp, parAgent } from "@elpis/fichiers";
import type { AgentClient } from "@elpis/fichiers";
import { premierEntete } from "@elpis/http";
import { ErreurCheminBac, lexicalRel } from "@elpis/securite";
import type { FastifyReply, FastifyRequest } from "fastify";

const MILLIARD = 1_000_000_000n;
export const BLOC_REPONSE = 1 << 20;
// Types qu'un navigateur exécute : servis avec une origine opaque (la visionneuse PDF refuse `sandbox`, les autres n'en ont pas besoin).
const TYPES_ACTIFS = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "text/xsl",
]);
export const PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals";

type OptionsVersion = { expectSize: number; expectMtimeNs: number | bigint; expectIno?: number | bigint };
const PLAGE = new RegExp(`^${BLANC_PY}*bytes=(\\p{Nd}*)-(\\p{Nd}*)${BLANC_PY}*$`, "u");
const JOURS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MOIS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Secondes des 1er janvier de l'an 1 et 31 décembre 9999 à 23:59:59 (bornes de `datetime`).
const PREMIERE_SECONDE = -62_135_596_800;
const DERNIERE_SECONDE = 253_402_300_799;

/** `_mtime_s` : mtime en secondes calculé comme `os.stat().st_mtime`, au bit près (division entière par défaut). */
export function mtimeS(ns: number | bigint): number {
  const n = BigInt(ns);
  let q = n / MILLIARD;
  let r = n % MILLIARD;
  if (r < 0n) {
    q -= 1n;
    r += MILLIARD;
  }
  return Number(q) + Number(r) * 1e-9;
}

/** Entier de chiffres décimaux Unicode (`\d` et `int()` de Python), exact. */
function entier(chiffres: string): bigint {
  return BigInt(Array.from(chiffres, (c) => String(intPy(c))).join(""));
}

/** `_plage` : `[début, fin[` d'un `Range` à une plage ; `null` sans plage utilisable (plusieurs : fichier entier) ; `"invalide"` hors du fichier (416). */
export function plage(
  entete: string | null | undefined,
  taille: number,
): [number, number] | null | "invalide" {
  const m = PLAGE.exec(entete ?? "");
  if (!m || (!m[1] && !m[2])) return null;
  const t = BigInt(taille);
  if (!m[1]) {
    const n = entier(m[2] ?? "");
    return n ? [Number(t > n ? t - n : 0n), taille] : "invalide";
  }
  const debut = entier(m[1]);
  const borne = m[2] ? entier(m[2]) + 1n : t;
  const fin = borne < t ? borne : t;
  return debut < t && debut < fin ? [Number(debut), Number(fin)] : "invalide";
}

/** `email.utils.formatdate(t, usegmt=True)` : secondes de `datetime.fromtimestamp` (µs arrondies au pair) ; hors des années 1 à 9999, lève comme Python. */
export function dateHttp(t: number): string {
  let s = Math.trunc(t);
  const us = arrondiEntierPy((t - s) * 1e6);
  if (us >= 1_000_000) s += 1;
  else if (us < 0) s -= 1;
  if (!(s >= PREMIERE_SECONDE && s <= DERNIERE_SECONDE))
    throw new RangeError(`date hors de l'an 1 à 9999 : ${t}`);
  const d = new Date(s * 1000);
  const deux = (n: number): string => String(n).padStart(2, "0");
  return (
    `${JOURS[d.getUTCDay()] ?? ""}, ${deux(d.getUTCDate())} ${MOIS[d.getUTCMonth()] ?? ""} ` +
    `${String(d.getUTCFullYear()).padStart(4, "0")} ${deux(d.getUTCHours())}:${deux(d.getUTCMinutes())}:` +
    `${deux(d.getUTCSeconds())} GMT`
  );
}

/** ETag de `_reponse_agent` : md5 de mtime, taille et inode (un remplacement de même taille et même date change l'ETag). */
export function etagAgent(
  taille: number | bigint,
  mtimeNs: number | bigint,
  ino: number | bigint | null,
): string {
  const cle = `${reprFlottant(mtimeS(mtimeNs))}-${String(taille)}-${ino === null ? "None" : String(ino)}`;
  return `"${createHash("md5").update(cle, "utf8").digest("hex")}"`;
}

/** Ce que l'aperçu et serve lisent de l'agent du conteneur (signatures de @elpis/fichiers). */
export type AgentLecture = Pick<AgentClient, "stat" | "read">;

/** `_rel_editeur` : chemin relatif au bac, sans lire le disque (`~` y est un nom, un non-texte lu par `str()`) ; hors du bac : 403. */
export function relEditeur(racine: string, chemin: unknown): string {
  try {
    return lexicalRel(racine, chemin === null || chemin === undefined ? "" : strPy(chemin), { tilde: false });
  } catch (e) {
    if (e instanceof ErreurCheminBac) throw new HttpError(403, "Access denied");
    throw e;
  }
}

/** `(e,) = await agent.stat([rel])` : une entrée exactement, sinon panne (ValueError de Python) ; avec `libelle` (`_stat_un`), refus sous ce libellé, entrée en erreur comprise. */
export async function statUn(agent: AgentLecture, rel: string, libelle?: string): Promise<Dict> {
  const entrees = await parAgent(agent, libelle ?? "Lecture", (a) => a.stat([rel]));
  const e = entrees[0];
  if (entrees.length !== 1 || e === undefined)
    throw new Error(`stat de l'agent : ${entrees.length} entrée(s) pour une demandée`);
  if (libelle !== undefined && getPy(e, "kind") === "error")
    throw agentHttp(new AgentError(strPy(getPy(e, "error") || "io_error"), ""), libelle);
  return e;
}

/** `_fichier_agent` : `[agent, rel, entrée]` du fichier, ou `null` (absent, hors du bac, pas un fichier : même « introuvable », sans oracle) ; l'agent n'est demandé qu'après le contrôle du chemin. */
export async function fichierAgent(
  racine: string,
  obtenirAgent: () => Promise<AgentLecture>,
  chemin: string,
): Promise<[AgentLecture, string, Dict] | null> {
  let rel: string;
  try {
    rel = relEditeur(racine, chemin);
  } catch (e) {
    if (e instanceof HttpError) return null;
    throw e;
  }
  const agent = await obtenirAgent();
  const e = await statUn(agent, rel);
  return getPy(e, "kind") === "file" ? [agent, rel, e] : null;
}

/** `_security_headers` : `nosniff` partout, origine opaque pour tout type qu'un navigateur exécute, tout `*+xml` compris (écart : /etc/mime.types en donne des dizaines que le Python laisse actifs). */
export function entetesSecurite(entetes: Record<string, string>, mediaType: string): void {
  entetes["x-content-type-options"] = "nosniff";
  const type = lowerPy(stripPy(mediaType.split(";")[0] ?? ""));
  if (TYPES_ACTIFS.has(type) || type.endsWith("+xml")) entetes["content-security-policy"] = PREVIEW_CSP;
}

/** `media_type` de Starlette : `; charset=utf-8` ajouté à un type `text/*` qui n'en a pas. */
export function typeAvecCharset(mediaType: string): string {
  return mediaType.startsWith("text/") && !mediaType.toLowerCase().includes("charset=")
    ? `${mediaType}; charset=utf-8`
    : mediaType;
}

function entierPy(v: unknown): number | bigint {
  return (typeof v === "number" && Number.isInteger(v)) || typeof v === "bigint" ? v : 0;
}

async function* blocs(
  agent: AgentLecture,
  rel: string,
  premier: Buffer,
  depuis: number,
  fin: number,
  version: OptionsVersion,
): AsyncGenerator<Buffer> {
  yield premier;
  let pos = depuis;
  while (pos < fin) {
    const n = Math.min(BLOC_REPONSE, fin - pos);
    const r = await agent.read(rel, { offset: pos, length: n, maxBytes: n, ...version });
    if (r.data.length === 0) return;
    yield r.data;
    pos += r.data.length;
  }
}

/** `_reponse_agent` : fichier lu par blocs sur une seule version (ETag, 304, une plage, 206/416, `If-Range`) ; changé avant l'envoi : repris une fois (encore changé : 503) ; `completer` ajoute des en-têtes d'après la version servie. */
export async function reponseAgent(
  requete: FastifyRequest,
  reponse: FastifyReply,
  agent: AgentLecture,
  rel: string,
  entree: Dict,
  mediaType: string,
  completer: (servie: Dict) => Record<string, string> = () => ({}),
): Promise<FastifyReply> {
  let e = entree;
  for (const essai of [1, 2]) {
    const taille = Number(entierPy(getPy(e, "size", 0)));
    const ns = entierPy(getPy(e, "mtime_ns", 0));
    const brutIno = getPy(e, "ino");
    const ino =
      (typeof brutIno === "number" && Number.isInteger(brutIno)) || typeof brutIno === "bigint"
        ? brutIno
        : null;
    const version: OptionsVersion = {
      expectSize: taille,
      expectMtimeNs: ns,
      ...(ino !== null ? { expectIno: ino } : {}),
    };
    const etag = etagAgent(taille, ns, ino);
    const entetes: Record<string, string> = {
      etag,
      "last-modified": dateHttp(mtimeS(ns)),
      "accept-ranges": "bytes",
      "cache-control": "no-cache, must-revalidate",
    };
    entetesSecurite(entetes, mediaType);
    const siAucun = (premierEntete(requete, "if-none-match") ?? "").split(",").map(stripPy);
    if (siAucun.includes(etag))
      return reponse
        .code(304)
        .headers({ ...entetes, ...completer(e) })
        .send();
    let [debut, fin, statut] = [0, taille, 200];
    const siPlage = premierEntete(requete, "if-range");
    if (siPlage === undefined || siPlage === etag) {
      const p = plage(premierEntete(requete, "range"), taille);
      if (p === "invalide")
        return reponse
          .code(416)
          .headers({ ...entetes, "content-range": `bytes */${taille}`, ...completer(e) })
          .send();
      if (p) {
        [debut, fin, statut] = [p[0], p[1], 206];
        entetes["content-range"] = `bytes ${debut}-${fin - 1}/${taille}`;
      }
    }
    entetes["content-length"] = String(fin - debut);
    let premier: Buffer;
    try {
      const n = Math.min(BLOC_REPONSE, fin - debut);
      premier =
        n > 0
          ? (await agent.read(rel, { offset: debut, length: n, maxBytes: n, ...version })).data
          : Buffer.alloc(0);
    } catch (ex) {
      if (!estErreurAgent(ex)) throw ex;
      if (ex.code !== "changed") throw agentHttp(ex, "Lecture");
      if (essai === 2) break;
      e = await statUn(agent, rel);
      if (getPy(e, "kind") !== "file") throw new HttpError(404, "Not found");
      continue;
    }
    const flux = Readable.from(blocs(agent, rel, premier, debut + premier.length, fin, version), {
      objectMode: false,
    });
    return reponse
      .code(statut)
      .headers({ ...entetes, "content-type": typeAvecCharset(mediaType), ...completer(e) })
      .send(flux);
  }
  throw new HttpError(503, "Fichier en cours de modification — réessayez.", { "retry-after": "1" });
}
