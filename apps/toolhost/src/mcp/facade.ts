// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/facade.ts — façade MCP de l'hôte : `/mcp[/<famille>]`, `/sse[/<famille>]` et `/messages/` relayés en flux vers elpis-tools (mêmes chemins, jetons, `_meta`). */
import type { IncomingMessage, ServerResponse } from "node:http";

import { pyJsonDumps } from "@elpis/commun";
import { cheminDecode, corpsRelaye, decouperCible, entetesFlux } from "@elpis/http";
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";
import { request } from "undici";
import type { Dispatcher } from "undici";

import type { Journal } from "../journal";
import { familleDuChemin, HTTP_MOUNT_PATH, introuvable, SSE_MOUNT_PATH, SSE_PREFIXES } from "../porte";
import { decrire } from "./service";
import type { ServiceMcp } from "./service";

export const MESSAGE_SANS_AMONT =
  "service MCP indisponible : aucun amont elpis-tools déclaré (toolhost.json › mcp_upstream)";
export const MESSAGE_INJOIGNABLE = "service MCP injoignable : elpis-tools ne répond pas";
export const MESSAGE_NON_PROTEGE = "service MCP refusé : elpis-tools accepte les appels sans jeton";
export const MESSAGE_NON_CONFORME =
  "service MCP refusé : elpis-tools sert des familles hors de toolhost.json › families ou servies nativement par l'hôte";
export const METHODES: HTTPMethods[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
export const CHEMINS_FACADE: readonly string[] = [
  HTTP_MOUNT_PATH,
  `${HTTP_MOUNT_PATH}/*`,
  SSE_MOUNT_PATH,
  `${SSE_MOUNT_PATH}/*`,
  "/messages",
  "/messages/*",
];

/** En-têtes propres à une connexion, jamais retransmis (RFC 9110 §7.6.1). */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/** Jamais relayés vers l'amont : `expect` (Node a déjà répondu 100, undici le refuse) et l'enveloppe de l'API (inutile au service MCP). */
const RETIRES_VERS_AMONT: ReadonlySet<string> = new Set(["expect", "x-elpis-identity"]);

/** Familles servies par l'hôte lui-même : une requête qu'elles prennent ne passe jamais par le relais. */
export interface AiguillageNatif {
  prend(chemin: string, requete: string): boolean;
  traiter(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export interface ContexteFacade {
  readonly service: ServiceMcp;
  readonly natif?: AiguillageNatif | null;
  readonly agent: Dispatcher;
  readonly journal: Journal;
  /** Flux en cours, terminés à l'arrêt du process. */
  readonly flux: Set<() => void>;
  readonly arret?: AbortSignal | undefined;
}

function refuser(reponse: FastifyReply, statut: number, detail: string): FastifyReply {
  return reponse
    .code(statut)
    .type("application/json; charset=utf-8")
    .send(pyJsonDumps({ detail }, { ensureAscii: false }));
}

/** Noms cités par `Connection` : propres à ce saut eux aussi. */
function nommesParConnection(rawHeaders: readonly string[]): Set<string> {
  const noms = new Set<string>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if ((rawHeaders[i] ?? "").toLowerCase() === "connection")
      for (const n of (rawHeaders[i + 1] ?? "").split(",")) noms.add(n.trim().toLowerCase());
  return noms;
}

/** En-têtes du client vers l'amont : tous sauf ceux du saut, `expect`, l'enveloppe, les `X-Forwarded-*` reçus (remplacés par ceux de l'hôte) ; un seul `Host`. */
export function entetesVersAmont(rawHeaders: readonly string[], ip: string, proto: string): string[] {
  const exclus = nommesParConnection(rawHeaders);
  const out: string[] = [];
  let hote = false;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const nom = (rawHeaders[i] ?? "").toLowerCase();
    if (
      HOP_BY_HOP.has(nom) ||
      exclus.has(nom) ||
      RETIRES_VERS_AMONT.has(nom) ||
      nom.startsWith("x-forwarded-")
    )
      continue;
    if (nom === "host") {
      if (hote) continue;
      hote = true;
    }
    out.push(rawHeaders[i] ?? "", rawHeaders[i + 1] ?? "");
  }
  if (ip) out.push("x-forwarded-for", ip);
  out.push("x-forwarded-proto", proto);
  return out;
}

/** En-têtes de l'amont vers le client, doublons compris, sans ceux du saut. */
export function entetesVersClient(rawHeaders: readonly string[]): Map<string, string[]> {
  const exclus = nommesParConnection(rawHeaders);
  const garde = new Map<string, string[]>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const nom = (rawHeaders[i] ?? "").toLowerCase();
    if (HOP_BY_HOP.has(nom) || exclus.has(nom)) continue;
    garde.set(nom, [...(garde.get(nom) ?? []), rawHeaders[i + 1] ?? ""]);
  }
  return garde;
}

/** Préfixe MCP du chemin décodé (`/mcp`, `/sse` ou `/messages`). */
function prefixe(chemin: string): string {
  return SSE_PREFIXES.find((p) => chemin.startsWith(p)) ?? HTTP_MOUNT_PATH;
}

/** URL amont bâtie depuis la cible brute ; `null` si sa forme normalisée sort du préfixe d'origine. */
export function urlAmont(base: string, cible: string, prefixeAttendu: string): URL | null {
  const { chemin, requete } = decouperCible(cible);
  let url: URL;
  try {
    url = new URL(base + chemin + (requete ? `?${requete}` : ""));
  } catch {
    return null;
  }
  const racine = new URL(base).pathname.replace(/\/+$/u, "");
  return url.pathname.startsWith(racine + prefixeAttendu) ? url : null;
}

/** Attente de place dans le tampon du client, levée aussi par la fermeture ou l'abandon. */
function drainOuFermeture(flux: ServerResponse, abandon: AbortSignal): Promise<void> {
  return new Promise((fin) => {
    const finir = (): void => {
      flux.off("drain", finir);
      flux.off("close", finir);
      abandon.removeEventListener("abort", finir);
      fin();
    };
    flux.once("drain", finir);
    flux.once("close", finir);
    abandon.addEventListener("abort", finir, { once: true });
    if (abandon.aborted) finir();
  });
}

/** Point d'entrée protégé par le vérificateur Bearer de l'amont (`/mcp`, `/mcp/<famille>`, `/sse`, `/sse/<famille>`, `/messages/…`). */
export function pointProtege(chemin: string): boolean {
  if (chemin === HTTP_MOUNT_PATH || chemin === SSE_MOUNT_PATH || chemin.startsWith("/messages/")) return true;
  return typeof familleDuChemin(chemin) === "string";
}

/** Sans `Bearer` (ou sans en-tête), l'amont refuse avant tout traitement : le même refus est rendu ici. */
function sansBearer(autorisation: string | undefined): boolean {
  return !(autorisation ?? "").toLowerCase().startsWith("bearer ");
}

/** Relais d'une requête MCP : corps et réponse en flux, contre-pression des deux côtés ; l'amont coupé coupe le client. */
async function relayer(
  requete: FastifyRequest,
  reponse: FastifyReply,
  ctx: ContexteFacade,
): Promise<unknown> {
  if (reponse.sent) return undefined;
  const chemin = cheminDecode(requete);
  const p = prefixe(chemin);
  const transport = p === HTTP_MOUNT_PATH ? "http" : "sse";
  const base = transport === "http" ? ctx.service.amont : ctx.service.amontSse;
  if (transport === "sse" && !ctx.service.sseServi) return introuvable(reponse);
  if (!base) return refuser(reponse, 503, MESSAGE_SANS_AMONT);
  const etat = await ctx.service.relaisPermis(transport);
  if (etat === "ouvert") return refuser(reponse, 503, MESSAGE_NON_PROTEGE);
  if (etat === "non-conforme") return refuser(reponse, 503, MESSAGE_NON_CONFORME);
  if (etat !== "protege") return refuser(reponse, 502, MESSAGE_INJOIGNABLE);
  const refus = ctx.service.refus401(transport);
  if (ctx.service.jetonExige && refus && sansBearer(requete.headers.authorization) && pointProtege(chemin))
    return reponse.code(401).headers(refus.entetes).send(refus.corps);
  const url = urlAmont(base, requete.originalUrl, p);
  if (url === null) return introuvable(reponse);
  const brut = reponse.raw;
  const abandon = new AbortController();
  const surFermeture = (): void => {
    if (!brut.writableFinished) abandon.abort();
  };
  brut.on("close", surFermeture);
  if (brut.destroyed) {
    brut.off("close", surFermeture);
    reponse.hijack();
    return undefined;
  }
  const corps = requete.method === "GET" || requete.method === "HEAD" ? null : corpsRelaye(requete.raw);
  let amont: Dispatcher.ResponseData;
  try {
    amont = await request(url, {
      dispatcher: ctx.agent,
      method: requete.method as Dispatcher.HttpMethod,
      headers: entetesVersAmont(requete.raw.rawHeaders, requete.ip, requete.protocol),
      body: corps,
      signal: abandon.signal,
      responseHeaders: "raw",
    });
  } catch (e) {
    corps?.destroy();
    brut.off("close", surFermeture);
    if (abandon.signal.aborted || brut.destroyed) {
      reponse.hijack();
      return undefined;
    }
    ctx.service.oublierEtat(transport);
    ctx.journal.warn(`amont MCP ${transport} injoignable : ${decrire(e)}`);
    return refuser(reponse, 502, MESSAGE_INJOIGNABLE);
  }
  const sansJeton = !requete.headers.authorization;
  if (ctx.service.jetonExige && sansJeton && amont.statusCode >= 200 && amont.statusCode < 300) {
    brut.off("close", surFermeture);
    amont.body.on("error", () => undefined);
    amont.body.destroy();
    corps?.destroy();
    ctx.service.signalerOuvert(transport);
    return refuser(reponse, 503, MESSAGE_NON_PROTEGE);
  }
  const entetes = entetesVersClient(amont.headers as unknown as string[]);
  const evenements = (entetes.get("content-type")?.[0] ?? "").toLowerCase().startsWith("text/event-stream");
  const finir = (): void => abandon.abort();
  if (evenements) {
    ctx.flux.add(finir);
    if (ctx.arret?.aborted) finir();
  }
  reponse.hijack();
  let coupe = false;
  try {
    for (const [nom, valeurs] of entetes)
      void reponse.header(nom, valeurs.length === 1 ? valeurs[0] : valeurs);
    brut.writeHead(amont.statusCode, entetesFlux(reponse));
    brut.flushHeaders();
    for await (const morceau of amont.body) {
      if (brut.destroyed || abandon.signal.aborted) break;
      if (!brut.write(morceau as Buffer)) await drainOuFermeture(brut, abandon.signal);
    }
  } catch (e) {
    coupe = !abandon.signal.aborted;
    if (coupe) ctx.journal.info(`flux MCP amont interrompu : ${decrire(e)}`);
  } finally {
    ctx.flux.delete(finir);
    brut.off("close", surFermeture);
    amont.body.on("error", () => undefined);
    amont.body.destroy();
    corps?.destroy();
  }
  if (coupe) brut.destroy();
  else if (!brut.destroyed && !brut.writableEnded) brut.end();
  return undefined;
}

/** Requête d'une famille native prise avant toute analyse : servie par @elpis/outils-mcp, 404 si non prise, 500 sur échec. */
function servirNatif(
  natif: AiguillageNatif,
  requete: FastifyRequest,
  reponse: FastifyReply,
  journal: Journal,
): void {
  reponse.hijack();
  const brut = reponse.raw;
  void natif.traiter(requete.raw, brut).then(
    (pris) => {
      if (pris || brut.headersSent) return;
      brut.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      brut.end("Not Found");
    },
    (e: unknown) => {
      journal.error(`famille native : requête MCP en échec : ${decrire(e)}`);
      if (brut.headersSent) return void brut.destroy();
      brut.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      brut.end("Internal Server Error");
    },
  );
}

/** Contexte de la famille : requêtes des familles natives aiguillées avant l'analyse ; sinon corps jamais lu ni validé ici (l'amont applique ses limites). */
export function contexteFacade(ctx: Pick<ContexteFacade, "natif" | "journal">) {
  return async (sous: FastifyInstance): Promise<void> => {
    const natif = ctx.natif ?? null;
    if (natif !== null)
      sous.addHook("onRequest", (requete, reponse, fait) => {
        if (natif.prend(cheminDecode(requete), decouperCible(requete.url).requete))
          servirNatif(natif, requete, reponse, ctx.journal);
        fait();
      });
    sous.removeAllContentTypeParsers();
    sous.addContentTypeParser("*", (_requete, _flux, fini) => {
      fini(null);
    });
    sous.addHook("preParsing", async (requete, reponse, charge) => {
      if (!reponse.sent) delete requete.raw.headers["content-type"];
      return charge;
    });
  };
}

export function traiterFacade(ctx: ContexteFacade) {
  return (requete: FastifyRequest, reponse: FastifyReply): Promise<unknown> => relayer(requete, reponse, ctx);
}

/** Termine les flux en cours (arrêt du process). */
export function arreterFlux(ctx: ContexteFacade): void {
  for (const finir of [...ctx.flux]) finir();
}
