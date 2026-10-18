// SPDX-License-Identifier: MIT
/** packages/http/src/reponse-fichier.ts — `FileResponse` de Starlette 1.0 : en-têtes de stat (taille, date, ETag), Content-Disposition, plages d'octets (206, multipart, 400, 416) et If-Range. */
import { createHash, randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";

import { ErreurPython, intPy, lowerPy, quotePy, reprFlottant, stripPy } from "@elpis/commun";
import type { FastifyReply, FastifyRequest } from "fastify";

const JOURS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MOIS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MILLIARD = 1_000_000_000n;

export type OptionsFichier = {
  mediaType: string;
  filename?: string | null;
  contentDispositionType?: string;
  headers?: Readonly<Record<string, string>>;
};

/** `MalformedRangeHeader` : réponse 400 en texte. */
export class PlageMalformee extends Error {
  readonly contenu: string;

  constructor(contenu = "Malformed range header.") {
    super(contenu);
    this.contenu = contenu;
  }
}

/** `RangeNotSatisfiable` : réponse 416 avec `Content-Range` (octets, taille du fichier). */
export class PlageInsatisfiable extends Error {
  readonly taille: number;

  constructor(taille: number) {
    super(`bytes */${taille}`);
    this.taille = taille;
  }
}

/** `st_mtime` de Python : `sec + nsec * 1e-9` en double. */
export function mtimePy(mtimeNs: bigint): number {
  let sec = mtimeNs / MILLIARD;
  let nsec = mtimeNs % MILLIARD;
  if (nsec < 0n) [sec, nsec] = [sec - 1n, nsec + MILLIARD];
  return Number(sec) + Number(nsec) * 1e-9;
}

/** `round()` de C (demi loin de zéro) puis demi au pair, comme `_PyTime_ROUND_HALF_EVEN`. */
function arrondiDemiPair(x: number): number {
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return Math.abs(x - r) === 0.5 ? 2.0 * Math.sign(x / 2) * Math.round(Math.abs(x / 2)) : r;
}

/** `email.utils.formatdate(t, usegmt=True)` : secondes de `datetime.fromtimestamp` (microsecondes arrondies au pair). */
export function formatdateGmt(t: number): string {
  let ip = Math.trunc(t);
  const fp = arrondiDemiPair((t - ip) * 1e6);
  if (fp >= 1e6) ip += 1;
  else if (fp < 0) ip -= 1;
  const d = new Date(ip * 1000);
  const deux = (n: number): string => String(n).padStart(2, "0");
  return (
    `${JOURS[d.getUTCDay()]}, ${deux(d.getUTCDate())} ${MOIS[d.getUTCMonth()]} ` +
    `${String(d.getUTCFullYear()).padStart(4, "0")} ${deux(d.getUTCHours())}:${deux(d.getUTCMinutes())}:` +
    `${deux(d.getUTCSeconds())} GMT`
  );
}

/** `set_stat_headers` : taille, date de modification et ETag (`md5("<st_mtime>-<st_size>")`). */
export function entetesStat(
  mtimeNs: bigint,
  taille: bigint | number,
): { "content-length": string; "last-modified": string; etag: string } {
  const mtime = mtimePy(mtimeNs);
  const base = `${reprFlottant(mtime)}-${String(taille)}`;
  return {
    "content-length": String(taille),
    "last-modified": formatdateGmt(mtime),
    etag: `"${createHash("md5").update(base, "utf-8").digest("hex")}"`,
  };
}

/** `Content-Disposition` : `filename="…"` si `quote()` ne change rien, sinon `filename*=utf-8''…`. */
export function contentDisposition(filename: string, type = "attachment"): string {
  const cite = quotePy(filename);
  return cite !== filename ? `${type}; filename*=utf-8''${cite}` : `${type}; filename="${filename}"`;
}

/** `int()` d'un morceau de plage ; ValueError → `null`. */
function entierPlage(texte: string): number | null {
  try {
    return intPy(texte);
  } catch (e) {
    if (e instanceof ErreurPython && e.type === "ValueError") return null;
    throw e;
  }
}

function plages(texte: string, taille: number): [number, number][] {
  const out: [number, number][] = [];
  for (const brut of texte.split(",")) {
    const part = stripPy(brut);
    if (!part || part === "-" || !part.includes("-")) continue;
    const tiret = part.indexOf("-");
    const [debutTexte, finTexte] = [stripPy(part.slice(0, tiret)), stripPy(part.slice(tiret + 1))];
    const debut = debutTexte ? entierPlage(debutTexte) : finTexte ? entierPlage(finTexte) : null;
    if (debut === null) continue;
    const start = debutTexte ? debut : taille - debut;
    let end = taille;
    if (debutTexte && finTexte) {
      const fin = entierPlage(finTexte);
      if (fin === null) continue;
      if (fin < taille) end = fin + 1;
    }
    out.push([start, end]);
  }
  return out;
}

/** `_parse_range_header` : plages `[début, fin)` fusionnées ; `PlageMalformee` ou `PlageInsatisfiable` sinon. */
export function parseRangeHeader(httpRange: string, taille: number): [number, number][] {
  const egal = httpRange.indexOf("=");
  if (egal < 0) throw new PlageMalformee();
  if (lowerPy(stripPy(httpRange.slice(0, egal))) !== "bytes")
    throw new PlageMalformee("Only support bytes range");
  const ranges = plages(httpRange.slice(egal + 1), taille);
  if (ranges.length === 0) throw new PlageMalformee("Range header: range must be requested");
  if (ranges.some(([s]) => !(0 <= s && s < taille))) throw new PlageInsatisfiable(taille);
  if (ranges.some(([s, e]) => s > e)) throw new PlageMalformee("Range header: start must be less than end");
  if (ranges.length === 1) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const fusion: [number, number][] = [ranges[0] as [number, number]];
  for (const [s, e] of ranges.slice(1)) {
    const dernier = fusion[fusion.length - 1] as [number, number];
    if (s <= dernier[1]) dernier[1] = Math.max(dernier[1], e);
    else fusion.push([s, e]);
  }
  return fusion;
}

/** Première valeur d'un en-tête reçu (`Headers.get` de Starlette), sans la jonction des doublons de Node. */
function entete(requete: FastifyRequest, nom: string): string | undefined {
  const brut = requete.raw.rawHeaders;
  for (let i = 0; i + 1 < brut.length; i += 2) if (brut[i]?.toLowerCase() === nom) return brut[i + 1];
  return undefined;
}

function texte(reponse: FastifyReply, statut: number, corps: string, entetes: Record<string, string> = {}) {
  return reponse.code(statut).headers(entetes).type("text/plain; charset=utf-8").send(corps);
}

async function* morceaux(
  fh: FileHandle,
  ranges: [number, number][],
  tete: (s: number, e: number) => Buffer,
  fin: Buffer,
) {
  try {
    for (const [s, e] of ranges) {
      yield tete(s, e);
      if (e > s) yield* fh.createReadStream({ start: s, end: e - 1, autoClose: false });
      yield Buffer.from("\r\n");
    }
    yield fin;
  } finally {
    await fh.close();
  }
}

/** `FileResponse(chemin, media_type, headers, filename, content_disposition_type)` envoyée sur `reponse` ; le fichier est ouvert une fois (stat et lecture sur le même descripteur). */
export async function reponseFichier(
  requete: FastifyRequest,
  reponse: FastifyReply,
  chemin: string,
  options: OptionsFichier,
): Promise<FastifyReply> {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.headers ?? {})) h[k.toLowerCase()] = v;
  if (!Object.hasOwn(h, "content-type")) {
    const t = options.mediaType;
    h["content-type"] =
      t.startsWith("text/") && !t.toLowerCase().includes("charset=") ? `${t}; charset=utf-8` : t;
  }
  h["accept-ranges"] ??= "bytes";
  if (options.filename !== undefined && options.filename !== null)
    h["content-disposition"] ??= contentDisposition(options.filename, options.contentDispositionType);
  let fh: FileHandle;
  try {
    fh = await open(chemin, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`File at path ${chemin} does not exist.`, { cause: e });
    throw e;
  }
  try {
    return await envoyer(requete, reponse, fh, h, chemin);
  } catch (e) {
    await fh.close();
    throw e;
  }
}

/** Envoi sur un descripteur ouvert : confié au flux rendu, refermé ici pour une réponse 400/416, par l'appelant si l'envoi lève. */
async function envoyer(
  requete: FastifyRequest,
  reponse: FastifyReply,
  fh: FileHandle,
  h: Record<string, string>,
  chemin: string,
): Promise<FastifyReply> {
  const s = await fh.stat({ bigint: true });
  if (!s.isFile()) throw new Error(`File at path ${chemin} is not a file.`);
  for (const [k, v] of Object.entries(entetesStat(s.mtimeNs, s.size))) h[k] ??= v;
  const taille = Number(s.size);
  const plage = entete(requete, "range");
  const siPlage = entete(requete, "if-range");
  if (
    plage === undefined ||
    (siPlage !== undefined && siPlage !== h["last-modified"] && siPlage !== h["etag"])
  )
    return reponse.code(200).headers(h).send(fh.createReadStream());
  let ranges: [number, number][];
  try {
    ranges = parseRangeHeader(plage, taille);
  } catch (e) {
    if (!(e instanceof PlageMalformee || e instanceof PlageInsatisfiable)) throw e;
    await fh.close();
    if (e instanceof PlageMalformee) return texte(reponse, 400, e.contenu);
    return texte(reponse, 416, "", { "content-range": `bytes */${e.taille}` });
  }
  if (ranges.length === 1) {
    const [debut, fin] = ranges[0] as [number, number];
    h["content-range"] = `bytes ${debut}-${fin - 1}/${taille}`;
    h["content-length"] = String(fin - debut);
    if (fin <= debut) {
      await fh.close();
      return reponse.code(206).headers(h).send(Buffer.alloc(0));
    }
    return reponse
      .code(206)
      .headers(h)
      .send(fh.createReadStream({ start: debut, end: fin - 1 }));
  }
  const borne = randomBytes(13).toString("hex");
  const type = h["content-type"] ?? "";
  const statique = 49 + borne.length + type.length + String(taille).length;
  const longueur =
    ranges.reduce((n, [a, b]) => n + String(a).length + String(b - 1).length + statique + (b - a), 0) +
    4 +
    borne.length;
  const tete = (a: number, b: number): Buffer =>
    Buffer.from(
      `--${borne}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${a}-${b - 1}/${taille}\r\n\r\n`,
      "latin1",
    );
  h["content-type"] = `multipart/byteranges; boundary=${borne}`;
  h["content-length"] = String(longueur);
  return reponse
    .code(206)
    .headers(h)
    .send(Readable.from(morceaux(fh, ranges, tete, Buffer.from(`--${borne}--`, "latin1"))));
}
