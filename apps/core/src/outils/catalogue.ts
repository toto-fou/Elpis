// SPDX-License-Identifier: MIT
/** apps/core/src/outils/catalogue.ts — catalogue d'outils d'un tour : outils de tous les serveurs MCP et outils intégrés, filtrés (refus, catégories, lecture seule, mémoire). */
import { strPy, veritePy } from "@elpis/commun";
import { BUILTIN_SENTINEL, builtinClientCfgs, raisonAnnulation, sharedId } from "@elpis/mcp";
import type { ConfigMcp, OutilMcp, PoolMcp } from "@elpis/mcp";
import { outilPermisSousAgent } from "@elpis/securite";
import type { SousAgent } from "@elpis/securite";

import { CTX } from "../contexte/config-contexte";
import { journal } from "../journal";
import { estDict, iterPy, lire } from "../python";
import type { Dict } from "../python";
import { categorize, getHiddenCategories, manifestSource } from "./categories";
import { friendlyMcpError, masquerAdresse, mcpToolToOpenai, poolMcp, resoudreClientMcp } from "./mcp/clients";
import { toolTraits } from "./traits";

const log = journal("_collect_mcp_tools");

/** Outils de la mémoire, gouvernés par un interrupteur du compte (désactivé par défaut). */
export const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set(["memory", "session_search"]);

export type Evenement = Dict;
export type SurEvenement = ((e: Evenement) => unknown) | null | undefined;

/** Outil intégré construit pour l'appel (RAG, sous-agents…) : définition `tools[]` et gestionnaire. */
/** Ce que la boucle sait de l'appel d'un outil intégré. */
export interface AppelIntegre {
  callId: string | null;
}

export interface OutilIntegre {
  definition: Dict;
  handler: (args: Dict, appel?: AppelIntegre) => unknown;
}

function nomOutil(t: unknown): string {
  return strPy(lire(t, "name") ?? "") || "";
}

/** `_emit` : l'événement part au flux, une panne du consommateur est tue. */
async function emettre(surEvenement: SurEvenement, e: Evenement): Promise<void> {
  if (!surEvenement) return;
  try {
    await surEvenement(e);
  } catch {
    // le consommateur du flux ne doit jamais casser le tour
  }
}

/** Retire les outils de la mémoire sans l'interrupteur, par nom et par catégorie (registre absent compris). */
export function applyMemoryGate(
  outils: readonly unknown[],
  memoryEnabled: boolean,
  categoriser: (nom: string) => string,
): unknown[] {
  if (memoryEnabled) return [...outils];
  return outils.filter((t) => !MEMORY_TOOL_NAMES.has(nomOutil(t)) && categoriser(nomOutil(t)) !== "memory");
}

/** Serveur d'outils intégré (sentinelle développée ou hôte d'outils du manifeste), jamais un serveur tiers. */
function serveurIntegre(cfg: unknown): boolean {
  return lire(cfg, "command") === BUILTIN_SENTINEL || lire(cfg, "identity") === "meta";
}

function estSentinelle(cfg: unknown): cfg is ConfigMcp {
  if (!estDict(cfg)) return false;
  const type = Object.hasOwn(cfg, "type") ? cfg["type"] : "sse";
  return type === "stdio" && (Object.hasOwn(cfg, "command") ? cfg["command"] : "") === BUILTIN_SENTINEL;
}

/** Développe chaque sentinelle en une config par entrée intégrée du manifeste (dédoublonnées par nom d'entrée). */
export function expandBuiltinConfigs(configs: readonly unknown[] | null | undefined): ConfigMcp[] {
  const out: ConfigMcp[] = [];
  const vus = new Set<string>();
  for (const cfg of configs ?? []) {
    if (!estSentinelle(cfg)) {
      out.push(cfg as ConfigMcp);
      continue;
    }
    let developpees: ConfigMcp[];
    try {
      const filtre = lire(cfg, "filter_categories");
      developpees = builtinClientCfgs(filtre === null || filtre === undefined ? null : (filtre as unknown[]));
    } catch {
      developpees = [cfg];
    }
    const seule = developpees.filter((e) => e["command"] === BUILTIN_SENTINEL).length === 1;
    for (let e of developpees) {
      const cle = strPy(veritePy(e["manifest"]) ? e["manifest"] : veritePy(e["command"]) ? e["command"] : "");
      if (vus.has(cle)) continue;
      vus.add(cle);
      if (e["command"] === BUILTIN_SENTINEL) {
        e = { ...cfg, ...e };
        if (seule) e["name"] = veritePy(cfg["name"]) ? cfg["name"] : e["name"];
      }
      out.push(e);
    }
  }
  return out;
}

export interface OptionsCatalogue {
  keywordsText?: string;
  allowedToolNames?: ReadonlySet<string> | null;
  memoryEnabled?: boolean;
  denyToolNames?: Iterable<string> | null;
  readOnly?: boolean;
  /** Sous-agent : outils hors de son périmètre retirés (même règle que la garde de l'hôte d'outils). */
  sousAgent?: SousAgent | null;
  signal?: AbortSignal | undefined;
  pool?: PoolMcp;
}

const RETIRES_DU_SHELL = ["on_timeout", "background"];

/** Définition offerte à un sous-agent : `execute_shell` sans `on_timeout` ni `background` (rien ne doit lui survivre). */
function pourSousAgent(nom: string, definition: Dict): Dict {
  if (nom !== "execute_shell") return definition;
  const fn = lire(definition, "function");
  const params = lire(fn, "parameters");
  const props = lire(params, "properties");
  if (
    !estDict(fn) ||
    !estDict(params) ||
    !estDict(props) ||
    !RETIRES_DU_SHELL.some((k) => Object.hasOwn(props, k))
  )
    return definition;
  const reste = Object.fromEntries(Object.entries(props).filter(([k]) => !RETIRES_DU_SHELL.includes(k)));
  const requis = Array.isArray(params["required"])
    ? params["required"].filter((r) => !RETIRES_DU_SHELL.includes(r as string))
    : null;
  return {
    ...definition,
    function: {
      ...fn,
      parameters: { ...params, properties: reste, ...(requis ? { required: requis } : {}) },
    },
  };
}

export interface Catalogue {
  /** Outil → config du serveur qui l'exécute. */
  toolCfgMap: Map<string, ConfigMcp>;
  toolsPayload: Dict[];
  builtinHandlers: Map<string, OutilIntegre["handler"]>;
  connectedServerNames: string[];
}

function typePy(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  return Array.isArray(v) ? "list" : typeof v === "object" ? "dict" : typeof v;
}

/** Annulation d'un enfant isolé (le parent annulé a déjà levé) : un serveur défaillant, pas un Stop. */
function estAbandon(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

/** `iter(x)` : liste, points de code d'un texte, clés d'un dict ; TypeError sinon. */
function iterer(v: unknown): unknown[] {
  const elements = iterPy(v);
  if (elements === null) throw new TypeError(`'${typePy(v)}' object is not iterable`);
  return elements;
}

/** `", ".join(cats)` : chaque élément doit être un texte. */
function joindreCategories(cats: unknown): string {
  const elements = iterPy(cats);
  if (elements === null) throw new TypeError("can only join an iterable");
  return elements
    .map((c, i) => {
      if (typeof c !== "string")
        throw new TypeError(`sequence item ${i}: expected str instance, ${typePy(c)} found`);
      return c;
    })
    .join(", ");
}

/** Connecte chaque serveur (en parallèle), filtre leurs outils et ajoute les intégrés ; un serveur en panne est un avertissement, pas une erreur de tour. */
export async function collectMcpTools(
  configs: readonly unknown[] | null | undefined,
  builtinTools: ReadonlyMap<string, OutilIntegre> | Readonly<Record<string, OutilIntegre>> | null | undefined,
  surEvenement: SurEvenement,
  options: OptionsCatalogue = {},
): Promise<Catalogue> {
  const refus = new Set(options.denyToolNames ?? []);
  const memoire = options.memoryEnabled ?? true;
  const toolCfgMap = new Map<string, ConfigMcp>();
  let toolsPayload: Dict[] = [];
  const connectes: string[] = [];
  let cachees = new Set(getHiddenCategories());
  let masquesParPorte = 0;

  const masque = (nom: string, explicites: ReadonlySet<unknown> = new Set()): boolean => {
    if (!nom) return false;
    if (!CTX.toolEnabled(nom)) return true;
    if (!CTX.gatingEnabled()) return false;
    const cat = categorize(nom);
    if (!cat || cachees.has(cat)) return false;
    if (explicites.has(cat)) return false;
    if (!options.keywordsText) return false;
    return CTX.categoryGatedOut(cat, options.keywordsText);
  };

  const cfgs = expandBuiltinConfigs(configs);
  const pool = options.pool ?? poolMcp;
  const connexions =
    cfgs.length > 0
      ? await Promise.allSettled(
          cfgs.map((cfg) => pool.getOrConnect(cfg, resoudreClientMcp, { signal: options.signal })),
        )
      : [];
  if (options.signal?.aborted) throw raisonAnnulation(options.signal);

  for (const [i, cfg] of cfgs.entries()) {
    const issue = connexions[i];
    const permises = lire(cfg, "filter_categories");
    try {
      if (issue === undefined) throw new Error("connexion MCP absente");
      if (issue.status === "rejected")
        throw estAbandon(issue.reason) ? new Error("connexion MCP annulée") : issue.reason;
      let outils: OutilMcp[] = issue.value[1];
      const registreOk = manifestSource() !== "empty";
      cachees = new Set(getHiddenCategories());
      if (permises !== null && permises !== undefined && registreOk) {
        const ensemble = new Set<unknown>([...iterer(permises), ...cachees]);
        if (memoire) ensemble.add("memory");
        outils = outils.filter((t) => ensemble.has(categorize(nomOutil(t))));
      } else if (permises !== null && permises !== undefined && !registreOk) {
        log.warn(
          `filter_categories=${strPy(permises)} requested but tool manifest is unavailable — passing all tools through. ` +
            "Restart the MCP server to enable category filtering.",
        );
      }
      outils = applyMemoryGate(outils, memoire, categorize) as OutilMcp[];
      const explicites = new Set<unknown>(veritePy(permises) ? iterer(permises) : []);
      for (const t of outils) {
        const nom = nomOutil(t);
        if (refus.has(nom)) continue;
        if (options.readOnly && !toolTraits(nom, t).readOnly) continue;
        if (
          options.sousAgent &&
          !outilPermisSousAgent(options.sousAgent, nom, toolTraits(nom, t).readOnly, serveurIntegre(cfg))
        )
          continue;
        if (masque(nom, explicites)) {
          masquesParPorte++;
          continue;
        }
        if (
          options.allowedToolNames !== null &&
          options.allowedToolNames !== undefined &&
          !options.allowedToolNames.has(nom) &&
          !cachees.has(categorize(nom))
        )
          continue;
        const deja = toolCfgMap.get(nom);
        if (deja !== undefined) {
          log.warn(
            `outil '${nom}' déjà fourni par le serveur '${strPy(lire(deja, "name") ?? "?")}' — ` +
              `doublon du serveur '${strPy(lire(cfg, "name") ?? "?")}' ignoré`,
          );
          continue;
        }
        toolCfgMap.set(nom, cfg);
        const def = mcpToolToOpenai(t);
        toolsPayload.push(options.sousAgent ? pourSousAgent(nom, def) : def);
      }
      const extra = veritePy(permises) ? ` (${joindreCategories(permises)})` : "";
      connectes.push(`${strPy(Object.hasOwn(cfg, "name") ? cfg["name"] : "")}${extra}`);
    } catch (e) {
      const nomSrv = strPy(Object.hasOwn(cfg, "name") ? cfg["name"] : "?");
      log.warn(
        `serveur MCP '${nomSrv}' injoignable : ${e instanceof Error ? `${e.name}(${e.message})` : strPy(e)}`,
      );
      const cause = friendlyMcpError(e);
      await emettre(surEvenement, {
        type: "warning",
        text:
          `Serveur d'outils « ${nomSrv} » injoignable — ses outils sont absents de ce tour. ` +
          (sharedId(lire(cfg, "id")) === null ? cause : masquerAdresse(cause, lire(cfg, "url"))),
      });
    }
  }

  const integres = builtinTools instanceof Map ? [...builtinTools] : Object.entries(builtinTools ?? {});
  if (cfgs.length > 0 && toolCfgMap.size === 0 && integres.length === 0) {
    if (connectes.length > 0) {
      log.info(
        `connexion OK (${connectes.join(", ")}) mais AUCUN outil ne passe les filtres` +
          `${options.readOnly ? " (mode lecture seule)" : ""} — le tour se fera sans outils.`,
      );
    } else {
      const noms = cfgs.map((c) => strPy(Object.hasOwn(c, "name") ? c["name"] : "?"));
      throw new Error(
        `Impossible de se connecter aux serveurs MCP : ${noms.join(", ")}. Vérifiez la configuration dans Paramètres → MCP.`,
      );
    }
  }

  const builtinHandlers = new Map<string, OutilIntegre["handler"]>();
  for (const [nom, info] of integres) {
    if (refus.has(nom)) continue;
    if (options.sousAgent && !outilPermisSousAgent(options.sousAgent, nom, toolTraits(nom).readOnly))
      continue;
    if (masque(nom)) {
      masquesParPorte++;
      continue;
    }
    const homonyme = toolCfgMap.get(nom);
    if (homonyme !== undefined) {
      log.warn(
        `builtin '${nom}' homonyme d'un outil du serveur '${strPy(lire(homonyme, "name") ?? "?")}' — ` +
          "le builtin prévaut, le schéma MCP est retiré",
      );
      toolCfgMap.delete(nom);
      toolsPayload = toolsPayload.filter((d) => lire(lire(d, "function"), "name") !== nom);
    }
    toolsPayload.push(info.definition);
    builtinHandlers.set(nom, info.handler);
  }
  if (masquesParPorte > 0)
    log.info(`tool_gating: ${masquesParPorte} outil(s) masqué(s) (hors profil actif ce tour)`);
  return { toolCfgMap, toolsPayload, builtinHandlers, connectedServerNames: connectes };
}
