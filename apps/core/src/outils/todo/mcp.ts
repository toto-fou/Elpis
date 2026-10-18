// SPDX-License-Identifier: MIT
/** apps/core/src/outils/todo/mcp.ts — outil MCP `todowrite` (famille todo) : définition figée par le golden, signature pydantic lax, identité de l'appel. */
import { py } from "@elpis/http";
import golden from "@elpis/outils-mcp/goldens/todo.json" with { type: "json" };
import { avant, getChatId, getUsername, outilDuGolden } from "@elpis/outils-mcp";
import type { DefinitionOutil, Golden } from "@elpis/outils-mcp";

import { todowrite } from "./ecriture";
import type { DependancesTodo } from "./ecriture";

/** `TodoItem` : une chaîne seule devient `{content}`, clés en plus ignorées, `status` vide par défaut. */
const todoItem = avant(
  py.model(
    { content: py.str(), status: py.optional(py.str()).defaut("") },
    { extra: "ignore", classe: "TodoItem" },
  ),
  (d) => (typeof d === "string" ? { content: d } : d),
);

/** Outils de la famille `todo` (`todowrite`) ; compte et chat viennent de l'identité de l'appel (`get_username(ctx, "")`). */
export function outilsTodo(dep: DependancesTodo): DefinitionOutil[] {
  return [
    outilDuGolden(golden as unknown as Golden, "todowrite", {
      signature: { todos: py.list(todoItem) },
      traiter: (args, ctx) =>
        todowrite(
          dep,
          { username: getUsername(ctx, ""), chatId: getChatId(ctx, "") },
          args["todos"] as unknown[],
        ),
    }),
  ];
}
