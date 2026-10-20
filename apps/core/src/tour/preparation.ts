// SPDX-License-Identifier: MIT
/** apps/core/src/tour/preparation.ts — préparation d'un tour : payload client → plan (cible, serveurs MCP résolus côté serveur, interrupteurs du compte, historique, titre), ressources et base de l'enregistrement optimiste (chatbot_app/turn/preparation.py). */
import { getUserSettings, getUsernameById, ligneUtilisateur } from "@elpis/auth";
import {
  BLANC_PY,
  estDict,
  FlottantPy,
  getOu,
  HttpError,
  inPy,
  intPy,
  prefixePy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { ReglageRagChat, SourceCiteeRag } from "@elpis/contracts";
import { config } from "@elpis/config";
import type { Base } from "@elpis/db";
import {
  builtinClientCfg,
  clientBuiltinRef,
  resolveConfig,
  resolveExternalCfg,
  resolveForAgents,
  resolvePersonal,
  sharedId,
} from "@elpis/mcp";

import { tokenHex } from "../boucle/ports";
import { getChat, getChatPlanMode, setTitleIfDefault, upsertChat } from "../chats/stockage";
import { applyPersistedState, extractCompressionState } from "../contexte/etat-compression";
import { mergeUserSuffix } from "../contexte/elagage";
import { resolveMaxRounds, resolveThreshold } from "../contexte/porte-compaction";
import type { CompactionThreshold } from "../contexte/porte-compaction";
import { journal } from "../journal";
import { readyFor, toolEnabledIn } from "../images/acces";
import { canUseEngine } from "../llm/acces-moteurs";
import { CURRENT_LOADED_MODELS, refreshModelCache } from "../llm/cache-modeles";
import { EngineUnavailable, resolveLlmTarget } from "../llm/cible";
import type { LlmTarget } from "../llm/cible";
import { BUILTIN_KEY, connectorKey } from "../llm/moteurs";
import { continueFinalSupport } from "../llm/parametres";
import { diffusion, ErreurPortAbsent } from "../llm/ports";
import { buildDefaultManager } from "../memoire/gestionnaire";
import type { MemoryManager } from "../memoire/gestionnaire";
import { hasActiveAgents } from "../outils/integres/taches-agents";
import { assembleSystemMessages } from "../prompts/systeme";
import {
  annonceRagDuTour,
  annonceVisibleRag,
  collectionsActivesRag,
  derniereAnnonceRag,
  lireReglageRagChat,
  reglageRagDe,
} from "../rag/chat";
import { sourcesRagDesMessages } from "../rag/sources-message";
import {
  expandHistoryForLlm,
  graftStoppedTurnState,
  greffeSourcesRag,
  lastUserText,
  msgText,
  normalizeClientMessages,
  recentUserText,
} from "./historique";
import type { Persister } from "./persistance";
import { jobsTour } from "./ports-jobs";
import type { OrigineReveil } from "./ports-jobs";

const log = journal("uvicorn.error");

/** Ce que la préparation a décidé pour le tour (gel superficiel : les listes sont celles du payload ou de la base). */
export interface TurnPlan {
  readonly userId: number;
  readonly chatId: string;
  readonly username: string;
  readonly userSettings: Dict;
  readonly ephemeral: boolean;
  readonly isContinue: boolean;
  readonly resumable: boolean;
  readonly runId: string;
  readonly execId: string;
  readonly target: LlmTarget;
  readonly selectedModel: string | null;
  readonly thinkingMode: boolean;
  readonly samplingOverride: Dict | null;
  readonly activeMcpServers: Dict[];
  /** RAG du tour : collections actives lisibles au début du tour (aucune = aucun outil `rag_*`), réglage et sources déjà numérotées. */
  readonly rag: PlanRag | null;
  readonly mcpOn: boolean;
  readonly agentsOn: boolean;
  readonly memoryOn: boolean;
  readonly liveShellOn: boolean;
  readonly denyTools: ReadonlySet<string> | null;
  readonly planMode: boolean;
  readonly uiToolCats: string[];
  readonly uiExtIds: string[];
  readonly uiExcl: string[];
  readonly compressionOn: boolean;
  readonly compactionThreshold: CompactionThreshold;
  readonly compactionMaxRounds: number | null;
  readonly prunedKeys: unknown[];
  readonly messages: Dict[];
  readonly msgs: Dict[];
  readonly msgsForLlm: Dict[];
  readonly lastUserText: string;
  readonly existingChat: Dict | null;
  readonly chatReadFailed: boolean;
  readonly title: string;
  readonly titleWasGenerated: boolean;
  readonly titleContent: string | null;
  readonly imageToolOn: boolean;
  /** Tour de réveil ouvert par le serveur (`job_wake`), absent pour un message de l'utilisateur. */
  readonly origin?: "user" | "job_wake";
  readonly wake?: Readonly<Record<string, unknown>> | null;
  /** Profondeur de la chaîne de réveils : 0 pour un message de l'utilisateur. */
  readonly depth?: number;
  /** Événements de jobs joints à la question (suffixe persisté, rejoué octet pour octet). */
  readonly jobSuffix?: string | null;
  /** Bloc `<rag_context>` joint à la question, devant les événements de jobs (même suffixe persisté). */
  readonly ragSuffix?: string | null;
  /** Instantané sans secret ni adresse, porté par le registre des tours pendant le tour. */
  readonly instantane?: Readonly<Dict>;
}

/** Persistance (vide en session éphémère), mémoire (fermée par le worker). */
export interface TurnResources {
  readonly persistChat: Persister;
  readonly memManager: MemoryManager | null;
}

export interface PlanRag {
  readonly collections: readonly string[];
  readonly mode: ReglageRagChat["mode"];
  readonly topK: number;
  readonly precedentes: readonly SourceCiteeRag[];
}

/** Base de l'enregistrement optimiste et état de compression précédent ; recalée après une passation et par le tour. */
export interface PersistBaseline {
  updatedAt: unknown;
  messages: unknown;
  title: string;
  comprPrevState: Dict | null;
}

export interface DependancesTour {
  readonly base: Base;
}

/** Administrateur PLEIN seulement pour une commande `stdio` sur l'hôte (refus si le compte est illisible). */
async function stdioAllowedFor(base: Base, uid: number): Promise<boolean> {
  try {
    const moi = await ligneUtilisateur(base, uid);
    return moi !== undefined && moi !== null && Number(moi.is_admin) === 1;
  } catch {
    return false;
  }
}

/** Serveurs MCP qu'un agent personnalisé peut référencer par id (même règle que les routines). */
export async function agentMcpConfigs(base: Base, settings: Dict, uid: number | null): Promise<Dict[]> {
  return resolveForAgents(base, settings, {
    allowStdio: uid !== null ? await stdioAllowedFor(base, uid) : false,
  });
}

function diffuserLog(message: string, level: string): void {
  try {
    diffusion().diffuser({ type: "log", message, level });
  } catch (e) {
    if (!(e instanceof ErreurPortAbsent)) throw e;
  }
}

const EN_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const B = BLANC_PY;
const FICHIER_JOINT = new RegExp(
  `---${B}*FILE:${B}*[^\\n]+?${B}*---[\\s\\S]*?---${B}*END FILE${B}*---${B}*`,
  "gu",
);
const egal0 = (v: unknown): boolean =>
  v === null || v === undefined || v === "" || v === "0" || v === false || (nombre(v) ?? 1) === 0;
const nombre = (v: unknown): number | null =>
  typeof v === "number" ? v : v instanceof FlottantPy ? v.valeur : null;

/** Serveurs MCP actifs résolus CÔTÉ SERVEUR (jamais repris du client), catégories demandées gardées. */
async function resoudreServeurs(base: Base, uid: number, settings: Dict, actifs: unknown[]): Promise<Dict[]> {
  const stdioOk = await stdioAllowedFor(base, uid);
  const visibles = new Set(
    (Array.isArray(settings["shared_mcp_visible"]) ? (settings["shared_mcp_visible"] as unknown[]) : []).map(
      strPy,
    ),
  );
  const resolus: Dict[] = [];
  for (const srv of actifs) {
    if (!estDict(srv)) continue;
    const cats = srv["filter_categories"];
    const avecCats = (cfg: Dict): Dict => {
      if (cats !== null && cats !== undefined) cfg["filter_categories"] = cats;
      return cfg;
    };
    if (!veritePy(srv["id"])) {
      const ref = clientBuiltinRef(srv);
      if (ref !== null) resolus.push(ref);
      else if (veritePy(srv["manifest"])) {
        const cfg = resolveExternalCfg(strPy(srv["manifest"]));
        if (cfg) resolus.push(avecCats(cfg as Dict));
      }
      continue;
    }
    const rid = sharedId(srv["id"]);
    let cfg: Dict | null;
    if (rid !== null) {
      if (!visibles.has(strPy(srv["id"]))) continue;
      cfg = await resolveConfig(base, rid);
    } else cfg = await resolvePersonal(settings, srv["id"], { allowStdio: stdioOk });
    if (cfg) resolus.push(avecCats(cfg));
  }
  return resolus;
}

/** Références des serveurs MCP demandés, sans adresse ni secret : id, manifeste ou outils locaux, et catégories. */
function refsServeurs(actifs: unknown): Dict[] {
  const refs: Dict[] = [];
  for (const srv of Array.isArray(actifs) ? (actifs as unknown[]) : []) {
    if (!estDict(srv)) continue;
    const ref: Dict = {};
    if (srv["command"] === "DEFAULT_LOCAL_PYTHON") {
      ref["command"] = "DEFAULT_LOCAL_PYTHON";
      if (typeof srv["name"] === "string") ref["name"] = srv["name"];
    } else if (veritePy(srv["id"])) ref["id"] = srv["id"];
    else if (typeof srv["manifest"] === "string") ref["manifest"] = srv["manifest"];
    else continue;
    if (Array.isArray(srv["filter_categories"])) ref["filter_categories"] = srv["filter_categories"];
    refs.push(ref);
  }
  return refs;
}

/** Suffixe de la question du tour : bloc `<rag_context>` puis événements de jobs, comme il sera enregistré et rejoué. */
export function suffixeDeQuestion(
  ragSuffix: string | null | undefined,
  jobSuffix: string | null | undefined,
): string {
  return [ragSuffix, jobSuffix].filter((s): s is string => typeof s === "string" && s !== "").join("\n\n");
}

/** Événements de jobs joints à la dernière question vue par le modèle (même fusion que le rappel des tâches). */
function joindreALaQuestion(msgs: Dict[], texte: string): void {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!["role"] !== "user") continue;
    msgs[i] = { ...msgs[i]!, content: mergeUserSuffix(msgs[i]!["content"], texte) };
    return;
  }
}

/** Prépare le tour ; lève HttpError (400, 409) avant que rien ne parte au client. */
export async function prepareTurn(
  dep: DependancesTour,
  data: Dict,
  uid: number,
  chatIdDemande: string,
  reveil: OrigineReveil | null = null,
): Promise<[TurnPlan, TurnResources, PersistBaseline]> {
  const base = dep.base;
  const brut = veritePy(data["messages"]) ? data["messages"] : [];
  let actifs = "active_mcp_servers" in data ? data["active_mcp_servers"] : [];
  let uiToolCats: string[] = [];
  let uiExtIds: string[] = [];
  for (const srv of Array.isArray(actifs) ? (actifs as unknown[]) : []) {
    if (!estDict(srv)) continue;
    if (srv["command"] === "DEFAULT_LOCAL_PYTHON" && Array.isArray(srv["filter_categories"])) {
      if (!uiToolCats.length)
        uiToolCats = (srv["filter_categories"] as unknown[]).filter(
          (c): c is string => typeof c === "string",
        );
    } else if (veritePy(srv["id"])) uiExtIds.push("ext:" + strPy(srv["id"]));
    else if (veritePy(srv["manifest"])) uiExtIds.push("mf:" + strPy(srv["manifest"]));
  }
  let uiExcl = (Array.isArray(data["excluded_tools"]) ? (data["excluded_tools"] as unknown[]) : [])
    .filter((t): t is string => typeof t === "string" && stripPy(t) !== "")
    .map((t) => prefixePy(stripPy(t), 64))
    .slice(0, 96);
  const exclusDemandes = [...uiExcl];
  const selectedModel = typeof data["model"] === "string" ? data["model"] : null;
  const thinkingMode = veritePy(getOu(data, "thinking_mode", false));
  let cidInt: number | null;
  try {
    cidInt = egal0(data["connector_id"]) ? null : intPy(data["connector_id"]);
  } catch {
    cidInt = null;
  }
  let target: LlmTarget;
  try {
    target = await resolveLlmTarget(uid, cidInt, selectedModel, { strict: true });
  } catch (e) {
    if (e instanceof EngineUnavailable)
      throw new HttpError(409, { code: "engine_unavailable", reason: e.reason, message: e.message });
    throw e;
  }
  let autorise: boolean;
  try {
    autorise = await canUseEngine(base, uid, cidInt ? connectorKey(cidInt) : BUILTIN_KEY);
  } catch {
    autorise = true;
  }
  if (!autorise)
    throw new HttpError(409, {
      code: "engine_unavailable",
      reason: "forbidden",
      message: "Ce serveur ne vous est pas ouvert.",
    });
  const ephemeral = veritePy(getOu(data, "ephemeral", false));
  const persistChat: Persister = ephemeral
    ? async () => null
    : (u, c, titre, messages, ts, attendu) => upsertChat(base, u, c, titre, messages, ts, attendu);
  const samplingOverride = estDict(data["sampling_override"]) ? data["sampling_override"] : null;
  if (
    target.isDefault &&
    target.profil.capacites.chargement &&
    selectedModel &&
    !CURRENT_LOADED_MODELS.has(selectedModel)
  ) {
    CURRENT_LOADED_MODELS.add(selectedModel);
    void refreshModelCache().catch(() => undefined);
    diffuserLog(`[LLM] Modèle auto-chargé par requête chat: ${selectedModel}`, "INFO");
  }
  const lus = await getUserSettings(base, uid);
  const settings: Dict = estDict(lus) ? lus : {};
  const username = (await getUsernameById(base, uid)) || `user_${uid}`;
  if (veritePy(actifs))
    actifs = await resoudreServeurs(base, uid, settings, Array.isArray(actifs) ? actifs : []);
  let activeMcpServers = (Array.isArray(actifs) ? actifs : []) as Dict[];
  const memoryOn = Boolean(config.MEMORY_ENABLED) && veritePy(getOu(settings, "memory_enabled", false));
  let agentsOn = Boolean(config.AGENTS_ENABLED) && veritePy(getOu(settings, "agents_enabled", false));
  if (agentsOn) {
    const agents = getOu(settings, "custom_agents", null);
    agentsOn = hasActiveAgents(Array.isArray(agents) ? agents : []);
  }
  const liveShellOn = veritePy(getOu(settings, "live_shell_enabled", true));
  const compressionOn =
    Boolean(config.COMPRESSION_ENABLED) && veritePy(getOu(settings, "compression_enabled", false));
  const compactionThreshold = resolveThreshold(settings);
  const compactionMaxRounds = resolveMaxRounds(settings);
  const mcpOn = veritePy(getOu(settings, "enable_mcp", true));
  if (!mcpOn) {
    activeMcpServers = [];
    uiToolCats = [];
    uiExtIds = [];
    uiExcl = [];
    agentsOn = false;
  }
  let denyTools: Set<string> | null = mcpOn ? null : new Set(["todowrite"]);
  if (uiExcl.length) denyTools = new Set([...(denyTools ?? []), ...uiExcl]);

  const chatId = chatIdDemande || tokenHex(12);
  let existingChat: Dict | null = null;
  let chatReadFailed = false;
  try {
    existingChat = await getChat(base, uid, chatId);
  } catch {
    chatReadFailed = true;
  }
  if (chatReadFailed) {
    await new Promise((ok) => setTimeout(ok, 300));
    try {
      existingChat = await getChat(base, uid, chatId);
      chatReadFailed = false;
    } catch (e) {
      existingChat = null;
      log.warn(
        `[chats] lecture du chat ${Array.from(chatId).slice(0, 12).join("")} échouée — état de compression et garde optimiste indisponibles pour ce tour : ${String(e)}`,
      );
    }
  }
  const planMode = chatReadFailed
    ? await getChatPlanMode(base, uid, chatId)
    : veritePy((existingChat ?? {})["plan_mode"]);
  if (planMode) denyTools = new Set([...(denyTools ?? []), "task", "generate_image"]);
  let imageToolOn = false;
  if (mcpOn && !planMode && toolEnabledIn(settings)) {
    try {
      imageToolOn = await readyFor(base, uid);
    } catch (e) {
      log.debug(`[chat.image_tool_gate] ${String(e)}`);
    }
  }
  const aServeurLocal = activeMcpServers.some((s) => estDict(s) && s["command"] === "DEFAULT_LOCAL_PYTHON");
  if (
    !aServeurLocal &&
    (memoryOn || (mcpOn && agentsOn && !activeMcpServers.length) || (mcpOn && activeMcpServers.length))
  )
    activeMcpServers = [...activeMcpServers, builtinClientCfg([]) as Dict];
  const baseSys = stripPy(config.SYSTEM_PROMPT_DEFAULT || "");
  const sysCompte = getOu(settings, "system_prompt", "");
  const userSys = stripPy(typeof sysCompte === "string" ? sysCompte : strPy(sysCompte));
  const customSys = baseSys && userSys ? `${baseSys}\n\n---\n\n${userSys}` : baseSys || userSys;

  if (!Array.isArray(brut)) throw new HttpError(400, "messages doit être une liste");
  const [messages, msgs] = normalizeClientMessages(brut);
  if (!messages.length) throw new HttpError(400, "messages: aucun message valide dans le payload");
  if (existingChat && !chatReadFailed) {
    try {
      graftStoppedTurnState(messages, msgs, existingChat["messages"]);
    } catch (e) {
      log.debug(`[chat.graft_stopped_tool_history] ${String(e)}`);
    }
    greffeSourcesRag(msgs, existingChat["messages"]);
  }
  if (messages.every((m) => m["role"] === "notice"))
    throw new HttpError(400, "messages: aucun message valide dans le payload");
  const isContinue = veritePy(getOu(data, "is_continue", false));
  const derniereQuestion = lastUserText(messages);
  const resumable = veritePy(getOu(data, "resumable", false)) && !ephemeral;
  const runId = tokenHex(8);
  const execId = `chat-${runId}`;
  const skillQuery = recentUserText(messages, 3);
  const epingles = Array.isArray(data["pinned_skills"]) ? (data["pinned_skills"] as unknown[]) : [];

  let memoryBlock = "";
  let memManager: MemoryManager | null = null;
  try {
    if (memoryOn) {
      memManager = buildDefaultManager(username, "user", { app: "chat", sessionId: chatId });
      await memManager.initialize(chatId);
      memoryBlock = await memManager.systemPromptBlock();
    }
  } catch {
    memManager = null;
    memoryBlock = "";
  }
  const n = new Date();
  const today = `${EN_MONTHS[n.getMonth()]} ${n.getDate()}, ${n.getFullYear()}`;
  const skillsOn = activeMcpServers.some((s) => {
    const fc = estDict(s) ? s["filter_categories"] : null;
    return fc === null || fc === undefined || inPy("skill", fc);
  });
  let modelLabel = stripPy(target.model || selectedModel || "");
  if (!modelLabel && target.isDefault) {
    const m = stripPy(config.LLAMA_MODEL || "");
    modelLabel = m === "local-model" ? "" : m;
  }
  let msgsForLlm: Dict[] = (
    await assembleSystemMessages({
      customSys,
      lastUserText: skillQuery,
      userId: uid,
      pinnedSkills: epingles.filter(veritePy).map(strPy),
      memoryBlock,
      today,
      skillsEnabled: skillsOn,
      planMode,
      modelLabel,
    })
  ).map((m) => ({ ...m }));
  const prunedKeys = Array.isArray((existingChat ?? {})["ctx_pruned_keys"])
    ? ((existingChat ?? {})["ctx_pruned_keys"] as unknown[])
    : [];
  let resumeNative = false;
  if (isContinue && target.profil.capacites.props) {
    try {
      resumeNative = continueFinalSupport(selectedModel || target.model) === true;
    } catch (e) {
      log.debug(`[chat.resume_native_probe] ${String(e)}`);
    }
  }
  msgsForLlm.push(
    ...expandHistoryForLlm(messages, {
      isContinue,
      prunedKeys,
      resumeNative,
      userSuffixes: (existingChat ?? {})["llm_user_suffixes"],
    }),
  );
  let comprPrevState: Dict | null = null;
  try {
    if (existingChat) {
      comprPrevState = extractCompressionState(
        Array.isArray(existingChat["messages"]) ? existingChat["messages"] : [],
      ) as Dict | null;
      if (comprPrevState) {
        const [m, etat] = applyPersistedState(msgsForLlm, comprPrevState);
        msgsForLlm = m as Dict[];
        comprPrevState = etat ?? null;
      }
    }
  } catch (e) {
    log.warn(`[chats] apply état de compression échoué (non-fatal) : ${String(e)}`);
    comprPrevState = null;
  }

  let rag: PlanRag | null = null;
  let ragSuffix: string | null = null;
  if (!ephemeral && (existingChat || chatReadFailed)) {
    const reglage = chatReadFailed
      ? await lireReglageRagChat(base, uid, chatId)
      : reglageRagDe((existingChat ?? {})["rag"]);
    const actives = reglage ? await collectionsActivesRag(base, uid, reglage.collections) : [];
    if (actives.length && reglage)
      rag = {
        collections: actives.map((c) => c.id),
        mode: reglage.mode,
        topK: reglage.top_k,
        precedentes: sourcesRagDesMessages([
          ...(Array.isArray((existingChat ?? {})["messages"])
            ? ((existingChat ?? {})["messages"] as unknown[])
            : []),
          ...messages,
        ]),
      };
    if (!isContinue && reveil === null && !chatReadFailed) {
      const rang = messages.filter((m) => m["role"] === "user").length - 1;
      const derniere = derniereAnnonceRag(messages, (existingChat ?? {})["llm_user_suffixes"], rang);
      // Annonce résumée par la compaction : le modèle ne la voit plus, elle est refaite.
      ragSuffix = annonceRagDuTour(
        actives,
        derniere !== null && !annonceVisibleRag(msgsForLlm, derniere) ? null : derniere,
      );
    }
  }

  let title = "Nouveau chat";
  const existingTitle = stripPy(veritePy((existingChat ?? {})["title"]) ? strPy(existingChat!["title"]) : "");
  let titleContent: string | null = null;
  let titleWasGenerated = false;
  if (existingTitle && existingTitle !== "Nouveau chat") title = existingTitle;
  else {
    const premiere = msgs.find((x) => x["role"] === "user");
    if (premiere) {
      titleContent = stripPy(msgText(premiere["content"]).replace(FICHIER_JOINT, ""));
      const nouveau = prefixePy(titleContent || "Nouveau chat", 28);
      if (nouveau !== title) titleWasGenerated = true;
      title = nouveau;
    }
  }
  if (resumable && titleWasGenerated && existingChat) {
    try {
      await setTitleIfDefault(base, uid, chatId, title);
    } catch (e) {
      log.debug(`[chat.early_title] ${String(e)}`);
    }
  }
  let jobSuffix: string | null = null;
  if (!ephemeral && reveil === null) jobsTour()?.tourUtilisateur(uid, chatId);
  if (!ephemeral && !isContinue && reveil === null) {
    try {
      jobSuffix = (await jobsTour()?.prendrePourMessage(uid, chatId, runId)) ?? null;
    } catch (e) {
      log.warn(`[jobs] événements non joints au message : ${String(e)}`);
    }
  }
  const suffixe = suffixeDeQuestion(ragSuffix, jobSuffix);
  if (suffixe) joindreALaQuestion(msgsForLlm, suffixe);
  const plan: TurnPlan = {
    userId: uid,
    chatId,
    username,
    userSettings: settings,
    ephemeral,
    isContinue,
    resumable,
    runId,
    execId,
    target,
    selectedModel,
    thinkingMode,
    samplingOverride,
    activeMcpServers,
    rag,
    mcpOn,
    agentsOn,
    memoryOn,
    liveShellOn,
    denyTools,
    planMode,
    uiToolCats,
    uiExtIds,
    uiExcl,
    compressionOn,
    compactionThreshold,
    compactionMaxRounds,
    prunedKeys,
    messages,
    msgs,
    msgsForLlm,
    lastUserText: derniereQuestion,
    existingChat,
    chatReadFailed,
    title,
    titleWasGenerated,
    titleContent,
    imageToolOn,
    origin: reveil === null ? "user" : "job_wake",
    wake: reveil?.wake ?? null,
    depth: reveil?.depth ?? 0,
    jobSuffix,
    ragSuffix,
    instantane: {
      run_id: runId,
      model: selectedModel,
      connector_id: cidInt,
      thinking_mode: thinkingMode,
      active_mcp_servers: refsServeurs(data["active_mcp_servers"]),
      excluded_tools: exclusDemandes,
      sampling_override: samplingOverride,
      plan_mode: planMode,
      depth: reveil?.depth ?? 0,
      ephemeral,
    },
  };
  const ex = existingChat;
  return [
    plan,
    { persistChat, memManager },
    {
      updatedAt: ex ? ex["updated_at"] : null,
      messages: ex ? ex["messages"] : null,
      title: ex ? strPy(veritePy(ex["title"]) ? ex["title"] : "") : "",
      comprPrevState,
    },
  ];
}
