// SPDX-License-Identifier: MIT
/** packages/navigateur/src/relais.ts — relais des secrets du navigateur d'un bac (hors du conteneur, hôte d'outils) : proxy HTTP sur un socket unix par lequel passe tout le trafic sortant du navigateur du bac ; destinations jugées par l'hôte ; pour les origines d'un secret en usage seulement, TLS terminé par l'autorité de l'instance, substitut d'une connexion remplacé par la valeur (fenêtre armée, origine du secret, corps de requête), défis 401 Basic et Digest résolus par le relais, valeur et formes encodées purgées des réponses ; ailleurs, tunnel CONNECT intact. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createServer as serveurHttp, request as requeteHttp } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import { request as requeteHttps } from "node:https";
import type { RequestOptions as OptionsHttps } from "node:https";
import { connect as connexionNet, isIP } from "node:net";
import type { Socket } from "node:net";
import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { connect as connexionTls, getCACertificates, TLSSocket } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { O_PATH } from "@elpis/securite";

import { Feuilles } from "./autorite";
import type { Autorite } from "./autorite";

/** Verdict de l'hôte sur une destination : adresse à joindre (jamais résolue de nouveau) et toutes les adresses jugées, ou motif de refus en anglais. */
export type VerdictRelais =
  | { readonly ok: true; readonly adresse: string; readonly adresses?: readonly string[] }
  | { readonly ok: false; readonly motif: string };
export type JugeRelais = (hote: string, port: number) => Promise<VerdictRelais>;

/** Identifiants d'un secret, résolus par le core au dernier moment : SECRET, gardés en mémoire le temps de la liaison (purge des réponses). */
export interface IdentifiantsRelais {
  readonly username: string;
  readonly secret: string;
}

/** Secret en usage dans une session du navigateur du bac. */
export interface LiaisonRelais {
  readonly id: string;
  readonly nom: string;
  readonly kind: "web-login" | "http-auth";
  /** Origines `scheme://hôte[:port]` du secret. */
  readonly origines: readonly string[];
  readonly tls: "strict" | "insecure";
  /** Substitut à usage unique qu'une connexion saisit à la place du mot de passe (web-login). */
  readonly substitut: string | null;
  resoudre(): Promise<IdentifiantsRelais | null>;
}

interface EtatLiaison {
  readonly l: LiaisonRelais;
  fenetreJusqua: number;
  valeur: IdentifiantsRelais | null;
  formes: Buffer[];
  substitutions: number;
  refus: number;
  digest: DefiDigest | null;
  nc: number;
  basic: boolean;
}

interface DefiDigest {
  readonly realm: string;
  readonly nonce: string;
  readonly opaque: string | null;
  readonly qop: string | null;
  readonly algorithme: string;
}

/** Bornes du relais ; réglables par les tests. */
export const reglagesRelaisNavigateur = {
  /** Corps de requête lu pour une origine de secret (au-delà : relayé tel quel, sans substitution). */
  corpsMax: 32 * 1024 * 1024,
  /** Substitutions par fenêtre armée : une soumission (une deuxième pourrait stocker la valeur pour la relire autrement). */
  substitutionsMax: 1,
};

const SAUT_PAR_SAUT = new Set([
  "proxy-connection",
  "proxy-authorization",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const METHODES_SUBSTITUTION = new Set(["POST", "PUT", "PATCH"]);
const MASQUE = "[secret]";

/** Formes sous lesquelles une valeur peut revenir, même liste que `formesSecret` du service (browser-service/secret_util.js) : brute, URL et formulaire (%xx en majuscules et en minuscules, tout octet encodé), HTML (entités nommées, décimales, hexadécimales), JSON (`\/`, `\uXXXX` des non-ASCII, des caractères HTML ou de tous), base64, hexadécimal. */
export function formesValeur(v: string): string[] {
  if (v.length < 3) return [];
  const o = Buffer.from(v, "utf8");
  const b64 = o.toString("base64");
  const f = new Set([v, b64, b64.replace(/=+$/u, ""), o.toString("base64url"), o.toString("hex")]);
  const pourcents = [[...o].map((x) => `%${x.toString(16).padStart(2, "0").toUpperCase()}`).join("")];
  try {
    const u = encodeURIComponent(v);
    pourcents.push(
      u,
      u.replaceAll("%20", "+"),
      new URLSearchParams({ x: v }).toString().slice(2),
      encodeURI(v),
    );
  } catch {
    // valeur non encodable (demi-paire) : formes brutes seules
  }
  for (const p of pourcents) {
    f.add(p);
    f.add(p.replace(/%[0-9A-F]{2}/gu, (m) => m.toLowerCase()));
  }
  f.add(
    v
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;"),
  );
  f.add(
    v.replaceAll("&", "&amp;").replaceAll("\u00a0", "&nbsp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );
  f.add(v.replaceAll("&", "&amp;").replaceAll("\u00a0", "&nbsp;").replaceAll('"', "&quot;"));
  const car = [...v];
  const html = (c: string): boolean => /[&<>"']/u.test(c);
  const dec = (c: string): string => `&#${c.codePointAt(0) ?? 0};`;
  const hex = (c: string): string => `&#x${(c.codePointAt(0) ?? 0).toString(16)};`;
  f.add(car.map((c) => (html(c) ? dec(c) : c)).join(""));
  f.add(car.map((c) => (html(c) ? hex(c) : c)).join(""));
  f.add(car.map(dec).join(""));
  f.add(car.map(hex).join(""));
  f.add(car.map((c) => hex(c).toUpperCase().replace("&#X", "&#x")).join(""));
  const u4 = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  const majuscules = (j: string): string =>
    j.replace(/\\u([0-9a-f]{4})/gu, (_m, h: string) => `\\u${h.toUpperCase()}`);
  const json = JSON.stringify(v).slice(1, -1);
  const ascii = json.replace(/[^\u0000-\u007e]/gu, (c) => c.split("").map(u4).join(""));
  for (const j of [json, ascii, ascii.replace(/[<>&']/gu, u4), v.split("").map(u4).join("")]) {
    f.add(j);
    f.add(j.replaceAll("/", "\\/"));
    f.add(majuscules(j));
  }
  return [...f].filter((x) => x.length >= 3).sort((a, b) => b.length - a.length);
}

/** Formes d'un en-tête `Authorization: Basic` (identifiant et valeur), que l'amont peut renvoyer : brute, base64 (trois variantes). */
export function formesBasic(username: string, secret: string): string[] {
  const brut = `${username}:${secret}`;
  const b64 = Buffer.from(brut, "utf8").toString("base64");
  return [brut, b64, b64.replace(/=+$/u, ""), Buffer.from(brut, "utf8").toString("base64url")];
}

/** Valeur encodée pour le corps où elle remplace le substitut : formulaire, JSON, sinon brute. */
export function valeurPourCorps(valeur: string, typeContenu: string): string {
  const t = typeContenu.toLowerCase();
  if (t.includes("application/x-www-form-urlencoded"))
    return new URLSearchParams({ x: valeur }).toString().slice(2);
  if (/[/+]json\b/u.test(t)) return JSON.stringify(valeur).slice(1, -1);
  return valeur;
}

/** Remplace toutes les occurrences de `de` par `par` dans `b`. */
export function remplacerOctets(b: Buffer, de: Buffer, par: Buffer): Buffer {
  if (de.length === 0) return b;
  const morceaux: Buffer[] = [];
  let i = 0;
  for (let j = b.indexOf(de, i); j >= 0; j = b.indexOf(de, i)) {
    morceaux.push(b.subarray(i, j), par);
    i = j + de.length;
  }
  if (i === 0) return b;
  morceaux.push(b.subarray(i));
  return Buffer.concat(morceaux);
}

/** Flux qui purge des formes (octets) en gardant une traîne pour les occurrences à cheval sur deux morceaux. */
export class Purgeur extends Transform {
  private reste: Buffer = Buffer.alloc(0);
  private readonly traine: number;
  private readonly formes: readonly Buffer[];
  private readonly par: Buffer;

  constructor(formes: readonly Buffer[], par: Buffer) {
    super();
    this.formes = formes;
    this.par = par;
    this.traine = Math.max(0, ...formes.map((f) => f.length - 1));
  }

  override _transform(morceau: Buffer, _e: BufferEncoding, fin: TransformCallback): void {
    let b: Buffer = Buffer.concat([this.reste, morceau]);
    for (const f of this.formes) b = remplacerOctets(b, f, this.par);
    const coupe = Math.max(0, b.length - this.traine);
    this.reste = b.subarray(coupe);
    fin(null, b.subarray(0, coupe));
  }

  override _flush(fin: TransformCallback): void {
    let b: Buffer = this.reste;
    for (const f of this.formes) b = remplacerOctets(b, f, this.par);
    fin(null, b);
  }
}

/** Origine WHATWG (`scheme://hôte[:port]`, port par défaut omis) d'un hôte et d'un port. */
export function origineDe(schema: "http" | "https", hote: string, port: number): string {
  const h = isIP(hote) === 6 ? `[${hote}]` : hote.toLowerCase();
  const defaut = schema === "https" ? 443 : 80;
  return `${schema}://${h}${port === defaut ? "" : `:${port}`}`;
}

/** Nom d'hôte comparable : minuscules, crochets et point final retirés (`exemple.fr.` est `exemple.fr`). */
function hoteNormal(h: string): string {
  return h
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.+$/u, "");
}

function hotePort(brut: string, defaut: number): { hote: string; port: number } | null {
  const m = /^\[([^\]]+)\](?::(\d+))?$/u.exec(brut) ?? /^([^:/\s]+)(?::(\d+))?$/u.exec(brut);
  if (!m?.[1]) return null;
  const port = m[2] ? Number(m[2]) : defaut;
  const hote = hoteNormal(m[1]);
  return hote && port > 0 && port < 65536 ? { hote, port } : null;
}

/** Schéma, hôte (normalisé) et port d'une origine `scheme://hôte[:port]`, `null` si illisible. */
function partiesOrigine(o: string): { schema: "http" | "https"; hote: string; port: number } | null {
  try {
    const u = new URL(o);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const schema = u.protocol === "https:" ? "https" : "http";
    return { schema, hote: hoteNormal(u.hostname), port: Number(u.port || (schema === "https" ? 443 : 80)) };
  } catch {
    return null;
  }
}

/** Couverture d'une destination par les liaisons : `exactes` par son origine, `liees` aussi par le même hôte ou la même adresse au même port, `schemas` des origines ainsi touchées. */
interface Couverture {
  readonly liees: EtatLiaison[];
  readonly exactes: EtatLiaison[];
  readonly schemas: ReadonlySet<"http" | "https">;
}

/** Défis `WWW-Authenticate` d'une réponse (en-têtes répétés gardés) : schéma et paramètres. */
export function defisAuth(brut: readonly string[]): { schema: string; params: Record<string, string> }[] {
  const sortie: { schema: string; params: Record<string, string> }[] = [];
  for (let i = 0; i + 1 < brut.length; i += 2) {
    if ((brut[i] ?? "").toLowerCase() !== "www-authenticate") continue;
    const texte = brut[i + 1] ?? "";
    const re = /([A-Za-z][\w-]*)(?:\s+((?:[\w-]+\s*=\s*(?:"(?:[^"\\]|\\.)*"|[^,\s]*)\s*,?\s*)*))?/gy;
    for (let m = re.exec(texte); m !== null && m[0] !== ""; m = re.exec(texte)) {
      const params: Record<string, string> = {};
      for (const p of (m[2] ?? "").matchAll(/([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/gu))
        params[(p[1] ?? "").toLowerCase()] =
          p[2] !== undefined ? p[2].replace(/\\(.)/gu, "$1") : (p[3] ?? "");
      sortie.push({ schema: (m[1] ?? "").toLowerCase(), params });
      while (re.lastIndex < texte.length && /[\s,]/u.test(texte[re.lastIndex] ?? "")) re.lastIndex++;
    }
  }
  return sortie;
}

/** Réponse Digest (RFC 7616 : MD5, SHA-256 et leurs variantes -sess, qop auth ou sans qop). */
export function reponseDigest(
  d: DefiDigest,
  id: IdentifiantsRelais,
  methode: string,
  uri: string,
  nc: number,
  cnonce: string = randomBytes(8).toString("hex"),
): string {
  const algo = d.algorithme.toUpperCase();
  const h = (s: string): string =>
    createHash(algo.startsWith("SHA-256") ? "sha256" : "md5")
      .update(s, "utf8")
      .digest("hex");
  let ha1 = h(`${id.username}:${d.realm}:${id.secret}`);
  if (algo.endsWith("-SESS")) ha1 = h(`${ha1}:${d.nonce}:${cnonce}`);
  const ha2 = h(`${methode}:${uri}`);
  const ncs = nc.toString(16).padStart(8, "0");
  const qop = d.qop ? "auth" : null;
  const reponse = qop ? h(`${ha1}:${d.nonce}:${ncs}:${cnonce}:${qop}:${ha2}`) : h(`${ha1}:${d.nonce}:${ha2}`);
  const q = (v: string): string => `"${v.replace(/(["\\])/gu, "\\$1")}"`;
  const champs = [
    `username=${q(id.username)}`,
    `realm=${q(d.realm)}`,
    `nonce=${q(d.nonce)}`,
    `uri=${q(uri)}`,
    `algorithm=${d.algorithme}`,
    `response=${q(reponse)}`,
  ];
  if (qop) champs.push(`qop=${qop}`, `nc=${ncs}`, `cnonce=${q(cnonce)}`);
  if (d.opaque !== null) champs.push(`opaque=${q(d.opaque)}`);
  return `Digest ${champs.join(", ")}`;
}

function egal(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function lireCorps(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((ok, ko) => {
    const morceaux: Buffer[] = [];
    let n = 0;
    req.on("data", (d: Buffer) => {
      n += d.length;
      if (n <= max) morceaux.push(d);
    });
    req.on("end", () => ok(n <= max ? Buffer.concat(morceaux) : null));
    req.on("error", ko);
    req.on("close", () => {
      if (!req.complete) ko(new Error("request aborted by the client"));
    });
  });
}

const O_CLOEXEC = 0o2000000;

/** Socket ouvert à tous (0666 : le service du bac n'a pas l'UID de l'hôte) sans suivre de lien posé par le bac : saisi en O_PATH|O_NOFOLLOW, vérifié socket, droits posés par /proc/self/fd sur ce seul inode ; son inode. */
export function ouvrirSocketATous(chemin: string): number {
  const fd = openSync(chemin, O_PATH | constants.O_NOFOLLOW | O_CLOEXEC);
  try {
    const st = fstatSync(fd);
    if (!st.isSocket()) throw new Error(`${chemin}: not a socket`);
    chmodSync(`/proc/self/fd/${fd}`, 0o666);
    return st.ino;
  } finally {
    closeSync(fd);
  }
}

function refuser(res: ServerResponse, statut: number, motif: string): void {
  if (res.headersSent) return void res.destroy();
  const texte = `Blocked by the Elpis browser relay: ${motif}.`;
  res.writeHead(statut, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(texte);
}

export interface OptionsRelais {
  /** Socket unix du relais sur l'hôte (`<P>/.elpis-agent/browser-relay.sock`). */
  readonly socket: string;
  /** Jeton `Proxy-Authorization: Bearer` attendu du service du bac. */
  readonly jeton: string;
  readonly juger: JugeRelais;
  readonly autorite: Autorite;
  readonly journal?: (m: string) => void;
  /** Autorités de confiance pour l'amont en TLS strict (défaut : celles de Node et du système). */
  readonly caAmont?: readonly string[];
}

/** Relais des secrets du navigateur d'UN bac (un par compte). */
export class RelaisNavigateur {
  private serveur: Server;
  private readonly interne: Server;
  private readonly feuilles: Feuilles;
  private readonly liaisons = new Map<string, EtatLiaison>();
  private readonly ouvertes = new Set<Socket>();
  private readonly journal: (m: string) => void;
  private ino: number | null = null;

  private readonly o: OptionsRelais;

  constructor(o: OptionsRelais) {
    this.o = o;
    this.journal = o.journal ?? ((): void => undefined);
    this.feuilles = new Feuilles(o.autorite);
    this.serveur = this.creerServeur();
    this.interne = serveurHttp((req, res) => {
      const origine = (req.socket as Socket & { origineElpis?: string }).origineElpis ?? "";
      this.versOrigine(req, res, origine, req.url ?? "/").catch((e: unknown) => this.echec(res, e));
    });
    // CONNECT dans un flux déchiffré : un tunnel y échapperait à la purge.
    this.interne.on("connect", (_req: IncomingMessage, s: Socket) => {
      s.end("HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    });
    this.interne.on("upgrade", (req: IncomingMessage, s: Socket, tete: Buffer) =>
      this.miseANiveau(req, s, tete, (s as Socket & { origineElpis?: string }).origineElpis ?? null).catch(
        (e: unknown) => this.echec(s, e),
      ),
    );
  }

  /** Échec d'un traitement (client parti, amont coupé) : connexion fermée, jamais de rejet non traité (l'hôte d'outils sert tous les comptes). */
  private echec(cible: ServerResponse | Socket, e: unknown): void {
    this.journal(`request dropped: ${e instanceof Error ? e.message : String(e)}`);
    cible.destroy();
  }

  private creerServeur(): Server {
    const srv = serveurHttp((req, res) => {
      this.requeteClaire(req, res).catch((e: unknown) => this.echec(res, e));
    });
    srv.on("connect", (req: IncomingMessage, s: Socket, tete: Buffer) => {
      this.tunnel(req, s, tete).catch((e: unknown) => this.echec(s, e));
    });
    srv.on("upgrade", (req: IncomingMessage, s: Socket, tete: Buffer) => {
      this.miseANiveau(req, s, tete, null).catch((e: unknown) => this.echec(s, e));
    });
    srv.on("connection", (s: Socket) => this.suivre(s));
    return srv;
  }

  /** Écoute de nouveau (socket retiré ou remplacé dans le bac), liaisons gardées. */
  async rouvrir(): Promise<void> {
    this.serveur.close();
    this.serveur = this.creerServeur();
    await this.ouvrir();
  }

  private suivre(s: Socket): void {
    this.ouvertes.add(s);
    s.once("close", () => this.ouvertes.delete(s));
    s.on("error", () => s.destroy());
  }

  /** Écoute sur le socket (0666 : le service du bac n'a pas l'UID de l'hôte), ancien socket retiré. */
  async ouvrir(): Promise<void> {
    try {
      unlinkSync(this.o.socket);
    } catch {
      // absent
    }
    // Socket créé par /proc/self/fd/N/nom : un chemin de bac trop long pour sun_path (108 octets) reste utilisable.
    const dossier = openSync(path.dirname(this.o.socket), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await new Promise<void>((ok, ko) => {
        this.serveur.once("error", ko);
        this.serveur.listen(`/proc/self/fd/${dossier}/${path.basename(this.o.socket)}`, () => ok());
      });
    } finally {
      closeSync(dossier);
    }
    this.ino = ouvrirSocketATous(this.o.socket);
  }

  /** Vrai si le socket écouté est toujours celui du relais (le bac peut retirer ou remplacer les fichiers de /run/elpis). */
  ecoute(): boolean {
    try {
      const st = lstatSync(this.o.socket);
      return st.isSocket() && st.ino === this.ino && this.serveur.listening;
    } catch {
      return false;
    }
  }

  async fermer(): Promise<void> {
    for (const s of this.ouvertes) s.destroy();
    await new Promise<void>((ok) => this.serveur.close(() => ok()));
    this.liaisons.clear();
  }

  /** Secret en usage dans une session : ses origines passent par le relais (TLS terminé), sans fenêtre armée. */
  lier(l: LiaisonRelais): void {
    this.liaisons.set(l.id, {
      l,
      fenetreJusqua: 0,
      valeur: null,
      formes: [],
      substitutions: 0,
      refus: 0,
      digest: null,
      nc: 0,
      basic: false,
    });
  }

  /** Ouvre la fenêtre de substitution d'une liaison web-login pour `dureeMs` (le temps d'une connexion). */
  armer(id: string, dureeMs: number): void {
    const e = this.liaisons.get(id);
    if (e === undefined) return;
    e.fenetreJusqua = Date.now() + dureeMs;
    e.substitutions = 0;
    e.refus = 0;
  }

  /** Ferme la fenêtre ; bilan de la connexion (substitutions faites, substituts refusés). */
  desarmer(id: string): { substitutions: number; refus: number } {
    const e = this.liaisons.get(id);
    if (e === undefined) return { substitutions: 0, refus: 0 };
    e.fenetreJusqua = 0;
    return { substitutions: e.substitutions, refus: e.refus };
  }

  oublier(id: string): void {
    this.liaisons.delete(id);
  }

  oublierTout(): void {
    this.liaisons.clear();
  }

  /** Liaisons en cours (identifiants, pour les tests et l'état). */
  ids(): string[] {
    return [...this.liaisons.keys()];
  }

  /** Liaisons qui couvrent la destination jugée `v` (`schema://hote:port`) : décidé sur le nom normalisé ET sur l'adresse jointe, pour qu'une origine de secret soit interceptée quelle que soit la façon de la nommer (adresse IP, point final, autre nom). */
  private async couvrant(
    schema: "http" | "https",
    hote: string,
    port: number,
    v: { readonly adresse: string; readonly adresses?: readonly string[] },
  ): Promise<Couverture> {
    const liees: EtatLiaison[] = [];
    const exactes: EtatLiaison[] = [];
    const schemas = new Set<"http" | "https">();
    if (this.liaisons.size === 0) return { liees, exactes, schemas };
    const nom = hoteNormal(hote);
    const cible = new Set(v.adresses ?? [v.adresse]);
    for (const e of [...this.liaisons.values()]) {
      let touchee = false;
      for (const o of e.l.origines) {
        const p = partiesOrigine(o);
        if (p === null || p.port !== port) continue;
        let meme = p.hote === nom;
        if (!meme) {
          const w = await this.o.juger(p.hote, p.port).catch(() => null);
          meme = w !== null && w.ok && (w.adresses ?? [w.adresse]).some((a) => cible.has(a));
        }
        if (!meme) continue;
        touchee = true;
        schemas.add(p.schema);
        if (p.hote === nom && p.schema === schema && !exactes.includes(e)) exactes.push(e);
      }
      if (touchee) liees.push(e);
    }
    return { liees, exactes, schemas };
  }

  /** TLS de l'amont pour des liaisons exactes : strict, sauf si toutes celles qui couvrent l'origine (une au moins) le relâchent. */
  private optionsTls(
    hote: string,
    exactes: readonly EtatLiaison[],
  ): Pick<OptionsHttps, "servername" | "rejectUnauthorized" | "ca"> {
    return {
      ...(isIP(hote) ? {} : { servername: hote }),
      rejectUnauthorized: !(exactes.length > 0 && exactes.every((e) => e.l.tls === "insecure")),
      ca: this.o.caAmont
        ? [...this.o.caAmont]
        : [...new Set([...getCACertificates("default"), ...getCACertificates("system")])],
    };
  }

  private autorise(req: IncomingMessage): boolean {
    const a = String(req.headers["proxy-authorization"] ?? "");
    const p = a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : "";
    return this.o.jeton !== "" && p !== "" && egal(p, this.o.jeton);
  }

  private async valeur(e: EtatLiaison): Promise<IdentifiantsRelais | null> {
    if (e.valeur !== null) return e.valeur;
    const v = await e.l.resoudre().catch(() => null);
    if (v === null || !v.secret) return null;
    e.valeur = v;
    const formes = new Set([
      ...formesValeur(v.secret),
      ...(e.l.kind === "http-auth" ? formesBasic(v.username, v.secret) : []),
    ]);
    e.formes = [...formes].sort((a, b) => b.length - a.length).map((f) => Buffer.from(f, "utf8"));
    return v;
  }

  /** Requête http en forme absolue : refus, origine d'un secret (traitée), sinon relayée telle quelle. */
  private async requeteClaire(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.on("error", () => undefined);
    if (!this.autorise(req)) return refuser(res, 407, "missing or invalid relay token");
    let u: URL;
    try {
      u = new URL(req.url ?? "");
    } catch {
      return refuser(res, 400, "malformed proxy request");
    }
    if (u.protocol !== "http:") return refuser(res, 400, "only http requests are relayed in clear");
    const hote = hoteNormal(u.hostname);
    if (!hote) return refuser(res, 400, "malformed proxy request");
    await this.versOrigine(req, res, origineDe("http", hote, Number(u.port || 80)), u.pathname + u.search);
  }

  /** CONNECT : refus, tunnel intact, ou TLS terminé pour une origine de secret. */
  private async tunnel(req: IncomingMessage, client: Socket, tete: Buffer): Promise<void> {
    this.suivre(client);
    if (!this.autorise(req))
      return void client.end("HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n");
    const hp = hotePort(req.url ?? "", 443);
    if (hp === null) return void client.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
    const v = await this.o.juger(hp.hote, hp.port);
    if (client.destroyed) return;
    if (!v.ok) {
      this.journal(`refused tunnel ${req.url ?? ""}: ${v.motif}`);
      const corps = `Blocked by the Elpis browser relay: ${v.motif}.`;
      return void client.end(
        `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(corps)}\r\n\r\n${corps}`,
      );
    }
    const c = await this.couvrant("https", hp.hote, hp.port, v);
    if (client.destroyed) return;
    if (c.liees.length > 0 && !c.schemas.has("https")) {
      // Port d'une origine http d'un secret : la même interception, en clair (HTTP ou WebSocket dans le tunnel).
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (tete.length) client.unshift(tete);
      (client as Socket & { origineElpis?: string }).origineElpis = origineDe("http", hp.hote, hp.port);
      this.interne.emit("connection", client);
      return;
    }
    if (c.liees.length === 0) {
      const amont = connexionNet(hp.port, v.adresse, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (tete.length) amont.write(tete);
        amont.pipe(client);
        client.pipe(amont);
      });
      this.suivre(amont);
      const fin = (): void => {
        amont.destroy();
        client.destroy();
      };
      amont.on("error", () => {
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
        fin();
      });
      client.on("close", fin);
      return;
    }
    let contexte: ReturnType<Feuilles["contexte"]>;
    try {
      contexte = this.feuilles.contexte(hp.hote);
    } catch (e) {
      this.journal(`no certificate for ${hp.hote}: ${e instanceof Error ? e.message : String(e)}`);
      return void client.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (tete.length) client.unshift(tete);
    const ts = new TLSSocket(client, { isServer: true, secureContext: contexte }) as TLSSocket & {
      origineElpis?: string;
    };
    ts.origineElpis = origineDe("https", hp.hote, hp.port);
    ts.on("error", () => client.destroy());
    this.interne.emit("connection", ts);
  }

  /** Requête vers `origine` (http en clair, ou https déchiffré) : substitution, authentification HTTP, purge de la réponse. */
  private async versOrigine(
    req: IncomingMessage,
    res: ServerResponse,
    origine: string,
    chemin: string,
  ): Promise<void> {
    req.on("error", () => undefined);
    const methode = (req.method ?? "GET").toUpperCase();
    // TRACE et TRACK renvoient la requête reçue par l'amont (substitution, Authorization) : jamais relayées.
    if (methode === "TRACE" || methode === "TRACK") return refuser(res, 405, `${methode} is not relayed`);
    const p = partiesOrigine(origine);
    if (p === null) return refuser(res, 400, "malformed destination");
    const https = p.schema === "https";
    const { port, hote } = p;
    const v = await this.o.juger(hote, port);
    if (!v.ok) {
      this.journal(`refused ${origine}: ${v.motif}`);
      return refuser(res, 403, v.motif);
    }
    const { liees, exactes } = await this.couvrant(p.schema, hote, port, v);
    const armees = [...this.liaisons.values()].filter(
      (e) => e.l.kind === "web-login" && e.l.substitut !== null && e.fenetreJusqua > Date.now(),
    );
    const lire = liees.length > 0 || armees.length > 0;
    let corps: Buffer | null = lire ? await lireCorps(req, reglagesRelaisNavigateur.corpsMax) : null;
    for (const e of this.liaisons.values()) {
      const sub = e.l.substitut;
      if (e.l.kind !== "web-login" || sub === null) continue;
      const dansUrl = chemin.includes(sub);
      const dansCorps = corps !== null && corps.includes(sub);
      if (!dansUrl && !dansCorps) continue;
      const raison = !exactes.includes(e)
        ? `towards ${origine}, not an origin of the secret`
        : e.fenetreJusqua <= Date.now()
          ? "outside the login window"
          : dansUrl
            ? "in the URL (only request bodies are substituted)"
            : !METHODES_SUBSTITUTION.has(methode)
              ? `in a ${methode} request`
              : e.substitutions >= reglagesRelaisNavigateur.substitutionsMax
                ? "too many submissions in this window"
                : null;
      const id = raison === null ? await this.valeur(e) : null;
      if (raison !== null || id === null || corps === null) {
        e.refus++;
        this.journal(`placeholder of secret '${e.l.nom}' not substituted: ${raison ?? "value unavailable"}`);
        continue;
      }
      corps = remplacerOctets(
        corps,
        Buffer.from(sub, "utf8"),
        Buffer.from(valeurPourCorps(id.secret, String(req.headers["content-type"] ?? "")), "utf8"),
      );
      e.substitutions++;
    }
    const entetes: Record<string, string | string[]> = {};
    for (const [k, val] of Object.entries(req.headers as IncomingHttpHeaders))
      if (val !== undefined && !SAUT_PAR_SAUT.has(k)) entetes[k] = val;
    entetes["host"] = new URL(origine).host;
    if (liees.length > 0) {
      // Réponse entière et sans codage inconnu : une plage ne porterait qu'un morceau de la valeur, hors d'atteinte de la purge.
      entetes["accept-encoding"] = "identity";
      delete entetes["range"];
      delete entetes["if-range"];
    }
    if (corps !== null) {
      delete entetes["transfer-encoding"];
      entetes["content-length"] = String(corps.length);
    }
    const auth = exactes.find((e) => e.l.kind === "http-auth");
    const envoyer = (autorisation: string | null): Promise<IncomingMessage> =>
      new Promise((ok, ko) => {
        const t = { ...entetes, ...(autorisation ? { authorization: autorisation } : {}) };
        const options = {
          host: v.adresse,
          port,
          method: methode,
          path: chemin,
          headers: t,
          setHost: false,
          agent: false as const,
        };
        const r = https
          ? requeteHttps({ ...options, ...this.optionsTls(hote, exactes) } as OptionsHttps, ok)
          : requeteHttp(options, ok);
        r.on("error", ko);
        res.once("close", () => r.destroy());
        if (corps !== null) r.end(corps);
        else req.pipe(r);
      });
    let r: IncomingMessage;
    try {
      r = await envoyer(auth ? await this.autorisationConnue(auth, methode, chemin) : null);
      if (r.statusCode === 401 && auth !== undefined && corps !== null) {
        const a = await this.repondreDefi(auth, r.rawHeaders, methode, chemin);
        if (a !== null) {
          r.resume();
          r = await envoyer(a);
        }
      }
    } catch (e) {
      this.journal(`upstream ${origine} unreachable: ${e instanceof Error ? e.message : String(e)}`);
      return refuser(res, 502, "upstream unreachable");
    }
    const formes = [...new Set(liees.flatMap((e) => e.formes))].sort((a, b) => b.length - a.length);
    const par = Buffer.from(
      liees.find((e) => e.l.substitut !== null && e.formes.length)?.l.substitut ?? MASQUE,
      "utf8",
    );
    const sortie: Record<string, string | string[]> = {};
    const purger = (t: string): string => {
      let x = t;
      for (const f of formes) x = x.split(f.toString("utf8")).join(par.toString("utf8"));
      return x;
    };
    const brut = r.rawHeaders;
    for (let i = 0; i + 1 < brut.length; i += 2) {
      const k = (brut[i] ?? "").toLowerCase();
      if (SAUT_PAR_SAUT.has(k)) continue;
      if (liees.length > 0 && (k === "content-length" || k === "content-encoding")) continue;
      const val = purger(brut[i + 1] ?? "");
      const deja = sortie[k];
      sortie[k] = deja === undefined ? val : ([] as string[]).concat(deja, val);
    }
    if (liees.length === 0) {
      res.writeHead(r.statusCode ?? 502, r.statusMessage, sortie);
      await pipeline(r, res).catch(() => res.destroy());
      return;
    }
    // Un seul codage connu est décodé puis purgé ; tout autre (zstd, codages empilés « gzip, br ») passerait sans purge : refusé.
    const codage = String(r.headers["content-encoding"] ?? "")
      .toLowerCase()
      .trim();
    const etapes: NodeJS.ReadWriteStream[] = [];
    if (codage === "gzip" || codage === "x-gzip") etapes.push(createGunzip());
    else if (codage === "deflate") etapes.push(createInflate());
    else if (codage === "br") etapes.push(createBrotliDecompress());
    else if (codage !== "" && codage !== "identity") {
      r.resume();
      this.journal(`response of ${origine} refused: content encoding '${codage}' cannot be scrubbed`);
      return refuser(res, 502, `content encoding '${codage}' of an origin covered by a secret`);
    }
    res.writeHead(r.statusCode ?? 502, r.statusMessage, sortie);
    if (formes.length) etapes.push(new Purgeur(formes, par));
    await (pipeline as (...f: unknown[]) => Promise<void>)(r, ...etapes, res).catch(() => res.destroy());
  }

  /** Authorization connue d'avance pour une liaison http-auth (Basic après un premier défi, Digest au nonce courant). */
  private async autorisationConnue(e: EtatLiaison, methode: string, uri: string): Promise<string | null> {
    if (!e.basic && e.digest === null) return null;
    const id = await this.valeur(e);
    if (id === null) return null;
    if (e.digest !== null) return reponseDigest(e.digest, id, methode, uri, ++e.nc);
    return "Basic " + Buffer.from(`${id.username}:${id.secret}`, "utf8").toString("base64");
  }

  /** Réponse à un défi 401 de l'amont (Basic ou Digest), retenue pour les requêtes suivantes ; `null` sans défi utilisable. */
  private async repondreDefi(
    e: EtatLiaison,
    brut: readonly string[],
    methode: string,
    uri: string,
  ): Promise<string | null> {
    const defis = defisAuth(brut);
    const digest = defis.find(
      (d) => d.schema === "digest" && /^(md5|sha-256)(-sess)?$/iu.test(d.params["algorithm"] ?? "MD5"),
    );
    const basic = defis.find((d) => d.schema === "basic");
    if (digest === undefined && basic === undefined) return null;
    const id = await this.valeur(e);
    if (id === null) return null;
    if (digest !== undefined) {
      const qop = (digest.params["qop"] ?? "").split(",").map((x) => x.trim().toLowerCase());
      e.digest = {
        realm: digest.params["realm"] ?? "",
        nonce: digest.params["nonce"] ?? "",
        opaque: digest.params["opaque"] ?? null,
        qop: qop.includes("auth") ? "auth" : null,
        algorithme: digest.params["algorithm"] ?? "MD5",
      };
      e.nc = 0;
      return reponseDigest(e.digest, id, methode, uri, ++e.nc);
    }
    e.basic = true;
    return "Basic " + Buffer.from(`${id.username}:${id.secret}`, "utf8").toString("base64");
  }

  /** WebSocket (mise à niveau) : relayé tel quel, sans substitution ni purge (connexions WebSocket hors du périmètre des secrets). */
  private async miseANiveau(
    req: IncomingMessage,
    client: Socket,
    tete: Buffer,
    origineInterceptee: string | null,
  ): Promise<void> {
    this.suivre(client);
    let u: URL;
    try {
      u = new URL(origineInterceptee === null ? (req.url ?? "") : `${origineInterceptee}${req.url ?? "/"}`);
    } catch {
      return void client.destroy();
    }
    if (origineInterceptee === null && !this.autorise(req)) return void client.destroy();
    const tls = u.protocol === "https:" || u.protocol === "wss:";
    const port = Number(u.port || (tls ? 443 : 80));
    const hote = hoteNormal(u.hostname);
    const v = await this.o.juger(hote, port);
    if (!v.ok || client.destroyed) return void client.destroy();
    // Amont en TLS comme pour une requête : strict, sauf liaisons exactes qui le relâchent toutes.
    const { exactes } = await this.couvrant(tls ? "https" : "http", hote, port, v);
    if (client.destroyed) return;
    const lignes = [`${req.method ?? "GET"} ${u.pathname}${u.search} HTTP/1.1`];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2)
      if (!/^proxy-/iu.test(req.rawHeaders[i] ?? ""))
        lignes.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    const amont = tls
      ? connexionTls({ host: v.adresse, port, ...this.optionsTls(hote, exactes) })
      : connexionNet(port, v.adresse);
    this.suivre(amont);
    amont.once(tls ? "secureConnect" : "connect", () => {
      amont.write(lignes.join("\r\n") + "\r\n\r\n");
      if (tete.length) amont.write(tete);
      amont.pipe(client);
      client.pipe(amont);
    });
    amont.on("error", () => client.destroy());
    client.on("close", () => amont.destroy());
  }
}
