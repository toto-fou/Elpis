// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/client.ts — adaptateur strict de ldapts (seul importeur) : socket LDAPS déjà vérifiée et épinglée, liaison vide refusée, recherche bornée, erreurs sans message du serveur. */
import type * as tls from "node:tls";
import type { TLSSocket } from "node:tls";

import {
  AndFilter,
  Client,
  EqualityFilter,
  Filter,
  FilterParser,
  MessageParserError,
  NotFilter,
  OrFilter,
  ResultCodeError,
} from "ldapts";
import type { Entry } from "ldapts";

import type { FournisseurLdap } from "../reglages";
import { connexionTls, ErreurSortant } from "../sortant";
import type { OptionsSortant } from "../sortant";
import { ErreurAnnuaire } from "./erreur";

export interface EntreeAnnuaire {
  readonly dn: string;
  /** Noms d'attributs en minuscules ; un attribut demandé et absent vaut une liste vide. */
  readonly attrs: Readonly<Record<string, readonly (string | Buffer)[]>>;
}

export interface OptionsRecherche {
  readonly portee: "base" | "sub";
  readonly filtre: string;
  readonly attributs: readonly string[];
  readonly limite: number;
  /** Ne transmet pas la limite au serveur : la réponse est tronquée ici, un « limite atteinte » du serveur est alors une erreur. */
  readonly sansLimiteServeur?: boolean;
}

export interface ConnexionAnnuaire {
  lier(dn: string, motDePasse: string): Promise<void>;
  chercher(base: string, o: OptionsRecherche): Promise<EntreeAnnuaire[]>;
  fermer(): Promise<void>;
}

export type FabriqueConnexion = (fournisseur: FournisseurLdap, url: string) => Promise<ConnexionAnnuaire>;

export const MOT_DE_PASSE_MAX_OCTETS = 1024;
export const DN_MAX = 2048;
export const LIMITE_MAX = 1000;
const FILTRE_MAX = 4096;
const ATTRIBUT = /^[A-Za-z][A-Za-z0-9.;-]{0,127}$/u;
const OID_SANS_ATTRIBUT = "1.1";
const BINAIRES = ["objectGUID", "objectguid", "ObjectGUID", "objectGuid"];
const URL_LDAPS = /^ldaps:\/\/(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::\d{1,5})?$/u;

/** Échappement RFC 4515 de la bibliothèque (chaîne ou octets). */
export function echapperFiltre(valeur: string | Buffer): string {
  return Filter.escape(valeur);
}

/** Vérifie qu'un filtre se lit (RFC 4515) ; sinon erreur de configuration. */
export function verifierFiltre(filtre: string): void {
  try {
    FilterParser.parseString(filtre);
  } catch {
    throw new ErreurAnnuaire("configuration");
  }
}

const SENTINELLE = "elpis-sentinelle-9f3a";

/** Vrai si, dans le filtre `(attribut=…)` lu par la bibliothèque, la valeur de l'unique `{username}` du gabarit est exactement celle d'une égalité hors de tout « non ». */
export function gabaritEnEgalite(gabarit: string): boolean {
  let filtre: Filter;
  try {
    filtre = FilterParser.parseString(gabarit.replace("{username}", SENTINELLE));
  } catch {
    return false;
  }
  let egalites = 0;
  const ok = (f: Filter, sousNon: boolean): boolean => {
    if (f instanceof AndFilter || f instanceof OrFilter) return f.filters.every((x) => ok(x, sousNon));
    if (f instanceof NotFilter) return ok(f.filter, true);
    if (!f.toString().includes(SENTINELLE)) return true;
    if (sousNon || !(f instanceof EqualityFilter) || String(f.value) !== SENTINELLE) return false;
    egalites++;
    return true;
  };
  return ok(filtre, false) && egalites === 1;
}

/** Traduit toute erreur de la bibliothèque ou du réseau en erreur d'annuaire, sans garder son message. */
export function traduireErreur(e: unknown): ErreurAnnuaire {
  if (e instanceof ErreurAnnuaire) return e;
  if (e instanceof ResultCodeError)
    return new ErreurAnnuaire(e.code === 49 ? "identifiants" : "protocole", { code: e.code });
  if (e instanceof ErreurSortant)
    return new ErreurAnnuaire(
      e.code === "ca_illisible" || e.code === "magasin_illisible" || e.code === "schema"
        ? "configuration"
        : "injoignable",
      { sortant: e.code },
    );
  if (e instanceof MessageParserError) return new ErreurAnnuaire("protocole");
  return new ErreurAnnuaire("injoignable", { sortant: "reseau" });
}

function texteSain(v: unknown, max: number): v is string {
  return typeof v === "string" && v.isWellFormed() && v.length <= max && !v.includes("\0");
}

function verifierLiaison(dn: unknown, motDePasse: unknown): void {
  const refus = (): never => {
    throw new ErreurAnnuaire("identifiants");
  };
  if (!texteSain(dn, DN_MAX) || dn === "" || !dn.includes("=")) refus();
  if (typeof motDePasse !== "string" || motDePasse === "" || motDePasse.includes("\0")) refus();
  if (Buffer.byteLength(motDePasse as string) > MOT_DE_PASSE_MAX_OCTETS) refus();
}

function verifierRecherche(base: unknown, o: OptionsRecherche): void {
  const refus = (): never => {
    throw new ErreurAnnuaire("configuration");
  };
  if (!texteSain(base, DN_MAX)) refus();
  if (o.portee !== "base" && o.portee !== "sub") refus();
  if (!texteSain(o.filtre, FILTRE_MAX) || o.filtre === "") refus();
  if (!Number.isInteger(o.limite) || o.limite < 1 || o.limite > LIMITE_MAX) refus();
  if (!Array.isArray(o.attributs) || o.attributs.length === 0 || o.attributs.length > 64) refus();
  for (const a of o.attributs)
    if (typeof a !== "string" || (a !== OID_SANS_ATTRIBUT && !ATTRIBUT.test(a))) refus();
  verifierFiltre(o.filtre);
}

/** Entrée de la bibliothèque en entrée d'annuaire : noms en minuscules, valeurs toujours en liste, `dn` et renvois écartés. */
export function normaliserEntree(brut: Entry): EntreeAnnuaire {
  const attrs: Record<string, (string | Buffer)[]> = {};
  for (const [nom, valeur] of Object.entries(brut)) {
    if (nom === "dn") continue;
    const liste = Array.isArray(valeur) ? valeur : [valeur];
    (attrs[nom.toLowerCase()] ??= []).push(...(liste as (string | Buffer)[]));
  }
  return { dn: brut.dn, attrs };
}

/** Octets reçus au plus par opération (liaison, recherche) ; au-delà la socket est détruite. */
export const OCTETS_RECUS_MAX = 1024 * 1024;

interface Reception {
  octets: number;
  depasse: boolean;
}

/** Compte les octets reçus sur la socket avant ldapts (le compteur repart à chaque opération) et la détruit au-delà du plafond. */
function lierSocketUnique(socket: TLSSocket, r: Reception): typeof tls.connect {
  let servie = false;
  return (() => {
    if (servie) throw new Error("socket déjà servie");
    servie = true;
    socket.on("data", (morceau: Buffer) => {
      r.octets += morceau.length;
      if (r.octets > OCTETS_RECUS_MAX && !r.depasse) {
        r.depasse = true;
        socket.destroy();
      }
    });
    return socket;
  }) as unknown as typeof tls.connect;
}

interface Ouverte {
  readonly client: Client;
  readonly socket: TLSSocket;
  readonly reception: Reception;
}

class ConnexionLdapts implements ConnexionAnnuaire {
  private lie = false;
  private ouverte: Promise<Ouverte> | null = null;
  private ferme = false;

  private readonly ouvrir: () => Promise<Ouverte>;
  private readonly delaiSec: number;

  constructor(ouvrir: () => Promise<Ouverte>, delaiSec: number) {
    this.ouvrir = ouvrir;
    this.delaiSec = delaiSec;
  }

  private obtenir(): Promise<Ouverte> {
    if (this.ferme) return Promise.reject(new ErreurAnnuaire("injoignable"));
    this.ouverte ??= this.ouvrir();
    return this.ouverte;
  }

  async lier(dn: string, motDePasse: string): Promise<void> {
    verifierLiaison(dn, motDePasse);
    if (this.lie) throw new ErreurAnnuaire("configuration");
    this.lie = true;
    try {
      const { client, reception } = await this.obtenir();
      reception.octets = 0;
      await client.bind(dn, motDePasse);
      if (reception.depasse) throw new ErreurAnnuaire("protocole");
    } catch (e) {
      throw await this.apresEchec(e);
    }
  }

  /** Une réception au-delà du plafond est une erreur de protocole, quelle que soit l'erreur de la bibliothèque. */
  private async apresEchec(e: unknown): Promise<ErreurAnnuaire> {
    const ouverte = await this.ouverte?.catch(() => null);
    return ouverte?.reception.depasse === true ? new ErreurAnnuaire("protocole") : traduireErreur(e);
  }

  async chercher(base: string, o: OptionsRecherche): Promise<EntreeAnnuaire[]> {
    verifierRecherche(base, o);
    const attributs = [...o.attributs];
    const binaires = attributs.some((a) => a.toLowerCase() === "objectguid")
      ? [...BINAIRES, ...attributs.filter((a) => a.toLowerCase() === "objectguid")]
      : [];
    try {
      const { client, reception } = await this.obtenir();
      reception.octets = 0;
      const r = await client.search(base, {
        scope: o.portee,
        filter: FilterParser.parseString(o.filtre),
        attributes: attributs,
        explicitBufferAttributes: binaires,
        ...(o.sansLimiteServeur === true ? {} : { sizeLimit: o.limite }),
        timeLimit: this.delaiSec,
        derefAliases: "never",
      });
      if (reception.depasse) throw new ErreurAnnuaire("protocole");
      return r.searchEntries.slice(0, o.limite).map(normaliserEntree);
    } catch (e) {
      throw await this.apresEchec(e);
    }
  }

  async fermer(): Promise<void> {
    const p = this.ouverte;
    this.ferme = true;
    if (p === null) return;
    try {
      const { client, socket } = await p;
      try {
        await client.unbind();
      } finally {
        socket.destroy();
      }
    } catch {
      /* fermeture : rien à dire */
    }
  }
}

export interface OptionsFabrique extends OptionsSortant {
  /** Établit la socket TLS ; `connexionTls` par défaut. */
  readonly connecter?: typeof connexionTls;
}

/** Fabrique de production : la socket LDAPS vérifiée et épinglée de `connexionTls` n'est demandée qu'au premier envoi valide, puis servie une seule fois à ldapts (aucune reconnexion, reliaison ni startTLS). */
export function fabriqueLdapts(o: OptionsFabrique = {}): FabriqueConnexion {
  const { connecter = connexionTls, ...sortant } = o;
  return (fournisseur, url) => {
    if (!URL_LDAPS.test(url)) return Promise.reject(new ErreurAnnuaire("configuration"));
    const u = new URL(url);
    const delai = fournisseur.timeout_sec * 1000;
    const ouvrir = async (): Promise<Ouverte> => {
      let socket: TLSSocket;
      try {
        ({ socket } = await connecter(u.hostname, u.port === "" ? 636 : Number(u.port), {
          ...sortant,
          caPem: fournisseur.ca_pem,
          delaiConnexionMs: delai,
        }));
      } catch (e) {
        throw traduireErreur(e);
      }
      if (socket.authorized !== true || socket.destroyed || socket.readyState !== "open") {
        socket.destroy();
        throw new ErreurAnnuaire("injoignable", { sortant: "tls" });
      }
      const reception: Reception = { octets: 0, depasse: false };
      const client = new Client({
        url: `ldaps://${u.host}`,
        timeout: delai,
        connectTimeout: delai,
        strictDN: true,
        createSecureConnection: lierSocketUnique(socket, reception),
      });
      return { client, socket, reception };
    };
    return Promise.resolve(new ConnexionLdapts(ouvrir, fournisseur.timeout_sec));
  };
}
