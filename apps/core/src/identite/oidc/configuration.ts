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
import type { ExportedJWKSCache, ServerMetadata } from "openid-client";

import type { Base } from "@elpis/db";

import { empreinteFournisseur, secretFournisseur } from "../fournisseurs";
import type { FournisseurOidc } from "../reglages";
import { clientHttps, ErreurSortant } from "../sortant";
import type { ClientHttps, OptionsSortant } from "../sortant";
import { adresseDecouverte, lireMetadonnees } from "./metadonnees";
import { RefusOidc } from "./refus";

export const DUREE_DECOUVERTE_S = 3600;
const DELAI_BIBLIOTHEQUE_S = 10;

interface Decouverte {
  readonly empreinte: string;
  readonly expire: number;
  readonly metadonnees: ServerMetadata;
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
  private readonly cles = new Map<string, ExportedJWKSCache>();
  private readonly o: OptionsConfigurations;

  constructor(o: OptionsConfigurations) {
    this.o = o;
  }

  /** Clé de l'oubli : un fournisseur éteint ou supprimé ne laisse rien en mémoire. */
  oublier(id: string): void {
    this.decouvertes.delete(id);
    this.cles.delete(id);
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
    this.decouvertes.set(f.id, { empreinte, expire: t + DUREE_DECOUVERTE_S, metadonnees: v.metadonnees });
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
      const gardees = this.cles.get(f.id);
      if (gardees !== undefined) setJwksCache(config, gardees);
      return {
        config,
        metadonnees,
        terminer: async () => {
          const lues = getJwksCache(config);
          if (lues !== undefined) this.cles.set(f.id, lues);
          await client.fermer().catch(() => undefined);
        },
      };
    } catch (e) {
      await client.fermer().catch(() => undefined);
      throw e;
    }
  }
}
