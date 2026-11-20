// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-identite-oidc.ts — console › essai à blanc d'un fournisseur SSO : lance le flux pour un fournisseur enregistré mais éteint, rend l'adresse d'autorisation, puis le dernier résultat (administrateurs seulement). */
import { ipDuClient } from "@elpis/auth";
import type { DependancesAuth, Reseau } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { parametreChemin } from "@elpis/http";
import type { Base } from "@elpis/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { auditer } from "../admin/aides";
import { fournisseurParId, secretFournisseur, connexionSecurisee } from "../identite/fournisseurs";
import { compterAdminsLocaux } from "../identite/etat";
import { lancerTest } from "../identite/essai";
import type { OptionsEssai } from "../identite/essai";
import type { FabriqueConfigurations } from "../identite/oidc/configuration";
import { preparerDepart } from "../identite/oidc/depart";
import { dernierEssai } from "../identite/oidc/essai-blanc";
import { secretLiaisonOuNeuf } from "../identite/oidc/flux";
import { enteteLiaison, HOTE_NON_CANONIQUE, hoteNonCanonique } from "../identite/oidc/page";
import { RefusOidc } from "../identite/oidc/refus";
import { lireReglagesAuth } from "../identite/reglages";
import type { Fournisseur } from "../identite/reglages";
import type { OptionsSortant } from "../identite/sortant";
import type { Journal } from "../journal";
import type { DefinitionRoute, Famille } from "../routes";

export interface DependancesAdminIdentiteOidc {
  readonly base: Base;
  readonly auth: Pick<DependancesAuth, "attributsCookie" | "maintenant">;
  readonly mandataires: readonly Reseau[];
  readonly journal: Journal;
  readonly configurations: FabriqueConfigurations;
  /** Résolution, juge et autorités du client sortant (tests seulement). */
  readonly sortant?: OptionsSortant;
  /** Bornes du test préalable (tests seulement). */
  readonly essai?: OptionsEssai;
}

const SANS_CACHE = { "cache-control": "no-store" };
const ESSAIS_MAX = 2;

function route(
  methode: "GET" | "POST",
  chemin: string,
  traiter: DefinitionRoute["traiter"],
): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces: "admin", traiter };
}

export function creerFamilleAdminIdentiteOidc(dep: DependancesAdminIdentiteOidc): Famille {
  const { base } = dep;
  const maintenant = (): number => (dep.auth.maintenant ? dep.auth.maintenant() : Date.now() / 1000);
  const cookieSecure = (): boolean => connexionSecurisee(dep.auth.attributsCookie().https_only === true);
  let essaisEnCours = 0;

  function enregistre(id: string): Fournisseur {
    const f = fournisseurParId(id);
    if (f === undefined) throw new HttpError(404, "Fournisseur introuvable.");
    return f;
  }

  /** Lance l'essai : les étapes du bouton « Tester » d'abord, puis, si toutes passent, le flux d'autorisation lié à cet administrateur. */
  async function lancer(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
    const f = enregistre(parametreChemin(req));
    if (f.enabled) throw new HttpError(409, "Éteignez le fournisseur avant de l'essayer.");
    const admin = req.utilisateur?.id;
    if (admin === undefined) throw new HttpError(401, "not logged in");
    const publicUrl = lireReglagesAuth().public_url;
    if (publicUrl === "") throw new HttpError(409, "L'adresse publique en https est requise.");
    if (hoteNonCanonique(req, publicUrl))
      return rep.code(409).headers(SANS_CACHE).send({ detail: HOTE_NON_CANONIQUE, canonical: publicUrl });
    if (essaisEnCours >= ESSAIS_MAX)
      throw new HttpError(429, "Deux essais sont déjà en cours, réessayez dans un instant.", {
        "Retry-After": "5",
      });
    essaisEnCours += 1;
    let test: ReturnType<typeof lancerTest>;
    try {
      test = lancerTest(
        f,
        { publicUrl, cookieSecure: cookieSecure(), adminsLocaux: await compterAdminsLocaux(base) },
        {
          ...dep.essai,
          sortant: { ...dep.sortant, ...dep.essai?.sortant },
          oidc: { secretEnregistre: (p) => secretFournisseur(base, p) },
        },
      );
    } catch (e) {
      essaisEnCours -= 1;
      throw e;
    }
    void test.termine.finally(() => {
      essaisEnCours -= 1;
    });
    const r = await test.resultat;
    let url: string | null = null;
    let secret: string | null = null;
    if (r.ok) {
      secret = secretLiaisonOuNeuf(req.headers.cookie);
      try {
        const d = await preparerDepart(
          { base, configurations: dep.configurations, maintenant },
          {
            fournisseur: f,
            publicUrl,
            cible: "app",
            oauthNext: null,
            essaiAdmin: admin,
            secretLiaison: secret,
            adresse: ipDuClient(req, dep.mandataires),
          },
        );
        if (d === "plafond")
          throw new HttpError(429, "Trop de flux en cours : réessayez dans quelques minutes.");
        url = d.url;
      } catch (e) {
        if (!(e instanceof RefusOidc)) throw e;
        dep.journal.warn(`essai SSO ${f.id} : départ impossible (${e.cause_})`);
        throw new HttpError(503, "Le fournisseur est indisponible : vérifiez ses réglages.");
      }
    }
    auditer(req, "admin.auth.provider.trial", {
      provider_id: f.id,
      ok: r.ok,
      failed_step: r.steps.find((e) => e.level === "fail")?.id ?? null,
      started: url !== null,
    });
    void rep.headers({ ...SANS_CACHE, ...(secret === null ? {} : { "set-cookie": enteteLiaison(secret) }) });
    return { ok: r.ok, steps: r.steps, url };
  }

  async function lire(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
    enregistre(parametreChemin(req));
    void rep.headers(SANS_CACHE);
    return { result: await dernierEssai(base, parametreChemin(req)) };
  }

  return {
    nom: "admin-identite-oidc",
    routes: [
      route("POST", "/api/admin/auth/providers/:id/trial", lancer),
      route("GET", "/api/admin/auth/providers/:id/trial", lire),
    ],
  };
}
