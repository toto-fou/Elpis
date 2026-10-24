// SPDX-License-Identifier: MIT
/** apps/core/src/llm/profils.ts — profil de chaque type de moteur déclaré (llama.cpp, vLLM, SGLang, générique) : adresses, capacités, métriques, drapeaux de lancement, dialecte ; aucune détection, le type déclaré fait foi. */
import { typeMoteurLlama } from "@elpis/config";

import { estDict } from "../python";
import { getPy } from "./dict-py";

export type TypeMoteur = "llamacpp" | "vllm" | "sglang" | "generic";

/** Adresses dérivées de la racine du serveur (sans `/v1`) ; `null` = le moteur ne l'expose pas. */
export interface CheminsMoteur {
  readonly chat: string;
  readonly modeles: string;
  readonly sante: string | null;
  readonly version: string | null;
  readonly infos: string | null;
  readonly infosModele: string | null;
  readonly metriques: string | null;
  readonly tokenisation: string | null;
  readonly gabarit: string | null;
  readonly chargement: string | null;
  readonly dechargement: string | null;
  readonly slots: string | null;
  readonly infill: string | null;
}

/** `props` : `/props` de llama.cpp ; `modeles` : `max_model_len` de `/v1/models` ; `aucune` : déclarée ou devinée. */
export type SourceContexte = "props" | "modeles" | "aucune";
/** Corps de `/tokenize` : `{content, add_special}` (llama.cpp) ou `{prompt | messages, add_special_tokens}` (vLLM, SGLang). */
export type FormeTokenisation = "llamacpp" | "openai";

export interface CapacitesMoteur {
  /** `/props` (gabarit, échantillonnage, build, slots) : llama.cpp seulement. */
  readonly props: boolean;
  readonly contexte: SourceContexte;
  readonly tokenisation: FormeTokenisation | null;
  /** Le moteur rend le prompt d'une conversation et le compte en un appel (sinon `/apply-template` puis `/tokenize`). */
  readonly tokenisationMessages: boolean;
  /** Charger et décharger un modèle : llama.cpp en mode routeur (rôle lu sur `/props`). */
  readonly chargement: boolean;
  readonly slots: boolean;
  /** Les appels passent par la file d'Elpis (créneaux, exclusivité de modèle) ; sinon le moteur regroupe les requêtes lui-même. */
  readonly file: boolean;
  /** Session de flux reprenable, arrêt et fin de réflexion côté moteur (llama.cpp récent). */
  readonly fluxReprenable: boolean;
  /** Un 503 ou un redémarrage s'attend en sondant la santé. */
  readonly attenteSante: boolean;
  /** Le gabarit reçoit le `reasoning_content` des messages assistant (SGLang) : « Raisonnement conservé » peut lui rendre la réflexion des tours d'outils. */
  readonly reflexionRenvoyee: boolean;
  /** Tout modèle annoncé par `/v1/models` est en mémoire (un seul modèle servi, pas de chargement à la demande). */
  readonly modelesServisCharges: boolean;
  /** `usage.prompt_tokens_details.cached_tokens` : toujours rendu, sur option du serveur, ou jamais connu. */
  readonly jetonsEnCache: "toujours" | "option" | "inconnu";
}

/** Noms Prometheus normalisés (`:` → `_`) lus par la jauge et l'état du moteur. */
export interface MetriquesMoteur {
  readonly enCours: string | null;
  readonly enAttente: string | null;
  /** Occupation du cache KV en fraction (0 à 1). */
  readonly kvRatio: string | null;
  readonly kvUtilises: string | null;
  readonly kvTotal: string | null;
  /** Métrique d'information portant `kv_cache_size_tokens`, sinon `num_gpu_blocks` × `block_size` (vLLM). */
  readonly kvInfo: string | null;
  readonly debit: string | null;
  readonly jetonsGeneres: string | null;
  readonly tauxCache: string | null;
  readonly cacheRequetes: string | null;
  readonly cacheSucces: string | null;
  /** Statut HTTP de `/metrics` quand le serveur est lancé sans métriques (501 llama.cpp, 404 vLLM et SGLang). */
  readonly statutDesactivees: number | null;
}

/** Conseil de lancement quand une capacité manque (option exacte du moteur) ; `null` = rien à conseiller. */
export interface DrapeauxMoteur {
  readonly metriques: string | null;
  readonly jetonsEnCache: string | null;
  readonly reflexion: string | null;
  readonly outils: string | null;
  readonly cle: string | null;
  readonly concurrence: string | null;
}

/** Champs de requête gardés en plus du standard OpenAI : tous dans le `ChatCompletionRequest` de vLLM 0.31 et de SGLang 0.5.21. */
export const CHAMPS_DIALECTE_ETENDU: ReadonlySet<string> = new Set([
  "chat_template_kwargs",
  "reasoning_effort",
  "top_k",
  "min_p",
  "repetition_penalty",
]);

/** Valeurs de `reasoning_effort` acceptées par les deux moteurs (et connues de l'interface). */
export const EFFORTS_DIALECTE_ETENDU: readonly string[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/** Champs de réflexion d'une réponse, dans l'ordre lu : `reasoning_content` (llama.cpp, SGLang), puis `reasoning` (vLLM). */
export const CHAMPS_REFLEXION: readonly string[] = ["reasoning_content", "reasoning"];

const AUCUN_CHAMP: ReadonlySet<string> = new Set();

/** Dialecte de requête et de réponse du moteur. */
export interface DialecteMoteur {
  /** Tous les champs llama.cpp gardés : `sanitizePayload` n'y touche pas. */
  readonly natif: boolean;
  /** Dialecte OpenAI étendu (vLLM, SGLang) : interrupteur `chat_template_kwargs.enable_thinking`, effort, échantillonnage étendu. */
  readonly etendu: boolean;
  /** Champs gardés en plus du standard OpenAI. */
  readonly champsEtendus: ReadonlySet<string>;
  /** Valeurs de `reasoning_effort` offertes ; `null` = aucune par le dialecte. */
  readonly efforts: readonly string[] | null;
  /** Champs lus pour la réflexion d'une réponse. */
  readonly champsReflexion: readonly string[];
}

const DIALECTE_STANDARD: DialecteMoteur = {
  natif: false,
  etendu: false,
  champsEtendus: AUCUN_CHAMP,
  efforts: null,
  champsReflexion: CHAMPS_REFLEXION,
};

const DIALECTE_ETENDU: DialecteMoteur = {
  natif: false,
  etendu: true,
  champsEtendus: CHAMPS_DIALECTE_ETENDU,
  efforts: EFFORTS_DIALECTE_ETENDU,
  champsReflexion: CHAMPS_REFLEXION,
};

export interface ProfilMoteur {
  readonly type: TypeMoteur;
  readonly libelle: string;
  readonly portParDefaut: number;
  readonly chemins: CheminsMoteur;
  readonly capacites: CapacitesMoteur;
  readonly metriques: MetriquesMoteur;
  readonly drapeaux: DrapeauxMoteur;
  readonly dialecte: DialecteMoteur;
}

const SANS_METRIQUES: MetriquesMoteur = {
  enCours: null,
  enAttente: null,
  kvRatio: null,
  kvUtilises: null,
  kvTotal: null,
  kvInfo: null,
  debit: null,
  jetonsGeneres: null,
  tauxCache: null,
  cacheRequetes: null,
  cacheSucces: null,
  statutDesactivees: null,
};

const OPENAI = { chat: "/v1/chat/completions", modeles: "/v1/models" } as const;

function figer<T extends object>(o: T): T {
  for (const v of Object.values(o)) if (v !== null && typeof v === "object") figer(v as object);
  return Object.freeze(o);
}

/** La table unique : une entrée par type déclarable dans `llama.engine` ou un connecteur. */
export const PROFILS: Readonly<Record<TypeMoteur, ProfilMoteur>> = figer({
  llamacpp: {
    type: "llamacpp",
    libelle: "llama.cpp",
    portParDefaut: 8080,
    chemins: {
      ...OPENAI,
      sante: "/health",
      version: "/props",
      infos: "/props",
      infosModele: null,
      metriques: "/metrics",
      tokenisation: "/tokenize",
      gabarit: "/apply-template",
      chargement: "/models/load",
      dechargement: "/models/unload",
      slots: "/slots",
      infill: "/infill",
    },
    capacites: {
      props: true,
      contexte: "props",
      tokenisation: "llamacpp",
      tokenisationMessages: false,
      chargement: true,
      slots: true,
      file: true,
      fluxReprenable: true,
      attenteSante: true,
      reflexionRenvoyee: false,
      modelesServisCharges: false,
      jetonsEnCache: "toujours",
    },
    metriques: {
      ...SANS_METRIQUES,
      enCours: "llamacpp_requests_processing",
      enAttente: "llamacpp_requests_deferred",
      kvUtilises: "llamacpp_kv_cache_tokens",
      kvTotal: "llamacpp_n_ctx_total",
      debit: "llamacpp_predicted_tokens_seconds",
      statutDesactivees: 501,
    },
    drapeaux: {
      metriques: "ajoutez --metrics",
      jetonsEnCache: null,
      reflexion: null,
      outils: null,
      cle: "--api-key",
      concurrence: "--parallel",
    },
    dialecte: { ...DIALECTE_STANDARD, natif: true },
  },
  vllm: {
    type: "vllm",
    libelle: "vLLM",
    portParDefaut: 8000,
    chemins: {
      ...OPENAI,
      sante: "/health",
      version: "/version",
      infos: null,
      infosModele: null,
      metriques: "/metrics",
      tokenisation: "/tokenize",
      gabarit: null,
      chargement: null,
      dechargement: null,
      slots: null,
      infill: null,
    },
    capacites: {
      props: false,
      contexte: "modeles",
      tokenisation: "openai",
      tokenisationMessages: true,
      chargement: false,
      slots: false,
      file: false,
      fluxReprenable: false,
      attenteSante: true,
      reflexionRenvoyee: false,
      modelesServisCharges: true,
      jetonsEnCache: "option",
    },
    metriques: {
      ...SANS_METRIQUES,
      enCours: "vllm_num_requests_running",
      enAttente: "vllm_num_requests_waiting",
      kvRatio: "vllm_kv_cache_usage_perc",
      kvInfo: "vllm_cache_config_info",
      jetonsGeneres: "vllm_generation_tokens_total",
      cacheRequetes: "vllm_prefix_cache_queries_total",
      cacheSucces: "vllm_prefix_cache_hits_total",
      statutDesactivees: 404,
    },
    drapeaux: {
      metriques: "retirez --disable-log-stats",
      jetonsEnCache: "ajoutez --enable-prompt-tokens-details",
      reflexion: "ajoutez --reasoning-parser <nom> (qwen3, deepseek_r1, openai_gptoss…)",
      outils:
        "ajoutez --enable-auto-tool-choice --tool-call-parser <nom> (hermes, llama3_json, qwen3_coder…)",
      cle: "--api-key",
      concurrence: "--max-num-seqs",
    },
    dialecte: DIALECTE_ETENDU,
  },
  sglang: {
    type: "sglang",
    libelle: "SGLang",
    portParDefaut: 30000,
    chemins: {
      ...OPENAI,
      sante: "/health",
      version: "/server_info",
      infos: "/server_info",
      infosModele: "/model_info",
      metriques: "/metrics",
      tokenisation: "/v1/tokenize",
      gabarit: null,
      chargement: null,
      dechargement: null,
      slots: null,
      infill: null,
    },
    capacites: {
      props: false,
      contexte: "modeles",
      tokenisation: "openai",
      tokenisationMessages: true,
      chargement: false,
      slots: false,
      file: false,
      fluxReprenable: false,
      attenteSante: true,
      reflexionRenvoyee: true,
      modelesServisCharges: true,
      jetonsEnCache: "option",
    },
    metriques: {
      ...SANS_METRIQUES,
      enCours: "sglang_num_running_reqs",
      enAttente: "sglang_num_queue_reqs",
      kvRatio: "sglang_token_usage",
      kvUtilises: "sglang_kv_used_tokens",
      debit: "sglang_gen_throughput",
      statutDesactivees: 404,
      jetonsGeneres: "sglang_generation_tokens_total",
      tauxCache: "sglang_cache_hit_rate",
    },
    drapeaux: {
      metriques: "ajoutez --enable-metrics",
      jetonsEnCache: "ajoutez --enable-cache-report",
      reflexion: "ajoutez --reasoning-parser <nom> (qwen3, deepseek-r1, gpt-oss…)",
      outils: "ajoutez --tool-call-parser <nom> (qwen25, llama3, qwen3_coder…)",
      cle: "--api-key",
      concurrence: "--max-running-requests",
    },
    dialecte: DIALECTE_ETENDU,
  },
  generic: {
    type: "generic",
    libelle: "OpenAI-compatible",
    portParDefaut: 8000,
    chemins: {
      ...OPENAI,
      sante: null,
      version: null,
      infos: null,
      infosModele: null,
      metriques: null,
      tokenisation: null,
      gabarit: null,
      chargement: null,
      dechargement: null,
      slots: null,
      infill: null,
    },
    capacites: {
      props: false,
      contexte: "aucune",
      tokenisation: null,
      tokenisationMessages: false,
      chargement: false,
      slots: false,
      file: false,
      fluxReprenable: false,
      attenteSante: false,
      reflexionRenvoyee: false,
      modelesServisCharges: false,
      jetonsEnCache: "inconnu",
    },
    metriques: SANS_METRIQUES,
    drapeaux: {
      metriques: null,
      jetonsEnCache: null,
      reflexion: null,
      outils: null,
      cle: null,
      concurrence: null,
    },
    dialecte: DIALECTE_STANDARD,
  },
});

export const TYPES_MOTEUR: readonly TypeMoteur[] = Object.freeze(["llamacpp", "vllm", "sglang", "generic"]);

/** Profil d'un type déjà normalisé (moteur intégré, connecteur) : correspondance exacte comme Python, sinon générique. */
export function profilDuType(type: string): ProfilMoteur {
  return Object.hasOwn(PROFILS, type) ? PROFILS[type as TypeMoteur] : PROFILS.generic;
}

/** Profil d'un type déclaré (`llama.engine` avec ses alias, ou `provider_type` d'un connecteur) ; un fournisseur cloud ou inconnu est générique. */
export function profilDe(type: string | null | undefined): ProfilMoteur {
  const t = typeMoteurLlama(type || "llamacpp");
  return PROFILS[t as TypeMoteur] ?? PROFILS.generic;
}

/** Dialecte étendu de vLLM et SGLang pour ce type exact (comme `provider_type`) ; tout autre type garde le standard. */
export function aDialecteEtendu(providerType: string | null | undefined): boolean {
  return profilDuType(providerType || "").dialecte.etendu;
}

/** Réflexion d'un delta ou d'un message : premier champ non vide de `CHAMPS_REFLEXION` (un seul quand un serveur envoie les deux). */
export function texteReflexion(d: unknown): string {
  if (!estDict(d)) return "";
  for (const cle of CHAMPS_REFLEXION) {
    const v = getPy(d, cle);
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/** Ce que l'interface lit d'un profil : type, libellé, chargement possible, passage par la file, fenêtre lue sur le moteur. */
export function vuePubliqueProfil(p: ProfilMoteur): {
  type: TypeMoteur;
  libelle: string;
  chargement: boolean;
  file: boolean;
  contexte: boolean;
} {
  return {
    type: p.type,
    libelle: p.libelle,
    chargement: p.capacites.chargement,
    file: p.capacites.file,
    contexte: p.capacites.contexte !== "aucune",
  };
}
