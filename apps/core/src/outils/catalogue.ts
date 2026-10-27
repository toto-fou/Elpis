// SPDX-License-Identifier: MIT
/** apps/core/src/outils/catalogue.ts — catalogue d'outils d'un tour : outils de tous les serveurs MCP et outils intégrés, filtrés (refus, catégories, lecture seule, mémoire). */
import { strPy, veritePy } from "@elpis/commun";
import { BUILTIN_SENTINEL, builtinClientCfgs, makeKey, raisonAnnulation, sharedId } from "@elpis/mcp";
import type { ConfigMcp, OutilMcp, PoolMcp } from "@elpis/mcp";
import { outilPermisSousAgent } from "@elpis/securite";
import type { SousAgent } from "@elpis/securite";

import { CTX } from "../contexte/config-contexte";
import type { CompactionThreshold } from "../contexte/porte-compaction";
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

/** Le run qui appelle un outil intégré, tel qu'un sous-agent `fork` doit le reprendre : instantané lu à la demande, valable le temps de l'appel. */
export interface ContexteParent {
  /** Appel venu du canal natif ; faux : appel lu dans le texte (identifiants synthétiques). */
  natif: boolean;
  /** Le run est lui-même celui d'un sous-agent. */
  sousAgent: boolean;
  /** Messages envoyés au dernier appel du moteur (forme d'entrée du flux : élagage et ajustement au contexte appliqués), copie ; vide sans appel. */
  envoye: Dict[];
  /** Message assistant porteur des appels du lot, tel que posé dans les messages de travail ; `null` s'il manque. */
  assistant: Dict | null;
  toolsPayload: readonly Dict[];
  toolCfgMap: ReadonlyMap<string, ConfigMcp>;
  builtinHandlers: ReadonlyMap<string, OutilIntegre["handler"]>;
  /** Trait « lecture seule » de chaque outil du catalogue. */
  lectureSeule: ReadonlyMap<string, boolean>;
  thinkingMode: boolean;
  samplingOverride: Dict | null;
  /** Jetons du contexte au dernier appel (entrée + complétion), mesurés par le moteur, sinon estimés. */
  jetons: number;
  /** Fenêtre du modèle ; 0 si inconnue. */
  fenetre: number;
  /** Seuil de compaction du run ; `null` : celui de l'instance. */
  seuilCompaction: CompactionThreshold | null;
  /** Clé d'affinité de slot llama.cpp du run (chatId par défaut). */
  slotKey: string | null;
}

/** Ce que la boucle sait de l'appel d'un outil intégré. */
export interface AppelIntegre {
  callId: string | null;
  /** Contexte du run appelant, lu à la demande ; la boucle ne le transmet qu'à `task` (un `fork` s'en sert). */
  parent?: (() => ContexteParent) | null;
  /** L'outil enregistre le résultat à rendre si le tour est annulé pendant l'appel : la boucle le dépose dans le lot partiel avant l'instantané, au lieu de la sentinelle. */
  rendreSiAnnule?: ((fournir: () => string | null) => void) | null;
}

/** Ce qu'un appel d'outil intégré écrit dans /work : `chemins` = préfixes relatifs au bac (`[]` : aucun), `null` = tout /work. */
export interface ClasseLot {
  ecrit: boolean;
  chemins: readonly string[] | null;
}

/** Classe un appel d'après ses arguments, avant son lot ; `null` : rien à ordonnancer (appel refusé d'avance). */
export type ClasseurLot = (args: Dict) => ClasseLot | null;

/** Outil intégré construit pour l'appel (RAG, sous-agents…) : définition `tools[]` et gestionnaire. */
export interface OutilIntegre {
  definition: Dict;
  handler: (args: Dict, appel?: AppelIntegre) => unknown;
  /** Facultatif : les appels du lot qui écrivent sur les mêmes chemins ne partent pas ensemble (un `task` qui écrit). */
  classerLot?: ClasseurLot;
}

/** Classeurs des outils intégrés retenus par le catalogue (`retenus` : leurs gestionnaires). */
export function classeursIntegres(
  builtinTools: ReadonlyMap<string, OutilIntegre> | Readonly<Record<string, OutilIntegre>> | null | undefined,
  retenus: ReadonlyMap<string, unknown>,
): Map<string, ClasseurLot> {
  const sortie = new Map<string, ClasseurLot>();
  const integres = builtinTools instanceof Map ? [...builtinTools] : Object.entries(builtinTools ?? {});
  for (const [nom, info] of integres)
    if (info.classerLot && retenus.has(nom)) sortie.set(nom, info.classerLot);
  return sortie;
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
  /** Trait « lecture seule » de chaque outil retenu (annotation de l'outil listé, sinon registre). */
  lectureSeule: Map<string, boolean>;
  connectedServerNames: string[];
}

type RegleOutils = Pick<OptionsCatalogue, "readOnly" | "sousAgent">;

/** Règle commune à tout enfant (collecte d'un `fresh`, périmètre d'un `fork`) : refus par nom, lecture seule du tour, périmètre du sous-agent. */
function retenuParRegle(
  nom: string,
  r: RegleOutils,
  refus: ReadonlySet<string>,
  lecture: boolean,
  integre: boolean,
): boolean {
  if (refus.has(nom)) return false;
  if (r.readOnly && !lecture) return false;
  return !r.sousAgent || outilPermisSousAgent(r.sousAgent, nom, lecture, integre);
}

/** Liste permise (`allowedToolNames`) : une catégorie cachée passe toujours. */
function dansListePermise(
  nom: string,
  permis: ReadonlySet<string> | null | undefined,
  cachees: ReadonlySet<unknown>,
): boolean {
  return permis === null || permis === undefined || permis.has(nom) || cachees.has(categorize(nom));
}

/** Catégories d'un serveur : celles demandées, les cachées, et la mémoire si son interrupteur est posé. */
function ensembleCategories(
  permises: unknown,
  cachees: ReadonlySet<unknown>,
  memoire: boolean,
): Set<unknown> {
  const ensemble = new Set<unknown>([...iterer(permises), ...cachees]);
  if (memoire) ensemble.add("memory");
  return ensemble;
}

/** Deux configs désignent le même serveur : l'entrée intégrée de même clé de pool, sinon l'`id` du serveur tiers. */
function memeServeur(a: ConfigMcp, b: ConfigMcp): boolean {
  try {
    if (serveurIntegre(a) || serveurIntegre(b))
      return serveurIntegre(a) && serveurIntegre(b) && makeKey(a) === makeKey(b);
    const ida = strPy(lire(a, "id") ?? "");
    return ida !== "" ? ida === strPy(lire(b, "id") ?? "") : makeKey(a) === makeKey(b);
  } catch {
    return false;
  }
}

/** Vue du catalogue d'un run qui sert à borner un enfant `fork`. */
export interface VueCatalogue {
  toolCfgMap: ReadonlyMap<string, ConfigMcp>;
  builtinHandlers: ReadonlyMap<string, unknown>;
  lectureSeule: ReadonlyMap<string, boolean>;
}

/** Ce qu'un enfant `fresh` du même type recevrait : configs MCP, intégrés fournis, filtres de `collectMcpTools`. */
export interface ProfilEnfant extends RegleOutils {
  allowedToolNames?: ReadonlySet<string> | null;
  denyToolNames?: Iterable<string> | null;
  configs: readonly unknown[];
  /** Noms des outils intégrés passés à l'enfant ; `null` : aucun. */
  integres: ReadonlySet<string> | null;
  memoryEnabled: boolean;
}

/** Outils du catalogue d'un run qu'un enfant `fresh` de ce profil aurait reçus, par la règle même de `collectMcpTools` : un `fork` garde le catalogue du parent et n'exécute que cet ensemble. */
export function perimetreEnfant(vue: VueCatalogue, enfant: ProfilEnfant): Set<string> {
  const refus = new Set(enfant.denyToolNames ?? []);
  const registreOk = manifestSource() !== "empty";
  const cachees = new Set(getHiddenCategories());
  const sources = expandBuiltinConfigs(enfant.configs);
  const retenus = new Set<string>();
  for (const [nom, cfg] of vue.toolCfgMap) {
    const source = sources.find((s) => memeServeur(s, cfg));
    if (source === undefined) continue;
    const permises = lire(source, "filter_categories");
    if (
      permises !== null &&
      permises !== undefined &&
      registreOk &&
      !ensembleCategories(permises, cachees, enfant.memoryEnabled).has(categorize(nom))
    )
      continue;
    if (applyMemoryGate([{ name: nom }], enfant.memoryEnabled, categorize).length === 0) continue;
    if (!retenuParRegle(nom, enfant, refus, vue.lectureSeule.get(nom) ?? false, serveurIntegre(cfg)))
      continue;
    if (!CTX.toolEnabled(nom) || !dansListePermise(nom, enfant.allowedToolNames, cachees)) continue;
    retenus.add(nom);
  }
  for (const nom of vue.builtinHandlers.keys()) {
    if (enfant.integres === null || !enfant.integres.has(nom)) continue;
    if (
      !retenuParRegle(nom, { ...enfant, readOnly: false }, refus, vue.lectureSeule.get(nom) ?? false, false)
    )
      continue;
    if (CTX.toolEnabled(nom)) retenus.add(nom);
  }
  return retenus;
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
  const lectureSeule = new Map<string, boolean>();
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
        const ensemble = ensembleCategories(permises, cachees, memoire);
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
        const lecture = toolTraits(nom, t).readOnly;
        if (!retenuParRegle(nom, options, refus, lecture, serveurIntegre(cfg))) continue;
        if (masque(nom, explicites)) {
          masquesParPorte++;
          continue;
        }
        if (!dansListePermise(nom, options.allowedToolNames, cachees)) continue;
        const deja = toolCfgMap.get(nom);
        if (deja !== undefined) {
          log.warn(
            `outil '${nom}' déjà fourni par le serveur '${strPy(lire(deja, "name") ?? "?")}' — ` +
              `doublon du serveur '${strPy(lire(cfg, "name") ?? "?")}' ignoré`,
          );
          continue;
        }
        toolCfgMap.set(nom, cfg);
        lectureSeule.set(nom, lecture);
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
    const lecture = toolTraits(nom).readOnly;
    if (!retenuParRegle(nom, { ...options, readOnly: false }, refus, lecture, false)) continue;
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
    lectureSeule.set(nom, lecture);
  }
  if (masquesParPorte > 0)
    log.info(`tool_gating: ${masquesParPorte} outil(s) masqué(s) (hors profil actif ce tour)`);
  return { toolCfgMap, toolsPayload, builtinHandlers, lectureSeule, connectedServerNames: connectes };
}
