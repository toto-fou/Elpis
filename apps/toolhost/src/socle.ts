// SPDX-License-Identifier: MIT
/** apps/toolhost/src/socle.ts — routes propres de l'hôte (toolhost/app.py) : `/health` ouvert, `/manifest` et la session d'historique ouverte par main au login. */
import { arrondiPy, FlottantPy, pyJsonDumps } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { entrees, py } from "@elpis/http";
import { FAMILY_NAMES } from "@elpis/mcp";
import type { FastifyReply } from "fastify";

import type { Famille } from "./app";
import { publicDict } from "./config";
import type { ToolhostConfig } from "./config";
import { currentSession, startSession } from "@elpis/fichiers";
import { endpointsView, exportMcpServers } from "./manifeste";
import type { CommandeStdio, VueHote } from "./manifeste";
import type { ServiceNatif } from "./mcp/natives";
import type { ServiceMcp } from "./mcp/service";
import { HTTP_MOUNT_PATH, SSE_MOUNT_PATH } from "./porte";

export const FILE_HISTORY_SESSION_PATH = "/internal/file-history/session";
/** Préfixes de l'API relayée par main que cet hôte sert déjà (complétés lot après lot jusqu'à `RELAY_PREFIXES`). */
export const SERVED_PREFIXES: readonly string[] = [
  "/api/sandbox/",
  "/api/terminal/",
  "/ws/terminal",
  "/api/playwright/screenshot/",
  "/api/desktop/frame/",
];
const DEMARRE_A = Date.now() / 1000;

/** `JSONResponse` de FastAPI : compact, UTF-8 brut, `application/json` sans charset (octets : Fastify n'en ajoute pas) ; NaN refusé (500). */
export function reponseJson(rep: FastifyReply, valeur: unknown): FastifyReply {
  const texte = pyJsonDumps(valeur, { ensureAscii: false, separators: [",", ":"], allowNan: false });
  return rep.header("content-type", "application/json").send(Buffer.from(texte, "utf-8"));
}

export interface ContexteSocle {
  readonly tc: ToolhostConfig;
  readonly service: ServiceMcp;
  readonly natif?: ServiceNatif | null;
  readonly stdio: (famille: string) => CommandeStdio;
  readonly demarreA?: number;
}

/** Transports servis, relayés ou natifs, dans l'ordre de la configuration. */
function transports(ctx: ContexteSocle): string[] {
  const servis = new Set([...ctx.service.transports(), ...(ctx.natif?.transports() ?? [])]);
  return ctx.tc.transports.filter((t) => servis.has(t));
}

/** Outils de l'amont et des familles natives, dans l'ordre canonique des familles (celui d'un seul serveur). */
function outils(ctx: ContexteSocle): Map<string, string> {
  const sources = [ctx.service.outils(), ctx.natif?.outils() ?? new Map<string, string>()];
  const carte = new Map<string, string>();
  for (const fam of FAMILY_NAMES)
    for (const source of sources)
      for (const [nom, f] of source) if (f === fam && !carte.has(nom)) carte.set(nom, f);
  return carte;
}

function famillesVivantes(ctx: ContexteSocle): string[] {
  const vivantes = new Set(outils(ctx).values());
  return FAMILY_NAMES.filter((f) => vivantes.has(f));
}

function vue(ctx: ContexteSocle): VueHote {
  return {
    host: ctx.tc.host,
    port: ctx.tc.port,
    transports: transports(ctx),
    transportsDe: (f) => (ctx.natif?.sert(f) ? ctx.natif.transports() : ctx.service.transports()),
    familles: famillesVivantes(ctx),
    stdio: ctx.stdio,
  };
}

/** Chemins de montage : `/mcp` toujours (monté sans condition en Python), `/sse` seulement s'il est relayé ou natif. */
function chemins(ctx: ContexteSocle): { mcp_path: string; sse_path: string } {
  return {
    mcp_path: HTTP_MOUNT_PATH,
    sse_path: transports(ctx).includes("sse") ? SSE_MOUNT_PATH : "",
  };
}

export function sante(ctx: ContexteSocle, maintenant = Date.now() / 1000): Dict {
  return {
    ok: true,
    service: "elpis-toolhost",
    uptime_s: new FlottantPy(arrondiPy(maintenant - (ctx.demarreA ?? DEMARRE_A), 1)),
    families: famillesVivantes(ctx),
    tools: outils(ctx).size,
    ...chemins(ctx),
    transports: transports(ctx),
    auth: Boolean(ctx.tc.token),
  };
}

/** Nombre d'outils par famille, dans l'ordre d'enregistrement. */
function parFamille(ctx: ContexteSocle): Dict {
  const out: Dict = {};
  for (const fam of outils(ctx).values()) out[fam] = ((out[fam] as number | undefined) ?? 0) + 1;
  return out;
}

export function manifeste(ctx: ContexteSocle, transport: string, baseUrl: string): Dict {
  const v = vue(ctx);
  return {
    ok: true,
    config: publicDict(ctx.tc),
    families: parFamille(ctx),
    served_prefixes: [...SERVED_PREFIXES],
    ...chemins(ctx),
    transports: [...v.transports],
    endpoints: endpointsView(v, baseUrl),
    ...exportMcpServers(v, transport, baseUrl),
  };
}

export function creerFamilleSocle(ctx: ContexteSocle): Famille {
  return {
    nom: "socle",
    routes: [
      {
        methode: "GET",
        chemin: "/health",
        processus: ["toolhost"],
        acces: "public",
        traiter: (_req, rep) => reponseJson(rep, sante(ctx)),
      },
      {
        methode: "GET",
        chemin: "/manifest",
        processus: ["toolhost"],
        acces: "enveloppe",
        traiter: (req, rep) => {
          const q = entrees(req, {
            query: { transport: py.str().defaut("http"), base_url: py.str().defaut("") },
          }).query;
          return reponseJson(rep, manifeste(ctx, q.transport, q.base_url));
        },
      },
      {
        methode: "POST",
        chemin: FILE_HISTORY_SESSION_PATH,
        processus: ["toolhost"],
        acces: "enveloppe",
        traiter: async (req, rep) => {
          const uid = Math.trunc(req.identite?.user_id ?? 0);
          const sid = await startSession(uid);
          return reponseJson(rep, { ok: (await currentSession(uid)) === sid, id: sid });
        },
      },
    ],
  };
}
