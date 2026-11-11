// SPDX-License-Identifier: MIT
/** packages/outils-mcp/test/aides.ts — client JSON-RPC brut sur un transport, famille d'outils de test. */
import type { Dict } from "@elpis/commun";
import { py } from "@elpis/http";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { err, ok } from "../src/boite";
import type { ContexteAppel } from "../src/contexte";
import { ErreurOutil } from "../src/limites";
import type { DefinitionOutil } from "../src/serveur";

/** Client JSON-RPC sans validation : réponses brutes et notifications reçues. */
export class ClientBrut {
  readonly notifications: Dict[] = [];
  private suivant = 1;
  private readonly attentes = new Map<number | string, (m: Dict) => void>();
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
    transport.onmessage = (m: JSONRPCMessage) => {
      const o = m as Dict;
      if ("id" in o && ("result" in o || "error" in o)) {
        this.attentes.get(o["id"] as number)?.(o);
        this.attentes.delete(o["id"] as number);
      } else this.notifications.push(o);
    };
  }

  async demarrer(): Promise<void> {
    await this.transport.start();
  }

  requete(method: string, params?: Dict): Promise<Dict> {
    const id = this.suivant++;
    return new Promise((fin) => {
      this.attentes.set(id, fin);
      void this.transport.send({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      } as JSONRPCMessage);
    });
  }

  async initialiser(version = "2025-06-18"): Promise<Dict> {
    const r = await this.requete("initialize", {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
    return r;
  }

  async appeler(name: string, args: Dict = {}, meta?: Dict): Promise<Dict> {
    const r = await this.requete("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    return r["result"] as Dict;
  }
}

export const CATEGORIE_TACHES = { name: "task", label: "Tâches", icon: "ph-list-checks", color: "blue" };
export const CATEGORIE_MEMOIRE = { name: "memory", label: "Mémoire", icon: "ph-brain", color: "violet" };

function definition(nom: string, cat: Dict, extra: Dict = {}): Dict {
  return {
    name: nom,
    description: `Outil ${nom}.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    ...extra,
    _meta: { category: cat, fastmcp: { tags: [cat["name"]] } },
  };
}

/** Famille « todo » de test : écho, échecs, sorties enveloppées ou validées, notifications. */
export function outilsTodo(journal: unknown[] = []): DefinitionOutil[] {
  const o = (
    nom: string,
    signature: DefinitionOutil["signature"],
    traiter: DefinitionOutil["traiter"],
    extra: Dict = {},
  ): DefinitionOutil => ({
    nom,
    famille: "todo",
    definition: definition(nom, CATEGORIE_TACHES, extra),
    signature,
    traiter,
  });
  return [
    o("echo", { texte: py.str(), n: py.int().defaut(1) }, (a) => ok({ texte: a["texte"], n: a["n"] })),
    o("echec_enveloppe", {}, () => err("bad_path", "chemin hors du bac — é", { fix: "relatif" })),
    o("echec_leve", {}, () => {
      throw new Error("boum");
    }),
    o("echec_outil", {}, () => {
      throw new ErreurOutil("refus net");
    }),
    o("texte_brut", {}, () => "bonjour"),
    o("enveloppe", {}, () => ({ ok: true, v: 1.5 }), {
      outputSchema: { type: "object", properties: { result: {} }, "x-fastmcp-wrap-result": true },
    }),
    o(
      "sortie_validee",
      { bon: py.bool().defaut(true) },
      (a) => (a["bon"] ? { ok: true, total: 3 } : { ok: true, total: "x" }),
      {
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" }, total: { type: "integer" } },
          required: ["total"],
        },
      },
    ),
    o("bavard", {}, async (_a, ctx: ContexteAppel) => {
      await ctx.debug("détail");
      await ctx.info("étape", { loggerName: "elpis.shell", extra: { kind: "shell_output", call_id: "c1" } });
      await ctx.reportProgress(1, 2, "moitié");
      journal.push(ctx.meta);
      return ok();
    }),
    o("titre_donne", {}, () => ok(), { title: "Titre Donné" }),
    o("titre_annote", {}, () => ok(), { annotations: { title: "Annoté", readOnlyHint: true } }),
  ];
}

export function outilsMemoire(): DefinitionOutil[] {
  return [
    {
      nom: "memory",
      famille: "memory",
      definition: definition("memory", CATEGORIE_MEMOIRE),
      signature: { action: py.literal("add", "remove") },
      traiter: (a) => ok({ action: a["action"] }),
    },
  ];
}

export function outilsGit(): DefinitionOutil[] {
  return [
    {
      nom: "git_query",
      famille: "git",
      definition: definition("git_query", { name: "git", label: "Git" }),
      signature: {},
      traiter: () => ok({ repo: "r" }),
    },
  ];
}
