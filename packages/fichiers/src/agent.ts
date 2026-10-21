// SPDX-License-Identifier: MIT
/** packages/fichiers/src/agent.ts — client de l'agent d'UN bac à sable (sandbox/agent_client.py) : HTTP sur `<P>/.elpis-agent/agent.sock` saisi sans suivre de lien, démarrage à la demande, version vérifiée, réponses bornées et tenues pour non fiables. */
import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import path from "node:path";
import { setTimeout as dormir } from "node:timers/promises";

import { AGENT_RUN_DIR, agentDir, RELAY_DIR } from "@elpis/bac";
import type {
  AgentBac,
  ArchiveAgent,
  BacPourAgent,
  DonneesEnvoi,
  ErreurAgent,
  EtatBac,
  OptionsArchive,
  OptionsExtraction,
} from "@elpis/bac";
import {
  estDict,
  fixePy,
  getPy,
  intPy,
  journalDe,
  pyJoin,
  pyJsonDumps,
  pyJsonLoads,
  pyParent,
  pyPath,
  rstripPy,
  strPy,
  texteJsonPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { O_PATH } from "@elpis/securite";
import { Client } from "undici";
import type { Dispatcher } from "undici";

/** Délais (secondes) ; réglables par les tests. */
export const reglagesAgent = {
  demarrageS: 10.0,
  /** Démarrage raté : mémorisé. */
  echecS: 30.0,
  /** `hello`, lecture comprise. */
  sondeS: 2.0,
  /** Une opération, flux compris. */
  delaiTotalS: 600.0,
  /** Silence toléré en lisant une réponse. */
  attenteS: 60.0,
  /** Extraction d'un /work entier. */
  delaiArchiveS: 3600.0,
  /** Archive relayée en flux (téléchargement, export). */
  delaiFluxS: 6 * 3600.0,
};

export const PETIT = 1 << 16;
export const TRAME_D = 1 << 22;
export const TRAME_J = 1 << 18;
export const LIGNE_MAX = 1 << 15;
const O_CLOEXEC = 0o2000000;
const EN_TETES: Readonly<Record<string, string>> = { "accept-encoding": "identity" };
const PASSIF: Readonly<Record<string, string>> = { "x-elpis-passive": "1" };

/** Refus ou panne de l'agent : `code` stable, `status` HTTP (0 = transport), données du refus. */
export class AgentError extends Error implements ErreurAgent {
  override readonly name = "AgentError" as const;
  readonly code: string;
  readonly status: number;
  readonly data: Dict;

  constructor(code: string, message = "", status = 0, data: Dict | null = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data ?? {};
  }

  /** `str(AgentError)` de Python. */
  override toString(): string {
    return this.message ? `${this.code}: ${this.message}` : this.code;
  }
}

class Absent extends Error {}

class DelaiDepasse extends Error {}

export interface AgentRead {
  readonly data: Buffer;
  readonly stat: Dict;
}

export interface AgentListing {
  readonly entries: Dict[];
  readonly truncated: boolean;
  readonly errors: number;
}

/** Résultat de `git` par l'agent (`returncode`, `stdout`, `stderr`, `truncated`, `timed_out`, `duration_ms`). */
export interface ResultatGitAgent {
  returncode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timed_out: boolean;
  duration_ms: number;
}

/** `s[:n]` de Python (points de code). */
export function tronquerPy(s: string, n: number): string {
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join("");
}

let versionSurchargee: string | null = null;
let versionLue: { dossier: string; version: string } | null = null;

/** `_VERSION_ATTENDUE` : empreinte (16 hex) de `server.py`, lue une fois ; `""` si illisible. */
export function versionAttendue(): string {
  if (versionSurchargee !== null) return versionSurchargee;
  const dossier = agentDir();
  if (versionLue?.dossier !== dossier) {
    let version = "";
    try {
      version = createHash("sha256")
        .update(readFileSync(path.join(dossier, "server.py")))
        .digest("hex")
        .slice(0, 16);
    } catch (e) {
      journalDe("sandbox").error(`[agent] ${dossier}/server.py illisible : ${String(e)}`);
    }
    versionLue = { dossier, version };
  }
  return versionLue.version;
}

/** Tests : version attendue imposée ; `null` revient à l'empreinte de `server.py`. */
export function surchargerVersionAttendue(v: string | null): void {
  versionSurchargee = v;
}

/** `_rel_sous` : chemin rendu par l'agent relatif, normalisé, sous `base`. */
export function relSous(p: unknown, base: string): boolean {
  if (typeof p !== "string" || !p || p.includes("\0") || p.startsWith("/")) return false;
  if (p.split("/").some((c) => c === "" || c === "." || c === "..")) return false;
  return !base || p.startsWith(rstripPy(base, "/") + "/");
}

/** `_objet` : objet JSON (entiers exacts), sinon `null`. */
export function objetJson(brut: Uint8Array): Dict | null {
  try {
    const d = pyJsonLoads(texteJsonPy(brut));
    return estDict(d) ? d : null;
  } catch {
    return null;
  }
}

/** `_chemin` : un chemin passé à l'agent est de l'UTF-8 (l'agent refuse le reste). */
function chemin(p: string): string {
  if (!p.isWellFormed()) throw new AgentError("bad_path", "chemin non UTF-8");
  return p;
}

function estEntierPy(v: unknown): v is number | bigint {
  return (typeof v === "number" && Number.isInteger(v)) || typeof v === "bigint";
}

/** `_entier_borne` : entier (pas un booléen) dans `[mini, maxi]`. */
function entierBorne(v: unknown, mini: bigint, maxi: bigint): number | bigint {
  if (!estEntierPy(v)) throw new AgentError("bad_response", "valeur d'entrée invalide");
  const b = BigInt(v);
  if (b < mini || b > maxi) throw new AgentError("bad_response", "valeur d'entrée invalide");
  return v;
}

/** `_entree_valide` : entrée `raw` de l'agent, nom relatif sous PATH_MAX, genre, taille, date et droits bornés. */
export function entreeValide(d: Dict, maxOctets: number): Dict {
  const nom = getPy(d, "entry");
  if (typeof nom !== "string" || !relSous(nom, "") || Buffer.byteLength(nom, "utf8") > 4096)
    throw new AgentError("bad_response", "nom d'entrée invalide");
  const genre = getPy(d, "kind");
  if (genre !== "file" && genre !== "dir") throw new AgentError("bad_response", "genre d'entrée invalide");
  return {
    entry: nom,
    kind: genre,
    size: entierBorne(getPy(d, "size", 0), 0n, BigInt(maxOctets || 2 ** 50)),
    mtime_ns: entierBorne(getPy(d, "mtime_ns", 0), -(1n << 100n), 1n << 100n),
    mode: entierBorne(getPy(d, "mode", 0), 0n, 0o7777n),
  };
}

/** `_bilan` : bilan de fin d'archive, champs utiles seulement, formes vérifiées. */
export function bilanArchive(d: Dict): Dict {
  const omis = getPy(d, "skipped");
  const propres: Dict[] = [];
  if (Array.isArray(omis)) {
    for (const o of omis.slice(0, 1000)) {
      if (!estDict(o)) continue;
      propres.push({
        path: tronquerPy(strPy(veritePy(getPy(o, "path")) ? getPy(o, "path") : ""), 4096),
        error: tronquerPy(strPy(veritePy(getPy(o, "error")) ? getPy(o, "error") : ""), 64),
      });
    }
  }
  const rendu: Dict = { done: true, skipped: propres, truncated: getPy(d, "truncated") === true };
  for (const cle of ["files", "dirs", "bytes", "omitted"]) {
    const v = getPy(d, cle);
    rendu[cle] = estEntierPy(v) && v >= 0 ? v : 0;
  }
  return rendu;
}

const decalagesParJour = new Map<number, [number | null, number][]>();

/** `tm_gmtoff` de l'heure locale à l'instant `t` (secondes). */
function decalage(t: number): number {
  return Math.round(-new Date(t * 1000).getTimezoneOffset() * 60);
}

/** Décalages de l'heure locale entre `debut` et `fin` : `[[borne, secondes], …]`, le dernier sans borne, 256 au plus. */
export function decalagesEntre(debut: number, fin: number): [number | null, number][] {
  let t = debut;
  let cur = decalage(t);
  const rendu: [number | null, number][] = [];
  while (t < fin) {
    const suivant = Math.min(t + 86400, fin);
    if (decalage(suivant) !== cur) {
      let bas = t;
      let haut = suivant;
      while (haut - bas > 1) {
        const milieu = Math.floor((bas + haut) / 2);
        if (decalage(milieu) === cur) bas = milieu;
        else haut = milieu;
      }
      rendu.push([Math.trunc(haut), cur]);
      cur = decalage(suivant);
    }
    t = suivant;
  }
  rendu.push([null, cur]);
  return rendu.slice(-256);
}

/** `_decalages_hote` : de 1980 (début des dates zip) à deux ans d'ici, recalculé une fois par jour. */
export function decalagesHote(): [number | null, number][] {
  const maintenant = Date.now() / 1000;
  const jour = Math.floor(maintenant / 86400);
  const connu = decalagesParJour.get(jour);
  if (connu !== undefined) return connu;
  const rendu = decalagesEntre(315532800, maintenant + 2 * 365 * 86400);
  decalagesParJour.clear();
  decalagesParJour.set(jour, rendu);
  return rendu;
}

/** `_lignes` : objets d'un flux NDJSON, lignes et total bornés, signes de vie (`{"tick"}`) ignorés. */
export async function* lignesNdjson(
  blocs: AsyncIterable<Uint8Array>,
  maxi: number,
  ligneMax = LIGNE_MAX,
): AsyncGenerator<Dict> {
  let tampon = Buffer.alloc(0);
  let total = 0;
  for await (const b of blocs) {
    total += b.length;
    if (total > maxi) throw new AgentError("too_large", `réponse de plus de ${maxi} octets`);
    const depuis = tampon.length;
    tampon = tampon.length ? Buffer.concat([tampon, b]) : Buffer.from(b);
    let debut = 0;
    let i = tampon.indexOf(0x0a, depuis);
    while (i >= 0) {
      if (i - debut > ligneMax) throw new AgentError("bad_response", "ligne NDJSON trop longue");
      const ligne = tampon.subarray(debut, i);
      debut = i + 1;
      if (ligne.toString("latin1").trim()) {
        const obj = objetJson(ligne);
        if (obj === null) throw new AgentError("bad_response", "ligne NDJSON invalide");
        if (!Object.hasOwn(obj, "tick")) yield obj;
      }
      i = tampon.indexOf(0x0a, debut);
    }
    if (debut) tampon = tampon.subarray(debut);
    if (tampon.length > ligneMax) throw new AgentError("bad_response", "ligne NDJSON trop longue");
  }
}

/** `_trames` : trames `[genre, corps]` d'une archive : `D` (octets, `maxi` en tout) ou `J` (objet JSON), chacune bornée. */
export async function* tramesArchive(
  blocs: AsyncIterable<Uint8Array>,
  maxi: number,
): AsyncGenerator<[string, Buffer]> {
  let tampon = Buffer.alloc(0);
  let donnees = 0;
  for await (const b of blocs) {
    tampon = tampon.length ? Buffer.concat([tampon, b]) : Buffer.from(b);
    let debut = 0;
    while (tampon.length - debut >= 5) {
      const genre = tampon.subarray(debut, debut + 1).toString("latin1");
      const n = tampon.readUInt32BE(debut + 1);
      if (n > (genre === "D" ? TRAME_D : genre === "J" ? TRAME_J : -1))
        throw new AgentError("bad_response", "trame invalide");
      if (tampon.length - debut < 5 + n) break;
      const corps = Buffer.from(tampon.subarray(debut + 5, debut + 5 + n));
      debut += 5 + n;
      if (genre === "D") {
        donnees += n;
        if (donnees > maxi) throw new AgentError("too_large", `archive de plus de ${maxi} octets`);
      }
      yield [genre, corps];
    }
    if (debut) tampon = tampon.subarray(debut);
    if (tampon.length > TRAME_D + 5) throw new AgentError("bad_response", "trame trop longue");
  }
  if (tampon.length) throw new AgentError("bad_response", "trame tronquée");
}

/** `AgentArchive` : `debut` (plan), puis octets de l'archive ou objets (`progress`, `entry` en `raw`) ; `fin` (bilan) une fois tout lu. */
class ArchiveEnFlux implements ArchiveAgent {
  debut: Dict = {};
  fin: Dict | null = null;
  private readonly iterateur: AsyncIterator<[string, Buffer]>;
  private readonly maxEntrees: number;
  private readonly maxOctets: number;
  private readonly fermeture: () => Promise<void>;

  constructor(
    trames: AsyncIterable<[string, Buffer]>,
    maxEntrees: number,
    maxOctets: number,
    fermeture: () => Promise<void>,
  ) {
    this.iterateur = trames[Symbol.asyncIterator]();
    this.maxEntrees = maxEntrees;
    this.maxOctets = maxOctets;
    this.fermeture = fermeture;
  }

  async ouvrir(): Promise<void> {
    const r = await this.iterateur.next();
    const [genre, corps] = r.done ? ["", Buffer.alloc(0)] : r.value;
    const d = genre === "J" ? objetJson(corps) : null;
    if (d === null || !veritePy(getPy(d, "start")))
      throw new AgentError("bad_response", "début d'archive attendu");
    this.debut = d;
  }

  fermer(): Promise<void> {
    return this.fermeture();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer | Dict> {
    let entrees = 0;
    let jsonTotal = 0;
    let reste: number | null = null;
    const maxJson = (this.maxEntrees || 20000) * 1024 + (64 << 20);
    for (let r = await this.iterateur.next(); !r.done; r = await this.iterateur.next()) {
      const [genre, corps] = r.value;
      if (genre === "D") {
        if (reste !== null) {
          reste -= corps.length;
          if (reste < 0) throw new AgentError("bad_response", "plus d'octets que la taille annoncée");
        }
        yield corps;
        continue;
      }
      jsonTotal += corps.length;
      if (jsonTotal > maxJson) throw new AgentError("bad_response", "trop de trames JSON");
      let d = objetJson(corps);
      if (d === null) throw new AgentError("bad_response", "trame JSON invalide");
      if (Object.hasOwn(d, "error"))
        throw new AgentError(
          tronquerPy(strPy(d["error"]), 64),
          tronquerPy(strPy(veritePy(d["message"]) ? d["message"] : ""), 500),
        );
      if (veritePy(getPy(d, "done"))) {
        this.fin = bilanArchive(d);
        return;
      }
      if (Object.hasOwn(d, "entry")) {
        entrees++;
        if (this.maxEntrees && entrees > this.maxEntrees)
          throw new AgentError("bad_response", "plus d'entrées que demandé");
        d = entreeValide(d, this.maxOctets);
        reste = d["kind"] === "file" ? Number(d["size"]) : null;
      }
      yield d;
    }
    throw new AgentError("bad_response", "archive interrompue");
  }
}

interface Connexion {
  readonly client: Client;
  fermer(): Promise<void>;
}

/** Socket saisi sans suivre de lien (`O_PATH|O_NOFOLLOW`), vérifié (`S_ISSOCK`) et joint par /proc/self/fd/N. */
function connexion(socket: string, attenteS: number): Connexion {
  let fd: number;
  try {
    fd = openSync(socket, O_PATH | constants.O_NOFOLLOW | O_CLOEXEC);
  } catch {
    throw new Absent();
  }
  let estSocket: boolean;
  try {
    estSocket = fstatSync(fd).isSocket();
  } catch {
    estSocket = false;
  }
  if (!estSocket) {
    closeSync(fd);
    throw new Absent();
  }
  const client = new Client("http://agent", {
    socketPath: `/proc/self/fd/${fd}`,
    connect: { timeout: 5_000 },
    headersTimeout: attenteS * 1000,
    bodyTimeout: attenteS * 1000,
    keepAliveTimeout: 1_000,
  });
  let ouvert = true;
  return {
    client,
    async fermer() {
      if (!ouvert) return;
      ouvert = false;
      try {
        await client.destroy();
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** Erreur de connexion (requête pas envoyée) : `httpx.ConnectError`. */
function estErreurConnexion(e: unknown): boolean {
  const x = e as { syscall?: unknown; code?: unknown } | null;
  return x?.syscall === "connect" || x?.code === "ECONNREFUSED" || x?.code === "ENOENT";
}

/** Nom httpx d'un délai (`ConnectTimeout`, `ReadTimeout`), `null` si ce n'en est pas un. */
function nomDelai(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "UND_ERR_CONNECT_TIMEOUT") return "ConnectTimeout";
  if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return "ReadTimeout";
  return null;
}

function nomTransport(e: unknown): string {
  if (estErreurConnexion(e)) return "ConnectError";
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "UND_ERR_SOCKET" || code === "ECONNRESET" || code === "EPIPE") return "ReadError";
  return "RemoteProtocolError";
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Abandonne un corps de réponse sans lever d'erreur non captée. */
export function jeterCorps(corps: { on(e: "error", f: () => void): unknown; destroy(): unknown }): void {
  corps.on("error", () => undefined);
  corps.destroy();
}

/** `_borne` : corps entier, jamais plus de `maxi` octets. */
export async function lireBorne(blocs: AsyncIterable<Uint8Array>, maxi: number): Promise<Buffer> {
  const morceaux: Buffer[] = [];
  let n = 0;
  for await (const b of blocs) {
    n += b.length;
    if (n > maxi) throw new AgentError("too_large", `réponse de plus de ${maxi} octets`);
    morceaux.push(Buffer.from(b));
  }
  return Buffer.concat(morceaux);
}

/** Corps prêt à envoyer : taille annoncée (Content-Length) et source rejouable une fois. */
interface CorpsPret {
  readonly taille: number;
  corps(): Buffer | Readable;
  nettoyer(): Promise<void>;
}

async function* parBlocs(
  source: AsyncIterable<Uint8Array>,
  taille: number,
  rapport?: (n: number) => void,
): AsyncGenerator<Buffer> {
  let reste = taille;
  for await (const brut of source) {
    if (reste <= 0) return;
    const b = Buffer.from(brut.subarray(0, reste));
    reste -= b.length;
    rapport?.(b.length);
    yield b;
  }
}

function estFichierEnvoi(d: DonneesEnvoi): d is { readonly chemin: string; readonly debut?: number } {
  return typeof d === "object" && "chemin" in d && typeof d.chemin === "string";
}

function estFluxEnvoi(
  d: DonneesEnvoi,
): d is { readonly flux: AsyncIterable<Uint8Array>; readonly taille: number } {
  return typeof d === "object" && "flux" in d && "taille" in d;
}

/** `_corps_envoi` : octets tels quels, fichier lu par blocs de 1 Mio depuis `debut`, flux de taille connue, ou flux nu recopié dans un temporaire 0600. */
async function corpsEnvoi(d: DonneesEnvoi, rapport?: (n: number) => void): Promise<CorpsPret> {
  if (d instanceof Uint8Array) {
    const b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
    rapport?.(b.length);
    return { taille: b.length, corps: () => b, nettoyer: async () => undefined };
  }
  if (estFichierEnvoi(d)) {
    const debut = d.debut ?? 0;
    const taille = Math.max(0, statSync(d.chemin).size - debut);
    return {
      taille,
      corps: () =>
        taille === 0
          ? Buffer.alloc(0)
          : Readable.from(
              parBlocs(createReadStream(d.chemin, { start: debut, highWaterMark: 1 << 20 }), taille, rapport),
            ),
      nettoyer: async () => undefined,
    };
  }
  if (estFluxEnvoi(d)) {
    const flux = Readable.from(parBlocs(d.flux, d.taille, rapport));
    return { taille: d.taille, corps: () => flux, nettoyer: async () => undefined };
  }
  const dossier = await mkdtemp(path.join(tmpdir(), "elpis-envoi-"));
  const fichier = path.join(dossier, "corps");
  try {
    const h = await open(fichier, "wx", 0o600);
    try {
      for await (const b of d) await h.write(b);
    } finally {
      await h.close();
    }
  } catch (e) {
    await rm(dossier, { recursive: true, force: true });
    throw e;
  }
  const pret = await corpsEnvoi({ chemin: fichier }, rapport);
  return { ...pret, nettoyer: () => rm(dossier, { recursive: true, force: true }) };
}

/** `_refus` : réponse ≥ 400 traduite en `AgentError` (code, message et données bornés). */
async function refus(statut: number, corps: AsyncIterable<Uint8Array>): Promise<never> {
  let brut: Buffer = Buffer.alloc(0);
  try {
    brut = await lireBorne(corps, PETIT);
  } catch (e) {
    if (!(e instanceof AgentError)) throw e;
  }
  const d = objetJson(brut) ?? {};
  throw new AgentError(
    tronquerPy(strPy(veritePy(d["error"]) ? d["error"] : `http_${statut}`), 64),
    tronquerPy(strPy(veritePy(d["message"]) ? d["message"] : ""), 500),
    statut,
    d,
  );
}

/** Verrou asynchrone (un démarrage d'agent à la fois). */
class Verrou {
  private queue: Promise<void> = Promise.resolve();

  async avec<T>(f: () => Promise<T>): Promise<T> {
    const avant = this.queue;
    let liberer = (): void => undefined;
    this.queue = new Promise<void>((ok) => {
      liberer = ok;
    });
    await avant;
    try {
      return await f();
    } finally {
      liberer();
    }
  }
}

interface OptionsFlux {
  readonly passif?: boolean;
  readonly delaiS?: number;
  readonly sansActivite?: boolean;
  readonly attenteS?: number;
  readonly params?: Record<string, string | number | bigint>;
  readonly json?: unknown;
  readonly corps?: CorpsPret;
}

/** Réponse ouverte : en-têtes lus, corps à lire dans la borne totale de l'opération, `fermer()` en `finally`. */
interface FluxOuvert {
  readonly entetes: Dispatcher.ResponseData["headers"];
  corps(): AsyncGenerator<Buffer>;
  fermer(): Promise<void>;
}

function versBuffer(b: unknown): Buffer {
  return Buffer.isBuffer(b) ? b : Buffer.from(b as Uint8Array);
}

/** Lecture du corps, ses erreurs traduites comme celles de l'envoi. */
async function* lectureTraduite(
  corps: AsyncIterable<unknown>,
  traduire: (e: unknown) => AgentError,
): AsyncGenerator<Buffer> {
  try {
    for await (const b of corps) yield versBuffer(b);
  } catch (e) {
    if (e instanceof AgentError) throw e;
    throw traduire(e);
  }
}

/** Échec de `promesse` quand `signal` s'abaisse (l'attente seule est abandonnée, comme une annulation asyncio). */
function course<T>(promesse: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DelaiDepasse());
  return new Promise<T>((ok, ko) => {
    const surArret = (): void => ko(new DelaiDepasse());
    signal.addEventListener("abort", surArret, { once: true });
    promesse.then(
      (v) => {
        signal.removeEventListener("abort", surArret);
        ok(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", surArret);
        ko(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function requete(route: string, params?: Record<string, string | number | bigint>): string {
  if (!params) return route;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  return `${route}?${q.toString()}`;
}

/** L'agent d'UN bac à sable ; `bac` : `sandboxPath` (`P/work`), `status`, `ensureRunning`, `startAgent` (UserSandbox). */
export class AgentClient implements AgentBac {
  readonly socketPath: string;
  private versionOk = false;
  private relance = false;
  private echecJusqua = 0;
  private echecCause = "";
  private readonly verrou = new Verrou();
  private readonly bac: BacPourAgent;

  constructor(bac: BacPourAgent) {
    this.bac = bac;
    this.socketPath = pyJoin(pyJoin(pyParent(pyPath(bac.sandboxPath)), AGENT_RUN_DIR), "agent.sock");
  }

  get sandbox(): BacPourAgent {
    return this.bac;
  }

  /** Dossier du relais Git de l'hôte (`RELAY_DIR`, frère des comptes), monté sur `RELAY_MOUNT`. */
  get relayDir(): string {
    return pyJoin(pyParent(pyParent(pyPath(this.bac.sandboxPath))), RELAY_DIR);
  }

  hello(): Promise<Dict> {
    return this.json("GET", "/v1/hello", PETIT);
  }

  async stat(
    paths: Iterable<string>,
    o: { hash?: boolean; hashMax?: number; passive?: boolean } = {},
  ): Promise<Dict[]> {
    const chemins = [...paths];
    const maxi = PETIT + chemins.reduce((n, c) => n + 6 * Array.from(c).length + 512, 0);
    const d = await this.json("POST", "/v1/stat", maxi, {
      passif: o.passive ?? false,
      json: { paths: chemins, hash: o.hash ?? false, hash_max: o.hashMax ?? 64 << 20 },
    });
    const entrees = getPy(d, "entries");
    return Array.isArray(entrees) ? [...(entrees as Dict[])] : [];
  }

  /** `expect*` : la version lue (taille, mtime, inode) doit être celle-là, sinon `changed`. */
  async read(
    p: string,
    o: {
      offset?: number;
      length?: number;
      maxBytes?: number;
      expectSize?: number | bigint;
      expectMtimeNs?: number | bigint;
      expectIno?: number | bigint;
    } = {},
  ): Promise<AgentRead> {
    const maxBytes = o.maxBytes ?? 64 << 20;
    const params: Record<string, string | number | bigint> = {
      path: chemin(p),
      offset: o.offset ?? 0,
      max: maxBytes,
    };
    for (const [cle, val] of [
      ["length", o.length],
      ["expect_size", o.expectSize],
      ["expect_mtime_ns", o.expectMtimeNs],
      ["expect_ino", o.expectIno],
    ] as const)
      if (val !== undefined) params[cle] = val;
    const flux = await this.ouvrir("GET", "/v1/read", { params });
    try {
      const data = await lireBorne(flux.corps(), maxBytes);
      const brut = flux.entetes["x-elpis-stat"];
      const texte = typeof brut === "string" ? Buffer.from(brut, "latin1") : Buffer.from("{}");
      return { data, stat: objetJson(texte.length ? texte : Buffer.from("{}")) ?? {} };
    } finally {
      await flux.fermer();
    }
  }

  /** `kinds`, `nameGlob`, `nameContains` : seules ces entrées sont rendues (et comptées) ; tout est parcouru. */
  async list(
    p = "",
    o: {
      depth?: number;
      maxEntries?: number;
      hidden?: boolean;
      prune?: Iterable<string>;
      exclude?: Iterable<string>;
      deadlineS?: number;
      nameContains?: string;
      kinds?: Iterable<string>;
      nameGlob?: string;
      passive?: boolean;
    } = {},
  ): Promise<AgentListing> {
    const maxEntries = o.maxEntries ?? 20000;
    const entries: Dict[] = [];
    const flux = await this.ouvrir("POST", "/v1/list", {
      passif: o.passive ?? false,
      json: {
        path: p,
        depth: o.depth ?? 1,
        max_entries: maxEntries,
        hidden: o.hidden ?? true,
        prune: [...(o.prune ?? [])],
        exclude: [...(o.exclude ?? [])],
        deadline_s: o.deadlineS ?? 30.0,
        name_contains: o.nameContains ?? "",
        kinds: [...(o.kinds ?? [])],
        name_glob: o.nameGlob ?? "",
      },
    });
    try {
      for await (const obj of lignesNdjson(flux.corps(), (1 << 20) + maxEntries * 1024)) {
        erreurDeFlux(obj);
        if (veritePy(getPy(obj, "done")))
          return {
            entries,
            truncated: veritePy(getPy(obj, "truncated")),
            errors: intPy(veritePy(getPy(obj, "errors")) ? getPy(obj, "errors") : 0),
          };
        if (entries.length >= maxEntries) throw new AgentError("bad_response", "plus d'entrées que demandé");
        if (!relSous(getPy(obj, "path"), p))
          throw new AgentError("bad_response", "chemin hors de la liste demandée");
        entries.push(obj);
      }
    } finally {
      await flux.fermer();
    }
    throw new AgentError("bad_response", "liste interrompue");
  }

  /** (lignes trouvées, bilan) dans les fichiers `paths` ; `filesOnly` : un `{"file"}` par fichier trouvé. */
  async grep(
    paths: Iterable<string>,
    needle: string,
    o: {
      ignoreCase?: boolean;
      maxFileBytes?: number;
      maxHits?: number;
      filesOnly?: boolean;
      width?: number;
      deadlineS?: number;
      regex?: boolean;
      context?: number;
      maxLine?: number;
    } = {},
  ): Promise<[Dict[], Dict]> {
    const chemins = [...paths];
    const demandes = new Set(chemins);
    const maxHits = o.maxHits ?? 2000;
    const width = o.width ?? 260;
    const context = o.context ?? 0;
    const maxLine = o.maxLine ?? 20000;
    const trouves: Dict[] = [];
    const flux = await this.ouvrir("POST", "/v1/grep", {
      json: {
        paths: chemins,
        needle,
        ignore_case: o.ignoreCase ?? true,
        max_file_bytes: o.maxFileBytes ?? 20 << 20,
        max_hits: maxHits,
        files_only: o.filesOnly ?? false,
        width,
        deadline_s: o.deadlineS ?? 600.0,
        regex: o.regex ?? false,
        context,
        max_line: maxLine,
      },
    });
    const ligne = (context ? Math.max(width, maxLine + 2 * context) : width) * 6 + 1024;
    try {
      for await (const obj of lignesNdjson(
        flux.corps(),
        (1 << 20) + maxHits * ligne,
        Math.max(LIGNE_MAX, ligne),
      )) {
        erreurDeFlux(obj);
        if (veritePy(getPy(obj, "done"))) return [trouves, obj];
        if (Object.hasOwn(obj, "file")) {
          if (trouves.length >= maxHits) throw new AgentError("bad_response", "plus de lignes que demandé");
          const f = obj["file"];
          if (typeof f !== "string" || !demandes.has(f))
            throw new AgentError("bad_response", "fichier non demandé");
          trouves.push(obj);
        }
      }
    } finally {
      await flux.fermer();
    }
    throw new AgentError("bad_response", "recherche interrompue");
  }

  /** {chemin: octets, ou `null` : absent, spécial, trop gros} des premiers fichiers, en un appel ; l'agent s'arrête avant `maxTotal`. */
  async readMany(
    paths: Iterable<string>,
    o: { maxFile?: number; maxTotal?: number; passive?: boolean } = {},
  ): Promise<Map<string, Buffer | null>> {
    const chemins = [...paths].map(chemin);
    const demandes = new Set(chemins);
    const maxFile = o.maxFile ?? 1 << 20;
    const maxTotal = o.maxTotal ?? 32 << 20;
    const rendu = new Map<string, Buffer | null>();
    const maxi = (1 << 20) + chemins.length * 1024 + Math.floor((maxTotal * 4) / 3);
    const flux = await this.ouvrir("POST", "/v1/readmany", {
      passif: o.passive ?? false,
      json: { paths: chemins, max_file: maxFile, max_total: maxTotal },
    });
    try {
      for await (const obj of lignesNdjson(flux.corps(), maxi, LIGNE_MAX + Math.floor((maxFile * 4) / 3))) {
        erreurDeFlux(obj);
        if (veritePy(getPy(obj, "done"))) return rendu;
        if (veritePy(getPy(obj, "started"))) continue;
        const p = getPy(obj, "path");
        if (typeof p !== "string" || !demandes.has(p) || rendu.has(p))
          throw new AgentError("bad_response", "fichier non demandé");
        const b64 = getPy(obj, "b64");
        if (typeof b64 !== "string") {
          rendu.set(p, null);
          continue;
        }
        const data = base64Strict(b64);
        if (data === null) throw new AgentError("bad_response", "base64 invalide");
        if (data.length > maxFile) throw new AgentError("bad_response", "fichier plus gros que demandé");
        rendu.set(p, data);
      }
    } finally {
      await flux.fermer();
    }
    throw new AgentError("bad_response", "lecture interrompue");
  }

  /** Écriture atomique ; préconditions vérifiées par l'agent au remplacement : `changed` / `exists` (412). */
  async write(
    p: string,
    data: DonneesEnvoi,
    o: {
      mode?: string;
      parents?: boolean;
      ifAbsent?: boolean;
      ifSha256?: string;
      ifMtimeNs?: number | bigint;
    } = {},
  ): Promise<Dict> {
    const corps = await corpsEnvoi(data);
    try {
      const params: Record<string, string | number | bigint> = { path: chemin(p), max: corps.taille };
      if (o.mode !== undefined) params["mode"] = o.mode;
      if (o.parents) params["parents"] = 1;
      if (o.ifAbsent) params["if_absent"] = 1;
      if (o.ifSha256) params["if_sha256"] = o.ifSha256;
      if (o.ifMtimeNs !== undefined) params["if_mtime_ns"] = o.ifMtimeNs;
      return await this.json("PUT", "/v1/write", PETIT, { params, corps });
    } finally {
      await corps.nettoyer();
    }
  }

  /** Relevé avant une commande : `{"id", "complete", "files"}` ; `allKinds` : liens et fichiers spéciaux aussi. */
  changesBegin(
    skip: Iterable<string>,
    o: { maxEntries?: number; deadlineS?: number; allKinds?: boolean } = {},
  ): Promise<Dict> {
    return this.json("POST", "/v1/changes/begin", PETIT, {
      json: {
        skip: [...skip],
        max_entries: o.maxEntries ?? 20000,
        deadline_s: o.deadlineS ?? 1.5,
        ...(o.allKinds ? { all_kinds: true } : {}),
      },
    });
  }

  /** (fichiers changés depuis `changesBegin`, bilan `total` / `complete`) ; contenus `{"b64"}`, sinon `{"state"}`. */
  async changesEnd(
    ident: string,
    o: { maxFiles?: number; maxBytes?: number; maxFile?: number } = {},
  ): Promise<[Dict[], Dict]> {
    const maxFiles = o.maxFiles ?? 200;
    const maxBytes = o.maxBytes ?? 32 << 20;
    const maxFile = o.maxFile ?? 5 << 20;
    const vus: Dict[] = [];
    const maxi = (1 << 20) + maxFiles * 2048 + Math.floor((maxBytes * 4) / 3);
    const ligne = LIGNE_MAX + 2 * (Math.floor((maxFile * 4) / 3) + 4);
    const flux = await this.ouvrir("POST", "/v1/changes/end", {
      json: { id: ident, max_files: maxFiles, max_bytes: maxBytes, max_file: maxFile },
    });
    try {
      for await (const obj of lignesNdjson(flux.corps(), maxi, ligne)) {
        erreurDeFlux(obj);
        if (veritePy(getPy(obj, "done"))) return [vus, obj];
        if (vus.length >= maxFiles) throw new AgentError("bad_response", "plus de fichiers que demandé");
        if (!relSous(getPy(obj, "path"), ""))
          throw new AgentError("bad_response", "chemin de relevé invalide");
        vus.push(obj);
      }
    } finally {
      await flux.fermer();
    }
    throw new AgentError("bad_response", "relevé interrompu");
  }

  /** Ajoute `data` à la fin du fichier (`truncate` : le crée ou le vide d'abord) ; jamais rejoué une fois envoyé. */
  async append(
    p: string,
    data: DonneesEnvoi,
    o: { parents?: boolean; truncate?: boolean } = {},
  ): Promise<Dict> {
    const corps = await corpsEnvoi(data);
    try {
      const params: Record<string, string | number | bigint> = { path: chemin(p), max: corps.taille };
      if (o.parents) params["parents"] = 1;
      if (o.truncate) params["truncate"] = 1;
      return await this.json("PUT", "/v1/append", PETIT, { params, corps });
    } finally {
      await corps.nettoyer();
    }
  }

  /** `mkdir`, `remove`, `rename`, `copy`, `chmod`, `clear`, `du` ; suppression, copie et vidage attendus jusqu'à la borne d'une opération. */
  fsop(op: string, args: Dict = {}): Promise<Dict> {
    let attente: number | null = null;
    if (op === "remove" || op === "copy" || op === "clear") attente = reglagesAgent.delaiTotalS;
    else if (op === "du") {
      const d = getPy(args, "deadline_s");
      attente = (veritePy(d) ? Number(d) : 10) + 10;
    }
    return this.json("POST", "/v1/fsop", PETIT, {
      json: { op, ...args },
      ...(attente ? { attenteS: attente } : {}),
    });
  }

  /** `git <args>` dans `cwd` (relatif à /work), sous l'UID du conteneur ; `relay` : réseau par le relais Git de l'hôte. */
  async git(
    cwd: string,
    args: Iterable<string>,
    o: {
      timeoutS?: number;
      maxOut?: number;
      env?: Record<string, string>;
      relay?: Record<string, string>;
      passive?: boolean;
    } = {},
  ): Promise<ResultatGitAgent> {
    const timeoutS = o.timeoutS ?? 60;
    const maxOut = o.maxOut ?? 1 << 20;
    const corps: Dict = { cwd: chemin(cwd), args: [...args], timeout_s: timeoutS, max_out: maxOut };
    if (o.env && Object.keys(o.env).length) corps["env"] = o.env;
    if (o.relay && Object.keys(o.relay).length) corps["relay"] = o.relay;
    const d = await this.json("POST", "/v1/git", 12 * maxOut + PETIT, {
      json: corps,
      passif: o.passive ?? false,
      attenteS: timeoutS + 30,
    });
    const rc = getPy(d, "returncode");
    const out = getPy(d, "stdout");
    const err = getPy(d, "stderr");
    if (!(estEntierPy(rc) || typeof rc === "boolean") || typeof out !== "string" || typeof err !== "string")
      throw new AgentError("bad_response", "résultat git mal formé");
    return {
      returncode: Number(rc),
      stdout: tronquerPy(out, maxOut),
      stderr: tronquerPy(err, maxOut),
      truncated: veritePy(getPy(d, "truncated")),
      timed_out: veritePy(getPy(d, "timed_out")),
      duration_ms: intPy(veritePy(getPy(d, "duration_ms")) ? getPy(d, "duration_ms") : 0),
    };
  }

  /** Archive `zip`, `tgz` ou `raw` de `paths`, produite par l'agent ; `fermer()` à appeler en `finally`. Un zip porte l'heure locale de l'hôte. */
  async archive(paths: readonly string[] = [""], o: OptionsArchive): Promise<ArchiveAgent> {
    const chemins = paths.map(chemin);
    const format = o.format ?? "zip";
    const maxi = o.maxBytes + Math.floor(o.maxBytes / 64) + o.maxFiles * 10240 + (1 << 20);
    const deadlineS = o.deadlineS ?? 30.0;
    const corps: Dict = {
      paths: chemins,
      base: o.base ?? "",
      prefix: o.prefix ?? "",
      format,
      dirs: o.dirs ?? false,
      walk: o.walk ?? true,
      strict: o.strict ?? true,
      max_bytes: o.maxBytes,
      max_files: o.maxFiles,
      deadline_s: deadlineS,
    };
    if (format === "zip") corps["utc_offsets"] = decalagesHote();
    const flux = await this.ouvrir("POST", "/v1/archive", {
      delaiS: reglagesAgent.delaiFluxS,
      attenteS: Math.max(reglagesAgent.attenteS, deadlineS + 30),
      sansActivite: !(o.activity ?? true),
      json: corps,
    });
    try {
      const a = new ArchiveEnFlux(tramesArchive(flux.corps(), maxi), o.maxFiles, o.maxBytes, () =>
        flux.fermer(),
      );
      await a.ouvrir();
      return a;
    } catch (e) {
      await flux.fermer();
      throw e;
    }
  }

  /** Remplace le contenu du dossier `path` par l'archive tar (gzip ou non) : bornes vérifiées par l'agent avant de toucher au contenu. */
  async extract(p: string, data: DonneesEnvoi, o: OptionsExtraction): Promise<Dict> {
    const corps = await corpsEnvoi(data, o.onSent);
    try {
      const params: Record<string, string | number | bigint> = {
        path: chemin(p),
        max: corps.taille,
        max_bytes: o.maxBytes,
        max_file: o.maxFile,
        max_members: o.maxMembers,
      };
      if (o.keep) params["keep"] = o.keep;
      if (o.leave) params["leave"] = o.leave;
      return await this.json("PUT", "/v1/extract", PETIT, {
        params,
        corps,
        delaiS: reglagesAgent.delaiArchiveS,
        attenteS: reglagesAgent.delaiArchiveS,
      });
    } finally {
      await corps.nettoyer();
    }
  }

  // ── jobs de fond (shell_job) ───────────────────────────────────────────

  /** `POST /v1/jobs/start` : job de fond de l'agent (`bash -c` en nouvelle session, journal `.bg/job-<id>.log`) ; `chainDepth` écrit dans chacun de ses événements. */
  jobsStart(o: {
    id: string;
    command: string;
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    label?: string;
    wakeOn?: readonly string[];
    chainDepth?: number;
  }): Promise<Dict> {
    return this.json("POST", "/v1/jobs/start", PETIT, {
      json: {
        id: o.id,
        command: o.command,
        cwd: chemin(o.cwd ?? ""),
        env: { ...(o.env ?? {}) },
        label: o.label ?? "",
        wake_on: [...(o.wakeOn ?? [])],
        ...(o.chainDepth !== undefined ? { chain_depth: o.chainDepth } : {}),
      },
    });
  }

  /** `POST /v1/jobs/kill` : groupe et processus marqués arrêtés (KILL après la grâce), purge au besoin ; attendu au-delà de la grâce. */
  jobsKill(o: {
    id: string;
    signal?: "TERM" | "KILL" | "INT";
    graceS?: number;
    by?: "agent" | "user" | "core";
    purge?: boolean;
    passive?: boolean;
  }): Promise<Dict> {
    const grace = o.graceS ?? 5;
    return this.json("POST", "/v1/jobs/kill", PETIT, {
      passif: o.passive ?? false,
      attenteS: grace + 30,
      json: {
        id: o.id,
        signal: o.signal ?? "TERM",
        grace_s: grace,
        by: o.by ?? "agent",
        purge: o.purge ?? false,
      },
    });
  }

  /** `GET /v1/jobs/status` : un job (`id`), ou tous ceux que l'agent suit. */
  async jobsStatus(id = "", o: { passive?: boolean } = {}): Promise<Dict[]> {
    const d = await this.json("GET", "/v1/jobs/status", 1 << 20, {
      passif: o.passive ?? false,
      ...(id ? { params: { id } } : {}),
    });
    return fichesJobs(d);
  }

  /** `GET /v1/jobs/list` : jobs suivis et fiches de `.bg/` inconnues de l'agent. */
  async jobsList(o: { passive?: boolean } = {}): Promise<Dict[]> {
    return fichesJobs(await this.json("GET", "/v1/jobs/list", 4 << 20, { passif: o.passive ?? false }));
  }

  /** `POST /v1/jobs/watch` (toujours passif) : événements de seq > `sinceSeq` et bilan `{last_seq, running, reset}` ; signes de vie ignorés ; `arret` coupe l'attente. */
  async jobsWatch(
    sinceSeq: number,
    o: { waitS?: number; arret?: AbortSignal } = {},
  ): Promise<{ events: Dict[]; done: Dict }> {
    const attente = Math.max(0, Math.min(o.waitS ?? 25, 25));
    if (o.arret?.aborted) throw new AgentError("cancelled", "veille arrêtée");
    const flux = await this.ouvrir("POST", "/v1/jobs/watch", {
      passif: true,
      delaiS: attente + 30,
      attenteS: 30,
      json: { since_seq: sinceSeq, wait_s: attente },
    });
    const couper = (): void => void flux.fermer();
    o.arret?.addEventListener("abort", couper, { once: true });
    const events: Dict[] = [];
    try {
      if (o.arret?.aborted) throw new AgentError("cancelled", "veille arrêtée");
      for await (const obj of lignesNdjson(flux.corps(), (1 << 20) + JOBS_LOT * 8192)) {
        erreurDeFlux(obj);
        if (veritePy(getPy(obj, "done"))) {
          const dernier = getPy(obj, "last_seq");
          const vivants = getPy(obj, "running");
          if (!estEntierPy(dernier) || Number(dernier) < 0 || !estEntierPy(vivants))
            throw new AgentError("bad_response", "bilan de veille mal formé");
          return {
            events,
            done: {
              last_seq: Number(dernier),
              running: Number(vivants),
              reset: getPy(obj, "reset") === true,
            },
          };
        }
        if (events.length >= JOBS_LOT) throw new AgentError("bad_response", "plus d'événements que permis");
        const seq = getPy(obj, "seq");
        const job = getPy(obj, "job_id");
        if (!estEntierPy(seq) || Number(seq) <= 0 || typeof job !== "string" || !ID_JOB.test(job))
          throw new AgentError("bad_response", "événement de job mal formé");
        events.push({ ...obj, seq: Number(seq) });
      }
    } catch (e) {
      if (o.arret?.aborted) throw new AgentError("cancelled", "veille arrêtée");
      throw e;
    } finally {
      o.arret?.removeEventListener("abort", couper);
      await flux.fermer();
    }
    throw new AgentError("bad_response", "veille interrompue");
  }

  // ── transport ──────────────────────────────────────────────────────────

  private async json(methode: string, route: string, maxi: number, o: OptionsFlux = {}): Promise<Dict> {
    const flux = await this.ouvrir(methode, route, o);
    let brut: Buffer;
    try {
      brut = await lireBorne(flux.corps(), maxi);
    } finally {
      await flux.fermer();
    }
    const d = objetJson(brut);
    if (d === null) throw new AgentError("bad_response", "objet JSON attendu");
    return d;
  }

  /** `_flux` : réponse (≥ 400 : `AgentError`) d'un agent démarré au besoin et de la bonne version ; un échec de CONNEXION est réessayé après démarrage, rien d'autre. */
  private async ouvrir(methode: string, route: string, o: OptionsFlux): Promise<FluxOuvert> {
    const passif = o.passif ?? false;
    const delai = o.delaiS || reglagesAgent.delaiTotalS;
    if (!this.versionOk && route !== "/v1/hello") await this.verifierVersion(passif);
    const entetes: Record<string, string> = { ...EN_TETES };
    if (passif || o.sansActivite) Object.assign(entetes, PASSIF);
    let corpsJson: Buffer | null = null;
    if (o.json !== undefined) {
      corpsJson = Buffer.from(pyJsonDumps(o.json, { separators: [",", ":"] }), "utf-8");
      entetes["content-type"] = "application/json";
    }
    if (o.corps) entetes["content-length"] = String(o.corps.taille);
    const arret = new AbortController();
    const minuterie = setTimeout(() => arret.abort(new DelaiDepasse()), delai * 1000);
    minuterie.unref();
    const delaiDepasse = (): AgentError => {
      this.versionOk = false;
      return new AgentError("timeout", `opération de plus de ${fixePy(delai, 0)} s`);
    };
    const traduire = (e: unknown, rendu: boolean): AgentError | "connexion" => {
      if (arret.signal.aborted || e instanceof DelaiDepasse) return delaiDepasse();
      const nom = nomDelai(e);
      if (nom !== null) {
        this.versionOk = false;
        return new AgentError("timeout", `agent muet : ${nom}`);
      }
      if (estErreurConnexion(e) && !rendu) return "connexion";
      return new AgentError("transport", `${nomTransport(e)}: ${message(e)}`);
    };
    try {
      for (const essai of [1, 2]) {
        let cx: Connexion;
        try {
          cx = connexion(this.socketPath, o.attenteS ?? reglagesAgent.attenteS);
        } catch {
          if (essai === 2) throw new AgentError("agent_unavailable", "aucun agent à joindre");
          await course(this.demarrer(passif), arret.signal);
          continue;
        }
        let r: Dispatcher.ResponseData;
        try {
          r = await cx.client.request({
            path: requete(route, o.params),
            method: methode as Dispatcher.HttpMethod,
            headers: entetes,
            body: corpsJson ?? o.corps?.corps() ?? null,
            signal: arret.signal,
          });
        } catch (e) {
          await cx.fermer();
          const t = traduire(e, false);
          if (t !== "connexion") throw t;
          if (essai === 2) throw new AgentError("transport", `ConnectError: ${message(e)}`);
          await course(this.demarrer(passif), arret.signal);
          continue;
        }
        if (r.statusCode >= 400) {
          try {
            await refus(
              r.statusCode,
              lectureTraduite(r.body, (e) => traduire(e, true) as AgentError),
            );
          } finally {
            await cx.fermer();
          }
        }
        const fermer = async (): Promise<void> => {
          clearTimeout(minuterie);
          jeterCorps(r.body);
          await cx.fermer();
        };
        // Échéance atteinte sans fermer() de l'appelant : connexion et descripteur rendus quand même.
        arret.signal.addEventListener("abort", () => void cx.fermer(), { once: true });
        return {
          entetes: r.headers,
          corps: () =>
            lectureTraduite(r.body, (e) => {
              const t = traduire(e, true);
              return t === "connexion" ? new AgentError("transport", `ConnectError: ${message(e)}`) : t;
            }),
          fermer,
        };
      }
      throw new AgentError("agent_unavailable", "aucun agent à joindre");
    } catch (e) {
      clearTimeout(minuterie);
      if (e instanceof DelaiDepasse) throw delaiDepasse();
      throw e;
    }
  }

  /** `_sonder` : (`hello`, figé) sans démarrage ; `[null, false]` si personne n'écoute, `[null, true]` si un processus écoute sans répondre. */
  private async sonder(): Promise<[Dict | null, boolean]> {
    let cx: Connexion;
    try {
      cx = connexion(this.socketPath, reglagesAgent.sondeS);
    } catch {
      return [null, false];
    }
    const signal = AbortSignal.timeout(reglagesAgent.sondeS * 1000);
    try {
      const r = await cx.client.request({
        path: "/v1/hello",
        method: "GET",
        headers: { ...EN_TETES, ...PASSIF },
        signal,
      });
      if (r.statusCode !== 200) {
        jeterCorps(r.body);
        return [null, false];
      }
      return [objetJson(await lireBorne(r.body, PETIT)), false];
    } catch (e) {
      if (estErreurConnexion(e) && !signal.aborted) return [null, false];
      return [null, true];
    } finally {
      await cx.fermer();
    }
  }

  /** `_demarrer` : agent lancé, conteneur démarré au besoin (sauf `passif`) ; un démarrage raté est mémorisé. */
  private demarrer(passif = false): Promise<Dict> {
    return this.verrou.avec(async () => {
      const [d, fige] = await this.sonder();
      if (d !== null) return d;
      if (performance.now() / 1000 < this.echecJusqua)
        throw new AgentError("agent_unavailable", this.echecCause || "démarrage échoué il y a peu");
      let st: EtatBac;
      try {
        st = await (passif ? this.bac.status() : this.bac.ensureRunning());
      } catch (e) {
        throw new AgentError("container_down", tronquerPy(message(e), 300));
      }
      if (!veritePy(st?.running))
        throw new AgentError("container_down", "le conteneur de la sandbox ne tourne pas");
      try {
        await this.bac.startAgent(fige);
      } catch (e) {
        this.echecJusqua = performance.now() / 1000 + reglagesAgent.echecS;
        this.echecCause = tronquerPy(message(e), 400) || "agent non démarré";
        throw new AgentError("agent_unavailable", this.echecCause);
      }
      const echeance = performance.now() / 1000 + reglagesAgent.demarrageS;
      for (;;) {
        const [pret] = await this.sonder();
        if (pret !== null) return pret;
        if (performance.now() / 1000 > echeance) {
          this.echecJusqua = performance.now() / 1000 + reglagesAgent.echecS;
          this.echecCause =
            "l'agent n'a pas démarré à temps (image de la sandbox sans agent ou sans python3 ?)";
          throw new AgentError("agent_unavailable", this.echecCause);
        }
        await dormir(50);
      }
    });
  }

  /** `_verifier_version` : un agent d'une autre version est arrêté puis relancé, une fois par client. */
  private async verifierVersion(passif = false): Promise<void> {
    let d = (await this.sonder())[0] ?? (await this.demarrer(passif));
    const attendue = versionAttendue();
    await this.verrou.avec(async () => {
      if (this.versionOk) return;
      const version = getPy(d, "version");
      if (version !== attendue && !this.relance) {
        this.relance = true;
        journalDe("sandbox").info(
          `[agent] ${this.socketPath} : version ${tronquerPy(strPy(version), 32)}, attendue ${attendue} → relance`,
        );
        await this.arreterAgent(version);
        for (let i = 0; i < 100; i++) {
          if ((await this.sonder())[0] === null) break;
          await dormir(50);
        }
      }
    });
    if (!this.versionOk) {
      d = (await this.sonder())[0] ?? (await this.demarrer(passif));
      const version = getPy(d, "version");
      if (version !== attendue)
        journalDe("sandbox").warn(
          `[agent] ${this.socketPath} : version ${tronquerPy(strPy(version), 32)}, attendue ${attendue} (code mis à jour sans redémarrage de l'app ?)`,
        );
      this.versionOk = true;
    }
  }

  /** `POST /v1/shutdown` (refusé si un autre processus l'a déjà remplacé) ; toute panne ignorée. */
  private async arreterAgent(version: unknown): Promise<void> {
    let cx: Connexion;
    try {
      cx = connexion(this.socketPath, reglagesAgent.sondeS);
    } catch {
      return;
    }
    try {
      const r = await cx.client.request({
        path: "/v1/shutdown",
        method: "POST",
        headers: { ...EN_TETES, "content-type": "application/json" },
        body: pyJsonDumps({ if_version: version }, { separators: [",", ":"] }),
        signal: AbortSignal.timeout(reglagesAgent.sondeS * 1000),
      });
      jeterCorps(r.body);
    } catch {
      // agent déjà parti ou muet
    } finally {
      await cx.fermer();
    }
  }
}

/** Événements au plus dans une réponse de `/v1/jobs/watch` (`_JOBS_VEILLE_LOT` de l'agent). */
export const JOBS_LOT = 256;
const ID_JOB = /^j-[0-9a-f]{8}$/u;

/** `jobs` d'une réponse de `/v1/jobs/status` ou `/list` : fiches objets à l'identifiant valide seulement. */
function fichesJobs(d: Dict): Dict[] {
  const jobs = getPy(d, "jobs");
  if (!Array.isArray(jobs)) throw new AgentError("bad_response", "liste de jobs attendue");
  return jobs.filter((j): j is Dict => estDict(j) && typeof j["id"] === "string" && ID_JOB.test(j["id"]));
}

/** Ligne `{"error"}` d'un flux NDJSON : refus de l'agent. */
function erreurDeFlux(obj: Dict): void {
  if (Object.hasOwn(obj, "error"))
    throw new AgentError(strPy(obj["error"]), strPy(veritePy(obj["message"]) ? obj["message"] : ""));
}

const B64_STRICT = /^[A-Za-z0-9+/]*={0,2}$/u;

/** `base64.b64decode(s, validate=True)` : alphabet strict, rembourrage exact ; `null` sinon. */
export function base64Strict(s: string): Buffer | null {
  if (!B64_STRICT.test(s)) return null;
  const sans = s.replace(/=+$/u, "");
  if (sans.length % 4 === 1) return null;
  if (s.length % 4 !== 0) return null;
  return Buffer.from(s, "base64");
}

/** `agent.sandbox` : le bac de l'agent. */
export function bacDeLAgent(agent: AgentClient): BacPourAgent {
  return agent.sandbox;
}
