// SPDX-License-Identifier: MIT
/** apps/core/src/familles/identite.ts — connexion par SSO OpenID Connect : départ du flux (main et console) et retour du fournisseur (main) ; 404 tant que le fournisseur n'est pas actif, tout refus mène à un code d'une liste fermée. */
import { randomBytes } from "node:crypto";

import { dependancesSession, dureeMaxSession, ipDuClient, validerSession, valeurCookie } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons, Reseau } from "@elpis/auth";
import { estDict, HttpError } from "@elpis/commun";
import { auditEvent } from "@elpis/securite";
import { corpsJson, corpsLu, entete } from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";

import { DebitConnexion } from "../comptes/debit-connexion";
import type { PortBac } from "../admin/bac";
import { ligneUtilisateur } from "@elpis/auth";
import { decouperHotePort } from "../interface/urls-publiques";
import { fournisseursActifs, enregistrerTestReussi } from "../identite/fournisseurs";
import type { Journal } from "../journal";
import { auditerRefus, auditerRequete } from "../journal-securite/auditer";
import { connecterParOidc } from "../identite/oidc/connexion";
import type { DependancesConnexionOidc } from "../identite/oidc/connexion";
import { verifierRetour, requeteBrute } from "../identite/oidc/echange";
import {
  appliquerDeconnexion,
  CORPS_DECONNEXION_MAX,
  JetonsVus,
  PlafondAppels,
  verifierJetonDeconnexion,
} from "../identite/oidc/deconnexion";
import { oauthNextAdmis, preparerDepart } from "../identite/oidc/depart";
import type { FabriqueConfigurations } from "../identite/oidc/configuration";
import { resultatEssaiBlanc, resultatEssaiEchoue, ranger } from "../identite/oidc/essai-blanc";
import {
  COOKIE_LIAISON,
  consommerFlux,
  empreinte,
  memeEmpreinte,
  secretLiaisonValide,
} from "../identite/oidc/flux";
import { cibleDeRetour, ENTETES_RETOUR, enteteLiaison, pageRetour, pageSimple } from "../identite/oidc/page";
import { RefusOidc } from "../identite/oidc/refus";
import { lireReglagesAuth } from "../identite/reglages";
import type { FournisseurOidc } from "../identite/reglages";
import type { Famille } from "../routes";

export interface DependancesIdentite {
  readonly auth: DependancesAuth & DependancesJetons;
  readonly mandataires: readonly Reseau[];
  readonly journal: Journal;
  readonly configurations: FabriqueConfigurations;
  readonly demarrerHistoriqueFichiers?: (uid: number) => Promise<void>;
  readonly logMetric?: (nom: string, valeur: number, etiquettes: Record<string, unknown>) => void;
  readonly publierSuspension?: (uid: number) => Promise<boolean>;
  /** Ferme les flux ouverts d'un compte dont une session vient d'être révoquée. */
  readonly revoquer?: (uid: number) => Promise<unknown>;
  readonly bac?: PortBac;
}

const CORPS_DEPART_MAX = 4096;
const STATE_MAX = 256;
const DUREE_REJEU_S = 900;
const REFUS_DEBIT = "Trop de tentatives de connexion : réessayez dans quelques minutes.";
const INDISPONIBLE =
  "La connexion par le service d'identité est indisponible : demandez à votre administrateur.";
const SANS_CACHE = { "cache-control": "no-store" } as const;
const HOTE_NON_CANONIQUE = "Utilisez l'adresse publique du service.";
const ENTETES_REFUS = { "cache-control": "no-store", "referrer-policy": "no-referrer" } as const;

function idDuChemin(req: FastifyRequest): string {
  const brut = (req.params as Record<string, unknown> | undefined)?.["id"];
  return typeof brut === "string" ? brut : "";
}

export function creerFamilleIdentite(dep: DependancesIdentite): Famille {
  const base = dep.auth.base;
  const debit = new DebitConnexion();
  const maintenant = (): number => (dep.auth.maintenant ? dep.auth.maintenant() : Date.now() / 1000);
  const cookieSecure = (): boolean => dep.auth.attributsCookie().https_only === true;
  const connexion: DependancesConnexionOidc = {
    base,
    provisionnement: {
      base,
      acces: dep.auth,
      maintenant,
      publierSuspension: dep.publierSuspension ?? (async () => false),
      bac: dep.bac,
      journal: dep.journal,
    },
    effets: {
      base,
      maintenant,
      demarrerHistoriqueFichiers: dep.demarrerHistoriqueFichiers,
      logMetric: dep.logMetric,
    },
    dureeGlobale: () => dureeMaxSession(dep.auth.config()),
  };

  /** Fournisseur OIDC actif d'identifiant donné ; 404 sinon, sans rien dire de plus. */
  async function actif(id: string): Promise<FournisseurOidc> {
    const f = (await fournisseursActifs(base, cookieSecure)).find((p) => p.id === id);
    if (f === undefined || f.type !== "oidc") throw new HttpError(404, "Not Found");
    return f;
  }

  function limiter(ip: string): void {
    const t = maintenant();
    const attente = debit.attenteAdresseS(ip, t);
    if (attente > 0) throw new HttpError(429, REFUS_DEBIT, { "Retry-After": String(Math.ceil(attente)) });
    debit.prendreAdresse(ip, t);
  }

  async function depart(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
    const f = await actif(idDuChemin(req));
    const corps = corpsJson(req);
    const cible = estDict(corps) ? corps["target"] : undefined;
    if (cible !== "app" && cible !== "console")
      throw new HttpError(400, "Champ « target » : app ou console.");
    const publicUrl = lireReglagesAuth().public_url;
    const hoteRequete = decouperHotePort((req.host ?? "").toLowerCase())[0];
    if (hoteRequete !== new URL(publicUrl).hostname.toLowerCase())
      return rep.code(409).headers(ENTETES_REFUS).send({ detail: HOTE_NON_CANONIQUE, canonical: publicUrl });
    const ip = ipDuClient(req, dep.mandataires);
    limiter(ip);
    const secret =
      secretLiaisonValide(valeurCookie(req.headers.cookie, COOKIE_LIAISON)) ??
      randomBytes(32).toString("base64url");
    let r: Awaited<ReturnType<typeof preparerDepart>>;
    try {
      r = await preparerDepart(
        { base, configurations: dep.configurations, maintenant },
        {
          fournisseur: f,
          publicUrl,
          cible,
          oauthNext: estDict(corps) ? oauthNextAdmis(corps["oauth_next"]) : null,
          essaiAdmin: null,
          secretLiaison: secret,
          adresse: ip,
        },
      );
    } catch (e) {
      if (!(e instanceof RefusOidc)) throw e;
      dep.journal.warn(`connexion SSO ${f.id} : départ impossible (${e.cause_})`);
      throw new HttpError(503, INDISPONIBLE);
    }
    if (r === "plafond") throw new HttpError(429, REFUS_DEBIT, { "Retry-After": "60" });
    void rep.headers({ ...ENTETES_REFUS, "set-cookie": enteteLiaison(secret) });
    return { url: r.url };
  }

  /** Refus d'un retour : référence aléatoire, cause réelle au journal et à l'audit, code fermé dans l'adresse de redirection. */
  async function refuser(
    req: FastifyRequest,
    rep: FastifyReply,
    id: string,
    refus: RefusOidc,
  ): Promise<unknown> {
    const ref = randomBytes(6).toString("base64url");
    dep.journal.warn(`connexion SSO ${id} refusée (réf. ${ref}) : ${refus.cause_}`);
    let username: string | null = null;
    if (refus.uid !== null) {
      try {
        username = String((await ligneUtilisateur(base, refus.uid))?.username ?? "") || null;
      } catch {
        username = null;
      }
    }
    auditEvent({
      userId: refus.uid,
      username,
      action: "auth.login.denied",
      ip: ipDuClient(req, dep.mandataires),
      details: {
        user_agent: (entete(req, "user-agent") ?? "").slice(0, 200),
        reason: refus.cause_,
        login_method: `oidc:${id}`,
        ref,
      },
    });
    return rep.headers(ENTETES_REFUS).redirect(`/?auth_error=${refus.code}&ref=${ref}`, 302);
  }

  /** Session d'administrateur de l'essai : celle de l'administrateur qui l'a lancé, encore valide. */
  async function administrateurDeLEssai(req: FastifyRequest, attendu: number): Promise<boolean> {
    const brut = req.session.get("user_id");
    if (typeof brut !== "number" || brut !== attendu) return false;
    try {
      const v = await validerSession(req.session, brut, dependancesSession(dep.auth));
      return v.valide && Number(v.ligne?.is_admin) === 1;
    } catch {
      return false;
    }
  }

  async function retour(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
    const id = idDuChemin(req);
    const f = lireReglagesAuth().providers.find((p) => p.id === id);
    if (f === undefined || f.type !== "oidc") throw new HttpError(404, "Not Found");
    const estActif = (await fournisseursActifs(base, cookieSecure)).some((p) => p.id === id);
    const secret = secretLiaisonValide(valeurCookie(req.headers.cookie, COOKIE_LIAISON));
    if (!estActif && secret === null) throw new HttpError(404, "Not Found");
    const ip = ipDuClient(req, dep.mandataires);
    const publicUrl = lireReglagesAuth().public_url;
    const t = maintenant();
    let ouverte: Awaited<ReturnType<FabriqueConfigurations["ouvrir"]>> | null = null;
    try {
      if (debit.attenteAdresseS(ip, t) > 0) throw new RefusOidc("unavailable", "rate_limited");
      debit.prendreAdresse(ip, t);
      if (secret === null) throw new RefusOidc("expired", "binding_cookie_missing");
      const requete = requeteBrute(req.url);
      const state = new URLSearchParams(requete).get("state") ?? "";
      if (state === "" || state.length > STATE_MAX) throw new RefusOidc("expired", "state_missing");
      const flux = await consommerFlux(base, state);
      if (!estActif && (flux === null || flux.essaiAdmin === null)) throw new HttpError(404, "Not Found");
      if (flux === null) throw new RefusOidc("expired", "state_unknown");
      if (flux.expiresAt < t) throw new RefusOidc("expired", "flow_expired");
      if (flux.providerId !== f.id) throw new RefusOidc("failed", "provider_mismatch");
      if (!memeEmpreinte(flux.browserHash, empreinte(secret)))
        throw new RefusOidc("failed", "browser_mismatch");
      if (flux.etape !== "auth") throw new RefusOidc("failed", "stage_unexpected");
      if (flux.essaiAdmin !== null && !(await administrateurDeLEssai(req, flux.essaiAdmin)))
        throw new RefusOidc("failed", "trial_admin_session_missing");
      ouverte = await dep.configurations.ouvrir(f, publicUrl);
      if (flux.essaiAdmin !== null) {
        const admin = flux.essaiAdmin;
        let resultat;
        let verifie = null;
        try {
          verifie = await verifierRetour(ouverte, f, { publicUrl, flux, state, requete, maintenant: t });
          resultat = await resultatEssaiBlanc(base, f, verifie, t);
        } catch (e) {
          if (!(e instanceof RefusOidc)) throw e;
          dep.journal.warn(`essai SSO ${id} : ${e.cause_}`);
          resultat = resultatEssaiEchoue(e, t);
        }
        await base.ecriture(async (x) => {
          await ranger(x, f.id, admin, resultat);
          if (verifie !== null && resultat.ok) await enregistrerTestReussi(x, f, publicUrl, t);
        });
        return rep
          .headers(ENTETES_RETOUR)
          .type("text/html; charset=utf-8")
          .send(pageSimple("L'essai est terminé : vous pouvez fermer cet onglet."));
      }
      const verifie = await verifierRetour(ouverte, f, { publicUrl, flux, state, requete, maintenant: t });
      await connecterParOidc(connexion, {
        fournisseur: f,
        retour: verifie,
        session: req.session,
        maintenant: t,
        ip,
        userAgent: entete(req, "user-agent") ?? null,
      });
      return rep
        .headers(ENTETES_RETOUR)
        .type("text/html; charset=utf-8")
        .send(pageRetour(cibleDeRetour(publicUrl, flux.cible, flux.oauthNext)));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e instanceof RefusOidc) return refuser(req, rep, id, e);
      dep.journal.error({ err: e }, `connexion SSO ${id} : erreur interne`);
      return refuser(req, rep, id, new RefusOidc("failed", "internal"));
    } finally {
      await ouverte?.terminer();
    }
  }

  const plafond = new PlafondAppels();
  const vus = new JetonsVus();

  /** Déconnexion par canal arrière : jeton signé du fournisseur ; 200 sans corps s'il est valide, 400 sinon, jamais rien du jeton en retour. */
  async function canalArriere(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
    const f = await actif(idDuChemin(req));
    if (!f.logout.backchannel) throw new HttpError(404, "Not Found");
    void rep.headers(SANS_CACHE);
    const t = maintenant();
    const refuser = (raison: string, statut = 400): FastifyReply => {
      dep.journal.warn(`déconnexion SSO ${f.id} refusée : ${raison}`);
      auditerRefus(req, "auth.oidc.backchannel_logout.denied", { provider_id: f.id, reason: raison });
      return rep.code(statut).send();
    };
    if (!plafond.prendre(f.id, t)) return refuser("rate_limited", 429);
    if (!/^application\/x-www-form-urlencoded\s*(;|$)/iu.test(entete(req, "content-type") ?? ""))
      return refuser("content_type");
    const champs = new URLSearchParams(corpsLu(req).toString("utf8"));
    const jetons = champs.getAll("logout_token");
    if (jetons.length !== 1) return refuser("malformed");
    let jeton;
    try {
      jeton = await verifierJetonDeconnexion(
        dep.configurations,
        f,
        lireReglagesAuth().public_url,
        jetons[0] ?? "",
        t,
      );
    } catch (e) {
      return refuser(e instanceof RefusOidc ? e.cause_ : "invalid");
    }
    if (jeton.jti !== null && vus.dejaVu(f.id, jeton.jti, jeton.iat + DUREE_REJEU_S, t))
      return rep.code(200).send();
    const bilan = await appliquerDeconnexion(base, f, jeton, t);
    for (const uid of bilan.comptes) {
      try {
        await dep.revoquer?.(uid);
      } catch (e) {
        dep.journal.warn({ err: e }, `déconnexion SSO ${f.id} : flux du compte non fermés`);
      }
    }
    auditerRequete(req, "auth.oidc.backchannel_logout", {
      provider_id: f.id,
      sessions: bilan.sessions,
      by: jeton.sid !== null ? "sid" : "sub",
    });
    return rep.code(200).send();
  }

  return {
    nom: "identite",
    routes: [
      {
        methode: "POST",
        chemin: "/api/auth/oidc/:id/start",
        processus: ["main", "admin"],
        acces: "public",
        corps: { limite: CORPS_DEPART_MAX },
        traiter: depart,
      },
      {
        methode: "GET",
        chemin: "/api/auth/oidc/:id/callback",
        processus: ["main"],
        acces: "public",
        traiter: retour,
      },
      {
        methode: "POST",
        chemin: "/api/auth/oidc/:id/backchannel-logout",
        processus: ["main"],
        acces: "public",
        corps: { limite: CORPS_DECONNEXION_MAX },
        traiter: canalArriere,
      },
    ],
  };
}
