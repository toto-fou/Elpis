// SPDX-License-Identifier: MIT
/** packages/outils-mcp/test/familles-test.ts — équivalents TS minimaux des familles Python todo et memory : définitions des goldens, signatures pydantic, traitements non portés. */
import { readFileSync } from "node:fs";

import { py } from "@elpis/http";

import { avant } from "../src/arguments";
import type { Signature } from "../src/arguments";
import { outilDuGolden } from "../src/goldens";
import type { Golden } from "../src/goldens";
import type { DefinitionOutil } from "../src/serveur";

export function lireGolden(famille: string): Golden {
  return JSON.parse(readFileSync(new URL(`../goldens/${famille}.json`, import.meta.url), "utf-8")) as Golden;
}

const todoItem = avant(
  py.model(
    { content: py.str(), status: py.optional(py.str()).defaut("") },
    { extra: "ignore", classe: "TodoItem" },
  ),
  (d) => (typeof d === "string" ? { content: d } : d),
);

/** Signatures Python réelles de todowrite, memory et session_search (FastMCP les valide par TypeAdapter). */
export const SIGNATURES_REELLES: Record<string, Signature> = {
  todowrite: { fonction: "todowrite", parametres: { todos: py.list(todoItem) } },
  memory: {
    fonction: "memory",
    parametres: {
      action: py.literal("add", "replace", "remove", "rewrite"),
      store: py.literal("memory", "user"),
      content: py.optional(py.str()).defaut(null),
      target: py.optional(py.str()).defaut(null),
      old_text: py.optional(py.str()).defaut(null),
      title: py.optional(py.str()).defaut(null),
    },
  },
  session_search: {
    fonction: "session_search",
    parametres: {
      query: py.str().defaut(""),
      limit: py.int().defaut(5),
      ref: py.optional(py.int()).defaut(null),
    },
  },
};

const nonPorte = (): never => {
  throw new Error("traitement non porté (B3-00 : socle seulement)");
};

/** Familles todo et memory du socle, dans l'ordre d'enregistrement Python (memory avant todo). */
export function famillesTodoMemory(): [string, DefinitionOutil[]][] {
  const outils = (famille: string): DefinitionOutil[] =>
    lireGolden(famille).outils.map((d) =>
      outilDuGolden(lireGolden(famille), d["name"] as string, {
        signature: (SIGNATURES_REELLES[d["name"] as string] as Signature).parametres,
        traiter: nonPorte,
      }),
    );
  return [
    ["memory", outils("memory")],
    ["todo", outils("todo")],
  ];
}
