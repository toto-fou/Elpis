// SPDX-License-Identifier: MIT
/** apps/core/src/familles/pont-mcp.ts — relais MCP sous l'origine de l'app (mcp/bridge.py) : client authentifié, délégation signée, flux non tamponné. */
import { resoudreJeton, verifyAccessToken } from "@elpis/auth";
import type { DependancesJetons, DependancesOAuth } from "@elpis/auth";
import {
  decoderUtf8Py,
  ErreurJsonPy,
  ErreurLecturePy,
  estDict,
  HttpError,
  intPy,
  lowerPy,
  pyJsonLoadsOctets,
  rstripPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import {
  delegationToken,
  isFamilyName,
  load,
  originAllowed,
  ROLE_APP,
  serviceUpstream,
  TYPE_INPROCESS,
} from "@elpis/mcp";
import { jetonDelegue, VERSIONS_PROTOCOLE } from "@elpis/outils-mcp";
import type { ServiceMcpHttp } from "@elpis/outils-mcp";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Agent, request } from "undici";
import type { Dispatcher } from "undici";

import type { Extension } from "../app";
import type { Journal } from "../journal";
import { decrire, drainOuFermeture } from "../relais/http";
import type { Famille } from "../routes";
import { wwwAuthenticate } from "./oauth";
import { corpsLu, decouperCible, entetesFlux, installerCorpsBorne } from "@elpis/http";

export const MCP_PROXY_PREFIX = "/api/mcp-bridge";
/** `mcp.shared.version.SUPPORTED_PROTOCOL_VERSIONS` du SDK Python (mcp 1.27.1), dans son ordre. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
];

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);
const ENTETES_RELAYES = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
  "accept-encoding",
  "user-agent",
];
const INJOIGNABLE =
  "Le service MCP partagé ne répond pas. Vérifiez qu'il tourne (./elpis start) et que LOCAL_MCP_URL pointe dessus.";

export interface ClientPont {
  user_id: number;
  username: string;
  kind: string;
  families: string[];
  [cle: string]: unknown;
}

/** Entrée du manifeste d'une famille du compte servie en processus (`role: app` sans URL). */
function estEntreeEnProcessus(famille: string): boolean {
  const e = load().entryForFamily(famille);
  return e !== null && e.role === ROLE_APP && e.type === TYPE_INPROCESS;
}

export interface DependancesPontMcp {
  readonly jetons: DependancesJetons;
  readonly oauth: DependancesOAuth;
  readonly journal: Journal;
  /** Période de revérification du jeton sur les flux GET (60 s). */
  readonly reverificationMs?: number;
  readonly delaiConnexionMs?: number;
  /** `CycleDeVie.signalArret` : flux GET terminés dès l'annonce de l'arrêt. */
  readonly arret?: AbortSignal | undefined;
  /** Service MCP des familles du compte servies en processus (entrées `inprocess` du manifeste). */
  readonly enProcessus?: () => ServiceMcpHttp | null;
}

export interface PontMcp {
  readonly famille: Famille;
  /** Flux GET terminés dès l'annonce de l'arrêt, connexions amont détruites à la fermeture. */
  readonly extension: Extension;
  fermer(): Promise<void>;
}

/** Première valeur d'un en-tête, comme `request.headers[...]` de Starlette (Node joint les doublons). */
export function premiereValeur(requete: FastifyRequest, nom: string): string | undefined {
  const brut = requete.raw.rawHeaders;
  for (let i = 0; i + 1 < brut.length; i += 2) if (brut[i]?.toLowerCase() === nom) return brut[i + 1];
  return undefined;
}

/** `_caller_token` : `Authorization: Bearer …` (clients MCP, opencode) ou `x-elpis-token` (le greffon), sinon "". */
export function jetonAppelant(requete: FastifyRequest): string {
  const auth = stripPy(premiereValeur(requete, "authorization") ?? "");
  if (lowerPy(auth).startsWith("bearer ")) return stripPy(auth.slice(7));
  return stripPy(premiereValeur(requete, "x-elpis-token") ?? "");
}

/** `verify_client` : jeton personnel (opencode, outils) puis jeton d'accès OAuth ; un vérificateur en panne ne refuse rien d'autre. */
export async function verifierClient(
  dep: Pick<DependancesPontMcp, "jetons" | "oauth" | "journal">,
  jeton: string,
): Promise<ClientPont | null> {
  const verificateurs: (() => Promise<ClientPont | null>)[] = [
    async () => {
      const d = await resoudreJeton(dep.jetons, jeton, ["opencode", "tools"]);
      if (!d) return null;
      return {
        user_id: intPy(veritePy(d.user_id) ? d.user_id : 0),
        username: strPy(veritePy(d.username) ? d.username : ""),
        kind: strPy(veritePy(d.kind) ? d.kind : ""),
        families: [...d.families],
      };
    },
    async () =>
      jeton.startsWith("eoa_") ? ((await verifyAccessToken(dep.oauth, jeton)) as ClientPont | null) : null,
  ];
  for (const v of verificateurs) {
    let c: ClientPont | null;
    try {
      c = await v();
    } catch (e) {
      dep.journal.warn({ err: e }, "vérificateur de client en échec");
      c = null;
    }
    if (c && veritePy(c.username)) return c;
  }
  return null;
}

/** Corps amont abandonné : `destroy()` d'undici émet une erreur qu'aucun lecteur n'attend plus. */
function jeter(corps: Dispatcher.ResponseData["body"]): void {
  corps.on("error", () => undefined).destroy();
}

/** En-têtes de l'amont sans ceux de saut à saut (doublons joints comme httpx) ; `no-store` et `X-Accel-Buffering: no` s'y ajoutent comme dans bridge.py, après une valeur amont. */
function entetesSortants(amont: Dispatcher.ResponseData["headers"]): Record<string, string | string[]> {
  const sortants: Record<string, string | string[]> = {};
  for (const [nom, valeur] of Object.entries(amont)) {
    if (valeur === undefined || HOP_BY_HOP.has(nom)) continue;
    sortants[nom] = Array.isArray(valeur) ? valeur.join(", ") : valeur;
  }
  for (const [nom, valeur] of [
    ["cache-control", "no-store"],
    ["x-accel-buffering", "no"],
  ] as const) {
    const deja = sortants[nom];
    sortants[nom] = deja === undefined ? valeur : [String(deja), valeur];
  }
  return sortants;
}

/** `_is_initialize` : POST JSON-RPC `initialize` (corps illisible : non ; trop imbriqué : panne comme `json.loads`). */
function estInitialize(requete: FastifyRequest): boolean {
  if (requete.method !== "POST") return false;
  let msg: unknown;
  try {
    const corps = corpsLu(requete);
    msg = pyJsonLoadsOctets(corps.length > 0 ? corps : Buffer.from("{}"));
  } catch (e) {
    if (e instanceof ErreurJsonPy || (e instanceof ErreurLecturePy && e.nature !== "RecursionError"))
      return false;
    throw e;
  }
  return estDict(msg) && msg["method"] === "initialize";
}

export function creerPontMcp(dep: DependancesPontMcp): PontMcp {
  const agent = new Agent({
    connect: { timeout: dep.delaiConnexionMs ?? 5_000 },
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  const flux = new Set<() => void>();
  let fermeture: Promise<void> | undefined;
  const terminerFlux = (): void => {
    for (const finir of [...flux]) finir();
  };
  dep.arret?.addEventListener("abort", terminerFlux, { once: true });
  const instant = (): number => (dep.oauth.maintenant ? dep.oauth.maintenant() : Date.now() / 1000);
  const config = (): unknown => dep.oauth.config();

  const authentifies = new WeakMap<FastifyRequest, { jeton: string; client: ClientPont }>();

  /** Service joignable (404) et origine admise (403), premiers refus de `_relay_to_mcp`. */
  function joignable(
    requete: FastifyRequest,
    family: string,
  ): { enProcessus: ServiceMcpHttp | null; base: string } {
    const enService = dep.enProcessus?.() ?? null;
    const local = stripPy(family).replace(/^\/+|\/+$/gu, "");
    const enProcessus =
      enService !== null && isFamilyName(local) && estEntreeEnProcessus(local) ? enService : null;
    const [base] = serviceUpstream();
    if (!base && enProcessus === null) throw new HttpError(404, "Service MCP partagé non configuré.");
    if (!originAllowed(premiereValeur(requete, "origin") ?? null))
      throw new HttpError(403, "Origine non autorisée.");
    return { enProcessus, base: base ?? "" };
  }

  /** `_caller_token` puis `verify_client` (401), familles d'un jeton OAuth (403) ; une seule vérification par requête. */
  async function authentifier(
    requete: FastifyRequest,
    fam: string,
  ): Promise<{ jeton: string; client: ClientPont }> {
    const connu = authentifies.get(requete);
    if (connu !== undefined) return connu;
    const jeton = jetonAppelant(requete);
    if (!jeton)
      throw new HttpError(401, "Jeton requis (Paramètres › Connexions).", {
        "WWW-Authenticate": wwwAuthenticate(requete, config, fam),
      });
    const client = await verifierClient(dep, jeton);
    if (client === null)
      throw new HttpError(401, "Jeton invalide, expiré ou révoqué.", {
        "WWW-Authenticate": wwwAuthenticate(requete, config, fam, "invalid_token"),
      });
    if (client.kind === "oauth" && fam && !client.families.includes(fam))
      throw new HttpError(403, "Famille d'outils non autorisée pour ce jeton.", {
        "WWW-Authenticate": wwwAuthenticate(requete, config, fam, "insufficient_scope"),
      });
    const r = { jeton, client };
    authentifies.set(requete, r);
    return r;
  }

  /** Avant la lecture d'un POST : service, origine et jeton (écart : avec `mcp-protocol-version`, le Python lit le corps et rend son 400 avant les 401/403 du jeton). */
  async function avantCorps(requete: FastifyRequest): Promise<void> {
    const family = (requete.params as { family?: string }).family ?? "";
    joignable(requete, family);
    await authentifier(requete, stripPy(family).replace(/^\/+|\/+$/gu, ""));
  }

  /** Tout ce qui précède l'appel amont : refus dans l'ordre de `_relay_to_mcp`, puis URL, en-têtes et corps à relayer. */
  async function preparer(
    requete: FastifyRequest,
    family: string,
  ): Promise<
    | { url: string; entetes: Record<string, string>; jeton: string; local?: undefined }
    | { local: { service: ServiceMcpHttp; client: ClientPont; famille: string }; jeton: string }
  > {
    const { enProcessus, base } = joignable(requete, family);
    const pv = premiereValeur(requete, "mcp-protocol-version");
    if (pv !== undefined && !estInitialize(requete) && !SUPPORTED_PROTOCOL_VERSIONS.includes(pv))
      throw new HttpError(
        400,
        `Version de protocole MCP non prise en charge : ${Array.from(pv).slice(0, 40).join("")} ` +
          `(connues : ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}).`,
      );
    const fam = stripPy(family).replace(/^\/+|\/+$/gu, "");
    const { jeton, client } = await authentifier(requete, fam);
    if (enProcessus !== null) {
      if (!stripPy(client.username))
        throw new HttpError(401, "Jeton invalide, expiré ou révoqué.", {
          "WWW-Authenticate": wwwAuthenticate(requete, config, fam, "invalid_token"),
        });
      return { local: { service: enProcessus, client, famille: fam }, jeton };
    }
    let jetonService = serviceUpstream()[1];
    if (!base || !jetonService) throw new HttpError(404, "Service MCP partagé non configuré.");
    if (fam && !isFamilyName(fam)) throw new HttpError(404, "Famille d'outils inconnue.");
    const entree = fam ? load().entryForFamily(fam) : null;
    let url: string;
    if (entree !== null && entree.role === ROLE_APP && entree.isNetwork) {
      url = rstripPy(entree.url, "/");
      if (!url.endsWith(`/${fam}`)) url = `${url}/${fam}`;
      jetonService = entree.token || jetonService;
    } else url = fam ? `${base}/${fam}` : base;
    const query = decoderUtf8Py(Buffer.from(decouperCible(requete.originalUrl).requete, "latin1"));
    if (query) url += `?${query}`;
    const entetes: Record<string, string> = {};
    for (const h of ENTETES_RELAYES) {
      const v = premiereValeur(requete, h);
      if (v !== undefined) entetes[h] = v;
    }
    entetes["accept"] ??= "*/*";
    entetes["authorization"] = `Bearer ${delegationToken(client, jetonService, { now: instant() })}`;
    return { url, entetes, jeton };
  }

  /** Revérifie le jeton du client à intervalle fixe ; jeton révoqué : `couper` ; panne transitoire : flux gardé. */
  function veiller(jeton: string, url: string, couper: () => void): () => void {
    let minuterie: NodeJS.Timeout | undefined;
    let fini = false;
    const tour = (): void => {
      minuterie = setTimeout(() => {
        void (async () => {
          let ok: boolean;
          try {
            ok = (await verifierClient(dep, jeton)) !== null;
          } catch {
            ok = true;
          }
          if (fini) return;
          if (!ok) {
            dep.journal.info(`jeton révoqué : flux ${url} fermé`);
            couper();
            return;
          }
          tour();
        })();
      }, dep.reverificationMs ?? 60_000);
    };
    tour();
    return () => {
      fini = true;
      clearTimeout(minuterie);
    };
  }

  /** Famille du compte servie par le serveur MCP de ce process : mêmes revendications que la délégation, sans saut réseau. */
  async function servirLocal(
    requete: FastifyRequest,
    reponse: FastifyReply,
    local: { service: ServiceMcpHttp; client: ClientPont; famille: string },
    jeton: string,
  ): Promise<unknown> {
    const { service, client, famille } = local;
    if (requete.method === "GET") {
      const sid = premiereValeur(requete, "mcp-session-id");
      const pv = premiereValeur(requete, "mcp-protocol-version");
      if (!sid || !service.aSession(sid) || (pv !== undefined && !VERSIONS_PROTOCOLE.includes(pv)))
        return reponse.code(405).headers({ Allow: "POST", "Cache-Control": "no-store" }).send();
    }
    const acces = jetonDelegue("dlg_inprocess", {
      sub: client.username,
      uid: client.user_id,
      kind: client.kind,
      families: client.families,
    });
    const brut = reponse.raw;
    reponse.hijack();
    const finir = (): void => {
      if (!brut.writableEnded) brut.end();
    };
    const get = requete.method === "GET";
    let arreterVeille = (): void => undefined;
    if (get) {
      flux.add(finir);
      arreterVeille = veiller(jeton, `inprocess:${famille}`, finir);
      brut.on("close", () => {
        arreterVeille();
        flux.delete(finir);
      });
    }
    try {
      await service.traiter(requete.raw, brut, {
        jeton: acces,
        chemin: `/mcp/${famille}`,
        corps: requete.method === "POST" ? corpsLu(requete) : Buffer.alloc(0),
        entetes: (h) => entetesFlux(reponse, entetesSortants(h)),
      });
    } catch (e) {
      dep.journal.warn(`service MCP en processus en échec : ${decrire(e)}`);
      if (!brut.headersSent) brut.writeHead(500).end();
      else brut.destroy();
    }
    if (get && dep.arret?.aborted) finir();
    return undefined;
  }

  async function relayer(requete: FastifyRequest, reponse: FastifyReply, family: string): Promise<unknown> {
    const prepare = await preparer(requete, family);
    if (prepare.local !== undefined) return servirLocal(requete, reponse, prepare.local, prepare.jeton);
    const { url, entetes, jeton } = prepare;
    const brut = reponse.raw;
    const abandon = new AbortController();
    const surFermeture = (): void => {
      if (!brut.writableFinished) abandon.abort();
    };
    brut.on("close", surFermeture);
    let amont: Dispatcher.ResponseData;
    try {
      amont = await request(url, {
        dispatcher: agent,
        method: requete.method as Dispatcher.HttpMethod,
        headers: entetes,
        body: requete.method === "POST" ? corpsLu(requete) : null,
        signal: abandon.signal,
      });
    } catch (e) {
      brut.off("close", surFermeture);
      if (abandon.signal.aborted || brut.destroyed) {
        reponse.hijack();
        return undefined;
      }
      dep.journal.warn(`service MCP injoignable (${url}) : ${decrire(e)}`);
      throw new HttpError(502, INJOIGNABLE);
    }
    // SDK MCP : un GET de flux qui répond 405 est ignoré, 400/404 (session périmée après redémarrage) le déconnecte.
    if (requete.method === "GET" && (amont.statusCode === 400 || amont.statusCode === 404)) {
      brut.off("close", surFermeture);
      jeter(amont.body);
      return reponse.code(405).headers({ Allow: "POST", "Cache-Control": "no-store" }).send();
    }
    if (amont.statusCode === 401 || amont.statusCode === 403) {
      brut.off("close", surFermeture);
      jeter(amont.body);
      dep.journal.warn(
        `délégation refusée par le service d'outils (${url}, HTTP ${amont.statusCode}) : ` +
          "vérifier l'horloge, la version et le jeton de service",
      );
      throw new HttpError(
        502,
        "Le service d'outils a refusé la délégation du relais (horloge, version ou jeton de service).",
      );
    }
    const sortants = entetesSortants(amont.headers);
    reponse.hijack();
    brut.writeHead(amont.statusCode, entetesFlux(reponse, sortants));
    brut.flushHeaders();
    const finir = (): void => abandon.abort();
    const get = requete.method === "GET";
    if (get) flux.add(finir);
    if (get && dep.arret?.aborted) finir();
    const arreterVeille = get ? veiller(jeton, url, finir) : () => undefined;
    try {
      for await (const morceau of amont.body) {
        if (brut.destroyed) break;
        if (!brut.write(morceau as Buffer)) await drainOuFermeture(brut);
      }
    } catch (e) {
      if (!abandon.signal.aborted) dep.journal.info(`flux amont interrompu (${url}) : ${decrire(e)}`);
    } finally {
      arreterVeille();
      flux.delete(finir);
      brut.off("close", surFermeture);
      jeter(amont.body);
    }
    if (!brut.destroyed && !brut.writableEnded) brut.end();
    return undefined;
  }

  const route = (chemin: string, famille: (req: FastifyRequest) => string): Famille["routes"][number] => ({
    methode: ["GET", "POST", "DELETE"],
    chemin,
    processus: ["main"],
    acces: "public",
    traiter: (req, rep) => relayer(req, rep, famille(req)),
  });

  /** Flux GET terminés, puis connexions amont détruites : le serveur est déjà fermé, aucune réponse n'attend plus. */
  function fermer(): Promise<void> {
    terminerFlux();
    fermeture ??= agent.destroy();
    return fermeture;
  }

  return {
    famille: {
      nom: "pont-mcp",
      contexte: (app) => {
        installerCorpsBorne(app, (req) =>
          req.method === "POST"
            ? {
                limite: req.routeOptions.bodyLimit ?? Infinity,
                message: "Request body is too large",
                avant: avantCorps,
              }
            : req.method === "DELETE"
              ? { limite: 0, avant: () => false }
              : null,
        );
      },
      routes: [
        route(MCP_PROXY_PREFIX, () => ""),
        route(`${MCP_PROXY_PREFIX}/:family`, (req) => (req.params as { family: string }).family),
      ],
    },
    extension: (app: FastifyInstance) => {
      app.addHook("preClose", async () => {
        terminerFlux();
      });
      app.addHook("onClose", () => fermer());
    },
    fermer,
  };
}
