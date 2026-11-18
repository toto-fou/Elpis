// SPDX-License-Identifier: MIT
/** apps/core/src/identite/sortant.ts — client sortant des fournisseurs d'identité (https et ldaps) : adresses jugées puis épinglées, ancres de confiance, TLS 1.2 au moins, ni redirection ni proxy, tailles et délais bornés. */
import type { TLSSocket } from "node:tls";

import { adresseIpOuNul } from "@elpis/commun";
import {
  agentEpingle,
  autoritesTls,
  certificatsPem,
  CODE_REFUS,
  connecteurEpingle,
  fetchPar,
} from "@elpis/http";
import type { JugeHote } from "@elpis/http";
import type { Resolveur } from "@elpis/securite";

import { gardeGit } from "../git/garde";

export const DELAI_CONNEXION_MS = 5_000;
export const DELAI_TOTAL_MS = 10_000;
export const TAILLE_MAX = 1024 * 1024;

export type CodeSortant =
  | "ca_illisible"
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

  constructor(code: CodeSortant) {
    super(code);
    this.name = "ErreurSortant";
    this.code = code;
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
}

/** Juge de production : adresses jugées par `gardeGit` (réseau local permis ; boucle, lien local, non spécifiée et multidiffusion refusés), une seule résolution, adresses validées rendues. */
export function jugeSortant(resoudre?: Resolveur): JugeHote {
  return async (hote, port) => {
    const url = `https://${hote.includes(":") ? `[${hote}]` : hote}:${port}/`;
    const v = await gardeGit(url, {
      allowSchemes: ["https"],
      allowHosts: [],
      criticalOnly: true,
      ...(resoudre === undefined ? {} : { resoudre }),
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
      if (/^ERR_SSL_.*(VERSION|PROTOCOL)/u.test(code)) return "version_tls";
      if (/^ERR_(SSL|TLS)_/u.test(code)) return "tls";
    }
    if (x.name === "TimeoutError" || x.name === "AbortError") return "delai";
  }
  return "reseau";
}

function ancres(o: OptionsSortant): readonly string[] {
  const collees = o.caPem ?? "";
  try {
    return collees.trim() !== "" ? certificatsPem(collees) : (o.magasin ?? autoritesTls());
  } catch {
    throw new ErreurSortant("ca_illisible");
  }
}

function borne(valeur: number | undefined, maximum: number): number {
  return valeur !== undefined && valeur > 0 ? Math.min(valeur, maximum) : maximum;
}

function optionsTls(o: OptionsSortant): {
  ca: string[];
  minVersion: "TLSv1.2";
  rejectUnauthorized: true;
  timeout: number;
  maxCachedSessions: 0;
} {
  return {
    ca: [...ancres(o)],
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
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
  const agent = agentEpingle(o.juger ?? jugeSortant(o.resoudre), optionsTls(o), {
    allowH2: false,
    headersTimeout: total,
    bodyTimeout: total,
  });
  const pareFeu = fetchPar(agent);
  const f: typeof globalThis.fetch = async (entree, init) => {
    try {
      if (!URL.canParse(urlDe(entree))) throw new ErreurSortant("schema");
      const u = new URL(urlDe(entree));
      if (u.protocol !== "https:" || u.username !== "" || u.password !== "")
        throw new ErreurSortant("schema");
      const signal = AbortSignal.any([AbortSignal.timeout(total), ...(init?.signal ? [init.signal] : [])]);
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
      throw e instanceof ErreurSortant ? e : new ErreurSortant(classerErreur(e));
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

const CONTROLE = /\p{Cc}/gu;

function nomCourt(champ: unknown): string {
  const o = (champ ?? {}) as Record<string, unknown>;
  const v = o["CN"] ?? o["O"];
  const texte = Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "";
  return texte.replace(CONTROLE, "?").slice(0, 120);
}

/** Connexion TLS brute (ldaps) : même juge, mêmes adresses épinglées, même vérification ; rend la socket (seulement si `authorized`) et ce que le certificat présenté permet de décrire. */
export async function connexionTls(
  hote: string,
  port: number,
  o: OptionsSortant = {},
): Promise<{ socket: TLSSocket; certificat: CertificatPresente }> {
  const options = optionsTls(o);
  const connecter = connecteurEpingle(o.juger ?? jugeSortant(o.resoudre), options);
  const nu = hote.replace(/^\[(.*)\]$/su, "$1");
  const litterale = adresseIpOuNul(nu) !== null;
  let abandonne = false;
  const socket = await new Promise<TLSSocket>((resoudre, rejeter) => {
    const minuteur = setTimeout(() => {
      abandonne = true;
      rejeter(new ErreurSortant("delai"));
    }, options.timeout);
    connecter(
      {
        hostname: nu,
        host: nu,
        protocol: "https:",
        port: String(port),
        servername: litterale ? undefined : nu,
      },
      (err, s) => {
        clearTimeout(minuteur);
        if (err !== null || s === null) {
          if (!abandonne) rejeter(new ErreurSortant(classerErreur(err)));
          return;
        }
        if (abandonne) s.destroy();
        else resoudre(s as TLSSocket);
      },
    );
  });
  if (socket.authorized !== true) {
    socket.destroy();
    throw new ErreurSortant("tls");
  }
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
