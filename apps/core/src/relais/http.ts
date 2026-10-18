// SPDX-License-Identifier: MIT
/** apps/core/src/relais/http.ts — relais HTTP en flux vers l'hôte d'outils (`_relay_http`) : corps jamais tamponnés, contre-pression des deux côtés. */
import type { ServerResponse } from "node:http";

import { pyJsonDumps } from "@elpis/commun";
import type { FastifyReply, FastifyRequest } from "fastify";
import { request } from "undici";
import type { Dispatcher } from "undici";

import type { Journal } from "../journal";
import { ENREGISTRES_PAR_MAIN, entetesReponse, entetesRequete, unquotePy, urlAmont } from "./chemins";
import type { SandboxHost } from "./hotes";
import { enregistrerChoixBac, entetesRelais } from "./identite";
import { corpsRelaye, decouperCible, entetesFlux } from "@elpis/http";

export const MESSAGE_INJOIGNABLE =
  "L'hôte d'outils ne répond pas. Vérifiez qu'il tourne et que mcp.json pointe dessus.";
export const MESSAGE_INACHEVE = "L'hôte d'outils n'a pas fini de répondre.";
const METHODES_AVEC_CORPS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SESSION_EXPIREE_SSE = "data: [SESSION_EXPIRED]\n\n";

export interface ContexteHttp {
  readonly agent: Dispatcher;
  readonly journal: Journal;
  /** Flux longs (SSE) en cours, terminés proprement à l'arrêt du process. */
  readonly flux: Set<() => void>;
  readonly arret?: AbortSignal | undefined;
  /** `SESSION_RECHECK_S` : période de revalidation de la session pendant un flux SSE relayé. */
  readonly revalidationMs: number;
}

/** Session du navigateur toujours valide ? (`undefined` : flux jamais revalidé, cas d'un aperçu). */
export type Revalidation = (() => Promise<boolean>) | undefined;

/** Refus du relais comme `_reject` : `{"detail": …}` écrit par `json.dumps` (espace après « : », ASCII). */
export function refuser(reponse: FastifyReply, statut: number, detail: string): FastifyReply {
  return reponse.code(statut).type("application/json; charset=utf-8").send(pyJsonDumps({ detail }));
}

export function decrire(erreur: unknown): string {
  if (erreur instanceof Error) {
    const code = (erreur as { code?: unknown }).code;
    return `${erreur.name}${typeof code === "string" ? ` ${code}` : ""}: ${erreur.message}`;
  }
  return String(erreur);
}

/** POST de `ENREGISTRES_PAR_MAIN` réussi : réponse lue en entier, choix enregistré par main (navigateur parti ou non), puis rendue telle quelle. */
async function rendreApresEnregistrement(
  reponse: FastifyReply,
  amont: Dispatcher.ResponseData,
  entetesAmont: Map<string, string[]>,
  uid: number,
  url: URL,
  ctx: ContexteHttp,
): Promise<unknown> {
  let corps: Buffer;
  try {
    corps = Buffer.from(await amont.body.arrayBuffer());
  } catch (e) {
    ctx.journal.warn(`réponse amont interrompue (${url.href}) : ${decrire(e)}`);
    if (!reponse.raw.destroyed) return refuser(reponse, 502, MESSAGE_INACHEVE);
    reponse.hijack();
    return undefined;
  } finally {
    amont.body.destroy();
  }
  if (!(entetesAmont.get("content-encoding") ?? []).join(", "))
    await enregistrerChoixBac(uid, corps, ctx.journal);
  if (reponse.raw.destroyed) {
    reponse.hijack();
    return undefined;
  }
  for (const [nom, valeurs] of entetesAmont)
    void reponse.header(nom, valeurs.length === 1 ? valeurs[0] : valeurs);
  reponse.hijack();
  reponse.raw.writeHead(200, entetesFlux(reponse));
  reponse.raw.end(corps);
  return undefined;
}

export function drainOuFermeture(flux: ServerResponse): Promise<void> {
  return new Promise((fin) => {
    const finir = (): void => {
      flux.off("drain", finir);
      flux.off("close", finir);
      fin();
    };
    flux.once("drain", finir);
    flux.once("close", finir);
  });
}

/** Relaie la requête (URL bâtie depuis le chemin brut) puis recopie la réponse en flux ; si l'hôte coupe, la réponse est coupée sans bloc final. */
export async function relayerHttp(
  requete: FastifyRequest,
  reponse: FastifyReply,
  hote: SandboxHost,
  uid: number,
  ctx: ContexteHttp,
  apercu = false,
  revalider: Revalidation = undefined,
): Promise<unknown> {
  const { chemin, requete: query } = decouperCible(requete.originalUrl);
  const url = urlAmont(hote.url, chemin, query, apercu);
  if (url === null) return refuser(reponse, 400, "chemin refusé");
  const entetes: Record<string, string> = {
    ...entetesRequete(requete.raw.rawHeaders),
    ...(await entetesRelais(hote, uid)),
  };
  if (requete.ip) entetes["x-forwarded-for"] = requete.ip;
  const brut = reponse.raw;
  const abandon = new AbortController();
  let enregistre = requete.method === "POST" && ENREGISTRES_PAR_MAIN.includes(unquotePy(chemin));
  const surFermeture = (): void => {
    if (!brut.writableFinished && !enregistre) abandon.abort();
  };
  brut.on("close", surFermeture);
  if (brut.destroyed) {
    brut.off("close", surFermeture);
    reponse.hijack();
    return undefined;
  }
  const corps = METHODES_AVEC_CORPS.has(requete.method) ? corpsRelaye(requete.raw) : null;
  let amont: Dispatcher.ResponseData;
  try {
    amont = await request(url, {
      dispatcher: ctx.agent,
      method: requete.method as Dispatcher.HttpMethod,
      headers: entetes,
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
    ctx.journal.warn(`hôte ${hote.id} injoignable (${url.href}) : ${decrire(e)}`);
    return refuser(reponse, 502, MESSAGE_INJOIGNABLE);
  }
  const entetesAmont = entetesReponse(amont.headers as unknown as string[]);
  if (enregistre && amont.statusCode === 200) {
    brut.off("close", surFermeture);
    return rendreApresEnregistrement(reponse, amont, entetesAmont, uid, url, ctx).finally(() =>
      corps?.destroy(),
    );
  }
  enregistre = false;
  if (brut.destroyed) abandon.abort();
  for (const [nom, valeurs] of entetesAmont)
    void reponse.header(nom, valeurs.length === 1 ? valeurs[0] : valeurs);
  const evenements = (entetesAmont.get("content-type")?.[0] ?? "")
    .toLowerCase()
    .startsWith("text/event-stream");
  const revalidation = (entetesAmont.get("content-type") ?? []).join(", ").includes("text/event-stream")
    ? revalider
    : undefined;
  const terminal = unquotePy(chemin).startsWith("/api/terminal/");
  reponse.hijack();
  const finir = (): void => abandon.abort();
  if (evenements) {
    ctx.flux.add(finir);
    if (ctx.arret?.aborted) finir();
  }
  let coupe = false;
  let prochaine = performance.now() + ctx.revalidationMs;
  try {
    brut.writeHead(amont.statusCode, entetesFlux(reponse));
    brut.flushHeaders();
    for await (const morceau of amont.body) {
      if (brut.destroyed) break;
      if (!brut.write(morceau as Buffer)) await drainOuFermeture(brut);
      if (revalidation !== undefined && performance.now() >= prochaine) {
        prochaine = performance.now() + ctx.revalidationMs;
        if (!(await revalidation())) {
          if (terminal && !brut.destroyed) brut.write(SESSION_EXPIREE_SSE);
          break;
        }
      }
    }
  } catch (e) {
    coupe = !abandon.signal.aborted;
    if (coupe) ctx.journal.info(`flux amont interrompu (${url.href}) : ${decrire(e)}`);
  } finally {
    ctx.flux.delete(finir);
    brut.off("close", surFermeture);
    amont.body.destroy();
    corps?.destroy();
  }
  if (coupe) brut.destroy();
  else if (!brut.destroyed && !brut.writableEnded) brut.end();
  return undefined;
}
