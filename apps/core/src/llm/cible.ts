// SPDX-License-Identifier: MIT
/** apps/core/src/llm/cible.ts — cible d'inférence de la requête (`LlmTarget`) portée par AsyncLocalStorage, et sa résolution par connecteur. */
import { AsyncLocalStorage } from "node:async_hooks";

import { stripPy, strPy, veritePy } from "@elpis/commun";
import { config } from "@elpis/config";

import { entierPy, estChiffresPy } from "../python";
import { connecteurs } from "./ports";
import type { ConnecteurSecret, PortConnecteurs } from "./ports";

export interface ChampsCible {
  wire?: string;
  providerType?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  connectorId?: number | null;
  isDefault?: boolean;
}

/** Connecteur visé par la requête ; `baseUrl` vide et `isDefault` = moteur intégré (`LLAMA_URL`). */
export class LlmTarget {
  wire: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  connectorId: number | null;
  isDefault: boolean;

  constructor(champs: ChampsCible = {}) {
    this.wire = champs.wire ?? "openai";
    this.providerType = champs.providerType ?? "llamacpp";
    this.baseUrl = champs.baseUrl ?? "";
    this.apiKey = champs.apiKey ?? "";
    this.model = champs.model ?? "";
    this.connectorId = champs.connectorId ?? null;
    this.isDefault = champs.isDefault ?? true;
  }

  /** Intégré local ET dialecte llama.cpp : seul cas où `/props`, `/slots`, `/tokenize` de `LLAMA_URL` existent. */
  get isLocalLlamacpp(): boolean {
    return this.isDefault && this.providerType === "llamacpp";
  }

  get isLlamacpp(): boolean {
    return this.providerType === "llamacpp";
  }
}

/** Moteur local intégré, du type configuré (`llama.engine`), relu à chaque appel. */
export function defaultTarget(): LlmTarget {
  return new LlmTarget({
    wire: "openai",
    providerType: config.LLAMA_PROVIDER_TYPE || "llamacpp",
    baseUrl: "",
    apiKey: "",
    model: "",
    connectorId: null,
    isDefault: true,
  });
}

const cibleCourante = new AsyncLocalStorage<LlmTarget | null>();

/** Cible posée par le contexte async courant, `null` hors de toute portée (le `_current.get()` de Python). */
export function cibleDuContexte(): LlmTarget | null {
  return cibleCourante.getStore() ?? null;
}

export function currentTarget(): LlmTarget {
  return cibleDuContexte() ?? defaultTarget();
}

/** Exécute `fn` avec `target` pour cible, propagée à travers `await`, `Promise.all` et minuteries ; `null` = moteur par défaut. */
export function useLlmTarget<T>(target: LlmTarget | null, fn: () => T): T {
  return cibleCourante.run(target, fn);
}

export type RaisonIndisponible = "missing" | "disabled" | "key" | "forbidden" | "provider";

/** Serveur demandé inutilisable : supprimé, désactivé, clé illisible, ou refusé par la politique d'accès. */
export class EngineUnavailable extends Error {
  override name = "EngineUnavailable";
  readonly reason: RaisonIndisponible;

  constructor(reason: RaisonIndisponible, message: string) {
    super(message);
    this.reason = reason;
  }
}

const MESSAGES: Readonly<Record<Exclude<RaisonIndisponible, "forbidden">, string>> = {
  missing: "Le serveur sélectionné n'existe plus.",
  disabled: "Le serveur sélectionné est désactivé.",
  key: "Le serveur sélectionné est illisible (clé).",
  provider: "Ce fournisseur n'est plus autorisé sur cette instance.",
};

/** `llm.allowed_provider_types` revérifié à chaque résolution pour le compte propriétaire ; illisible = rien d'interdit. */
async function providerAllowed(userId: number, providerType: unknown): Promise<boolean> {
  if (!veritePy(providerType)) return true;
  try {
    return (await connecteurs().allowedProviderTypes(userId)).includes(providerType as string);
  } catch {
    return true;
  }
}

function actif(ligne: ConnecteurSecret): boolean {
  return ligne.enabled === undefined ? true : veritePy(ligne.enabled);
}

/** Cible de `(userId, connectorId, model)` : intégré sans connecteur, sinon le connecteur visible par ce compte ; `strict` lève au lieu du repli. */
export async function resolveLlmTarget(
  userId: unknown,
  connectorId: unknown,
  model: string | null = null,
  options: { strict?: boolean; touch?: boolean } = {},
): Promise<LlmTarget> {
  const parDefaut = (): LlmTarget => {
    const t = defaultTarget();
    if (model) t.model = model;
    return t;
  };
  if (!veritePy(connectorId)) return parDefaut();
  let ligne: ConnecteurSecret | null;
  let raison: Exclude<RaisonIndisponible, "forbidden"> = "missing";
  let port: PortConnecteurs | null = null;
  let uid: number | null = null;
  try {
    port = connecteurs();
    const texte = userId === null || userId === undefined ? null : strPy(userId);
    uid = texte !== null && estChiffresPy(texte) ? entierPy(userId) : null;
    ligne = uid !== null ? await port.getSecretForUser(uid, entierPy(connectorId)) : null;
  } catch {
    ligne = null;
    raison = "key";
  }
  if (ligne !== null && veritePy(ligne) && !actif(ligne)) raison = "disabled";
  if (ligne !== null && veritePy(ligne) && actif(ligne) && ligne.scope === "user" && uid !== null) {
    if (!(await providerAllowed(uid, ligne.provider_type || ""))) {
      ligne = null;
      raison = "provider";
    }
  }
  if (ligne === null || !veritePy(ligne) || !actif(ligne) || port === null) {
    if (options.strict) throw new EngineUnavailable(raison, MESSAGES[raison]);
    return parDefaut();
  }
  const choisi = stripPy(model || ligne.default_model || "");
  const connecteursActifs = port;
  const toucher = async (): Promise<void> => connecteursActifs.bumpLastUsed(entierPy(connectorId));
  if (options.touch ?? true) await toucher().catch(() => undefined);
  return new LlmTarget({
    wire: ligne.wire || "openai",
    providerType: ligne.provider_type || "generic",
    baseUrl: stripPy(ligne.base_url || ""),
    apiKey: ligne.api_key || "",
    model: choisi,
    connectorId: entierPy(connectorId),
    isDefault: false,
  });
}
