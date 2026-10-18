// SPDX-License-Identifier: MIT
/** apps/core/src/memoire/mcp.ts — outils MCP `memory` et `session_search` (famille memory) : définitions figées par les goldens, signatures pydantic lax, identité et dépendances de l'appel. */
import { resolve } from "node:path";

import { config } from "@elpis/config";
import type { Executeur } from "@elpis/db";
import { py } from "@elpis/http";
import golden from "@elpis/outils-mcp/goldens/memory.json" with { type: "json" };
import { getChatId, getUsername, outilDuGolden } from "@elpis/outils-mcp";
import type { DefinitionOutil, Golden } from "@elpis/outils-mcp";

import { memory, sessionSearch } from "./outil";
import type { PortComptesMemoire } from "./ports";

/** `_memory_root` : `MCP_MEMORY_ROOT` s'il est posé, sinon `MEMORY_DIR` de la configuration (relu à chaque appel, comme les routes). */
export function racineMemoire(): string {
  const env = process.env["MCP_MEMORY_ROOT"];
  return env ? resolve(env) : config.MEMORY_DIR;
}

export interface DependancesOutilsMemoire {
  /** Base lue par `session_search` (hors transaction : repli LIKE sous PostgreSQL). */
  base: Executeur;
  comptes: PortComptesMemoire;
  /** Racine des magasins ; absent : `racineMemoire()`. */
  racine?: () => string;
}

/** Outils de la famille `memory` (`memory`, `session_search`) ; seul le compte du jeton ou du `_meta` est lu, jamais les arguments. */
export function outilsMemoire(dep: DependancesOutilsMemoire): DefinitionOutil[] {
  const g = golden as unknown as Golden;
  const identite = (ctx: Parameters<typeof getUsername>[0]): { username: string; chatId: string } => ({
    username: getUsername(ctx),
    chatId: getChatId(ctx),
  });
  return [
    outilDuGolden(g, "memory", {
      signature: {
        action: py.literal("add", "replace", "remove", "rewrite"),
        store: py.literal("memory", "user"),
        content: py.optional(py.str()).defaut(null),
        target: py.optional(py.str()).defaut(null),
        old_text: py.optional(py.str()).defaut(null),
        title: py.optional(py.str()).defaut(null),
      },
      traiter: (args, ctx) =>
        memory({ racine: (dep.racine ?? racineMemoire)(), info: (m) => ctx.info(m) }, identite(ctx), args),
    }),
    outilDuGolden(g, "session_search", {
      signature: {
        query: py.str().defaut(""),
        limit: py.int().defaut(5),
        ref: py.optional(py.int()).defaut(null),
      },
      traiter: (args, ctx) =>
        sessionSearch(
          { base: dep.base, idUtilisateur: (nom) => dep.comptes.idUtilisateur(nom) },
          identite(ctx),
          args,
        ),
    }),
  ];
}
