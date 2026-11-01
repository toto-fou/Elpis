// SPDX-License-Identifier: MIT
/** apps/core/src/memoire/fournisseur.ts — fournisseurs de mémoire (interface et fournisseur intégré Markdown au bloc figé par tour), port de _provider.py et _builtin_provider.py. */
import { neutraliserMarqueursTour } from "@elpis/securite";

import { storeFor } from "./portee";

/** Stratégie de mémoire branchable ; ses crochets ne doivent pas lever (la mémoire ne bloque jamais la conversation). */
export abstract class MemoryProvider {
  abstract readonly name: string;

  /** Fournisseur tiers (un seul actif à la fois). */
  get isExternal(): boolean {
    return false;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async initialize(_sessionId: string): Promise<void> {}

  /** Bloc statique du début de session ; `""` = rien. */
  async systemPromptBlock(): Promise<string> {
    return "";
  }

  async syncTurn(_userContent: string, _assistantContent: string, _sessionId = ""): Promise<void> {}

  async onMemoryWrite(_action: string, _target: string, _content: string): Promise<void> {}

  async onSessionEnd(_messages: readonly Record<string, unknown>[]): Promise<void> {}

  async shutdown(): Promise<void> {}

  getToolSchemas(): Record<string, unknown>[] {
    return [];
  }

  async handleToolCall(_toolName: string, _args: Record<string, unknown>): Promise<string> {
    return "";
  }
}

export interface ReglagesFournisseur {
  memoryLimit: number;
  userLimit: number;
}

/** USER.md (par compte) et MEMORY.md (par portée) rendus en un bloc aux marqueurs de tour inertes, capturé une fois à `initialize` puis figé. */
export class MarkdownMemoryProvider extends MemoryProvider {
  readonly name = "builtin";
  private readonly username: string | null;
  private readonly scopeKey: string | null;
  private readonly sandboxDir: string;
  private readonly limites: ReglagesFournisseur;
  private bloc: string | null = null;

  constructor(
    username: string | null,
    scopeKey: string | null,
    sandboxDir: string,
    limites: ReglagesFournisseur,
  ) {
    super();
    this.username = username;
    this.scopeKey = scopeKey;
    this.sandboxDir = sandboxDir;
    this.limites = limites;
  }

  override async initialize(_sessionId: string): Promise<void> {
    this.bloc = await this.rendre();
  }

  /** Bloc figé, ou rendu à la volée si `initialize` n'a pas été appelé. */
  override async systemPromptBlock(): Promise<string> {
    return this.bloc ?? (await this.rendre());
  }

  private async rendre(): Promise<string> {
    const magasin = (kind: string) =>
      storeFor(kind, this.username, this.scopeKey, this.sandboxDir, this.limites);
    const parties = [await magasin("user").renderBlock(), await magasin("memory").renderBlock()].filter(
      (p) => p,
    );
    return parties.length === 0
      ? ""
      : neutraliserMarqueursTour(`# Memory (snapshot)\n\n${parties.join("\n\n")}`);
  }
}
