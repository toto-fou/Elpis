// SPDX-License-Identifier: MIT
/** apps/core/src/familles/identite.ts — connexion par SSO OpenID Connect : départ du flux (main et console) et retour du fournisseur (main) ; 404 tant que le fournisseur n'est pas actif, tout refus mène à un code d'une liste fermée ; la frontière de confiance du cookie de liaison est le nom d'hôte (tout port). */
import { randomBytes } from "node:crypto";

import {
  cleAdresse,
  dependancesSession,
  dureeMaxSession,
  ipDuClient,
  validerSession,
  valeurCookie,
} from "@elpis/auth";
import type { DependancesAuth, DependancesJetons, Reseau } from "@elpis/auth";
import { estDict, HttpError } from "@elpis/commun";
import { auditEvent } from "@elpis/securite";
import { corpsJson, corpsLu, entete } from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";

import { DebitConnexion } from "../comptes/debit-connexion";
import { ConnexionRefusee } from "../comptes/ouverture";
import type { PortBac } from "../admin/bac";
import { ligneUtilisateur } from "@elpis/auth";
import { decouperHotePort } from "../interface/urls-publiques";
import { empreinteFournisseur, fournisseursActifs, enregistrerTestReussi } from "../identite/fournisseurs";
import type { Journal } from "../journal";
import { auditerRefus, auditerRequete } from "../journal-securite/auditer";
import { auditerRefusPreuve, prouverEtRattacher } from "../identite/rattachement";
import { connecterParOidc } from "../identite/oidc/connexion";
import { lireFluxPreuve, ouvrirFluxPreuve, ouvrirSessionApresPreuve } from "../identite/oidc/preuve";
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
import {
  RAISON_REGLAGES_CHANGES,
  resultatEssaiBlanc,
  resultatEssaiEchoue,
  ranger,
} from "../identite/oidc/essai-blanc";
import type { ResultatEssaiBlanc } from "../identite/oidc/essai-blanc";
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
  /** Flux ouverts d'un compte rattaché coupés dans tous les process. */
  readonly revoquer: (uid: number) => Promise<unknown>;
  readonly bac?: PortBac;
}

const CORPS_DEPART_MAX = 4096;
const CORPS_PREUVE_MAX = 4096;
const STATE_MAX = 256;
const DUREE_REJEU_S = 900;
const PREUVE_PERIMEE =
  "Cette demande n'est plus valable : reconnectez-vous ou demandez à votre administrateur.";
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
  async function actif(id: string): Promise<FournisseurOidc> {
    const f = (await fournisseursActifs(base, cookieSecure)).find((p) => p.id === id);
    if (f === undefined || f.type !== "oidc") throw new HttpError(404, "Not Found");
    return f;
  }

  function limiter(ip: string): void {
    const t = maintenant();
    const cle = cleAdresse(ip);
    const attente = debit.attenteAdresseS(cle, t);
    if (attente > 0) throw new HttpError(429, REFUS_DEBIT, { "Retry-After": String(Math.ceil(attente)) });
    debit.prendreAdresse(cle, t);
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

  /** Nom du compte pour l'audit, `null` s'il ne se lit pas. */
  async function nomDe(uid: number): Promise<string | null> {
    try {
      return String((await ligneUtilisateur(base, uid))?.username ?? "") || null;
    } catch {
      return null;
    }
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
    const cle = cleAdresse(ip);
    const publicUrl = lireReglagesAuth().public_url;
    const t = maintenant();
    let ouverte: Awaited<ReturnType<FabriqueConfigurations["ouvrir"]>> | null = null;
    try {
      if (debit.attenteAdresseS(cle, t) > 0) throw new RefusOidc("unavailable", "rate_limited");
      debit.prendreAdresse(cle, t);
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
      if (flux.essaiAdmin !== null) {
        const admin = flux.essaiAdmin;
        let resultat: ResultatEssaiBlanc;
        let verifie = null;
        try {
          if (flux.empreinteReglages !== empreinteFournisseur(f, publicUrl))
            throw new RefusOidc("failed", RAISON_REGLAGES_CHANGES);
          ouverte = await dep.configurations.ouvrir(f, publicUrl);
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
        if (resultat.ok) debit.rendreAdresse(cle, t);
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
            profil: issue.profil,
            appartenance: issue.appartenance,
            sub: verifie.sub,
            idpSid: verifie.idpSid,
            idToken: verifie.idToken,
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
      debit.rendreAdresse(cle, t);
      debit.rendreAdresse(cle, t);
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

  /** Demande de preuve en cours du navigateur : `pending` et le compte visé, ou rien. */
  async function preuveEnCours(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
    void rep.headers(ENTETES_REFUS);
    const secret = secretLiaisonValide(valeurCookie(req.headers.cookie, COOKIE_LIAISON));
    const aucune = { pending: false, username: null };
    if (secret === null) return aucune;
    const flux = await lireFluxPreuve(base, secret, maintenant());
    if (flux === null) return aucune;
    const compte = await base.get<{ username: string }>(
      "SELECT u.username FROM auth_prelinks p JOIN users u ON u.id=p.user_id WHERE p.id=?",
      [flux.prelinkId],
    );
    return compte === undefined ? aucune : { pending: true, username: compte.username };
  }

  /** Ancien mot de passe du compte visé : preuve du titulaire, rattachement, session `oidc:<id>`. */
  async function prouverLien(req: FastifyRequest, rep: FastifyReply): Promise<unknown> {
    void rep.headers(ENTETES_REFUS);
    const corps = corpsJson(req);
    const motDePasse = estDict(corps) ? corps["password"] : undefined;
    if (typeof motDePasse !== "string" || motDePasse === "" || motDePasse.length > 1024)
      throw new HttpError(400, "Champ « password » : texte attendu.");
    const secret = secretLiaisonValide(valeurCookie(req.headers.cookie, COOKIE_LIAISON));
    const t = maintenant();
    const flux = secret === null ? null : await lireFluxPreuve(base, secret, t);
    if (flux === null) throw new HttpError(409, PREUVE_PERIMEE);
    const compte = await base.get<{ username: string }>(
      "SELECT u.username FROM auth_prelinks p JOIN users u ON u.id=p.user_id WHERE p.id=?",
      [flux.prelinkId],
    );
    if (compte === undefined) throw new HttpError(409, PREUVE_PERIMEE);
    const f = (await fournisseursActifs(base, cookieSecure)).find((p) => p.id === flux.providerId);
    if (f === undefined || f.type !== "oidc") throw new HttpError(409, PREUVE_PERIMEE);
    const ip = ipDuClient(req, dep.mandataires);
    limiter(ip);
    const cle = cleAdresse(ip);
    const attente = debit.attenteS(compte.username, cle, t);
    if (attente > 0) throw new HttpError(429, REFUS_DEBIT, { "Retry-After": String(Math.ceil(attente)) });
    const essai = debit.prendre(compte.username, cle, t);
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
          { uid: null, username: compte.username, action: "auth.login.denied", raison: "rate_limited" },
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
          username: compte.username,
          action: "auth.identity.link.denied",
          raison: r.type === "refus" ? r.raison : r.type,
        },
      );
      throw new HttpError(409, PREUVE_PERIMEE);
    }
    try {
      await ouvrirSessionApresPreuve(connexion, {
        fournisseur: f,
        uid: r.uid,
        username: compte.username,
        sub: flux.sub,
        idpSid: flux.idpSid,
        idToken: flux.idToken,
        session: req.session,
        maintenant: t,
        ip,
        userAgent: agent,
      });
    } catch (e) {
      if (e instanceof ConnexionRefusee) throw new HttpError(401, "invalid credentials");
      throw e;
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
