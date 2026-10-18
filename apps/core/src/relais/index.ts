// SPDX-License-Identifier: MIT
/** apps/core/src/relais/index.ts — famille du relais vers l'hôte d'outils : routes HTTP et WebSocket des préfixes relayés, registre des terminaux, arrêt. */
import { dependancesParDefaut, estInterSite, revaliderFlux } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import type { FastifyInstance, FastifyRequest, HTTPMethods } from "fastify";
import { Agent } from "undici";
import type { WebSocket } from "ws";

import { base } from "../base";
import { journal as journalDomaine } from "../journal";
import type { Journal } from "../journal";
import type { Acces, DefinitionRoute, Famille, Traitement, TraitementWs } from "../routes";
import {
  isPreviewPath,
  isRelayedPath,
  PREVIEW_PREFIXES,
  RELAY_PREFIXES,
  unquotePy,
  urlAmont,
  wsUrl,
} from "./chemins";
import { previewPathUid } from "./apercu";
import { sandboxHostFor } from "./hotes";
import { refuser, relayerHttp } from "./http";
import type { ContexteHttp, Revalidation } from "./http";
import { entetesRelais } from "./identite";
import { ConnexionWs, fermee, fermerBorne } from "./ws";
import type { PreparationWs } from "./ws";
import { decouperCible } from "@elpis/http";

export const AUCUN_HOTE = "aucun hôte d'outils déclaré : mcp.json › sandboxHosts";
export const SANS_JETON = "hôte d'outils sans jeton de service";
export const APERCU_EXPIRE = "Aperçu expiré : rechargez-le";
const METHODES_SANS_WS: HTTPMethods[] = ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
export const SESSION_RECHECK_MS = 60_000;

export interface OptionsRelais {
  readonly journal?: Journal;
  /** `cycle.signalArret` : WebSocket relayées fermées en 1012 et flux SSE terminés dès l'annonce de l'arrêt. */
  readonly arret?: AbortSignal;
  readonly delaiConnexionMs?: number;
  readonly battementMs?: number;
  /** `_CLOSE_TIMEOUT_S` : au-delà, une fermeture sans réponse coupe le transport (5 s). */
  readonly delaiFermetureMs?: number;
  /** Dépendances de la revalidation des sessions (`revaliderFlux`) ; défaut : celles de production sur la base du core. */
  readonly auth?: DependancesAuth;
  readonly revalidationMs?: number;
}

export interface Relais {
  readonly famille: Famille;
  /** Révocation (bus d'événements) : WebSocket relayées du compte closes comme à l'expiration (4001 des deux côtés, l'hôte tue les PTY) ; `null` = toutes (rend -1). */
  fermerTerminauxDuCompte(uid: number | null): number;
  fermer(): Promise<void>;
}

function estRouteApercu(requete: FastifyRequest): boolean {
  const motif = requete.routeOptions.url ?? "";
  return PREVIEW_PREFIXES.some((p) => motif.startsWith(p));
}

/** Chemin décodé comme `scope["path"]`. */
function cheminDecode(requete: FastifyRequest): string {
  return unquotePy(decouperCible(requete.originalUrl).chemin);
}

/** Identité du chemin d'aperçu (décodé), ou celle de la session posée par la garde. */
function uidDeLaRequete(requete: FastifyRequest): { uid: number | null; apercu: boolean } {
  if (!estRouteApercu(requete)) return { uid: requete.utilisateur?.id ?? null, apercu: false };
  const decode = cheminDecode(requete);
  return { uid: isPreviewPath(decode) ? previewPathUid(decode) : null, apercu: true };
}

export function creerRelais(options: OptionsRelais = {}): Relais {
  const journal = options.journal ?? journalDomaine("sandbox-relay");
  const delaiConnexionMs = options.delaiConnexionMs ?? 5_000;
  const battementMs = options.battementMs ?? 20_000;
  const delaiFermetureMs = options.delaiFermetureMs ?? 5_000;
  const agent = new Agent({
    connect: { timeout: delaiConnexionMs },
    headersTimeout: 0,
    bodyTimeout: 0,
    keepAliveTimeout: 5_000,
  });
  const revalidationMs = options.revalidationMs ?? SESSION_RECHECK_MS;
  const ctx: ContexteHttp = { agent, journal, flux: new Set(), arret: options.arret, revalidationMs };
  let authParDefaut: DependancesAuth | undefined;
  const terminaux = new Map<number, Set<ConnexionWs>>();
  const preparations = new WeakMap<FastifyRequest, PreparationWs>();
  const enGarde = new WeakSet<FastifyRequest>();

  /** Fermetures en cours (bornées), attendues par l'arrêt du relais. */
  const enFermeture = new Set<Promise<void>>();
  const suivre = (fin: Promise<void>): void => {
    enFermeture.add(fin);
    void fin.then(() => enFermeture.delete(fin));
  };
  const retirer = (c: ConnexionWs): void => {
    const ouvertes = terminaux.get(c.uid);
    ouvertes?.delete(c);
    if (ouvertes?.size === 0) terminaux.delete(c.uid);
    suivre(c.fin);
  };

  /** `_session_valide` : session du navigateur toujours valide ? Erreur passagère → oui. */
  async function sessionValide(uid: number, loginTs: unknown, sid: unknown): Promise<boolean> {
    try {
      return await revaliderFlux(
        options.auth ?? (authParDefaut ??= dependancesParDefaut(base())),
        uid,
        loginTs,
        sid,
      );
    } catch {
      return true;
    }
  }

  /** Revalidation de la session lue à l'ouverture ; aucune pour un aperçu, dont l'identité est celle de son jeton. */
  function revalidation(requete: FastifyRequest, uid: number, apercu: boolean): Revalidation {
    if (apercu) return undefined;
    const loginTs = requete.session.get("_login_ts");
    const sid = requete.session.get("_sid");
    return () => sessionValide(uid, loginTs, sid);
  }

  /** Ordre de `SandboxRelayASGI` : identité, hôte du compte (affectation `by_user` enregistrée au passage), jeton, puis relais. */
  const traiter: Traitement = async (requete, reponse) => {
    if (!isRelayedPath(cheminDecode(requete))) throw new HttpError(404);
    const { uid, apercu } = uidDeLaRequete(requete);
    if (uid === null) return refuser(reponse, apercu ? 403 : 401, apercu ? APERCU_EXPIRE : "not logged in");
    const hote = await sandboxHostFor(uid);
    if (hote === null) return refuser(reponse, 503, AUCUN_HOTE);
    if (!hote.token) return refuser(reponse, 503, SANS_JETON);
    return relayerHttp(requete, reponse, hote, uid, ctx, apercu, revalidation(requete, uid, apercu));
  };

  /** Contrôles d'avant l'upgrade, dans l'ordre de `_relay_ws` ; tout refus devient un 403 à la poignée de main (comme uvicorn). */
  async function preparerWs(requete: FastifyRequest): Promise<PreparationWs | null> {
    const { uid, apercu } = uidDeLaRequete(requete);
    if (uid === null || !isRelayedPath(cheminDecode(requete))) return null;
    const hote = await sandboxHostFor(uid);
    if (hote === null || !hote.token || estInterSite(requete.headers, requete.host)) return null;
    const { chemin, requete: query } = decouperCible(requete.originalUrl);
    const url = urlAmont(wsUrl(hote.url), chemin, query, apercu);
    if (url === null) return null;
    return {
      uid,
      url,
      entetes: await entetesRelais(hote, uid),
      chemin: unquotePy(chemin),
      revalider: revalidation(requete, uid, apercu),
    };
  }

  const relayerWs: TraitementWs = (socket: WebSocket, requete) => {
    const preparation = preparations.get(requete);
    preparations.delete(requete);
    if (preparation === undefined || options.arret?.aborted) {
      fermerBorne(socket, preparation === undefined ? 1011 : 1012, "", delaiFermetureMs);
      suivre(fermee(socket));
      return;
    }
    const connexion = new ConnexionWs(socket, preparation, {
      journal,
      delaiConnexionMs,
      battementMs,
      revalidationMs,
      delaiFermetureMs,
      surFin: retirer,
    });
    const ouvertes = terminaux.get(preparation.uid) ?? new Set<ConnexionWs>();
    ouvertes.add(connexion);
    terminaux.set(preparation.uid, ouvertes);
    connexion.demarrer();
  };

  function toutes(): ConnexionWs[] {
    return [...terminaux.values()].flatMap((s) => [...s]);
  }

  function arreter(): void {
    for (const finir of [...ctx.flux]) finir();
    for (const c of toutes()) c.fermer(1012);
  }
  options.arret?.addEventListener("abort", arreter, { once: true });

  /** Corps jamais lu ni validé (l'hôte applique ses limites), routes hors CORS de l'app comme derrière le middleware Python, refus au format du relais. */
  async function contexte(sous: FastifyInstance): Promise<void> {
    sous.removeAllContentTypeParsers();
    sous.addContentTypeParser("*", (_requete, _flux, fini) => {
      fini(null);
    });
    sous.addHook("onRoute", (route) => {
      route.config = Object.assign({}, route.config, { horsCors: true });
    });
    sous.addHook("preParsing", async (requete, _reponse, charge) => {
      delete requete.raw.headers["content-type"];
      return charge;
    });
    sous.addHook("onRequest", async (requete) => {
      enGarde.add(requete);
    });
    sous.addHook("preHandler", async (requete, reponse) => {
      enGarde.delete(requete);
      if (!requete.ws) return undefined;
      const preparation = await preparerWs(requete);
      if (preparation === null) return reponse.code(403).send();
      preparations.set(requete, preparation);
      return undefined;
    });
    sous.setErrorHandler((erreur, requete, reponse) => {
      if (requete.ws) return reponse.code(403).send();
      if (enGarde.has(requete) && erreur instanceof HttpError && [401, 403].includes(erreur.statusCode)) {
        return refuser(reponse, 401, "not logged in");
      }
      throw erreur;
    });
    sous.addHook("onClose", async () => {
      await relais.fermer();
    });
  }

  function routes(prefixe: string, acces: Acces): DefinitionRoute[] {
    const chemin = `${prefixe}*`;
    return [
      { methode: "GET", chemin, processus: ["main"], acces, traiter, ws: relayerWs },
      { methode: METHODES_SANS_WS, chemin, processus: ["main"], acces, traiter },
    ];
  }

  const relais: Relais = {
    famille: {
      nom: "relais",
      intercepteur: true,
      contexte,
      routes: [
        ...RELAY_PREFIXES.flatMap((p) => routes(p, "session")),
        ...PREVIEW_PREFIXES.flatMap((p) => routes(p, "public")),
      ],
    },
    fermerTerminauxDuCompte(uid) {
      const cibles = uid === null ? toutes() : [...(terminaux.get(uid) ?? [])];
      for (const c of cibles) c.expirer();
      return uid === null ? -1 : cibles.length;
    },
    async fermer() {
      arreter();
      await Promise.all([agent.destroy(), ...enFermeture]);
    },
  };
  return relais;
}

export { checkPreviewToken, familleJetonApercu, makePreviewToken, previewPathUid, TTL_S } from "./apercu";
export {
  codeFermeture,
  isPreviewPath,
  isRelayedPath,
  PREVIEW_PREFIXES,
  RELAY_PREFIXES,
  SERVIS_PAR_MAIN,
  unquotePy,
  upstreamPath,
} from "./chemins";
export { hostFromSpec, isLoopback, lireHotes, sandboxHostFor } from "./hotes";
export type { SandboxHost } from "./hotes";
export { entetesRelais, identiteRelais, profilReseauDesReglages, resolveNetworkProfileId } from "./identite";
export { hostForUser, leastLoaded, placementOf } from "./placement";
export {
  FILE_HISTORY_SESSION_PATH,
  fetchRelayedBytes,
  ouvrirSessionHistorique,
  pushSkillsMirror,
} from "./services";
