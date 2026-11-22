// SPDX-License-Identifier: MIT
/** apps/core/src/identite/sortant.ts — client sortant des fournisseurs d'identité (https) : adresses jugées puis épinglées, ancres de confiance, TLS 1.2 au moins, ni redirection ni proxy, tailles et délais bornés. */
import { lookup } from "node:dns/promises";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";
import type { PeerCertificate, TLSSocket } from "node:tls";

import { adresseIpOuNul } from "@elpis/commun";
import {
  agentEpingle,
  autoritesTls,
  certificatsPem,
  CODE_REFUS,
  fetchPar,
  rechercheEpinglee,
} from "@elpis/http";
import type { JugeHote } from "@elpis/http";
import type { Resolveur } from "@elpis/securite";

import { gardeGit } from "../git/garde";

const RESOLUTIONS_SIMULTANEES = 2;
const DELAI_RESOLUTION_MS = 5_000;

export const DELAI_CONNEXION_MS = 5_000;
export const DELAI_TOTAL_MS = 10_000;
export const TAILLE_MAX = 1024 * 1024;

export type CodeSortant =
  | "ca_illisible"
  | "magasin_illisible"
  | "pas_tls"
  | "adresse_refusee"
  | "resolution"
  | "refusee"
  | "delai"
  | "cert_expire"
  | "cert_futur"
  | "ca_inconnue"
  | "auto_signe"
  | "nom_certificat"
  | "version_tls"
  | "tls"
  | "redirection"
  | "taille"
  | "schema"
  | "reseau";

/** Échec du client sortant : un code fermé, jamais le message d'un tiers. */
export class ErreurSortant extends Error {
  readonly code: CodeSortant;
  readonly elpisSansSan: boolean;

  constructor(code: CodeSortant, sansSan = false) {
    super(code);
    this.name = "ErreurSortant";
    this.code = code;
    this.elpisSansSan = sansSan;
  }
}

/** Réglages d'un appel ; la résolution, le juge, le magasin et les bornes ne s'injectent que par ce paramètre (jamais lus d'une configuration ni de l'environnement), et les bornes ne peuvent que se resserrer. */
export interface OptionsSortant {
  /** Autorités collées du fournisseur : si présentes, elles seules font foi. */
  readonly caPem?: string;
  readonly resoudre?: Resolveur;
  readonly juger?: JugeHote;
  readonly magasin?: readonly string[];
  readonly delaiConnexionMs?: number;
  readonly delaiTotalMs?: number;
  readonly tailleMax?: number;
  /** Échéance du travail en cours : plus aucune résolution ni connexion ne démarre une fois levée. */
  readonly signal?: AbortSignal;
}

export interface OptionsResolution {
  readonly chercher?: (hote: string) => Promise<string[]>;
  readonly delaiMs?: number;
  readonly simultanes?: number;
}

async function chercherSysteme(hote: string): Promise<string[]> {
  return (await lookup(hote, { all: true, order: "verbatim" })).map((r) => r.address);
}

/** Résolveur à délai fixe et au plus N recherches du système en vol (le fil occupé n'est rendu que quand la recherche finit réellement) : le groupe de fils commun ne se sature pas. */
export function creerResolutionBornee(o: OptionsResolution = {}): Resolveur {
  const chercher = o.chercher ?? chercherSysteme;
  const delai = o.delaiMs ?? DELAI_RESOLUTION_MS;
  const maximum = o.simultanes ?? RESOLUTIONS_SIMULTANEES;
  let enCours = 0;
  const attente: (() => void)[] = [];
  const echec = (): Error => Object.assign(new Error("resolution"), { code: "EAI_AGAIN" });
  const prendre = (): Promise<void> => {
    if (enCours < maximum) {
      enCours += 1;
      return Promise.resolve();
    }
    return new Promise<void>((ok, ko) => {
      const reveil = (): void => {
        clearTimeout(minuteur);
        ok();
      };
      const minuteur = setTimeout(() => {
        attente.splice(attente.indexOf(reveil), 1);
        ko(echec());
      }, delai);
      attente.push(reveil);
    });
  };
  const rendre = (): void => {
    const suivant = attente.shift();
    if (suivant === undefined) enCours -= 1;
    else suivant();
  };
  return async (hote) => {
    await prendre();
    const travail = Promise.resolve()
      .then(() => chercher(hote))
      .finally(rendre);
    let minuteur: NodeJS.Timeout | undefined;
    const limite = new Promise<never>((_, ko) => {
      minuteur = setTimeout(() => ko(echec()), delai);
    });
    try {
      return await Promise.race([travail, limite]);
    } finally {
      clearTimeout(minuteur);
    }
  };
}

const resolutionSortant = creerResolutionBornee();

/** Juge de production : adresses jugées par `gardeGit` (réseau local permis ; boucle, lien local, non spécifiée et multidiffusion refusés), une seule résolution bornée en temps, adresses validées rendues. */
export function jugeSortant(resoudre: Resolveur = resolutionSortant): JugeHote {
  return async (hote, port) => {
    const url = `https://${hote.includes(":") ? `[${hote}]` : hote}:${port}/`;
    const v = await gardeGit(url, {
      allowSchemes: ["https"],
      allowHosts: [],
      criticalOnly: true,
      resoudre,
    });
    if (v.motif !== null) return { motif: v.motif, adresses: [] };
    return { motif: null, adresses: v.adresses ?? (adresseIpOuNul(hote) !== null ? [hote] : []) };
  };
}

function enChaine(e: unknown): Error[] {
  const chaine: Error[] = [];
  for (let c: unknown = e; c instanceof Error && chaine.length < 6; c = c.cause) chaine.push(c);
  return chaine;
}

const CODES_TLS: Readonly<Record<string, CodeSortant>> = {
  CERT_HAS_EXPIRED: "cert_expire",
  CERT_NOT_YET_VALID: "cert_futur",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "ca_inconnue",
  UNABLE_TO_GET_ISSUER_CERT: "ca_inconnue",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "ca_inconnue",
  SELF_SIGNED_CERT_IN_CHAIN: "ca_inconnue",
  CERT_UNTRUSTED: "ca_inconnue",
  DEPTH_ZERO_SELF_SIGNED_CERT: "auto_signe",
  ERR_TLS_CERT_ALTNAME_INVALID: "nom_certificat",
  ECONNREFUSED: "refusee",
  ENOTFOUND: "resolution",
  EAI_AGAIN: "resolution",
  ETIMEDOUT: "delai",
  UND_ERR_CONNECT_TIMEOUT: "delai",
  UND_ERR_HEADERS_TIMEOUT: "delai",
  UND_ERR_BODY_TIMEOUT: "delai",
  ERR_SSL_WRONG_VERSION_NUMBER: "pas_tls",
  ERR_SSL_HTTP_REQUEST: "pas_tls",
  ERR_SSL_HTTPS_PROXY_REQUEST: "pas_tls",
  ERR_SSL_UNKNOWN_PROTOCOL: "pas_tls",
  ERR_SSL_PACKET_LENGTH_TOO_LONG: "pas_tls",
  ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION: "version_tls",
  ERR_SSL_UNSUPPORTED_PROTOCOL: "version_tls",
  ERR_SSL_NO_PROTOCOLS_AVAILABLE: "version_tls",
  ERR_SSL_TLSV1_ALERT_INSUFFICIENT_SECURITY: "version_tls",
  [CODE_REFUS]: "adresse_refusee",
};

/** Code fermé d'une erreur réseau ou TLS de Node ou d'undici ; seul son `code` ou son nom est lu, jamais son message. */
export function classerErreur(e: unknown): CodeSortant {
  for (const x of enChaine(e)) {
    if (x instanceof ErreurSortant) return x.code;
    const code = (x as { code?: unknown }).code;
    if (typeof code === "string") {
      const connu = CODES_TLS[code];
      if (connu !== undefined) return connu;
      if (/^ERR_(SSL|TLS)_/u.test(code)) return "tls";
    }
    if (x.name === "TimeoutError" || x.name === "AbortError") return "delai";
  }
  return "reseau";
}

function ancres(o: OptionsSortant): readonly string[] {
  const collees = o.caPem ?? "";
  const colle = collees.trim() !== "";
  try {
    return colle ? certificatsPem(collees) : (o.magasin ?? autoritesTls());
  } catch {
    throw new ErreurSortant(colle ? "ca_illisible" : "magasin_illisible");
  }
}

function borne(valeur: number | undefined, maximum: number): number {
  return valeur !== undefined && valeur > 0 ? Math.min(valeur, maximum) : maximum;
}

/** Suites acceptées : échange de clés à confidentialité persistante et chiffrement authentifié seulement. */
const SUITES_TLS = [
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_AES_128_GCM_SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "DHE-RSA-AES256-GCM-SHA384",
  "DHE-RSA-AES128-GCM-SHA256",
].join(":");

const JOKER_ADMIS = /^\*\.[^*.]+(?:\.[^*.]+)+$/u;
const NOM_INVALIDE = "ERR_TLS_CERT_ALTNAME_INVALID";

/** Entrées du subjectAltName tel que Node l'écrit (« , » hors d'une valeur entre guillemets) ; `null` si des guillemets ne se referment pas. */
function entreesSan(san: string): string[] | null {
  const entrees: string[] = [];
  let debut = 0;
  let guillemets = false;
  for (let i = 0; i < san.length; i++) {
    const c = san[i];
    if (guillemets && c === "\\") i++;
    else if (c === '"') guillemets = !guillemets;
    else if (!guillemets && c === "," && san[i + 1] === " ") {
      entrees.push(san.slice(debut, i));
      debut = i + 2;
      i++;
    }
  }
  if (guillemets) return null;
  entrees.push(san.slice(debut));
  return entrees;
}

/** Une entrée DNS n'est gardée que sans guillemets (aucun nom d'hôte n'en demande) et, avec un joker, seulement dans la forme admise. */
function entreeAdmise(e: string): boolean {
  if (!e.startsWith("DNS:")) return true;
  const nom = e.slice(4);
  return !nom.includes('"') && (!nom.includes("*") || JOKER_ADMIS.test(nom));
}

/** Vrai quand l'erreur vient d'un certificat sans extension subjectAltName. */
export function sansNomAlternatif(e: unknown): boolean {
  return enChaine(e).some((x) => (x as { elpisSansSan?: unknown }).elpisSansSan === true);
}

/** Nom du serveur selon RFC 9525 : subjectAltName obligatoire (le CN n'est jamais lu), joker admis seulement comme étiquette de gauche entière avec deux étiquettes derrière, comparaison déléguée à Node sur un certificat nettoyé. */
export function verifierNomServeur(hote: string, cert: PeerCertificate): Error | undefined {
  const san = (cert as { subjectaltname?: unknown }).subjectaltname;
  if (typeof san !== "string" || san.trim() === "")
    return Object.assign(new Error("subjectAltName absent"), { code: NOM_INVALIDE, elpisSansSan: true });
  const illisible = Object.assign(new Error("subjectAltName illisible"), { code: NOM_INVALIDE });
  const entrees = entreesSan(san);
  if (entrees === null) return illisible;
  try {
    return checkServerIdentity(hote, {
      ...cert,
      subject: undefined,
      subjectaltname: entrees.filter(entreeAdmise).join(", "),
    } as unknown as PeerCertificate);
  } catch {
    return illisible;
  }
}

function optionsTls(o: OptionsSortant): {
  ca: string[];
  ciphers: string;
  minVersion: "TLSv1.2";
  minDHSize: 2048;
  rejectUnauthorized: true;
  checkServerIdentity: typeof verifierNomServeur;
  timeout: number;
  maxCachedSessions: 0;
} {
  return {
    ca: [...ancres(o)],
    ciphers: SUITES_TLS,
    minVersion: "TLSv1.2",
    minDHSize: 2048,
    rejectUnauthorized: true,
    checkServerIdentity: verifierNomServeur,
    timeout: borne(o.delaiConnexionMs, DELAI_CONNEXION_MS),
    maxCachedSessions: 0,
  };
}

export interface ClientHttps {
  /** `fetch` dont chaque connexion est jugée et épinglée ; une réponse 3xx, un corps de plus de 1 Mio ou un délai dépassé lèvent `ErreurSortant`. */
  readonly fetch: typeof globalThis.fetch;
  fermer(): Promise<void>;
}

function urlDe(entree: Parameters<typeof globalThis.fetch>[0]): string {
  return typeof entree === "string" ? entree : entree instanceof URL ? entree.href : entree.url;
}

async function lireBorne(rep: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const annonce = Number(rep.headers.get("content-length"));
  if (Number.isFinite(annonce) && annonce > max) {
    await rep.body?.cancel().catch(() => undefined);
    throw new ErreurSortant("taille");
  }
  const morceaux: Uint8Array[] = [];
  let total = 0;
  const lecteur = rep.body?.getReader();
  while (lecteur !== undefined) {
    const { done, value } = await lecteur.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await lecteur.cancel().catch(() => undefined);
      throw new ErreurSortant("taille");
    }
    morceaux.push(value);
  }
  const sortie = new Uint8Array(total);
  let decalage = 0;
  for (const m of morceaux) {
    sortie.set(m, decalage);
    decalage += m.byteLength;
  }
  return sortie;
}

const SANS_CORPS = new Set([101, 204, 205, 304]);

/** Client https : `https:` seulement, aucune redirection suivie, aucun proxy d'environnement, HTTP/1.1, corps lu en entier sous 1 Mio, délai total de 10 s. */
export function clientHttps(o: OptionsSortant = {}): ClientHttps {
  const total = borne(o.delaiTotalMs, DELAI_TOTAL_MS);
  const max = borne(o.tailleMax, TAILLE_MAX);
  const agent = agentEpingle(
    o.juger ?? jugeSortant(o.resoudre),
    { ...optionsTls(o), allowH2: false },
    {
      allowH2: false,
      headersTimeout: total,
      bodyTimeout: total,
    },
  );
  const pareFeu = fetchPar(agent);
  const f: typeof globalThis.fetch = async (entree, init) => {
    try {
      if (!URL.canParse(urlDe(entree))) throw new ErreurSortant("schema");
      const u = new URL(urlDe(entree));
      if (u.protocol !== "https:" || u.username !== "" || u.password !== "")
        throw new ErreurSortant("schema");
      const signal = AbortSignal.any([
        AbortSignal.timeout(total),
        ...(o.signal ? [o.signal] : []),
        ...(init?.signal ? [init.signal] : []),
      ]);
      const rep = await pareFeu(entree, { ...init, redirect: "manual", signal });
      if ((rep.status >= 300 && rep.status < 400) || rep.type === "opaqueredirect") {
        await rep.body?.cancel().catch(() => undefined);
        throw new ErreurSortant("redirection");
      }
      const octets = await lireBorne(rep, max);
      return new Response(SANS_CORPS.has(rep.status) ? null : octets, {
        status: rep.status,
        statusText: rep.statusText,
        headers: rep.headers,
      });
    } catch (e) {
      throw e instanceof ErreurSortant ? e : new ErreurSortant(classerErreur(e), sansNomAlternatif(e));
    }
  };
  return { fetch: f, fermer: () => agent.close() };
}

export interface CertificatPresente {
  readonly sujet: string;
  readonly emetteur: string;
  /** Secondes depuis l'époque. */
  readonly valide_du: number;
  readonly valide_au: number;
  readonly version_tls: string;
  readonly adresse: string;
}

const CONTROLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Nom d'un champ de certificat présenté, sans caractère de contrôle, de mise en forme ni séparateur de ligne, borné à 120 caractères. */
export function nomCourt(champ: unknown): string {
  const o = (champ ?? {}) as Record<string, unknown>;
  const v = o["CN"] ?? o["O"];
  const texte = Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "";
  return texte.replace(CONTROLE, "?").slice(0, 120);
}

function ouvrirTls(
  hote: string,
  port: number,
  juger: JugeHote,
  options: ReturnType<typeof optionsTls>,
  signal: AbortSignal | undefined,
): Promise<TLSSocket> {
  const litterale = adresseIpOuNul(hote) !== null;
  return new Promise<TLSSocket>((resoudre, rejeter) => {
    let termine = false;
    let socket: TLSSocket | undefined;
    const echouer = (code: CodeSortant, sansSan = false): void => {
      if (termine) return;
      termine = true;
      clearTimeout(minuteur);
      signal?.removeEventListener("abort", surEcheance);
      socket?.destroy();
      rejeter(new ErreurSortant(code, sansSan));
    };
    const surEcheance = (): void => echouer("delai");
    const minuteur = setTimeout(surEcheance, options.timeout);
    signal?.addEventListener("abort", surEcheance, { once: true });
    if (signal?.aborted) {
      surEcheance();
      return;
    }
    juger(hote, port).then(
      (v) => {
        if (termine) return;
        if (signal?.aborted) return surEcheance();
        if (v.motif !== null || v.adresses.length === 0) return echouer("adresse_refusee");
        socket = tlsConnect({
          host: hote,
          port,
          servername: litterale ? undefined : hote,
          lookup: rechercheEpinglee(v.adresses),
          ca: options.ca,
          ciphers: options.ciphers,
          minVersion: options.minVersion,
          minDHSize: options.minDHSize,
          rejectUnauthorized: options.rejectUnauthorized,
          checkServerIdentity: options.checkServerIdentity,
        });
        socket.on("error", (e) => echouer(classerErreur(e), sansNomAlternatif(e)));
        socket.once("secureConnect", () => {
          if (termine) return;
          if (socket?.authorized !== true) return echouer("tls");
          termine = true;
          clearTimeout(minuteur);
          signal?.removeEventListener("abort", surEcheance);
          resoudre(socket);
        });
      },
      (e: unknown) => echouer(classerErreur(e)),
    );
  });
}

/** Connexion TLS brute (étape TLS du test d'un fournisseur), sans ALPN : même juge, mêmes adresses épinglées, mêmes ancres, même vérification ; rend la socket (seulement si `authorized`) et ce que le certificat présenté permet de décrire. */
export async function connexionTls(
  hote: string,
  port: number,
  o: OptionsSortant = {},
): Promise<{ socket: TLSSocket; certificat: CertificatPresente }> {
  const options = optionsTls(o);
  const nu = hote.replace(/^\[(.*)\]$/su, "$1");
  const socket = await ouvrirTls(nu, port, o.juger ?? jugeSortant(o.resoudre), options, o.signal);
  const c = socket.getPeerCertificate();
  const certificat: CertificatPresente = {
    sujet: nomCourt(c.subject),
    emetteur: nomCourt(c.issuer),
    valide_du: Math.floor(Date.parse(c.valid_from) / 1000),
    valide_au: Math.floor(Date.parse(c.valid_to) / 1000),
    version_tls: socket.getProtocol() ?? "",
    adresse: socket.remoteAddress ?? "",
  };
  return { socket, certificat };
}
