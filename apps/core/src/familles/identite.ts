// SPDX-License-Identifier: MIT
/** apps/core/src/familles/identite.ts — connexion par SSO OpenID Connect : départ du flux (main et console) et retour du fournisseur (main) ; 404 tant que le fournisseur n'est pas actif, tout refus mène à un code d'une liste fermée ; la frontière de confiance du cookie de liaison est le nom d'hôte (tout port). */
import { randomBytes } from "node:crypto";

import { cleAdresse, cleAdresseExacte, compteSuspendu, dureeMaxSession, ipDuClient } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons, Reseau } from "@elpis/auth";
import { estDict, HttpError } from "@elpis/commun";
import type { ResultatEssaiBlanc } from "@elpis/contracts";
import { auditEvent } from "@elpis/securite";
import { corpsJson, entete, parametreChemin } from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";

import { DebitConnexion } from "../comptes/debit-connexion";
import { ConnexionRefusee } from "../comptes/ouverture";
import type { PortBac } from "../admin/bac";
import { ligneUtilisateur } from "@elpis/auth";
import { groupesUtiles } from "../identite/correspondance";
import { empreinteFournisseur, fournisseursActifs, enregistrerTestReussi } from "../identite/fournisseurs";
import type { Journal } from "../journal";
import { auditerRefus } from "../journal-securite/auditer";
import { auditerRefusPreuve, prouverEtRattacher } from "../identite/rattachement";
import { connecterParOidc, ouvrirSessionOidc } from "../identite/oidc/connexion";
import { lireFluxPreuve, ouvrirFluxPreuve } from "../identite/oidc/preuve";
import type { DependancesConnexionOidc } from "../identite/oidc/connexion";
import { verifierRetour, requeteBrute } from "../identite/oidc/echange";
import { RefusAgreges } from "../identite/oidc/deconnexion";
import { oauthNextAdmis, preparerDepart } from "../identite/oidc/depart";
import type { FabriqueConfigurations } from "../identite/oidc/configuration";
import {
  RAISON_REGLAGES_CHANGES,
  resultatEssaiBlanc,
  resultatEssaiEchoue,
  ranger,
} from "../identite/oidc/essai-blanc";
import {
  consommerFlux,
  empreinte,
  lireFlux,
  memeEmpreinte,
  secretLiaisonDe,
  secretLiaisonOuNeuf,
} from "../identite/oidc/flux";
import {
  cibleDeRetour,
  ENTETES_RETOUR,
  enteteLiaison,
  HOTE_NON_CANONIQUE,
  hoteNonCanonique,
  pageRetour,
  pageSimple,
} from "../identite/oidc/page";
import { RefusOidc } from "../identite/oidc/refus";
import { lireReglagesAuth } from "../identite/reglages";
import type { Fournisseur } from "../identite/reglages";
import type { Famille } from "../routes";

export interface DependancesIdentite {
  readonly auth: DependancesAuth & DependancesJetons;
  readonly mandataires: readonly Reseau[];
  readonly journal: Journal;
  readonly configurations: FabriqueConfigurations;
  readonly demarrerHistoriqueFichiers?: (uid: number) => Promise<void>;
  readonly logMetric?: (nom: string, valeur: number, etiquettes: Record<string, unknown>) => void;
  readonly publierSuspension?: (uid: number) => Promise<boolean>;
  /** Flux ouverts d'un compte rattaché coupés dans tous les process. */
  readonly revoquer: (uid: number) => Promise<unknown>;
  readonly bac?: PortBac;
}

const CORPS_DEPART_MAX = 4096;
const CORPS_PREUVE_MAX = 4096;
const STATE_MAX = 256;
const PREUVE_PERIMEE =
  "Cette demande n'est plus valable : reconnectez-vous ou demandez à votre administrateur.";
const REFUS_DEBIT = "Trop de tentatives de connexion : réessayez dans quelques minutes.";
const INDISPONIBLE =
  "La connexion par le service d'identité est indisponible : demandez à votre administrateur.";
const ENTETES_REFUS = { "cache-control": "no-store", "referrer-policy": "no-referrer" } as const;

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
      revoquer: dep.revoquer,
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
  async function actif(id: string): Promise<Fournisseur> {
    const [f] = await fournisseursActifs(base, cookieSecure, id);
    if (f === undefined) throw new HttpError(404, "Not Found");
    return f;
  }

  /** 404 tant qu'aucun fournisseur OIDC n'est actif. */
  async function exigerOidcActif(): Promise<void> {
    if ((await fournisseursActifs(base, cookieSecure)).length === 0) throw new HttpError(404, "Not Found");
  }

  function limiter(ip: string): void {
    const t = maintenant();
    const attente = debit.attenteSsoS(cleAdresseExacte(ip), cleAdresse(ip), t);
    if (attente > 0) throw new HttpError(429, REFUS_DEBIT, { "Retry-After": String(Math.ceil(attente)) });
    debit.prendreSso(cleAdresseExacte(ip), cleAdresse(ip), t);
  }

  async function depart(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
    const f = await actif(parametreChemin(req));
    const corps = corpsJson(req);
    const cible = estDict(corps) ? corps["target"] : undefined;
    if (cible !== "app" && cible !== "console")
      throw new HttpError(400, "Champ « target » : app ou console.");
    const publicUrl = lireReglagesAuth().public_url;
    if (hoteNonCanonique(req, publicUrl))
      return rep.code(409).headers(ENTETES_REFUS).send({ detail: HOTE_NON_CANONIQUE, canonical: publicUrl });
    const ip = ipDuClient(req, dep.mandataires);
    limiter(ip);
    const secret = secretLiaisonOuNeuf(req.headers.cookie);
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

  /** Nom du compte pour l'audit, `null` s'il ne se lit pas. */
  async function nomDe(uid: number): Promise<string | null> {
    try {
      return String((await ligneUtilisateur(base, uid))?.username ?? "") || null;
    } catch {
      return null;
    }
  }

  const refusDuRetour = new RefusAgreges((raison, n) =>
    dep.journal.warn(`connexion SSO refusée : ${raison} (${n} sur la dernière minute)`),
  );

  /** Refus d'un retour : référence aléatoire ; avant qu'un flux du navigateur soit retrouvé, journal et audit agrégés (le débit n'est pas audité), sinon cause réelle au journal et à l'audit. */
  async function refuser(
    req: FastifyRequest,
    rep: FastifyReply,
    id: string,
    refus: RefusOidc,
    fluxLie: boolean,
  ): Promise<unknown> {
    const ref = randomBytes(6).toString("base64url");
    const redirection = (): unknown =>
      rep.headers(ENTETES_REFUS).redirect(`/?auth_error=${refus.code}&ref=${ref}`, 302);
    if (!fluxLie) {
      refusDuRetour.noter(refus.cause_);
      if (refus.cause_ !== "rate_limited")
        auditerRefus(req, "auth.login.denied", {
          reason: refus.cause_,
          login_method: `oidc:${id}`,
          ref,
        });
      return redirection();
    }
    dep.journal.warn(`connexion SSO ${id} refusée (réf. ${ref}) : ${refus.cause_}`);
    const username = refus.uid === null ? null : await nomDe(refus.uid);
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
    return redirection();
  }

  /** Vrai si l'administrateur de l'essai existe encore, est administrateur et n'est pas suspendu. */
  async function administrateurDeLEssai(attendu: number): Promise<boolean> {
    try {
      const l = await ligneUtilisateur(base, attendu);
      return l !== undefined && l !== null && Number(l.is_admin) === 1 && !compteSuspendu(l);
    } catch {
      return false;
    }
  }

  async function retour(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
    const id = parametreChemin(req);
    const f = lireReglagesAuth().providers.find((p) => p.id === id);
    if (f === undefined) throw new HttpError(404, "Not Found");
    const estActif = (await fournisseursActifs(base, cookieSecure, id)).length > 0;
    const secret = secretLiaisonDe(req.headers.cookie);
    const ip = ipDuClient(req, dep.mandataires);
    const cle = cleAdresse(ip);
    const exacte = cleAdresseExacte(ip);
    const publicUrl = lireReglagesAuth().public_url;
    const t = maintenant();
    const requete = requeteBrute(req.url);
    const state = new URLSearchParams(requete).get("state") ?? "";
    const etatLisible = state !== "" && state.length <= STATE_MAX;
    const vu = secret !== null && etatLisible ? await lireFlux(base, state) : null;
    const lie =
      vu !== null &&
      secret !== null &&
      vu.providerId === f.id &&
      memeEmpreinte(vu.browserHash, empreinte(secret));
    if (!estActif && !(lie && vu.essaiAdmin !== null)) throw new HttpError(404, "Not Found");
    let jetonPris = false;
    const prendreJeton = (): void => {
      if (debit.attenteSsoS(exacte, cle, t) > 0) throw new RefusOidc("unavailable", "rate_limited");
      debit.prendreSso(exacte, cle, t);
      jetonPris = true;
    };
    let fluxLie = false;
    let ouverte: Awaited<ReturnType<FabriqueConfigurations["ouvrir"]>> | null = null;
    try {
      if (!(lie && vu.expiresAt >= t && vu.etape === "auth")) prendreJeton();
      if (secret === null) throw new RefusOidc("expired", "binding_cookie_missing");
      if (!etatLisible) throw new RefusOidc("expired", "state_missing");
      const flux = await consommerFlux(base, state);
      if (!estActif && (flux === null || flux.essaiAdmin === null)) throw new HttpError(404, "Not Found");
      if (flux === null) {
        if (!jetonPris) prendreJeton();
        throw new RefusOidc("expired", "state_unknown");
      }
      fluxLie = flux.providerId === f.id && memeEmpreinte(flux.browserHash, empreinte(secret));
      if (!fluxLie && !jetonPris) prendreJeton();
      if (flux.expiresAt < t) throw new RefusOidc("expired", "flow_expired");
      if (flux.providerId !== f.id) throw new RefusOidc("failed", "provider_mismatch");
      if (!memeEmpreinte(flux.browserHash, empreinte(secret)))
        throw new RefusOidc("failed", "browser_mismatch");
      if (flux.etape !== "auth") throw new RefusOidc("failed", "stage_unexpected");
      if (flux.essaiAdmin !== null) {
        const admin = flux.essaiAdmin;
        if (!(await administrateurDeLEssai(admin))) throw new RefusOidc("failed", "trial_admin_invalid");
        let resultat: ResultatEssaiBlanc;
        try {
          if (flux.empreinteReglages !== empreinteFournisseur(f, publicUrl))
            throw new RefusOidc("failed", RAISON_REGLAGES_CHANGES);
          ouverte = await dep.configurations.ouvrir(f, publicUrl);
          const verifie = await verifierRetour(ouverte, f, {
            publicUrl,
            flux,
            state,
            requete,
            maintenant: t,
          });
          resultat = await resultatEssaiBlanc(base, f, verifie, t);
        } catch (e) {
          if (!(e instanceof RefusOidc)) throw e;
          dep.journal.warn(`essai SSO ${id} : ${e.cause_}`);
          resultat = resultatEssaiEchoue(e, t);
        }
        await base.ecriture(async (x) => {
          await ranger(x, f.id, resultat);
          if (resultat.ok) await enregistrerTestReussi(x, f, publicUrl);
        });
        auditEvent({
          userId: admin,
          username: await nomDe(admin),
          action: "admin.auth.provider.trial.result",
          ip,
          details: {
            provider_id: f.id,
            ok: resultat.ok,
            outcome: resultat.decision.outcome,
            reason: resultat.decision.reason,
          },
        });
        if (resultat.ok && jetonPris) debit.rendreSso(exacte, cle, t);
        return rep
          .headers(ENTETES_RETOUR)
          .type("text/html; charset=utf-8")
          .send(pageSimple("L'essai est terminé : vous pouvez fermer cet onglet."));
      }
      ouverte = await dep.configurations.ouvrir(f, publicUrl);
      const verifie = await verifierRetour(ouverte, f, { publicUrl, flux, state, requete, maintenant: t });
      const issue = await connecterParOidc(connexion, {
        fournisseur: f,
        retour: verifie,
        session: req.session,
        maintenant: t,
        ip,
        userAgent: entete(req, "user-agent") ?? null,
      });
      if (typeof issue !== "number") {
        await ouvrirFluxPreuve(
          base,
          {
            providerId: f.id,
            secretLiaison: secret,
            prelinkId: issue.prelinkId,
            profil: verifie.profil,
            appartenance: verifie.appartenance,
            sub: verifie.sub,
            idpSid: verifie.idpSid,
            idToken: verifie.idToken,
            groupes: groupesUtiles(f, verifie.groupesComplets),
            secondFacteur: verifie.secondFacteur,
            cible: flux.cible,
            oauthNext: flux.oauthNext,
            adresse: ip,
          },
          t,
        );
        return rep
          .headers({ ...ENTETES_RETOUR, "set-cookie": enteteLiaison(secret) })
          .type("text/html; charset=utf-8")
          .send(pageRetour("/?auth_link=1"));
      }
      debit.rendreSso(exacte, cle, t);
      if (jetonPris) debit.rendreSso(exacte, cle, t);
      return rep
        .headers(ENTETES_RETOUR)
        .type("text/html; charset=utf-8")
        .send(pageRetour(cibleDeRetour(publicUrl, flux.cible, flux.oauthNext)));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e instanceof RefusOidc) return refuser(req, rep, id, e, fluxLie);
      dep.journal.error({ err: e }, `connexion SSO ${id} : erreur interne`);
      return refuser(req, rep, id, new RefusOidc("failed", "internal"), fluxLie);
    } finally {
      await ouverte?.terminer();
    }
  }

  /** Demande de preuve en cours du navigateur : `pending` et le compte visé, ou rien. */
  async function preuveEnCours(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
    await exigerOidcActif();
    void rep.headers(ENTETES_REFUS);
    const secret = secretLiaisonDe(req.headers.cookie);
    const aucune = { pending: false, username: null };
    if (secret === null) return aucune;
    const flux = await lireFluxPreuve(base, secret, maintenant());
    if (flux === null) return aucune;
    return { pending: true, username: flux.username };
  }

  /** Ancien mot de passe du compte visé : preuve du titulaire, rattachement, session `oidc:<id>`. */
  async function prouverLien(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
    await exigerOidcActif();
    void rep.headers(ENTETES_REFUS);
    const corps = corpsJson(req);
    const motDePasse = estDict(corps) ? corps["password"] : undefined;
    if (typeof motDePasse !== "string" || motDePasse === "" || motDePasse.length > 1024)
      throw new HttpError(400, "Champ « password » : texte attendu.");
    const secret = secretLiaisonDe(req.headers.cookie);
    const t = maintenant();
    const flux = secret === null ? null : await lireFluxPreuve(base, secret, t);
    if (flux === null) throw new HttpError(409, PREUVE_PERIMEE);
    const [f] = await fournisseursActifs(base, cookieSecure, flux.providerId);
    if (f === undefined) throw new HttpError(409, PREUVE_PERIMEE);
    const ip = ipDuClient(req, dep.mandataires);
    limiter(ip);
    const cle = cleAdresse(ip);
    const attente = debit.attenteS(flux.username, cle, t);
    if (attente > 0) throw new HttpError(429, REFUS_DEBIT, { "Retry-After": String(Math.ceil(attente)) });
    const essai = debit.prendre(flux.username, cle, t);
    const agent = entete(req, "user-agent") ?? null;
    const r = await prouverEtRattacher(connexion.provisionnement, {
      fournisseur: f,
      prelinkId: flux.prelinkId,
      profil: flux.profil,
      appartenance: flux.appartenance,
      motDePasse,
      ip,
      userAgent: agent,
    });
    if (r.type === "mot_de_passe") {
      if (essai.epuise)
        auditerRefusPreuve(
          { fournisseur: f, profil: flux.profil, ip, userAgent: agent },
          { uid: null, username: flux.username, action: "auth.login.denied", raison: "rate_limited" },
        );
      if (essai.delaiMs > 0) await new Promise((fin) => setTimeout(fin, essai.delaiMs));
      throw new HttpError(401, "invalid credentials");
    }
    if (r.type !== "compte") {
      debit.annulation(essai, maintenant());
      auditerRefusPreuve(
        { fournisseur: f, profil: flux.profil, ip, userAgent: agent },
        {
          uid: r.type === "refus" ? (r.uid ?? null) : null,
          username: flux.username,
          action: "auth.identity.link.denied",
          raison: r.type === "refus" ? r.raison : r.type,
        },
      );
      throw new HttpError(409, PREUVE_PERIMEE);
    }
    try {
      await ouvrirSessionOidc(connexion, {
        fournisseur: f,
        uid: r.uid,
        username: flux.username,
        mode: "retrait",
        sub: flux.sub,
        idpSid: flux.idpSid,
        idToken: flux.idToken,
        groupes: flux.groupes,
        secondFacteur: flux.secondFacteur,
        session: req.session,
        ip,
        userAgent: agent,
      });
    } catch (e) {
      if (e instanceof ConnexionRefusee) {
        if (essai.delaiMs > 0) await new Promise((fin) => setTimeout(fin, essai.delaiMs));
        throw new HttpError(401, "invalid credentials");
      }
      dep.journal.error({ err: e }, "[auth] ouverture de session échouée après la preuve du titulaire");
      auditerRefusPreuve(
        { fournisseur: f, profil: flux.profil, ip, userAgent: agent },
        { uid: r.uid, username: flux.username, action: "auth.login.denied", raison: "session_open_failed" },
      );
      debit.annulation(essai, maintenant());
      throw new HttpError(409, PREUVE_PERIMEE);
    }
    debit.reussite(essai, maintenant());
    return { ok: true, next: cibleDeRetour(lireReglagesAuth().public_url, flux.cible, flux.oauthNext) };
  }

  return {
    nom: "identite",
    routes: [
      {
        methode: "GET",
        chemin: "/api/auth/oidc/link-proof",
        processus: ["main"],
        acces: "public",
        traiter: preuveEnCours,
      },
      {
        methode: "POST",
        chemin: "/api/auth/oidc/link-proof",
        processus: ["main"],
        acces: "public",
        corps: { limite: CORPS_PREUVE_MAX },
        traiter: prouverLien,
      },
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
    ],
  };
}
