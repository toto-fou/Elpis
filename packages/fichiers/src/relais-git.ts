// SPDX-License-Identifier: MIT
/** packages/fichiers/src/relais-git.ts — relais Git authentifiant (sandbox/git_relay.py) : un socket par processus dans `<SANDBOX_DIR>/.elpis-relay`, un ticket par opération, seul le Git « smart HTTP » du dépôt du ticket passe, l'identifiant n'entre jamais dans le bac. */
import { randomBytes, X509Certificate } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { createServer as serveurHttp } from "node:http";
import type { IncomingMessage, Server as ServeurHttp, ServerResponse } from "node:http";
import type { LookupFunction } from "node:net";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { domainToASCII } from "node:url";
import { getCACertificates, rootCertificates } from "node:tls";

import { adresseIpOuNul, hostname, journalDe, port, rstripPy, stripPy, urlsplit } from "@elpis/commun";
import type { UrlDecoupee } from "@elpis/commun";
import { O_PATH } from "@elpis/securite";
import { Agent } from "undici";
import type { Dispatcher } from "undici";

import { jeterCorps, tronquerPy } from "./agent";

export const UPLOAD = "git-upload-pack";
export const RECEIVE = "git-receive-pack";

/** Bornes et délais du relais ; réglables par les tests. */
export const reglagesRelais = {
  /** Début d'un push lu avant relais (commandes). */
  commandesMax: 1 << 20,
  /** Requêtes servies en même temps, par ticket. */
  connexionsMax: 8,
  /** Connexions ouvertes en même temps, tous tickets. */
  connexionsServeur: 64,
  /** Délai pour présenter le ticket (secondes, au total). */
  preambuleS: 5.0,
  /** Lecture de la requête (secondes, par lecture). */
  lectureS: 60,
};

const PREAMBULE = /^ELPIS-RELAY\/1 ([A-Za-z0-9_-]{20,128})\r\n$/u;
const ENTETES_REQUETE: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "content-encoding",
  "git-protocol",
  "user-agent",
  "pragma",
]);
const ENTETES_REPONSE: ReadonlySet<string> = new Set([
  "content-type",
  "content-encoding",
  "content-length",
  "cache-control",
  "expires",
  "pragma",
  "www-authenticate",
]);
const SEGMENT_INTERDIT = /(^|\/)(\.|\.\.|%2e|%2e%2e|\.%2e|%2e\.)(\/|$)/iu;
const O_CLOEXEC = 0o2000000;

/** Opération réseau refusée avant tout transfert (URL, schéma, dépôt). */
export class RelayRefused extends Error {
  override readonly name = "RelayRefused";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Verdict de la garde anti-SSRF : motif de refus, ou adresses validées à joindre (`null` : IP littérale ou garde sans résolution). */
export interface VerdictDepot {
  readonly motif: string | null;
  readonly adresses: readonly string[] | null;
}

export type GardeTicket = () => Promise<VerdictDepot>;

interface Ticket {
  readonly uid: number;
  /** « https://hote[:port] ». */
  readonly amont: string;
  /** « /org/depot », sans « .git » ni « / » final. */
  readonly depot: string;
  readonly service: string;
  readonly refs: ReadonlySet<string>;
  /** Valeur d'Authorization, ou "". */
  readonly auth: string;
  /** Garde anti-SSRF refaite à chaque requête ; ses adresses servent à la connexion. */
  readonly garde: GardeTicket;
  readonly echeance: number;
  readonly refus: string[];
  actives: number;
  /** Identifiants SAISIS : envoyés seulement après une demande de l'amont (401), comme git. */
  readonly authSurDefi: boolean;
  defie: boolean;
}

const tickets = new Map<string, Ticket>();

function maintenant(): number {
  return performance.now() / 1000;
}

function ajouterTicket(t: Ticket): string {
  const jeton = randomBytes(32).toString("base64url");
  const m = maintenant();
  for (const [k, v] of tickets) if (v.echeance < m) tickets.delete(k);
  tickets.set(jeton, t);
  return jeton;
}

/** `_Registre.entrer` : le ticket valide, une requête de plus comptée ; `null` s'il est inconnu, échu ou à sa limite. */
function entrer(jeton: string): Ticket | null {
  const t = tickets.get(jeton);
  if (t === undefined || t.echeance < maintenant() || t.actives >= reglagesRelais.connexionsMax) return null;
  t.actives++;
  return t;
}

/** `_montrer` : adresse du DÉPÔT vers laquelle l'amont redirige, affichable (ni identifiants ni requête, sans la partie protocole). */
export function montrer(url: string, amont = ""): string {
  try {
    let p: UrlDecoupee = urlsplit(url);
    if (!p.scheme) p = urlsplit(rstripPy(amont, "/") + "/" + url.replace(/^\/+/u, ""));
    const chemin = p.path.replace(/\/(info\/refs|git-upload-pack|git-receive-pack)$/u, "");
    let hote = hostname(p) ?? "";
    hote = hote.includes(":") ? `[${hote}]` : hote;
    const n = port(p);
    return tronquerPy(`${p.scheme}://${hote}${n ? `:${n}` : ""}${chemin}`, 200);
  } catch {
    return "?";
  }
}

function sous(chemin: string, depot: string, suite: string): boolean {
  return chemin === depot + suite || chemin === depot + ".git" + suite;
}

class Refus extends Error {
  readonly statut: number;

  constructor(statut: number, message: string) {
    super(message);
    this.statut = statut;
  }
}

/** `int(octets, 16)` de Python sur une longueur de pkt-line : blancs, signe, `0x`, `_` entre chiffres ; `null` si illisible. */
export function entierHexPy(brut: Buffer): number | null {
  const s = brut.toString("latin1").replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu, "");
  const m = /^([+-]?)(?:0[xX]_?)?([0-9a-fA-F](?:_?[0-9a-fA-F])*)$/u.exec(s);
  if (m === null) return null;
  const n = parseInt((m[2] ?? "").replaceAll("_", ""), 16);
  return m[1] === "-" ? -n : n;
}

/** `_commandes_push` : début d'un `git-receive-pack` relu jusqu'à la fin des commandes ; chaque ref mise à jour doit être permise, aucune supprimée ; rendu tel quel ensuite. */
export async function commandesPush(
  corps: AsyncIterable<Uint8Array>,
  permises: ReadonlySet<string>,
): Promise<AsyncGenerator<Buffer>> {
  const it = corps[Symbol.asyncIterator]();
  let tampon = Buffer.alloc(0);
  const exiger = async (n: number): Promise<void> => {
    while (tampon.length < n) {
      const r = await it.next();
      if (r.done) throw new Refus(400, "Relais Git : corps de push tronqué");
      tampon = Buffer.concat([tampon, r.value]);
    }
  };
  let pos = 0;
  for (;;) {
    await exiger(pos + 4);
    const n = entierHexPy(tampon.subarray(pos, pos + 4));
    if (n === null) throw new Refus(400, "Relais Git : push mal formé");
    if (n === 0) break;
    if (n < 5 || pos + n > reglagesRelais.commandesMax) throw new Refus(400, "Relais Git : push mal formé");
    await exiger(pos + n);
    let ligne = tampon.subarray(pos + 4, pos + n);
    const nul = ligne.indexOf(0);
    if (nul >= 0) ligne = ligne.subarray(0, nul);
    let fin = ligne.length;
    while (fin > 0 && ligne[fin - 1] === 0x0a) fin--;
    ligne = ligne.subarray(0, fin);
    pos += n;
    if (ligne.subarray(0, 8).toString("latin1") === "shallow ") continue;
    const parts = decouper(ligne, 0x20);
    if (parts.length !== 3) throw new Refus(400, "Relais Git : push signé ou mal formé, non relayé");
    const ref = new TextDecoder("utf-8").decode(parts[2]);
    if (!(parts[1] as Buffer).some((o) => o !== 0x30))
      throw new Refus(403, `Relais Git : suppression de ${ref} refusée`);
    if (!permises.has(ref))
      throw new Refus(403, `Relais Git : push vers ${ref} hors de l'opération autorisée`);
  }
  const debut = tampon;
  return (async function* () {
    yield debut;
    for (let r = await it.next(); !r.done; r = await it.next()) yield Buffer.from(r.value);
  })();
}

function decouper(b: Buffer, sep: number): Buffer[] {
  const parts: Buffer[] = [];
  let debut = 0;
  for (let i = b.indexOf(sep); i >= 0; i = b.indexOf(sep, debut)) {
    parts.push(b.subarray(debut, i));
    debut = i + 1;
  }
  parts.push(b.subarray(debut));
  return parts;
}

const NOM_CAPATH = /^[0-9a-f]{8}\.\d+$/u;
const autorites = new Map<string, string[]>();

/** Nom de l'exception Python d'une lecture de fichier ratée. */
function nomOsError(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return "FileNotFoundError";
  if (code === "EACCES" || code === "EPERM") return "PermissionError";
  if (code === "EISDIR") return "IsADirectoryError";
  return "OSError";
}

/** Certificat d'un bloc `TRUSTED CERTIFICATE` d'OpenSSL : la SEQUENCE DER du certificat, sans les réglages de confiance qui la suivent. */
function depuisConfiance(bloc: string): string | null {
  const der = Buffer.from(bloc.replace(/-----[^-]+-----|\s/gu, ""), "base64");
  if (der[0] !== 0x30 || der.length < 2) return null;
  let longueur = der[1] as number;
  let tete = 2;
  if (longueur & 0x80) {
    const n = longueur & 0x7f;
    if (n < 1 || n > 4 || der.length < 2 + n) return null;
    longueur = der.subarray(2, 2 + n).reduce((acc, o) => acc * 256 + o, 0);
    tete = 2 + n;
  }
  if (tete + longueur > der.length) return null;
  const corps = der
    .subarray(0, tete + longueur)
    .toString("base64")
    .replace(/.{1,64}/gu, "$&\n");
  return `-----BEGIN CERTIFICATE-----\n${corps}-----END CERTIFICATE-----\n`;
}

function certificats(texte: string): string[] {
  const blocs = (
    texte.match(/-----BEGIN (?:TRUSTED )?CERTIFICATE-----[\s\S]*?-----END (?:TRUSTED )?CERTIFICATE-----/gu) ??
    []
  ).map((b) => (b.startsWith("-----BEGIN TRUSTED") ? depuisConfiance(b) : b));
  return blocs.filter((b): b is string => {
    if (b === null) return false;
    try {
      new X509Certificate(b);
      return true;
    } catch {
      return false;
    }
  });
}

/** `_tls` : magasin du système (PKI interne), plus la CA donnée à git sur l'hôte (`GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`) ; lève `[nom Python]` si illisible. */
export function autoritesGit(): string[] {
  const cainfo = process.env["GIT_SSL_CAINFO"] || "";
  const capath = process.env["GIT_SSL_CAPATH"] || "";
  const cle = JSON.stringify([cainfo, capath]);
  const connues = autorites.get(cle);
  if (connues !== undefined) return connues;
  let ca: string[];
  try {
    ca = [...getCACertificates("system")];
  } catch {
    ca = [...rootCertificates];
  }
  if (cainfo) {
    let texte: string;
    try {
      texte = readFileSync(cainfo, "latin1");
    } catch (e) {
      throw new Error(nomOsError(e), { cause: e });
    }
    const lus = certificats(texte);
    if (!lus.length) throw new Error("SSLError");
    ca.push(...lus);
  }
  if (capath) {
    let noms: string[];
    try {
      noms = readdirSync(capath).filter((n) => NOM_CAPATH.test(n));
    } catch {
      noms = [];
    }
    for (const nom of noms.sort()) {
      try {
        ca.push(...certificats(readFileSync(path.join(capath, nom), "latin1")));
      } catch {
        continue;
      }
    }
  }
  autorites.set(cle, ca);
  return ca;
}

/** Nom httpx d'une panne de l'amont. */
function nomPanneAmont(e: unknown): string {
  const x = e as { code?: unknown; syscall?: unknown } | null;
  const code = typeof x?.code === "string" ? x.code : "";
  if (code === "UND_ERR_CONNECT_TIMEOUT") return "ConnectTimeout";
  if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return "ReadTimeout";
  if (
    x?.syscall === "connect" ||
    x?.syscall === "getaddrinfo" ||
    code.startsWith("ERR_TLS") ||
    /CERT|SSL|SELF_SIGNED|VERIFY/u.test(code)
  )
    return "ConnectError";
  if (code === "UND_ERR_SOCKET" || code === "ECONNRESET") return "ReadError";
  return "RemoteProtocolError";
}

/** Recherche DNS figée sur les adresses validées par la garde (pas de nouvelle résolution). */
function rechercheFigee(adresses: readonly string[]): LookupFunction {
  const liste = adresses.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));
  return (_hote, options, rappel) => {
    const premiere = liste[0];
    if (premiere === undefined)
      rappel(Object.assign(new Error("aucune adresse validée"), { code: "ENOTFOUND" }), "", 0);
    else if (options.all) rappel(null, liste);
    else rappel(null, premiere.address, premiere.family);
  };
}

/** git parti en cours de réponse : rien à signaler (comme l'OSError ignorée du Python). */
class ClientParti extends Error {}

/** Attend que `res` se vide ; `ClientParti` si la connexion se ferme avant. */
function vidange(res: ServerResponse): Promise<void> {
  if (res.destroyed) return Promise.reject(new ClientParti());
  return new Promise((ok, ko) => {
    const surVide = (): void => {
      res.off("close", surFin);
      ok();
    };
    const surFin = (): void => {
      res.off("drain", surVide);
      ko(new ClientParti());
    };
    res.once("drain", surVide);
    res.once("close", surFin);
  });
}

function repondre(res: ServerResponse, statut: number, message: string): void {
  const corps = Buffer.from(message + "\n", "utf-8");
  res.writeHead(statut, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(corps.length),
    Connection: "close",
  });
  res.end(corps);
}

/** Un socket du relais pour ce processus, lié par le dossier ouvert (chemin court quelle que soit sa longueur). */
class ServeurRelais {
  readonly nom = `${process.pid}.sock`;
  private actives = 0;
  private readonly http: ServeurHttp;
  private readonly net: Server;
  private readonly ticketsDesSockets = new WeakMap<Socket, Ticket>();
  private readonly ouvertes = new Set<Socket>();
  private dossierFd: number | null = null;

  constructor() {
    this.http = serveurHttp(
      { requestTimeout: 0, headersTimeout: reglagesRelais.lectureS * 1000 },
      (req, res) => {
        void this.relayer(req, res);
      },
    );
    // Une requête par connexion (handle_one_request) : les suivantes reçoivent 503 sans atteindre l'amont.
    this.http.maxRequestsPerSocket = 1;
    this.net = createServer((s) => this.accueillir(s));
    this.net.on("error", (e) =>
      journalDe("git").warn(`[git] relais : connexion non acceptée (${String(e)})`),
    );
  }

  async ecouter(dossier: string): Promise<void> {
    const fd = openSync(dossier, O_PATH | constants.O_DIRECTORY | O_CLOEXEC);
    const court = `/proc/self/fd/${fd}/${this.nom}`;
    try {
      try {
        unlinkSync(court);
      } catch (e) {
        if ((e as { code?: unknown }).code !== "ENOENT") throw e;
      }
      await new Promise<void>((ok, ko) => {
        this.net.once("error", ko);
        this.net.listen(court, () => {
          this.net.off("error", ko);
          ok();
        });
      });
      chmodSync(court, 0o666);
      this.dossierFd = fd;
    } catch (e) {
      // Fermé avant le dossier : libuv retire le socket par ce chemin, qui ne doit pas désigner un autre dossier.
      if (this.net.listening) await new Promise<void>((ok) => this.net.close(() => ok()));
      closeSync(fd);
      throw e;
    }
  }

  /** Arrêt (tests) : le socket est retiré par le dossier encore ouvert. */
  async fermer(): Promise<void> {
    const fermeture = new Promise<void>((ok) => this.net.close(() => ok()));
    for (const s of this.ouvertes) s.destroy();
    await fermeture;
    if (this.dossierFd !== null) closeSync(this.dossierFd);
    this.dossierFd = null;
  }

  /** Au-delà de `connexionsServeur` connexions en cours, la nouvelle est fermée sans lecture ; sinon le ticket est lu, en 5 s au total. */
  private accueillir(s: Socket): void {
    if (this.actives >= reglagesRelais.connexionsServeur) {
      s.destroy();
      return;
    }
    this.actives++;
    this.ouvertes.add(s);
    let ticket: Ticket | null = null;
    s.once("close", () => {
      this.actives--;
      this.ouvertes.delete(s);
      if (ticket !== null) ticket.actives--;
    });
    s.on("error", () => undefined);
    let tampon = Buffer.alloc(0);
    const minuterie = setTimeout(() => s.destroy(), reglagesRelais.preambuleS * 1000);
    const surDonnees = (b: Buffer): void => {
      tampon = Buffer.concat([tampon, b]);
      const i = tampon.indexOf(0x0a);
      if (i < 0 && tampon.length < 256) return;
      s.off("data", surDonnees);
      s.off("end", surFin);
      s.pause();
      clearTimeout(minuterie);
      const longueur = i >= 0 && i < 256 ? i + 1 : 256;
      ticket = this.lireTicket(tampon.subarray(0, longueur));
      this.suite(s, ticket, tampon.subarray(longueur));
    };
    const surFin = (): void => {
      s.off("data", surDonnees);
      clearTimeout(minuterie);
      s.destroy();
    };
    s.on("data", surDonnees);
    s.once("end", surFin);
  }

  private lireTicket(ligne: Buffer): Ticket | null {
    const m = PREAMBULE.exec(ligne.toString("latin1"));
    return m ? entrer(m[1] as string) : null;
  }

  /** Ticket refusé : fermé sans réponse (la requête déjà envoyée est lue, bornée, pour une fermeture propre) ; sinon une requête HTTP. */
  private suite(s: Socket, ticket: Ticket | null, reste: Buffer): void {
    if (ticket === null) {
      const fermer = (): void => {
        clearTimeout(m);
        s.end();
        s.destroySoon();
      };
      const m = setTimeout(fermer, reste.length ? 0 : 200);
      s.once("data", fermer);
      s.resume();
      return;
    }
    this.ticketsDesSockets.set(s, ticket);
    s.setTimeout(reglagesRelais.lectureS * 1000, () => s.destroy());
    if (reste.length) s.unshift(reste);
    this.http.emit("connection", s);
    s.resume();
  }

  private async relayer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t = this.ticketsDesSockets.get(req.socket);
    res.shouldKeepAlive = false;
    req.on("error", () => undefined);
    res.on("error", () => undefined);
    if (t === undefined) {
      req.socket.destroy();
      return;
    }
    try {
      const cible = req.url ?? "";
      const q = cible.indexOf("?");
      const chemin = q >= 0 ? cible.slice(0, q) : cible;
      const requete = q >= 0 ? cible.slice(q + 1) : "";
      if (req.method !== "GET" && req.method !== "POST") {
        repondre(res, 501, `Unsupported method (${JSON.stringify(req.method)})`);
        return;
      }
      const permis =
        req.method === "GET"
          ? requete === `service=${t.service}` && sous(chemin, t.depot, "/info/refs")
          : !requete && q < 0 && sous(chemin, t.depot, "/" + t.service);
      if (!permis) throw new Refus(403, "Relais Git : requête hors de l'opération autorisée");
      // Les 60 s portent sur les lectures et écritures de git, pas sur l'attente de l'amont (bornée par undici).
      if (req.method === "GET") req.socket.setTimeout(0);
      else req.once("end", () => req.socket.setTimeout(0));
      const verdict = await t.garde();
      if (verdict.motif) throw new Refus(403, `Relais Git : dépôt refusé (${verdict.motif})`);
      const entetes: Record<string, string> = {};
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        const k = (req.rawHeaders[i] as string).toLowerCase();
        if (ENTETES_REQUETE.has(k)) entetes[k] = req.rawHeaders[i + 1] as string;
      }
      let corps: AsyncIterable<Uint8Array> | null = null;
      if (req.method === "POST") {
        corps = req;
        const longueur = req.headers["content-length"];
        if (!req.headers["transfer-encoding"]?.toLowerCase().includes("chunked") && longueur !== undefined)
          entetes["content-length"] = String(Number(longueur));
        if (t.service === RECEIVE) {
          if ((req.headers["content-encoding"] ?? "identity") !== "identity")
            throw new Refus(415, "Relais Git : push compressé non relayé");
          corps = await commandesPush(req, t.refs);
        }
      }
      await this.amont(t, req, res, entetes, corps, verdict);
    } catch (e) {
      if (!(e instanceof Refus)) {
        req.socket.destroy();
        return;
      }
      t.refus.push(e.message);
      if (!res.headersSent && !req.socket.destroyed) repondre(res, e.statut, e.message);
      else req.socket.destroy();
    }
  }

  /** Requête à l'amont (sans proxy, sans redirection) ; identifiants saisis ajoutés après un premier 401 (la découverte est alors refaite). */
  private async amont(
    t: Ticket,
    req: IncomingMessage,
    res: ServerResponse,
    entetes: Record<string, string>,
    corps: AsyncIterable<Uint8Array> | null,
    verdict: VerdictDepot,
  ): Promise<void> {
    let ca: string[];
    try {
      ca = autoritesGit();
    } catch (e) {
      throw new Refus(
        502,
        `Relais Git : autorité de certification illisible (GIT_SSL_CAINFO / GIT_SSL_CAPATH : ${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const agent = new Agent({
      connect: {
        ca,
        timeout: 30_000,
        ...(verdict.adresses ? { lookup: rechercheFigee(verdict.adresses) } : {}),
      },
      headersTimeout: 300_000,
      bodyTimeout: 300_000,
      allowH2: false,
    });
    let envoye = false;
    try {
      const methode = req.method === "POST" ? "POST" : "GET";
      const avec: Record<string, string> = { ...entetes };
      if (t.auth && (!t.authSurDefi || t.defie)) avec["authorization"] = t.auth;
      const envoyer = (
        m: Dispatcher.HttpMethod,
        h: Record<string, string>,
        b: AsyncIterable<Uint8Array> | null,
      ) =>
        agent.request({
          origin: t.amont,
          path: req.url ?? "/",
          method: m,
          headers: h,
          body: b === null ? null : Readable.from(b),
        });
      let r = await envoyer(methode, avec, corps);
      if (r.statusCode === 401 && t.auth && t.authSurDefi && !t.defie && methode === "GET") {
        t.defie = true;
        jeterCorps(r.body);
        avec["authorization"] = t.auth;
        r = await envoyer("GET", avec, null);
      }
      try {
        if (r.statusCode >= 300 && r.statusCode < 400) {
          const loc = r.headers["location"];
          const cible = Array.isArray(loc) ? (loc[0] ?? "") : (loc ?? "");
          throw new Refus(
            502,
            `Relais Git : l'amont redirige (${r.statusCode}` +
              (cible ? ` vers ${montrer(cible, t.amont)}` : "") +
              ") ; corrigez l'URL du remote",
          );
        }
        const sortants: [string, string][] = [];
        for (const [k, v] of Object.entries(r.headers)) {
          if (!ENTETES_REPONSE.has(k.toLowerCase()) || v === undefined) continue;
          for (const x of Array.isArray(v) ? v : [v]) sortants.push([k, x]);
        }
        sortants.push(["Connection", "close"]);
        req.socket.setTimeout(reglagesRelais.lectureS * 1000);
        res.writeHead(r.statusCode, sortants.flat());
        envoye = true;
        for await (const b of r.body) {
          if (!res.write(b)) await vidange(res);
        }
        res.end();
      } finally {
        jeterCorps(r.body);
      }
    } catch (e) {
      if (e instanceof Refus) throw e;
      if (e instanceof ClientParti || req.socket.destroyed) {
        req.socket.destroy();
        return;
      }
      const motif = `Relais Git : amont injoignable (${nomPanneAmont(e)})`;
      t.refus.push(motif);
      if (!envoye && !res.headersSent) repondre(res, 502, motif);
      else req.socket.destroy();
    } finally {
      void agent.destroy();
    }
  }
}

const serveurs = new Map<string, ServeurRelais>();
const demarrages = new Map<string, Promise<ServeurRelais>>();

/** `_nettoyer` : sockets laissés par des processus de l'app qui ne tournent plus. */
function nettoyer(dossier: string): void {
  let noms: string[];
  try {
    noms = readdirSync(dossier);
  } catch {
    return;
  }
  for (const nom of noms) {
    if (!nom.endsWith(".sock")) continue;
    const tige = nom.slice(0, -".sock".length);
    if (!/^[+-]?\d+$/u.test(tige.trim())) continue;
    const pid = Number(tige);
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as { code?: unknown }).code !== "ESRCH") continue;
      try {
        unlinkSync(path.join(dossier, nom));
      } catch {
        // déjà parti
      }
    }
  }
}

/** `serveur` : nom du socket du relais de ce processus dans `dossier` (démarré au besoin). */
export async function serveurRelais(dossier: string): Promise<string> {
  const connu = serveurs.get(dossier);
  if (connu !== undefined) return connu.nom;
  let demarrage = demarrages.get(dossier);
  if (demarrage === undefined) {
    demarrage = (async () => {
      mkdirSync(dossier, { mode: 0o755, recursive: true });
      chmodSync(dossier, 0o755);
      nettoyer(dossier);
      const srv = new ServeurRelais();
      await srv.ecouter(dossier);
      serveurs.set(dossier, srv);
      return srv;
    })();
    demarrages.set(dossier, demarrage);
    demarrage.finally(() => demarrages.delete(dossier)).catch(() => undefined);
  }
  return (await demarrage).nom;
}

/** Tests : arrête les serveurs du relais de ce processus (socket retiré). */
export async function arreterRelais(): Promise<void> {
  const tous = [...serveurs.values()];
  serveurs.clear();
  await Promise.all(tous.map((s) => s.fermer()));
}

/** `amont` : (`schéma://hôte[:port]`, dépôt, origine telle qu'écrite dans l'URL) d'une URL de dépôt, ou `RelayRefused`. */
export function amont(url: string): [string, string, string] {
  let p: UrlDecoupee;
  let n: number | null;
  try {
    p = urlsplit(stripPy(url || ""));
    n = port(p);
  } catch {
    throw new RelayRefused("malformed_url", "URL de dépôt mal formée");
  }
  if (p.scheme !== "http" && p.scheme !== "https")
    throw new RelayRefused(
      "scheme_not_relayed",
      `Schéma « ${p.scheme || "?"} » : seul Git sur HTTP(S) passe par le relais.`,
    );
  const arobase = p.netloc.lastIndexOf("@");
  const infos = arobase >= 0 ? p.netloc.slice(0, arobase) : null;
  const deux = infos === null ? -1 : infos.indexOf(":");
  const identifiants =
    infos !== null && Boolean(deux >= 0 ? infos.slice(0, deux) || infos.slice(deux + 1) : infos);
  const hote = hostname(p);
  if (identifiants || !hote || p.query || p.fragment)
    throw new RelayRefused("malformed_url", "URL de dépôt invalide (identifiants, requête ou hôte)");
  let depot = rstripPy(p.path, "/");
  if (depot.endsWith(".git")) depot = depot.slice(0, -4);
  if (!depot || SEGMENT_INTERDIT.test(depot) || /[\\\0\r\n\t ]/u.test(depot))
    throw new RelayRefused("malformed_url", "Chemin de dépôt invalide");
  let h = hote.toLowerCase();
  h = h.includes(":") ? `[${h}]` : h;
  const netloc = n ? `${h}:${n}` : h;
  const base = `${p.scheme}://${netloc}`;
  if (!memeCible(base, hote.toLowerCase(), n || (p.scheme === "https" ? 443 : 80)))
    throw new RelayRefused("malformed_url", "URL de dépôt invalide (identifiants, requête ou hôte)");
  return [base, depot, `${p.scheme}://${p.netloc}/`];
}

/** undici relit `base` en WHATWG : il doit y trouver le même hôte (même IP le cas échéant) et le même port, sinon l'épinglage DNS serait contourné. */
function memeCible(base: string, hote: string, portVoulu: number): boolean {
  if (!URL.canParse(base)) return false;
  const w = new URL(base);
  const hw = w.hostname.startsWith("[") ? w.hostname.slice(1, -1) : w.hostname;
  const a = adresseIpOuNul(hote);
  const b = adresseIpOuNul(hw);
  const meme =
    a !== null || b !== null
      ? a !== null && b !== null && a.version === b.version && a.valeur === b.valeur
      : hw === hote ||
        ([...hote].some((c) => c.charCodeAt(0) > 0x7f) && !/[%\s]/u.test(hote) && domainToASCII(hote) === hw);
  const defaut = w.protocol === "https:" ? 443 : 80;
  return meme && (w.port ? Number(w.port) : defaut) === portVoulu;
}

/** `basic_auth` : `Basic` de l'identifiant (le jeton s'il est vide) et du jeton, comme git. */
export function basicAuth(username: string, token: string): string {
  return "Basic " + Buffer.from(`${username || token}:${token}`, "utf-8").toString("base64");
}

/** Spécification `relay` passée à l'agent : socket, ticket, origine (rien de secret). */
export interface SpecRelais {
  readonly socket: string;
  readonly ticket: string;
  readonly origin: string;
}

export interface OptionsTicket {
  readonly uid: number;
  readonly url: string;
  readonly service: string;
  readonly refs?: Iterable<string>;
  readonly auth?: string;
  /** `auth` envoyé seulement après un 401 de l'amont (identifiants saisis). */
  readonly authOnChallenge?: boolean;
  readonly garde?: GardeTicket;
  readonly dureeS?: number;
}

/** `ticket` : ticket d'une opération (spécification pour l'agent, motifs des requêtes refusées), révoqué à la fin de `f`. */
export async function avecTicket<T>(
  dossier: string,
  o: OptionsTicket,
  f: (relay: SpecRelais, refus: string[]) => Promise<T>,
): Promise<T> {
  if (o.service !== UPLOAD && o.service !== RECEIVE) throw new Error(`ValueError: ${o.service}`);
  const [base, depot, origine] = amont(o.url);
  const t: Ticket = {
    uid: o.uid,
    amont: base,
    depot,
    service: o.service,
    refs: new Set(o.refs ?? []),
    auth: o.auth ?? "",
    garde: o.garde ?? (async () => ({ motif: null, adresses: null })),
    echeance: maintenant() + (o.dureeS ?? 600),
    refus: [],
    actives: 0,
    authSurDefi: o.authOnChallenge ?? false,
    defie: false,
  };
  const nom = await serveurRelais(dossier);
  const jeton = ajouterTicket(t);
  try {
    return await f({ socket: nom, ticket: jeton, origin: origine }, t.refus);
  } finally {
    tickets.delete(jeton);
  }
}

/** Tests : requêtes en cours d'un ticket, `null` s'il est révoqué. */
export function activesDuTicket(jeton: string): number | null {
  return tickets.get(jeton)?.actives ?? null;
}
