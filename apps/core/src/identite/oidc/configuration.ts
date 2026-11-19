// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/configuration.ts — configuration de la bibliothèque OIDC pour un fournisseur : découverte faite ici (mise en cache une heure), authentification du client choisie, signature du jeton d'identité exigée, client sortant borné, clés relues au plus une fois par minute. */
import {
  ClientSecretBasic,
  ClientSecretPost,
  Configuration,
  clockTolerance,
  customFetch,
  enableNonRepudiationChecks,
  getJwksCache,
  setJwksCache,
} from "openid-client";
import type { ExportedJWKSCache, JWK, ServerMetadata } from "openid-client";

import type { Base } from "@elpis/db";

import { empreinteFournisseur, secretFournisseur } from "../fournisseurs";
import type { FournisseurOidc } from "../reglages";
import { clientHttps, ErreurSortant } from "../sortant";
import type { ClientHttps, OptionsSortant } from "../sortant";
import { adresseDecouverte, lireMetadonnees } from "./metadonnees";
import { RefusOidc } from "./refus";

export const DUREE_DECOUVERTE_S = 3600;
const DELAI_BIBLIOTHEQUE_S = 10;
const ECHEC_DECOUVERTE_S = 30;
const CLES_FRAICHES_S = 300;
const CLES_RELECTURE_S = 60;
const CLES_MAX = 50;

interface Decouverte {
  readonly empreinte: string;
  readonly expire: number;
  readonly metadonnees: ServerMetadata;
}

interface EchecDecouverte {
  readonly empreinte: string;
  readonly jusqua: number;
  readonly cause: string;
}

interface ClesGardees {
  readonly empreinte: string;
  readonly cache: ExportedJWKSCache;
}

export interface ConfigurationOuverte {
  readonly config: Configuration;
  readonly metadonnees: ServerMetadata;
  /** Garde les clés lues et ferme le client sortant. */
  terminer(): Promise<void>;
}

export interface OptionsConfigurations {
  readonly base: Base;
  readonly maintenant: () => number;
  readonly sortant?: OptionsSortant;
}

/** Fabrique des configurations d'un process : une découverte et un cache de clés par fournisseur (jamais partagés avec l'autre process). */
export class FabriqueConfigurations {
  private readonly decouvertes = new Map<string, Decouverte>();
  private readonly echecs = new Map<string, EchecDecouverte>();
  private readonly cles = new Map<string, ClesGardees>();
  private readonly o: OptionsConfigurations;

  constructor(o: OptionsConfigurations) {
    this.o = o;
  }

  /** Métadonnées de la dernière découverte (mêmes réglages), même périmées, sans aucun appel ; `null` si rien n'est gardé. */
  metadonneesGardees(f: FournisseurOidc, publicUrl: string): ServerMetadata | null {
    const c = this.decouvertes.get(f.id);
    return c !== undefined && c.empreinte === empreinteFournisseur(f, publicUrl) ? c.metadonnees : null;
  }

  /** Clés de signature du fournisseur, dans le cache de la connexion : relues si le cache a plus de cinq minutes, ou, une fois par minute au plus, si la clé `kid` y manque. */
  async clesDeSignature(f: FournisseurOidc, publicUrl: string, kid: string | undefined): Promise<JWK[]> {
    const client = this.client(f);
    try {
      const metadonnees = await this.decouvrir(f, publicUrl, client);
      const t = this.o.maintenant();
      const gardees = this.clesGardees(f, publicUrl);
      const age = gardees === undefined ? Infinity : t - gardees.uat;
      const absente = kid !== undefined && !(gardees?.jwks.keys ?? []).some((k) => k.kid === kid);
      if (gardees !== undefined && age < CLES_FRAICHES_S && !(absente && age >= CLES_RELECTURE_S))
        return gardees.jwks.keys;
      let rep: Response;
      let texte: string;
      try {
        rep = await client.fetch(String(metadonnees.jwks_uri), { headers: { accept: "application/json" } });
        texte = await rep.text();
      } catch (e) {
        throw new RefusOidc("unavailable", `jwks:${e instanceof ErreurSortant ? e.code : "reseau"}`);
      }
      if (rep.status !== 200) throw new RefusOidc("unavailable", `jwks:status_${rep.status}`);
      let doc: unknown;
      try {
        doc = JSON.parse(texte);
      } catch {
        throw new RefusOidc("unavailable", "jwks:json");
      }
      const liste = (doc as { keys?: unknown } | null)?.keys;
      if (!Array.isArray(liste) || liste.length > CLES_MAX)
        throw new RefusOidc("unavailable", "jwks:invalid");
      const keys = liste.filter((k): k is JWK => k !== null && typeof k === "object" && !Array.isArray(k));
      this.cles.set(f.id, {
        empreinte: empreinteFournisseur(f, publicUrl),
        cache: { jwks: { keys }, uat: t },
      });
      return keys;
    } finally {
      await client.fermer().catch(() => undefined);
    }
  }

  /** Clés gardées de ce fournisseur, seulement si elles viennent des mêmes réglages. */
  private clesGardees(f: FournisseurOidc, publicUrl: string): ExportedJWKSCache | undefined {
    const g = this.cles.get(f.id);
    return g !== undefined && g.empreinte === empreinteFournisseur(f, publicUrl) ? g.cache : undefined;
  }

  /** Client sortant des réglages du fournisseur (autorités du fournisseur, adresses jugées et épinglées). */
  client(f: FournisseurOidc, sortant: OptionsSortant = {}): ClientHttps {
    return clientHttps({ ...this.o.sortant, ...sortant, caPem: f.ca_pem });
  }

  private async decouvrir(
    f: FournisseurOidc,
    publicUrl: string,
    client: ClientHttps,
  ): Promise<ServerMetadata> {
    const empreinte = empreinteFournisseur(f, publicUrl);
    const t = this.o.maintenant();
    const connue = this.decouvertes.get(f.id);
    if (connue !== undefined && connue.empreinte === empreinte && connue.expire > t)
      return connue.metadonnees;
    const echec = this.echecs.get(f.id);
    if (echec !== undefined && echec.empreinte === empreinte && echec.jusqua > t)
      throw new RefusOidc("unavailable", echec.cause);
    let metadonnees: ServerMetadata;
    try {
      metadonnees = await this.lireDecouverte(f, client);
    } catch (e) {
      if (e instanceof RefusOidc)
        this.echecs.set(f.id, { empreinte, jusqua: t + ECHEC_DECOUVERTE_S, cause: e.cause_ });
      throw e;
    }
    this.echecs.delete(f.id);
    this.decouvertes.set(f.id, { empreinte, expire: t + DUREE_DECOUVERTE_S, metadonnees });
    return metadonnees;
  }

  /** Document de découverte lu et vérifié ; `unavailable` s'il manque ou s'il est faux. */
  private async lireDecouverte(f: FournisseurOidc, client: ClientHttps): Promise<ServerMetadata> {
    let rep: Response;
    let texte: string;
    try {
      rep = await client.fetch(adresseDecouverte(f.issuer), { headers: { accept: "application/json" } });
      texte = await rep.text();
    } catch (e) {
      throw new RefusOidc("unavailable", `discovery:${e instanceof ErreurSortant ? e.code : "reseau"}`);
    }
    if (rep.status !== 200) throw new RefusOidc("unavailable", `discovery:status_${rep.status}`);
    let doc: unknown;
    try {
      doc = JSON.parse(texte);
    } catch {
      throw new RefusOidc("unavailable", "discovery:json");
    }
    const v = lireMetadonnees(doc, f.issuer);
    if (!v.ok) throw new RefusOidc("unavailable", "discovery:invalid");
    return v.metadonnees;
  }

  /** Configuration prête pour un appel : secret du coffre, signature du jeton d'identité vérifiée avec l'algorithme réglé, tolérance d'horloge du fournisseur, `fetch` borné ; `unavailable` si le secret manque ou si la découverte échoue. */
  async ouvrir(f: FournisseurOidc, publicUrl: string): Promise<ConfigurationOuverte> {
    const secret = await secretFournisseur(this.o.base, f);
    if (secret === null) throw new RefusOidc("unavailable", "client_secret_missing");
    const client = this.client(f);
    try {
      const metadonnees = await this.decouvrir(f, publicUrl, client);
      const config = new Configuration(
        metadonnees,
        f.client_id,
        { [clockTolerance]: f.clock_skew_sec, id_token_signed_response_alg: f.id_token_alg },
        f.client_auth === "basic" ? ClientSecretBasic(secret) : ClientSecretPost(secret),
      );
      config[customFetch] = (url, options) => client.fetch(url, options as RequestInit);
      config.timeout = DELAI_BIBLIOTHEQUE_S;
      enableNonRepudiationChecks(config);
      const gardees = this.clesGardees(f, publicUrl);
      if (gardees !== undefined) setJwksCache(config, gardees);
      return {
        config,
        metadonnees,
        terminer: async () => {
          const lues = getJwksCache(config);
          if (lues !== undefined)
            this.cles.set(f.id, { empreinte: empreinteFournisseur(f, publicUrl), cache: lues });
          await client.fermer().catch(() => undefined);
        },
      };
    } catch (e) {
      await client.fermer().catch(() => undefined);
      throw e;
    }
  }
}
