// SPDX-License-Identifier: MIT
/** apps/core/src/memoire/gestionnaire.ts — orchestrateur des fournisseurs de mémoire (bloc système, crochets, index des sessions), port de llm_core/memory/_manager.py. */
import { ErreurPython, stripPy } from "@elpis/commun";
import { config } from "@elpis/config";

import { journal } from "../journal";
import { MarkdownMemoryProvider } from "./fournisseur";
import type { MemoryProvider } from "./fournisseur";
import { DEFAULT_MEMORY_LIMIT, DEFAULT_USER_LIMIT } from "./portee";
import { comptesMemoire, indexSessions } from "./ports";

const log = (): ReturnType<typeof journal> => journal("memory");
const texte = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface OptionsGestionnaire {
  scopeKey?: string | null;
  /** `chat` ou `agentic`. */
  app?: string;
  sessionId?: string;
}

/** Enregistre les fournisseurs (un seul externe), agrège leurs blocs et route les écritures ; aucun crochet ne lève. */
export class MemoryManager {
  readonly username: string | null;
  readonly scopeKey: string;
  readonly app: string;
  sessionId: string;
  private readonly fournisseurs: MemoryProvider[] = [];
  private idUtilisateur: number | null = null;
  private idResolu = false;

  constructor(username: string | null | undefined, options: OptionsGestionnaire = {}) {
    this.username = username ?? null;
    this.scopeKey = options.scopeKey || "user";
    this.app = options.app ?? "chat";
    this.sessionId = options.sessionId ?? "";
  }

  register(provider: MemoryProvider): this {
    if (provider.isExternal && this.fournisseurs.some((p) => p.isExternal))
      throw new ErreurPython("ValueError", "Only one external memory provider is allowed at a time");
    this.fournisseurs.push(provider);
    return this;
  }

  get providers(): MemoryProvider[] {
    return [...this.fournisseurs];
  }

  async initialize(sessionId = ""): Promise<this> {
    if (sessionId) this.sessionId = sessionId;
    for (const p of this.fournisseurs) {
      try {
        if (await p.isAvailable()) await p.initialize(this.sessionId);
      } catch (e) {
        log().warn(`initialize(${p.name}) failed: ${texte(e)}`);
      }
    }
    return this;
  }

  async shutdown(): Promise<void> {
    for (const p of this.fournisseurs) await p.shutdown().catch(() => undefined);
  }

  /** Blocs non vides des fournisseurs, séparés d'une ligne vide. */
  async systemPromptBlock(): Promise<string> {
    const blocs: string[] = [];
    for (const p of this.fournisseurs) {
      try {
        const b = stripPy((await p.systemPromptBlock()) || "");
        if (b) blocs.push(b);
      } catch (e) {
        log().warn(`system_prompt_block(${p.name}) failed: ${texte(e)}`);
      }
    }
    return blocs.join("\n\n");
  }

  /** Id du compte, résolu une fois ; `null` (index sauté) si inconnu ou comptes indisponibles. */
  private async resoudreIdUtilisateur(): Promise<number | null> {
    if (this.idResolu) return this.idUtilisateur;
    this.idResolu = true;
    try {
      this.idUtilisateur = this.username ? await comptesMemoire().idUtilisateur(this.username) : null;
    } catch (e) {
      log().debug(`user id unavailable: ${texte(e)}`);
      this.idUtilisateur = null;
    }
    return this.idUtilisateur;
  }

  private async indexerMessage(role: string, content: string): Promise<void> {
    const contenu = stripPy(content || "");
    if (!contenu) return;
    const uid = await this.resoudreIdUtilisateur();
    if (uid === null) return;
    try {
      await indexSessions().indexerMessage({
        user_id: uid,
        app: this.app,
        session_id: this.sessionId,
        scope_key: this.scopeKey === "user" ? "" : this.scopeKey,
        role,
        content: contenu,
        ts: Date.now() / 1000,
      });
    } catch (e) {
      log().debug(`session index failed: ${texte(e)}`);
    }
  }

  /** Tour terminé : index plein texte (les deux messages) puis crochet de chaque fournisseur. */
  async syncTurn(userContent: string, assistantContent: string): Promise<void> {
    await this.indexerMessage("user", userContent);
    await this.indexerMessage("assistant", assistantContent);
    for (const p of this.fournisseurs) {
      try {
        await p.syncTurn(userContent, assistantContent, this.sessionId);
      } catch (e) {
        log().warn(`sync_turn(${p.name}) failed: ${texte(e)}`);
      }
    }
  }

  async onMemoryWrite(action: string, target: string, content: string): Promise<void> {
    for (const p of this.fournisseurs) await p.onMemoryWrite(action, target, content).catch(() => undefined);
  }

  async onSessionEnd(messages: readonly Record<string, unknown>[]): Promise<void> {
    for (const p of this.fournisseurs) await p.onSessionEnd(messages).catch(() => undefined);
  }
}

export interface OptionsFabrique {
  app?: string;
  sessionId?: string;
  /** Absent : `MEMORY_DIR` et les limites de la config ; fourni : limites par défaut. */
  sandboxDir?: string | null;
}

/** Gestionnaire câblé avec le fournisseur intégré (Markdown auto-curé). */
export function buildDefaultManager(
  username: string | null | undefined,
  scopeKey: string | null = "user",
  options: OptionsFabrique = {},
): MemoryManager {
  let { sandboxDir } = options;
  let memoryLimit = DEFAULT_MEMORY_LIMIT;
  let userLimit = DEFAULT_USER_LIMIT;
  if (sandboxDir === null || sandboxDir === undefined) {
    sandboxDir = config.MEMORY_DIR;
    memoryLimit = config.MEMORY_MD_CHAR_LIMIT;
    userLimit = config.USER_MD_CHAR_LIMIT;
  }
  const gestionnaire = new MemoryManager(username, {
    scopeKey,
    app: options.app ?? "chat",
    sessionId: options.sessionId ?? "",
  });
  return gestionnaire.register(
    new MarkdownMemoryProvider(username ?? null, scopeKey, sandboxDir, { memoryLimit, userLimit }),
  );
}
