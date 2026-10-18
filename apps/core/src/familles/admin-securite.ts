// SPDX-License-Identifier: MIT
/** apps/core/src/familles/admin-securite.ts — console : révocation des sessions, mode HTTPS et écoute (admin/security.py). */
import {
  estLocalDirect,
  effacerMinSession,
  leverMinSession,
  ligneUtilisateur,
  revoquerTousAcces,
} from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import {
  floatPy,
  getPy,
  HttpError,
  lowerPy,
  poserCle,
  stripPy,
  texteOu,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { readConfigJson, sousVerrouConfigJson, writeConfigJson } from "@elpis/config";
import type { Base } from "@elpis/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { auditer, entierPy, lireConfigPourEcrire } from "../admin/aides";
import {
  caddyEcoute,
  hoteDEcoute,
  hotePublicDe,
  httpsActif,
  modeEcoute,
  portsHttps,
  redemarrerApp,
  sectionDict,
  sousDict,
  urlsHttps,
} from "../admin/securite";
import type { PortCycleVie } from "../admin/securite";
import type { Journal } from "../journal";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";
import { corpsJsonValeurs, entrees, py, reponseJsonPy } from "@elpis/http";

export interface DependancesAdminSecurite {
  readonly base: Base;
  readonly auth: DependancesAuth & DependancesJetons;
  readonly journal: Journal;
  readonly revoquer: (uid: number | null) => Promise<unknown>;
  /** Diffusion à tous les process (fenêtre de maintenance avant redémarrage). */
  readonly diffuser: (message: Dict) => Promise<unknown>;
  readonly cycleVie?: PortCycleVie;
  /** Sonde TCP d'un port du frontal Caddy (tests). */
  readonly sonderPort?: (port: number) => Promise<boolean>;
}

const REFUS_LOCAL =
  "Passer en écoute locale depuis le réseau vous couperait l'accès : faites-le depuis le serveur (http://127.0.0.1:8002/admin) ou ./elpis configure --listen local.";

function route(methode: "GET" | "POST", chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["admin"], acces: "admin", traiter };
}

function cheminEntier(requete: FastifyRequest, nom: string): number {
  return (entrees(requete, { path: { [nom]: py.int() } }).path as Record<string, number>)[nom] as number;
}

/** `await request.json()` sous `except Exception: body = {}`. */
function corpsOuVide(requete: FastifyRequest): unknown {
  try {
    return corpsJsonValeurs(requete);
  } catch {
    return {};
  }
}

function clientLocal(requete: FastifyRequest): boolean {
  try {
    return estLocalDirect(requete.socket.remoteAddress, requete.headers);
  } catch {
    return false;
  }
}

export function creerFamilleAdminSecurite(dep: DependancesAdminSecurite): Famille {
  const { base, auth } = dep;
  const maintenant = (): number => (auth.maintenant ? auth.maintenant() : Date.now() / 1000);
  const sonder = dep.sonderPort ?? ((port: number) => caddyEcoute(port));
  const redemarrage = { journal: dep.journal, diffuser: dep.diffuser, cycleVie: dep.cycleVie, maintenant };

  async function publierRevocation(uid: number | null): Promise<void> {
    try {
      await dep.revoquer(uid);
    } catch (e) {
      dep.journal.error({ err: e }, "[security] publication session_revoked échouée");
    }
  }

  async function sessions(_req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    const sess = sousDict(sousDict(readConfigJson(), "security"), "session");
    const revoques: Dict[] = [];
    try {
      const lignes = await base.valeurs<[unknown, unknown, unknown]>(
        "SELECT id, username, session_min_ts FROM users WHERE session_min_ts IS NOT NULL AND session_min_ts > 0 " +
          "ORDER BY session_min_ts DESC LIMIT 200",
      );
      for (const [id, nom, ts] of lignes)
        revoques.push({
          user_id: Number(id),
          username: String(nom),
          session_min_ts: versFlottantPy(veritePy(ts) ? Number(ts) : 0),
        });
    } catch (e) {
      dep.journal.warn(`admin_security_sessions_overview: ${e instanceof Error ? e.message : String(e)}`);
    }
    return reponseJsonPy(rep, {
      session_cfg: {
        max_age_sec: entierPy(getPy(sess, "max_age_sec", 86400)),
        idle_timeout_sec: entierPy(getPy(sess, "idle_timeout_sec", 0)),
        cookie_name: texteOu(getPy(sess, "cookie_name", null), "mcpwebui_session"),
        same_site: texteOu(getPy(sess, "same_site", null), "lax"),
        https_only: veritePy(getPy(sess, "https_only", false)),
        global_min_ts: versFlottantPy(floatPy(getPy(sess, "global_min_ts", versFlottantPy(0)))),
      },
      revoked_user_count: revoques.length,
      revoked_users: revoques,
    });
  }

  async function revoquerTout(req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    const operateur = utilisateur(req);
    const t = maintenant();
    await sousVerrouConfigJson(() => {
      const cfg = lireConfigPourEcrire();
      const sess = sectionDict(sectionDict(cfg, "security"), "session");
      poserCle(sess, "global_min_ts", versFlottantPy(t));
      writeConfigJson(cfg);
    });
    dep.journal.warn(
      `[security] global session revocation issued by uid=${operateur}, new global_min_ts=${String(versFlottantPy(t))}`,
    );
    auditer(req, "admin.security.sessions.revoke_all", { global_min_ts: versFlottantPy(t) });
    await publierRevocation(null);
    return reponseJsonPy(rep, { ok: true, global_min_ts: versFlottantPy(t) });
  }

  async function revoquerCompte(req: FastifyRequest, rep: FastifyReply): Promise<FastifyReply> {
    const operateur = utilisateur(req);
    const cible = cheminEntier(req, "user_id");
    const t = maintenant();
    try {
      const u = await ligneUtilisateur(base, cible);
      if (!u) throw new HttpError(404, "Utilisateur introuvable");
      await leverMinSession(base, cible, t);
      const acces = await revoquerTousAcces(auth, cible);
      dep.journal.warn(
        `[security] per-user session revocation: uid=${cible} revoked by uid=${operateur} (jetons=${acces.tokens}, oauth=${acces.oauth})`,
      );
      auditer(req, "admin.security.sessions.revoke_user", {
        target_user_id: cible,
        session_min_ts: versFlottantPy(t),
        tokens_revoked: acces.tokens,
        oauth_revoked: acces.oauth,
      });
      await publierRevocation(cible);
      return reponseJsonPy(rep, {
        ok: true,
        user_id: cible,
        session_min_ts: versFlottantPy(t),
        username: u.username,
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      dep.journal.error({ err: e }, "revoke-user failed");
      throw new HttpError(500, "Échec de la révocation");
    }
  }

  async function effacerRevocation(req: FastifyRequest): Promise<Dict> {
    const cible = cheminEntier(req, "user_id");
    try {
      await effacerMinSession(base, cible);
    } catch (e) {
      dep.journal.error({ err: e }, "clear-user-revocation failed");
      throw new HttpError(500, "Échec du reset");
    }
    return { ok: true, user_id: cible };
  }

  async function etatHttps(req: FastifyRequest): Promise<Dict> {
    const cfg = readConfigJson();
    const ports = portsHttps(cfg);
    const actif = httpsActif(cfg);
    const proto = req.headers["x-forwarded-proto"];
    let schema = lowerPy(stripPy(((Array.isArray(proto) ? proto[0] : proto) ?? "").split(",")[0] ?? ""));
    if (schema !== "http" && schema !== "https") schema = lowerPy(req.protocol || "http");
    return {
      enabled: actif,
      ports,
      caddy: {
        main: await sonder(ports["main"] as number),
        admin: await sonder(ports["admin"] as number),
        rag: await sonder(ports["rag"] as number),
      },
      current_scheme: schema,
      urls: urlsHttps(hotePublicDe(req), actif, ports),
      listen: modeEcoute(cfg),
      client_local: clientLocal(req),
    };
  }

  async function basculerHttps(req: FastifyRequest): Promise<Dict> {
    const operateur = utilisateur(req);
    const corps = corpsOuVide(req);
    const actif = veritePy(getPy(veritePy(corps) ? corps : {}, "enabled", null));
    const ports = portsHttps(readConfigJson());
    if (actif) {
      const fermes: number[] = [];
      for (const p of [ports["main"], ports["admin"]] as number[]) if (!(await sonder(p))) fermes.push(p);
      if (fermes.length)
        throw new HttpError(
          409,
          `Caddy n'écoute pas sur le(s) port(s) ${fermes.map((p) => `:${p}`).join(", ")} — installez/démarrez le reverse proxy (deploy/caddy/install_caddy.sh) avant d'activer le HTTPS.`,
        );
    }
    const hote = await sousVerrouConfigJson(() => {
      const cfg = lireConfigPourEcrire();
      const sec = sectionDict(cfg, "security");
      const https = sectionDict(sec, "https");
      poserCle(https, "enabled", actif);
      for (const [cle, defaut] of [
        ["main_port", 443],
        ["admin_port", 8443],
        ["rag_port", 8444],
      ] as const)
        if (!Object.hasOwn(https, cle)) poserCle(https, cle, defaut);
      const sess = sectionDict(sec, "session");
      poserCle(sess, "https_only", actif);
      if (!actif && lowerPy(texteOu(getPy(sess, "same_site", null), "")) === "none")
        poserCle(sess, "same_site", "lax");
      writeConfigJson(cfg);
      return hoteDEcoute(cfg);
    });
    dep.journal.warn(
      `[security] HTTPS mode ${actif ? "ENABLED" : "DISABLED"} by uid=${operateur} (binds ${hote}, cookie https_only=${actif ? "True" : "False"})`,
    );
    const ok = await redemarrerApp(
      redemarrage,
      `Le serveur redémarre pour changer de mode d'accès (${actif ? "HTTPS" : "HTTP direct"}). Reconnexion automatique...`,
    );
    return { ok, enabled: actif, urls: urlsHttps(hotePublicDe(req), actif, ports), main_restarted: ok };
  }

  async function changerEcoute(req: FastifyRequest): Promise<Dict> {
    const operateur = utilisateur(req);
    const corps = corpsOuVide(req);
    const ecoute = lowerPy(stripPy(texteOu(getPy(veritePy(corps) ? corps : {}, "listen", null), "")));
    if (ecoute !== "local" && ecoute !== "lan") throw new HttpError(400, "listen : « local » ou « lan »");
    const hote = await sousVerrouConfigJson(() => {
      const cfg = lireConfigPourEcrire();
      const sec = sectionDict(cfg, "security");
      if (veritePy(getPy(sousDict(sec, "https"), "enabled", false)))
        throw new HttpError(409, "HTTPS actif : l'application écoute déjà en local derrière Caddy.");
      if (ecoute === "local" && !clientLocal(req)) throw new HttpError(409, REFUS_LOCAL);
      poserCle(sec, "listen", ecoute);
      writeConfigJson(cfg);
      return hoteDEcoute(cfg);
    });
    dep.journal.warn(`[security] listen=${ecoute} by uid=${operateur} (binds ${hote})`);
    const ok = await redemarrerApp(
      redemarrage,
      `Le serveur redémarre pour changer d'écoute (${ecoute === "lan" ? "réseau local" : "ce serveur seulement"}). Reconnexion automatique...`,
    );
    return { ok, listen: ecoute, main_restarted: ok };
  }

  return {
    nom: "admin-securite",
    routes: [
      route("GET", "/api/admin/security/sessions", sessions),
      route("POST", "/api/admin/security/sessions/revoke-all", revoquerTout),
      route("POST", "/api/admin/security/sessions/revoke-user/:user_id", revoquerCompte),
      route("POST", "/api/admin/security/sessions/clear-user-revocation/:user_id", effacerRevocation),
      route("GET", "/api/admin/security/https", etatHttps),
      route("POST", "/api/admin/security/https", basculerHttps),
      route("POST", "/api/admin/security/listen", changerEcoute),
    ],
  };
}
